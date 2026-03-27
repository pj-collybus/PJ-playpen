/**
 * Bybit adapter — WebSocket market data feed (spot & linear perp).
 *
 * Sequence tracking: seq field on orderbook messages.
 * Gap recovery: REST GET /v5/market/orderbook?category={cat}&symbol={sym}&limit=50.
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const { BookGuard }    = require('./bookGuard');

const VENUE = 'BYBIT';
const WS_URLS = { spot: 'wss://stream.bybit.com/v5/public/spot', linear: 'wss://stream.bybit.com/v5/public/linear' };

class BybitAdapter extends EventEmitter {
  constructor({ publishToBus = true, category = 'spot', dataBreaker = null } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this.category       = category;
    this._ws            = null;
    this._subscriptions = new Set();
    this._dead          = false;
    this._reconnectMs   = 2000;
    this._pingTimer     = null;
    this._guard         = new BookGuard(VENUE, this, (sym) => this._fetchSnapshot(sym), { publishToBus, dataBreaker });
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URLS[this.category] || WS_URLS.spot);
      this._ws = ws;
      ws.once('open', () => { this._startPing(); this.emit('connected'); resolve(); });
      ws.once('error', reject);
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => { this._stopPing(); this.emit('disconnected'); if (!this._dead) setTimeout(() => this.connect().then(() => this._resubscribe()).catch(() => {}), this._reconnectMs); });
      ws.on('error', (err) => this.emit('error', err));
    });
  }

  async subscribe(venueSymbol, category) {
    if (category) this.category = category;
    this._subscriptions.add(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ op: 'subscribe', args: [`orderbook.1.${venueSymbol}`, `publicTrade.${venueSymbol}`] }));
    }
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ op: 'unsubscribe', args: [`orderbook.1.${venueSymbol}`, `publicTrade.${venueSymbol}`] }));
    }
  }

  disconnect() { this._dead = true; this._stopPing(); this._guard.destroy(); if (this._ws) this._ws.close(); }

  _startPing() { this._pingTimer = setInterval(() => { if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify({ op: 'ping' })); }, 20_000); }
  _stopPing()  { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
  async _resubscribe() { for (const sym of this._subscriptions) await this.subscribe(sym); }

  _onMessage(raw) {
    const receivedTs = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.op === 'pong' || msg.op === 'subscribe') return;

    const topic = msg.topic || '';
    if (topic.startsWith('orderbook.')) this._handleOrderbook(msg, receivedTs);
    else if (topic.startsWith('publicTrade.')) this._handleTrades(msg, receivedTs);
  }

  _handleOrderbook(msg, receivedTs) {
    const data        = msg.data || {};
    const venueSymbol = data.s || '';
    const seqId       = data.seq ?? null;
    const isSnapshot  = msg.type === 'snapshot';

    // Sequence gap check
    if (!this._guard.check(venueSymbol, seqId, isSnapshot)) return;

    const instrumentClass = this.category === 'linear' ? InstrumentClass.CRYPTO_PERP : InstrumentClass.CRYPTO_SPOT;
    const symbol  = normalise(VENUE, venueSymbol, instrumentClass);
    const bids    = data.b || [];
    const asks    = data.a || [];
    const bidPrice = parseFloat(bids[0]?.[0]) || 0;
    const bidSize  = parseFloat(bids[0]?.[1]) || 0;
    const askPrice = parseFloat(asks[0]?.[0]) || 0;
    const askSize  = parseFloat(asks[0]?.[1]) || 0;
    const midPrice = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    const event = {
      venue: VENUE, instrumentClass, symbol, venueSymbol,
      exchangeTs: data.ts ?? receivedTs, receivedTs, sequenceId: seqId,
      bidPrice, bidSize, bidOrderCount: 0, askPrice, askSize, askOrderCount: 0,
      midPrice, spreadBps, feedType: FeedType.WEBSOCKET,
    };
    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleTrades(msg, receivedTs) {
    const trades = Array.isArray(msg.data) ? msg.data : [];
    for (const t of trades) {
      const venueSymbol = t.s || '';
      this._guard.touch(venueSymbol);
      const instrumentClass = this.category === 'linear' ? InstrumentClass.CRYPTO_PERP : InstrumentClass.CRYPTO_SPOT;
      const symbol = normalise(VENUE, venueSymbol, instrumentClass);
      const price = parseFloat(t.p) || 0;
      const size  = parseFloat(t.v) || 0;
      const event = {
        venue: VENUE, symbol, exchangeTs: t.T ?? receivedTs, receivedTs,
        tradeId: String(t.i), price, size,
        side: t.S === 'Buy' ? 'BUY' : 'SELL', isLiquidation: !!t.L, isBlockTrade: false, notionalUsd: price * size,
      };
      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }

  async _fetchSnapshot(venueSymbol) {
    const cat = this.category === 'linear' ? 'linear' : 'spot';
    const url = `https://api.bybit.com/v5/market/orderbook?category=${cat}&symbol=${encodeURIComponent(venueSymbol)}&limit=50`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit snapshot error ${j.retCode}`);
    const seq = j.result?.seq ?? null;
    this._guard.check(venueSymbol, seq, true);
  }
  // ── Standard order interface ───────────────────────────────────────────────

  static mapSymbol(canonical) {
    // Already in venue format (e.g. XRPUSDT) — pass through
    if (/^[A-Z]+USDT$/.test(canonical)) return canonical;
    const MAP = { 'BTC-PERP':'BTCUSDT','ETH-PERP':'ETHUSDT','SOL-PERP':'SOLUSDT','XRP-PERP':'XRPUSDT','BNB-PERP':'BNBUSDT','DOGE-PERP':'DOGEUSDT','BTC-USDT':'BTCUSDT','ETH-USDT':'ETHUSDT' };
    if (MAP[canonical]) return MAP[canonical];
    const m = canonical.match(/^(\w+)-(PERP|USDT)$/);
    if (m) return m[1] + 'USDT';
    console.warn(`[bybit] Unmapped symbol: ${canonical}`);
    return canonical.replace(/-/g, '');
  }

  async submitOrder(order, creds) {
    const { orderResponse, OrderStatus, mapTIF, hmacSha256Hex, genClientOrderId, extractRejectReason } = require('./orderInterface');
    const base = creds?.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const sym = BybitAdapter.mapSymbol(order.symbol);
    const cid = order.clientOrderId || genClientOrderId('BY');
    const tif = mapTIF('BYBIT', order.timeInForce || 'IOC');
    const ts  = String(Date.now()), recv = '5000';
    const body = JSON.stringify({ category: 'linear', symbol: sym, side: order.side === 'BUY' ? 'Buy' : 'Sell', orderType: 'Limit', qty: String(order.quantity), price: String(order.limitPrice), timeInForce: tif, orderLinkId: cid });
    const sig = hmacSha256Hex(creds.fields.secretKey, ts + creds.fields.apiKey + recv + body);
    const r = await fetch(`${base}/v5/order/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': creds.fields.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv }, body });
    const j = await r.json();
    if (j.retCode !== 0) {
      console.debug('[DEBUG] BYBIT rejection raw:', r.status, JSON.stringify(j));
      const reason = extractRejectReason('BYBIT', j, r.status);
      console.debug('[DEBUG] BYBIT extracted reason:', reason);
      return orderResponse({ venueOrderId: null, clientOrderId: cid, status: OrderStatus.REJECTED, rejectReason: reason });
    }
    return orderResponse({ venueOrderId: j.result?.orderId, clientOrderId: j.result?.orderLinkId || cid, status: OrderStatus.ACKNOWLEDGED });
  }

  async cancelOrder(venueOrderId, creds) {
    const { orderResponse, OrderStatus, hmacSha256Hex } = require('./orderInterface');
    const base = creds?.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const ts = String(Date.now()), recv = '5000';
    const body = JSON.stringify({ category: 'linear', orderId: venueOrderId });
    const sig = hmacSha256Hex(creds.fields.secretKey, ts + creds.fields.apiKey + recv + body);
    const r = await fetch(`${base}/v5/order/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': creds.fields.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv }, body });
    const j = await r.json();
    if (j.retCode !== 0) throw new Error(j.retMsg || `Error ${j.retCode}`);
    return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
  }

  async amendOrder(venueOrderId, changes, creds) {
    const { orderResponse, OrderStatus, hmacSha256Hex } = require('./orderInterface');
    const base = creds?.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const ts = String(Date.now()), recv = '5000';
    const patch = { category: 'linear', orderId: venueOrderId };
    if (changes.quantity) patch.qty = String(changes.quantity);
    if (changes.price)    patch.price = String(changes.price);
    const body = JSON.stringify(patch);
    const sig = hmacSha256Hex(creds.fields.secretKey, ts + creds.fields.apiKey + recv + body);
    const r = await fetch(`${base}/v5/order/amend`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': creds.fields.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv }, body });
    const j = await r.json();
    if (j.retCode !== 0) throw new Error(j.retMsg || `Error ${j.retCode}`);
    return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
  }

  async getOrderStatus(venueOrderId, creds) {
    const { orderResponse, OrderStatus, hmacSha256Hex } = require('./orderInterface');
    const base = creds?.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const ts = String(Date.now()), recv = '5000';
    const qs = `category=linear&orderId=${venueOrderId}`;
    const sig = hmacSha256Hex(creds.fields.secretKey, ts + creds.fields.apiKey + recv + qs);
    const r = await fetch(`${base}/v5/order/realtime?${qs}`, { headers: { 'X-BAPI-API-KEY': creds.fields.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv } });
    const j = await r.json();
    if (j.retCode !== 0) throw new Error(j.retMsg || `Error ${j.retCode}`);
    const o = j.result?.list?.[0] || {};
    const stMap = { New: OrderStatus.ACKNOWLEDGED, Filled: OrderStatus.FILLED, PartiallyFilled: OrderStatus.PARTIAL, Cancelled: OrderStatus.REJECTED };
    return orderResponse({ venueOrderId, clientOrderId: o.orderLinkId, status: stMap[o.orderStatus] || OrderStatus.ACKNOWLEDGED, filledQty: parseFloat(o.cumExecQty) || 0, avgFillPrice: parseFloat(o.avgPrice) || 0 });
  }

  // ── Private channel subscriptions ─────────────────────────────────────────

  subscribePrivate(creds) {
    console.log('[bybit] subscribePrivate called, testnet:', creds.testnet, 'fields:', Object.keys(creds.fields || {}));
    if (!creds?.fields?.apiKey) return Promise.reject(new Error('No API key — available fields: ' + Object.keys(creds.fields || {}).join(', ')));
    const { hmacSha256Hex } = require('./orderInterface');
    const wsUrl = creds.testnet ? 'wss://stream-testnet.bybit.com/v5/private' : 'wss://stream.bybit.com/v5/private';

    return new Promise((resolve, reject) => {
      const pws = new WebSocket(wsUrl);
      this._privateWs = pws;
      const timeout = setTimeout(() => reject(new Error('WS auth timeout')), 10000);

      pws.onopen = () => {
        const expires = Date.now() + 10000;
        const sig = hmacSha256Hex(creds.fields.secretKey, 'GET/realtime' + expires);
        pws.send(JSON.stringify({ op: 'auth', args: [creds.fields.apiKey, expires, sig] }));
      };

      pws.onmessage = (raw) => {
        let msg; try { msg = JSON.parse(raw.data || raw); } catch { return; }
        if (msg.op === 'auth') {
          clearTimeout(timeout);
          if (msg.success) {
            pws.send(JSON.stringify({ op: 'subscribe', args: ['order', 'execution', 'position', 'wallet'] }));
            console.log('[bybit] Private channels subscribed');
            this._fetchInitialPositions(creds).catch(e => console.error('[bybit] Initial positions failed:', e.message));
            // Keepalive ping every 20s (Bybit disconnects after 30s idle)
            this._privatePing = setInterval(() => {
              if (pws.readyState === WebSocket.OPEN) pws.send(JSON.stringify({ op: 'ping' }));
            }, 20000);
            resolve();
          } else {
            const reason = msg.ret_msg || msg.retMsg || 'Auth failed';
            console.error('[bybit] Private WS auth failed:', reason);
            reject(new Error(reason));
          }
          return;
        }
        if (msg.op === 'pong' || msg.op === 'subscribe') return; // heartbeat/ack
        if (msg.topic) {
          console.log('[bybit] private WS message topic:', msg.topic, 'type:', msg.type, 'count:', Array.isArray(msg.data) ? msg.data.length : 1);
        }
        if (msg.topic === 'order' && msg.data) this._handlePrivateOrders(msg.data);
        if (msg.topic === 'execution' && msg.data) this._handlePrivateFills(msg.data);
        if (msg.topic === 'position' && msg.data) this._handlePrivatePositions(msg.data);
        if (msg.topic === 'wallet' && msg.data) this._handlePrivateBalances(msg.data);
      };

      pws.onclose = () => {
        console.log('[bybit] Private WS closed — reconnecting in 3s');
        this._privateWs = null;
        if (this._privatePing) { clearInterval(this._privatePing); this._privatePing = null; }
        setTimeout(() => {
          console.log('[bybit] Attempting private WS reconnect');
          this.subscribePrivate(creds).catch(e => console.error('[bybit] Reconnect failed:', e.message));
        }, 3000);
      };
      pws.onerror = (err) => { clearTimeout(timeout); reject(new Error('WS connection error')); };
    });
  }

  async _fetchInitialPositions(creds) {
    const { hmacSha256Hex } = require('./orderInterface');
    const base = creds.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const ts = String(Date.now()), recv = '5000';
    const qs = 'category=linear&settleCoin=USDT';
    const sig = hmacSha256Hex(creds.fields.secretKey, ts + creds.fields.apiKey + recv + qs);
    const r = await fetch(`${base}/v5/position/list?${qs}`, { headers: { 'X-BAPI-API-KEY': creds.fields.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv } });
    const j = await r.json();
    if (j.retCode !== 0) { console.error('[bybit] Position fetch error:', j.retMsg); return; }
    for (const p of (j.result?.list || [])) {
      const size = parseFloat(p.size) || 0;
      if (size === 0) continue;
      const unit = p.symbol.replace(/USDT$|USD$|PERP$/i, '');
      const pos = {
        venue: VENUE, symbol: p.symbol,
        side: p.side === 'Buy' ? 'LONG' : 'SHORT',
        size, sizeUnit: unit,
        avgEntryPrice: parseFloat(p.avgPrice) || 0,
        markPrice: parseFloat(p.markPrice) || 0,
        unrealisedPnl: parseFloat(p.unrealisedPnl) || 0,
        liquidationPrice: parseFloat(p.liqPrice) || 0,
        timestamp: Date.now(),
      };
      console.log('[bybit] Initial position:', p.symbol, pos.side, pos.size, pos.sizeUnit, 'mark:', pos.markPrice);
      publish(Topics.POSITIONS, pos, p.symbol).catch(() => {});
    }
  }

  _handlePrivateOrders(data) {
    for (const o of data) {
      const order = {
        venue: VENUE, orderId: o.orderId, symbol: o.symbol, side: o.side === 'Buy' ? 'BUY' : 'SELL',
        orderType: (o.orderType || '').toUpperCase(), quantity: parseFloat(o.qty) || 0,
        filledQuantity: parseFloat(o.cumExecQty) || 0,
        remainingQuantity: parseFloat(o.leavesQty) || 0,
        limitPrice: parseFloat(o.price) || 0,
        state: { New:'OPEN', Filled:'FILLED', PartiallyFilled:'PARTIAL', Cancelled:'CANCELLED', Rejected:'REJECTED' }[o.orderStatus] || o.orderStatus,
        updatedTs: parseInt(o.updatedTime) || Date.now(), createdTs: parseInt(o.createdTime) || Date.now(),
      };
      publish(Topics.ORDERS, order, order.symbol).catch(() => {});
    }
  }

  _handlePrivateFills(data) {
    for (const f of data) {
      const fill = {
        fillId: f.execId, orderId: f.orderId, venue: VENUE, symbol: f.symbol,
        side: f.side === 'Buy' ? 'BUY' : 'SELL',
        fillPrice: parseFloat(f.execPrice) || 0, fillSize: parseFloat(f.execQty) || 0,
        fillTs: parseInt(f.execTime) || Date.now(), receivedTs: Date.now(),
        commission: parseFloat(f.execFee) || 0, commissionAsset: f.feeCurrency || '',
        slippageBps: 0, arrivalMid: 0,
      };
      publish(Topics.FILLS, fill, fill.symbol).catch(() => {});
    }
  }

  _handlePrivatePositions(data) {
    for (const p of data) {
      const size = parseFloat(p.size) || 0;
      const unit = (p.symbol || '').replace(/USDT$|USD$|PERP$/i, '');
      const pos = {
        venue: VENUE, symbol: p.symbol,
        side: p.side === 'Buy' ? 'LONG' : p.side === 'Sell' ? 'SHORT' : 'FLAT',
        size, sizeUnit: unit, avgEntryPrice: parseFloat(p.avgPrice) || 0,
        markPrice: parseFloat(p.markPrice) || 0,
        unrealisedPnl: parseFloat(p.unrealisedPnl) || 0,
        liquidationPrice: parseFloat(p.liqPrice) || 0, timestamp: Date.now(),
      };
      publish(Topics.POSITIONS, pos, pos.symbol).catch(() => {});
    }
  }

  _handlePrivateBalances(data) {
    for (const w of data) {
      for (const c of (w.coin || [])) {
        const bal = {
          venue: VENUE, currency: c.coin,
          available: parseFloat(c.availableToWithdraw) || 0,
          total: parseFloat(c.walletBalance) || 0,
          unrealisedPnl: parseFloat(c.unrealisedPnl) || 0, timestamp: Date.now(),
        };
        publish(Topics.BALANCES, bal, bal.currency).catch(() => {});
      }
    }
  }
}

module.exports = { BybitAdapter };
