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

/** @type {Map<string, { strategy, state, startTime, intentCount, intentWindow, childOrders }>} */
const _strategies = new Map();
const MAX_INTENTS_PER_SEC = 10;
let _nextIntentId = 1;

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

  const strategy = new plugin.Strategy(params);
  const entry = {
    strategy,
    strategyType: plugin.config.name,
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
  for (const [sid, entry] of _strategies) {
    if (entry.state !== 'RUNNING') continue;
    if (entry.strategy.symbol !== data.symbol) continue;
    try { entry.strategy.onTick(data); }
    catch (err) { _handleStrategyError(sid, entry, err); }
  }
}

function _onTradeData(data) {
  for (const [sid, entry] of _strategies) {
    if (entry.state !== 'RUNNING') continue;
    if (entry.strategy.symbol !== data.symbol) continue;
    try { if (entry.strategy.onTrade) entry.strategy.onTrade(data); }
    catch (err) { _handleStrategyError(sid, entry, err); }
  }
}

function _onFillData(data) {
  for (const [sid, entry] of _strategies) {
    if (entry.childOrders.includes(data.childId || data.orderId)) {
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
    intentId, strategyId,
    symbol: intent.symbol, side: intent.side, quantity: intent.quantity,
    limitPrice: intent.limitPrice, orderType: intent.orderType || 'LIMIT',
    algoType: intent.algoType || entry.strategyType, venue: intent.venue || 'DERIBIT',
  });
  return intentId;
}

function _cancelChild(strategyId, childId) {
  if (!childId) return;
  _send('CANCEL_INTENT', { strategyId, childId });
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
  _send('ALGO_PROGRESS', {
    strategyId, type: s.type, symbol: s.symbol,
    filledQty: s.filledQty, remainingQty: s.remainingQty,
    avgFillPrice: s.avgFillPrice, status: entry.state, elapsed: Date.now() - entry.startTime,
  });
}

function _send(type, payload) { parentPort.postMessage({ type, ...payload }); }

console.log('[algo-engine] Worker started');
