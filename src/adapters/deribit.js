/**
 * Deribit adapter — WebSocket market data feed.
 *
 * Connects to Deribit (testnet or live), subscribes to instruments,
 * normalises raw messages to canonical L1_BBO and L2_BOOK events,
 * and publishes them to the event bus.
 *
 * Sequence tracking: change_id on book updates.
 * Gap recovery: REST public/get_order_book snapshot.
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const { BookGuard }    = require('./bookGuard');
const venues           = require('../config/venues');

const VENUE = 'DERIBIT';
const cfg   = venues.DERIBIT;

function detectInstrumentClass(venueSymbol) {
  if (venueSymbol.includes('PERPETUAL')) return InstrumentClass.CRYPTO_PERP;
  if (/\d{2}[A-Z]{3}\d{2}$/.test(venueSymbol)) return InstrumentClass.CRYPTO_FUTURE;
  return InstrumentClass.CRYPTO_SPOT;
}

class DeribitAdapter extends EventEmitter {
  constructor({ publishToBus = true, dataBreaker = null } = {}) {
    super();
    this.publishToBus  = publishToBus;
    this._ws           = null;
    this._reqId        = 1;
    this._pending      = new Map();
    this._subscriptions = new Set();
    this._reconnectMs  = 2000;
    this._dead         = false;
    this._guard        = new BookGuard(VENUE, this, (sym) => this._fetchSnapshot(sym), { publishToBus, dataBreaker });
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(cfg.wsUrl);
      this._ws = ws;
      ws.once('open', () => { this.emit('connected'); resolve(); });
      ws.once('error', reject);
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => { this.emit('disconnected'); if (!this._dead) this._scheduleReconnect(); });
      ws.on('error', (err) => this.emit('error', err));
    });
  }

  async subscribe(venueSymbol) {
    this._subscriptions.add(venueSymbol);
    const channels = [`book.${venueSymbol}.100ms`, `ticker.${venueSymbol}.100ms`];
    await this._rpc('public/subscribe', { channels });
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    const channels = [`book.${venueSymbol}.100ms`, `ticker.${venueSymbol}.100ms`];
    await this._rpc('public/unsubscribe', { channels });
  }

  disconnect() {
    this._dead = true;
    this._guard.destroy();
    if (this._ws) this._ws.close();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this._reqId++;
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); } }, 10_000);
    });
  }

  _onMessage(raw) {
    const receivedTs = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    if (msg.method === 'subscription' && msg.params) {
      this._onNotification(msg.params.channel, msg.params.data, receivedTs);
    }
  }

  _onNotification(channel, data, receivedTs) {
    if (channel.startsWith('ticker.')) {
      this._handleTicker(channel, data, receivedTs);
    } else if (channel.startsWith('book.')) {
      this._handleBook(channel, data, receivedTs);
    } else if (channel.startsWith('user.changes.')) {
      this._handleUserChanges(data, receivedTs);
    } else if (channel.startsWith('user.portfolio.')) {
      this._handleUserPortfolio(data, receivedTs);
    }
  }

  _handleTicker(channel, data, receivedTs) {
    const venueSymbol    = channel.split('.')[1];
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol         = normalise(VENUE, venueSymbol, instrumentClass);

    this._guard.touch(venueSymbol);

    const bidPrice = data.best_bid_price ?? 0;
    const askPrice = data.best_ask_price ?? 0;
    const midPrice = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    const event = {
      venue: VENUE, instrumentClass, symbol, venueSymbol,
      exchangeTs: data.timestamp ?? receivedTs, receivedTs,
      sequenceId: null,
      bidPrice, bidSize: data.best_bid_amount ?? 0, bidOrderCount: 0,
      askPrice, askSize: data.best_ask_amount ?? 0, askOrderCount: 0,
      midPrice, spreadBps, feedType: FeedType.WEBSOCKET,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleBook(channel, data, receivedTs) {
    const venueSymbol     = channel.split('.')[1];
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);
    const isSnapshot      = data.type === 'snapshot';
    const sequenceId      = data.change_id ?? null;

    // Sequence gap check — skip publish if gap detected
    if (!this._guard.check(venueSymbol, sequenceId, isSnapshot)) return;

    const updateType = isSnapshot ? 'SNAPSHOT' : 'DELTA';

    const emit = (side, [price, size, orderCount], depth) => {
      const event = {
        venue: VENUE, symbol,
        exchangeTs: data.timestamp ?? receivedTs, receivedTs,
        sequenceId, updateId: null, side, price, size,
        orderCount: orderCount ?? 0, levelDepth: depth, updateType,
      };
      this.emit('l2', event);
      if (this.publishToBus) publish(Topics.L2_BOOK, event, symbol).catch(() => {});
    };

    (data.bids || []).forEach((level, i) => emit('BID', level, i));
    (data.asks || []).forEach((level, i) => emit('ASK', level, i));
  }

  async _fetchSnapshot(venueSymbol) {
    const url = `${cfg.restBase}/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(venueSymbol)}&depth=20`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const book = j.result;
    const receivedTs = Date.now();
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol = normalise(VENUE, venueSymbol, instrumentClass);
    const seqId  = book.change_id ?? null;

    // Reset sequence baseline with snapshot
    this._guard.check(venueSymbol, seqId, true);

    const emitLevel = (side, price, size, depth) => {
      const event = {
        venue: VENUE, symbol,
        exchangeTs: book.timestamp ?? receivedTs, receivedTs,
        sequenceId: seqId, updateId: null, side, price, size,
        orderCount: 0, levelDepth: depth, updateType: 'SNAPSHOT',
      };
      this.emit('l2', event);
      if (this.publishToBus) publish(Topics.L2_BOOK, event, symbol).catch(() => {});
    };

    (book.bids || []).forEach(([price, size], i) => emitLevel('BID', price, size, i));
    (book.asks || []).forEach(([price, size], i) => emitLevel('ASK', price, size, i));
  }

  // ── Standard order interface ───────────────────────────────────────────────

  static mapSymbol(canonical) {
    const MAP = { 'BTC-PERP':'BTC-PERPETUAL','ETH-PERP':'ETH-PERPETUAL','SOL-PERP':'SOL-PERPETUAL','XRP-PERP':'XRP-PERPETUAL','BNB-PERP':'BNB-PERPETUAL','DOGE-PERP':'DOGE_USDC-PERPETUAL','MATIC-PERP':'MATIC-PERPETUAL' };
    if (MAP[canonical]) return MAP[canonical];
    if (canonical.endsWith('-PERP')) return canonical.replace('-PERP', '-PERPETUAL');
    console.warn(`[deribit] Unmapped symbol: ${canonical}`);
    return canonical;
  }

  async submitOrder(order, creds) {
    const { orderResponse, OrderStatus, mapTIF, genClientOrderId, extractRejectReason } = require('./orderInterface');
    const base = creds?.testnet ? 'https://test.deribit.com/api/v2' : 'https://www.deribit.com/api/v2';
    const authR = await fetch(`${base}/public/auth?client_id=${encodeURIComponent(creds.fields.clientId)}&client_secret=${encodeURIComponent(creds.fields.clientSecret)}&grant_type=client_credentials`);
    const authJ = await authR.json();
    if (authJ.error) return orderResponse({ venueOrderId: null, clientOrderId: order.clientOrderId, status: OrderStatus.REJECTED, rejectReason: extractRejectReason('DERIBIT', authJ, authR.status) });
    const token = authJ.result.access_token;

    const venueSymbol = DeribitAdapter.mapSymbol(order.symbol);
    const method = order.side === 'BUY' ? 'private/buy' : 'private/sell';
    const tif = mapTIF('DERIBIT', order.timeInForce || 'IOC');
    const clientOid = order.clientOrderId || genClientOrderId('DRB');
    const qs = `instrument_name=${encodeURIComponent(venueSymbol)}&type=limit&price=${order.limitPrice}&amount=${order.quantity}&time_in_force=${tif}&label=${clientOid}`;
    const r = await fetch(`${base}/${method}?${qs}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const j = await r.json();
    if (j.error) return orderResponse({ venueOrderId: null, clientOrderId: clientOid, status: OrderStatus.REJECTED, rejectReason: extractRejectReason('DERIBIT', j, r.status) });
    const o = j.result?.order || {};
    const filled = o.filled_amount || 0;
    const avg = o.average_price || 0;
    const st = filled >= order.quantity ? OrderStatus.FILLED : filled > 0 ? OrderStatus.PARTIAL : OrderStatus.ACKNOWLEDGED;
    return orderResponse({ venueOrderId: o.order_id, clientOrderId: clientOid, status: st, filledQty: filled, avgFillPrice: avg });
  }

  async cancelOrder(venueOrderId, creds) {
    const { orderResponse, OrderStatus } = require('./orderInterface');
    const base = creds?.testnet ? 'https://test.deribit.com/api/v2' : 'https://www.deribit.com/api/v2';
    const authR = await fetch(`${base}/public/auth?client_id=${encodeURIComponent(creds.fields.clientId)}&client_secret=${encodeURIComponent(creds.fields.clientSecret)}&grant_type=client_credentials`);
    const authJ = await authR.json();
    if (authJ.error) throw new Error(authJ.error.message);
    const token = authJ.result.access_token;
    const r = await fetch(`${base}/private/cancel?order_id=${encodeURIComponent(venueOrderId)}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
  }

  async amendOrder(venueOrderId, changes, creds) {
    const { orderResponse, OrderStatus } = require('./orderInterface');
    const base = creds?.testnet ? 'https://test.deribit.com/api/v2' : 'https://www.deribit.com/api/v2';
    const authR = await fetch(`${base}/public/auth?client_id=${encodeURIComponent(creds.fields.clientId)}&client_secret=${encodeURIComponent(creds.fields.clientSecret)}&grant_type=client_credentials`);
    const authJ = await authR.json();
    if (authJ.error) throw new Error(authJ.error.message);
    const token = authJ.result.access_token;
    let qs = `order_id=${encodeURIComponent(venueOrderId)}`;
    if (changes.quantity) qs += `&amount=${changes.quantity}`;
    if (changes.price) qs += `&price=${changes.price}`;
    const r = await fetch(`${base}/private/edit?${qs}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const o = j.result?.order || {};
    return orderResponse({ venueOrderId: o.order_id || venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED, filledQty: o.filled_amount || 0, avgFillPrice: o.average_price || 0 });
  }

  async getOrderStatus(venueOrderId, creds) {
    const { orderResponse, OrderStatus } = require('./orderInterface');
    const base = creds?.testnet ? 'https://test.deribit.com/api/v2' : 'https://www.deribit.com/api/v2';
    const authR = await fetch(`${base}/public/auth?client_id=${encodeURIComponent(creds.fields.clientId)}&client_secret=${encodeURIComponent(creds.fields.clientSecret)}&grant_type=client_credentials`);
    const authJ = await authR.json();
    if (authJ.error) throw new Error(authJ.error.message);
    const token = authJ.result.access_token;
    const r = await fetch(`${base}/private/get_order_state?order_id=${encodeURIComponent(venueOrderId)}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const o = j.result || {};
    const stMap = { open: OrderStatus.ACKNOWLEDGED, filled: OrderStatus.FILLED, cancelled: OrderStatus.REJECTED };
    return orderResponse({ venueOrderId, clientOrderId: o.label || null, status: stMap[o.order_state] || OrderStatus.ACKNOWLEDGED, filledQty: o.filled_amount || 0, avgFillPrice: o.average_price || 0 });
  }

  // ── Private channel subscriptions ─────────────────────────────────────────

  async subscribePrivate(creds) {
    console.log('[deribit] subscribePrivate called, testnet:', creds.testnet, 'fields:', Object.keys(creds.fields || {}));
    if (!creds?.fields?.clientId) throw new Error('No clientId — available fields: ' + Object.keys(creds.fields || {}).join(', '));

    // If no public WS is connected, create a dedicated private WS
    let useOwnWs = false;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.log('[deribit] No public WS — creating dedicated private WS');
      const wsUrl = creds.testnet ? 'wss://test.deribit.com/ws/api/v2' : 'wss://www.deribit.com/ws/api/v2';
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => reject(new Error('Private WS connect timeout')), 10000);
        ws.once('open', () => { clearTimeout(timeout); this._ws = ws; useOwnWs = true; resolve(); });
        ws.once('error', (e) => { clearTimeout(timeout); reject(new Error('Private WS error: ' + e.message)); });
        ws.on('message', (data) => this._onMessage(data));
      });
    }

    await this._rpc('public/auth', { grant_type: 'client_credentials', client_id: creds.fields.clientId, client_secret: creds.fields.clientSecret });
    await this._rpc('private/subscribe', { channels: ['user.trades.any.any.raw', 'user.orders.any.any.raw', 'user.changes.any.any.raw', 'user.portfolio.btc', 'user.portfolio.eth', 'user.portfolio.usdc'] });
    this._privateAuth = true;
    console.log('[deribit] Private channels subscribed' + (useOwnWs ? ' (dedicated WS)' : ''));
    this._fetchInitialPositions().catch(e => console.error('[deribit] Initial positions failed:', e.message));
  }

  _handleUserChanges(data, receivedTs) {
    const { getBaseCurrency } = require('./orderInterface');
    // Positions
    if (Array.isArray(data.positions)) {
      for (const p of data.positions) {
        const instr = p.instrument_name;
        const baseCcy = getBaseCurrency('DERIBIT', instr);
        // Deribit's size_currency is a NUMBER = size expressed in base currency
        // Use it directly when available; otherwise fall back to p.size
        const rawSize = (typeof p.size_currency === 'number' && p.size_currency !== 0)
          ? p.size_currency : (p.size || 0);
        const unit = baseCcy;
        console.log('[deribit] WS position update:', {
          instrument: instr, apiSize: p.size, sizeCurrencyField: p.size_currency,
          usedSize: rawSize, direction: p.direction, baseCcy, kind: p.kind,
        });
        if (rawSize === 0 || p.direction === 'zero') {
          publish(Topics.POSITIONS, {
            venue: VENUE, symbol: instr, side: 'FLAT', size: 0, sizeUnit: unit,
            avgEntryPrice: 0, unrealisedPnl: 0, liquidationPrice: 0, markPrice: 0, timestamp: receivedTs,
          }, instr).catch(() => {});
          continue;
        }
        const side = p.direction === 'buy' ? 'LONG' : p.direction === 'sell' ? 'SHORT' : (rawSize > 0 ? 'LONG' : 'SHORT');
        publish(Topics.POSITIONS, {
          venue: VENUE, symbol: instr, side,
          size: Math.abs(rawSize), sizeUnit: unit,
          avgEntryPrice: p.average_price || 0,
          unrealisedPnl: p.floating_profit_loss || 0,
          liquidationPrice: p.estimated_liquidation_price || 0,
          markPrice: p.mark_price || 0, timestamp: receivedTs,
        }, instr).catch(() => {});
      }
    }
    // Fills
    if (Array.isArray(data.trades)) {
      for (const t of data.trades) {
        publish(Topics.FILLS, {
          fillId: t.trade_id, orderId: t.order_id, venue: VENUE, symbol: t.instrument_name,
          side: t.direction === 'buy' ? 'BUY' : 'SELL',
          fillPrice: t.price || 0, fillSize: t.amount || 0,
          fillTs: t.timestamp || receivedTs, receivedTs,
          commission: t.fee || 0, commissionAsset: t.fee_currency || '', slippageBps: 0, arrivalMid: 0,
        }, t.instrument_name).catch(() => {});
      }
    }
    // Orders
    if (Array.isArray(data.orders)) {
      for (const o of data.orders) {
        const stateMap = { open: 'OPEN', filled: 'FILLED', cancelled: 'CANCELLED', rejected: 'REJECTED', untriggered: 'PENDING' };
        publish(Topics.ORDERS, {
          venue: VENUE, orderId: o.order_id, symbol: o.instrument_name,
          side: o.direction === 'buy' ? 'BUY' : 'SELL', orderType: (o.order_type || '').toUpperCase(),
          quantity: o.amount || 0, filledQuantity: o.filled_amount || 0,
          remainingQuantity: (o.amount || 0) - (o.filled_amount || 0), limitPrice: o.price || 0,
          state: stateMap[o.order_state] || o.order_state, updatedTs: o.last_update_timestamp || receivedTs,
        }, o.instrument_name).catch(() => {});
      }
    }
  }

  _handleUserPortfolio(data, receivedTs) {
    if (!data || !data.currency) return;
    publish(Topics.BALANCES, {
      venue: VENUE, currency: data.currency.toUpperCase(),
      available: data.available_funds || 0, total: data.balance || 0,
      unrealisedPnl: data.futures_session_upl || 0, timestamp: receivedTs,
    }, data.currency).catch(() => {});
  }

  async _fetchInitialPositions() {
    let futureCount = 0, optionCount = 0;
    for (const kind of ['future', 'option']) {
      try {
        const result = await this._rpc('private/get_positions', { currency: 'any', kind });
        console.log(`[deribit] get_positions RAW ${kind} response:`, JSON.stringify(result).substring(0, 500));
        console.log(`[deribit] get_positions ${kind} count:`, Array.isArray(result) ? result.length : 'not array: ' + typeof result);
        if (!Array.isArray(result)) continue;
        const { getBaseCurrency } = require('./orderInterface');
        for (const p of result) {
          const baseCcy = getBaseCurrency('DERIBIT', p.instrument_name);
          // Deribit's size_currency is a NUMBER = size in base currency units
          const rawSize = (typeof p.size_currency === 'number' && p.size_currency !== 0)
            ? p.size_currency : (p.size || 0);
          console.log('[deribit] position raw:', {
            instrument: p.instrument_name, apiSize: p.size, sizeCurrencyField: p.size_currency,
            usedSize: rawSize, direction: p.direction, baseCcy, kind: p.kind,
          });
          if (rawSize === 0) { console.log(`[deribit] Skipping ${p.instrument_name} — size is 0`); continue; }
          const unit = baseCcy;
          const side = p.direction === 'buy' ? 'LONG' : p.direction === 'sell' ? 'SHORT' : (rawSize > 0 ? 'LONG' : 'SHORT');
          const pos = {
            venue: VENUE, symbol: p.instrument_name,
            side,
            size: Math.abs(rawSize), sizeUnit: unit,
            avgEntryPrice: p.average_price || 0,
            unrealisedPnl: p.floating_profit_loss || 0,
            liquidationPrice: p.estimated_liquidation_price || 0,
            markPrice: markPx,
            timestamp: Date.now(),
          };
          if (kind === 'future') futureCount++; else optionCount++;
          console.log(`[deribit] Publishing position: ${p.instrument_name} size=${pos.size} side=${pos.side}`);
          publish(Topics.POSITIONS, pos, p.instrument_name).catch(() => {});
        }
      } catch (e) { console.error(`[deribit] Position fetch (${kind}) failed:`, e.message); }
    }
    console.log(`[deribit] Initial positions fetched: ${futureCount} futures, ${optionCount} options`);
  }

  _scheduleReconnect() {
    setTimeout(async () => {
      try {
        await this.connect();
        for (const sym of this._subscriptions) await this.subscribe(sym);
      } catch (err) {
        this.emit('error', err);
        this._scheduleReconnect();
      }
    }, this._reconnectMs);
  }
}

module.exports = { DeribitAdapter };
