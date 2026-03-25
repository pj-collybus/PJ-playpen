/**
 * Algo execution engine — runs as a worker_threads worker.
 *
 * Strategies are loaded as plugins: scans src/algo/strategies/ on startup
 * and registers any .js file that exports { config, Strategy }.
 * Adding a new strategy = dropping one file. No other changes needed.
 *
 * IPC protocol:
 *   Main → Worker: START_STRATEGY, STOP_STRATEGY, PAUSE_STRATEGY, RESUME_STRATEGY, GET_STATUS, MARKET_DATA, TRADE_DATA, FILL_DATA
 *   Worker → Main: STRATEGY_STARTED, STRATEGY_STOPPED, STRATEGY_ERROR, STATUS_UPDATE, ORDER_INTENT, CANCEL_INTENT, ALGO_PROGRESS, STRATEGY_CONFIGS
 */

'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');
const fs   = require('fs');

// ── Plugin loader — scan strategies directory ────────────────────────────────

const STRATEGIES_DIR = path.join(__dirname, 'strategies');
const _plugins = new Map(); // name → { config, Strategy }

function _loadPlugins() {
  _plugins.clear();
  let files;
  try { files = fs.readdirSync(STRATEGIES_DIR); }
  catch { console.error('[algo-engine] Cannot read strategies directory'); return; }

  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const fullPath = path.join(STRATEGIES_DIR, file);
    try {
      const mod = require(fullPath);
      if (mod.config && mod.Strategy) {
        const name = mod.config.name.toUpperCase();
        _plugins.set(name, { config: mod.config, Strategy: mod.Strategy });
        console.log(`[algo-engine] Loaded strategy plugin: ${name} (${file})`);
      }
    } catch (err) {
      console.error(`[algo-engine] Failed to load ${file}:`, err.message);
    }
  }
  console.log(`[algo-engine] ${_plugins.size} strategy plugins loaded`);
}

_loadPlugins();

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, { strategy, state, startTime, intentCount, intentWindow, childOrders, venue }>} */
const _strategies = new Map();
const MAX_INTENTS_PER_SEC = 10;
let _nextIntentId = 1;

// ── Fill simulation for unreliable testnet matching engines ──────────────────
/** @type {Set<string>} venues where fills should be simulated */
const _simFillVenues = new Set();
/** @type {Map<string, { intentId, strategyId, symbol, side, qty, price, venue, placedAt }>} */
const _pendingSimFills = new Map();

// ── Heartbeat — ensures strategies tick even when market data is slow ────────
/** @type {Map<string, object>} last market data per symbol */
const _lastMdBySymbol = new Map();

setInterval(() => {
  for (const [sid, entry] of _strategies) {
    if (entry.state === 'STOPPED' || entry.state === 'ERROR') continue;
    const sym = entry.strategy.symbol;
    const lastMd = _lastMdBySymbol.get(sym);
    if (lastMd) {
      try { entry.strategy.onTick(lastMd); }
      catch (err) { _handleStrategyError(sid, entry, err); }
    }
    // Safety: force completion if strategy is filled but status not COMPLETED
    const s = entry.strategy;
    if (s.filledSize >= s.totalSize - 0.001 && s.status !== 'COMPLETED' && s.status !== 'STOPPED' && s.status !== 'COMPLETING') {
      console.log(`[twap] Heartbeat forced completion: filled=${s.filledSize} total=${s.totalSize} status was ${s.status}`);
      s._completedTs = s._completedTs || Date.now();
      s.status = 'COMPLETED';
      entry.state = 'COMPLETED';
      if (typeof s.stop === 'function') s.stop();
    }
    // Sync engine entry state with strategy status
    if (s.status === 'COMPLETED' && entry.state !== 'COMPLETED') entry.state = 'COMPLETED';
    if (s.status === 'STOPPED' && entry.state !== 'STOPPED') entry.state = 'STOPPED';
    _emitProgress(sid);
  }

  // Check simulated fills
  const now = Date.now();
  for (const [intentId, pend] of _pendingSimFills) {
    const md = _lastMdBySymbol.get(pend.symbol);
    if (!md) continue;
    const bid = md.bidPrice || 0, ask = md.askPrice || 0;
    if (bid <= 0 || ask <= 0) continue;
    // Check if market crossed order price
    const crossed = pend.side === 'BUY' ? (bid >= pend.price) : (ask <= pend.price);
    // Random delay 500-2000ms after crossing
    if (crossed && now >= pend.placedAt + 500 + Math.random() * 1500) {
      console.log(`[algo] Simulated fill for ${intentId} at ${pend.price} — testnet mode`);
      // Publish simulated fill to main process — it will publish to FILLS bus
      // which feeds back to the worker via _wireAlgoDataFeeds → _onFillData
      // Do NOT call _onFillData directly here to avoid double-counting
      _send('SIMULATED_FILL', {
        intentId, strategyId: pend.strategyId,
        symbol: pend.symbol, venue: pend.venue,
        side: pend.side, fillSize: pend.qty, fillPrice: pend.price,
      });
      _pendingSimFills.delete(intentId);
    }
  }

  // Generate synthetic market trades for POV on testnet (every 2-5s per symbol)
  if (_simFillVenues.size > 0) {
    for (const [sid, entry] of _strategies) {
      if (entry.state !== 'RUNNING' || !entry.strategy.onTrade) continue;
      if (!_simFillVenues.has((entry.venue || '').toUpperCase())) continue;
      const sym = entry.strategy.symbol;
      const md = _lastMdBySymbol.get(sym);
      if (!md || !md.midPrice) continue;
      // Random interval 2-5 seconds
      const tradeKey = `_simTradeTs_${sym}`;
      if (!entry[tradeKey]) entry[tradeKey] = now;
      if (now - entry[tradeKey] < 2000 + Math.random() * 3000) continue;
      entry[tradeKey] = now;
      const mid = md.midPrice;
      const spread = (md.askPrice || mid) - (md.bidPrice || mid);
      const jitter = (Math.random() - 0.5) * spread;
      const synthTrade = {
        symbol: sym, venueSymbol: sym, venue: entry.venue,
        price: mid + jitter, size: 1 + Math.random() * 20,
        side: Math.random() > 0.5 ? 'BUY' : 'SELL',
        timestamp: now, synthetic: true,
      };
      try { entry.strategy.onTrade(synthTrade); } catch {}
    }
  }
}, 1000);

// ── Message handler ──────────────────────────────────────────────────────────

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'START_STRATEGY':  _startStrategy(msg.payload);      break;
      case 'STOP_STRATEGY':   _stopStrategy(msg.strategyId);    break;
      case 'PAUSE_STRATEGY':  _pauseStrategy(msg.strategyId);   break;
      case 'RESUME_STRATEGY': _resumeStrategy(msg.strategyId);  break;
      case 'GET_STATUS':      _sendStatus();                    break;
      case 'GET_CONFIGS':     _sendConfigs();                   break;
      case 'MARKET_DATA':     _onMarketData(msg.payload);       break;
      case 'TRADE_DATA':      _onTradeData(msg.payload);        break;
      case 'FILL_DATA':       _onFillData(msg.payload);         break;
      case 'ACCELERATE':      _accelerate(msg.strategyId, msg.quantity); break;
      case 'ORDER_UPDATE':    _onOrderUpdate(msg.payload);              break;
      case 'SET_SIM_VENUES':  {
        _simFillVenues.clear();
        for (const v of (msg.venues || [])) _simFillVenues.add(v.toUpperCase());
        console.log(`[algo-engine] Simulated fill venues: ${Array.from(_simFillVenues).join(', ') || 'none'}`);
        break;
      }
      default: break;
    }
  } catch (err) {
    console.error('[algo-engine] Message handler error:', err);
  }
});

// ── Send strategy configs to main process ────────────────────────────────────

function _sendConfigs() {
  const configs = [];
  for (const [, plugin] of _plugins) {
    configs.push(plugin.config);
  }
  _send('STRATEGY_CONFIGS', { configs });
}

// Send configs immediately on startup so the main process has them
_sendConfigs();

// ── Strategy lifecycle ───────────────────────────────────────────────────────

function _startStrategy(payload) {
  const { strategyId, strategyType, params } = payload;

  if (_strategies.has(strategyId)) {
    _send('STRATEGY_ERROR', { strategyId, error: 'Strategy already running' });
    return;
  }

  const plugin = _plugins.get(strategyType?.toUpperCase());
  if (!plugin) {
    _send('STRATEGY_ERROR', { strategyId, error: `Unknown strategy type: ${strategyType}. Available: ${Array.from(_plugins.keys()).join(', ')}` });
    return;
  }

  const shortId = strategyId.substring(strategyId.length - 6);
  const strategy = new plugin.Strategy(params);
  const entry = {
    strategy,
    strategyType: plugin.config.name,
    shortId,
    venue:       params.venue || 'DERIBIT',
    state:       'RUNNING',
    startTime:   Date.now(),
    intentCount: 0,
    intentWindow: Date.now(),
    childOrders: [],
  };
  _strategies.set(strategyId, entry);

  const ctx = {
    submitIntent: (intent) => _submitIntent(strategyId, intent),
    cancelChild:  (childId) => _cancelChild(strategyId, childId),
  };

  try {
    strategy.start(ctx);
    _send('STRATEGY_STARTED', { strategyId, strategyType: plugin.config.name, params });
    _emitProgress(strategyId);
  } catch (err) {
    entry.state = 'ERROR';
    console.error(`CRITICAL: Strategy ${strategyId} (${plugin.config.name}) failed to start:`, err.stack);
    _send('STRATEGY_ERROR', { strategyId, error: err.message, stack: err.stack });
  }
}

function _stopStrategy(strategyId) {
  const entry = _strategies.get(strategyId);
  if (!entry) { _send('STRATEGY_ERROR', { strategyId, error: 'Strategy not found' }); return; }
  try { entry.strategy.stop(); } catch (err) { console.error(`[algo-engine] Error stopping ${strategyId}:`, err.message); }
  entry.state = 'STOPPED';
  _send('STRATEGY_STOPPED', { strategyId });
  _emitProgress(strategyId);
}

function _pauseStrategy(strategyId) {
  const entry = _strategies.get(strategyId);
  if (!entry || entry.state !== 'RUNNING') return;
  entry.strategy.pause();
  entry.state = 'PAUSED';
  _emitProgress(strategyId);
  _send('STATUS_UPDATE', { strategyId, state: 'PAUSED' });
}

function _resumeStrategy(strategyId) {
  const entry = _strategies.get(strategyId);
  if (!entry || entry.state !== 'PAUSED') return;
  entry.strategy.resume();
  entry.state = 'RUNNING';
  _emitProgress(strategyId);
  _send('STATUS_UPDATE', { strategyId, state: 'RUNNING' });
}

// ── Market data forwarding ───────────────────────────────────────────────────

function _onMarketData(data) {
  // Cache for heartbeat replay
  if (data.symbol) _lastMdBySymbol.set(data.symbol, data);
  if (data.venueSymbol) _lastMdBySymbol.set(data.venueSymbol, data);

  for (const [sid, entry] of _strategies) {
    if (entry.state === 'STOPPED' || entry.state === 'ERROR') continue;
    const sym = entry.strategy.symbol;
    if (sym !== data.symbol && sym !== data.venueSymbol) continue;
    try { entry.strategy.onTick(data); }
    catch (err) { _handleStrategyError(sid, entry, err); }
  }
}

function _onTradeData(data) {
  for (const [sid, entry] of _strategies) {
    if (entry.state === 'STOPPED' || entry.state === 'ERROR') continue;
    const sym = entry.strategy.symbol;
    if (sym !== data.symbol && sym !== data.venueSymbol) continue;
    try { if (entry.strategy.onTrade) entry.strategy.onTrade(data); }
    catch (err) { _handleStrategyError(sid, entry, err); }
  }
}

function _onOrderUpdate(data) {
  if (!data || !data.state) return;
  // Remove from sim fill tracking if rejected/cancelled
  if (data.state === 'REJECTED' || data.state === 'CANCELLED') {
    const intentKey = data.orderId || data.intentId;
    if (_pendingSimFills.has(intentKey)) {
      console.log(`[algo] Removing sim fill for ${intentKey} — order ${data.state}`);
      _pendingSimFills.delete(intentKey);
    }
  }
  for (const [sid, entry] of _strategies) {
    if (entry.childOrders.includes(data.orderId || data.intentId)) {
      if (typeof entry.strategy.onOrderUpdate === 'function') {
        try { entry.strategy.onOrderUpdate(data); _emitProgress(sid); }
        catch (err) { _handleStrategyError(sid, entry, err); }
      }
      break;
    }
  }
}

function _onFillData(data) {
  if (!data.fillSize || data.fillSize <= 0) return; // ignore zero fills
  const matchKey = data.childId || data.orderId;
  for (const [sid, entry] of _strategies) {
    if (entry.childOrders.includes(matchKey)) {
      console.log(`[engine] _onFillData matched: strategy=${sid} key=${matchKey} size=${data.fillSize} price=${data.fillPrice}`);
      try { entry.strategy.onFill(data); _emitProgress(sid); }
      catch (err) { _handleStrategyError(sid, entry, err); }
      break;
    }
  }
}

// ── Order intent (rate-limited) ──────────────────────────────────────────────

function _submitIntent(strategyId, intent) {
  const entry = _strategies.get(strategyId);
  if (!entry || entry.state !== 'RUNNING') return null;

  const now = Date.now();
  if (now - entry.intentWindow >= 1000) { entry.intentCount = 0; entry.intentWindow = now; }
  entry.intentCount++;
  if (entry.intentCount > MAX_INTENTS_PER_SEC) {
    console.warn(`WARNING: Strategy ${strategyId} exceeded ${MAX_INTENTS_PER_SEC} intents/sec — discarding`);
    return null;
  }

  const intentId = `intent-${_nextIntentId++}`;
  entry.childOrders.push(intentId);

  _send('ORDER_INTENT', {
    intentId, strategyId, shortId: entry.shortId,
    parentOrderId: `TWAP-${entry.shortId}`,
    sliceNumber: entry.childOrders.length,
    symbol: intent.symbol, side: intent.side, quantity: intent.quantity,
    limitPrice: intent.limitPrice, orderType: intent.orderType || 'LIMIT',
    algoType: intent.algoType || entry.strategyType,
    venue: entry.venue,
  });

  // Register for simulated fill if venue has simulation enabled
  if (_simFillVenues.has((entry.venue || '').toUpperCase())) {
    _pendingSimFills.set(intentId, {
      intentId, strategyId,
      symbol: intent.symbol, side: intent.side,
      qty: intent.quantity, price: intent.limitPrice,
      venue: entry.venue, placedAt: Date.now(),
    });
  }

  return intentId;
}

function _cancelChild(strategyId, childId) {
  if (!childId) return;
  _pendingSimFills.delete(childId); // remove from sim fill tracking
  _send('CANCEL_INTENT', { strategyId, childId });
}

function _accelerate(strategyId, quantity) {
  const entry = _strategies.get(strategyId);
  if (!entry || (entry.state !== 'RUNNING' && entry.state !== 'PAUSED')) return;
  const s = entry.strategy;
  const lastMd = _lastMdBySymbol.get(s.symbol);
  const bid = lastMd?.bidPrice || 0;
  const ask = lastMd?.askPrice || 0;
  const mid = lastMd?.midPrice || ((bid + ask) / 2) || 0;
  if (mid <= 0) { console.log('[algo] Acceleration failed — no market data'); return; }

  // Cancel existing child
  if (s.activeChildId) { _cancelChild(strategyId, s.activeChildId); s.activeChildId = null; }

  const qty = Math.min(quantity || s.remainingSize, s.remainingSize);
  const price = s.side === 'BUY' ? ask : bid; // aggressive
  console.log(`[twap] Acceleration triggered: amount=${qty} price=${price} urgency=aggressive`);

  const intentId = `intent-${_nextIntentId++}`;
  entry.childOrders.push(intentId);
  _send('ORDER_INTENT', {
    intentId, strategyId,
    symbol: s.symbol, side: s.side, quantity: qty,
    limitPrice: price, orderType: 'LIMIT',
    algoType: 'TWAP-ACCEL', venue: entry.venue,
  });
}

// ── Error handling ───────────────────────────────────────────────────────────

function _handleStrategyError(strategyId, entry, err) {
  entry.state = 'ERROR';
  console.error(`CRITICAL: Strategy ${strategyId} (${entry.strategyType}) threw error:`, err.stack);
  try { entry.strategy.stop(); } catch {}
  _send('STRATEGY_ERROR', { strategyId, error: err.message, stack: err.stack });
}

// ── Status & progress ────────────────────────────────────────────────────────

function _sendStatus() {
  const strategies = {};
  for (const [sid, entry] of _strategies) {
    strategies[sid] = {
      state: entry.state, startTime: entry.startTime, elapsed: Date.now() - entry.startTime,
      ...(entry.strategy.getState()), childOrderCount: entry.childOrders.length,
    };
  }
  _send('STATUS_UPDATE', { strategies });
}

function _emitProgress(strategyId) {
  const entry = _strategies.get(strategyId);
  if (!entry) return;
  const s = entry.strategy;
  const state = typeof s.getState === 'function' ? s.getState() : {};
  // Exclude chart arrays from heartbeat progress (sent via GET_STATUS poll instead)
  const { chartBids, chartAsks, chartOrder, chartTimes, chartFills, ...lightState } = state;
  _send('ALGO_PROGRESS', {
    strategyId, shortId: entry.shortId,
    ...lightState,
    state: entry.state,
    elapsed: Date.now() - entry.startTime,
    childOrderCount: entry.childOrders.length,
    venue: entry.venue,
  });
}

function _send(type, payload) { parentPort.postMessage({ type, ...payload }); }

console.log('[algo-engine] Worker started');
