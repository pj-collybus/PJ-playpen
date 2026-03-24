/**
 * OKX adapter — WebSocket market data feed.
 *
 * Sequence tracking: seqId on books channel (in arg).
 * Gap recovery: REST GET /api/v5/market/books?instId={sym}&sz=50.
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const { BookGuard }    = require('./bookGuard');

const VENUE  = 'OKX';
const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';

function detectInstrumentClass(venueSymbol) {
  if (venueSymbol.endsWith('-SWAP')) return InstrumentClass.CRYPTO_PERP;
  if (/\d{6}$/.test(venueSymbol))   return InstrumentClass.CRYPTO_FUTURE;
  return InstrumentClass.CRYPTO_SPOT;
}

class OKXAdapter extends EventEmitter {
  constructor({ publishToBus = true, dataBreaker = null } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this._ws            = null;
    this._subscriptions = new Set();
    this._dead          = false;
    this._reconnectMs   = 2000;
    this._pingTimer     = null;
    this._guard         = new BookGuard(VENUE, this, (sym) => this._fetchSnapshot(sym), { publishToBus, dataBreaker });
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      this._ws = ws;
      ws.once('open', () => { this._startPing(); this.emit('connected'); resolve(); });
      ws.once('error', reject);
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => { this._stopPing(); this.emit('disconnected'); if (!this._dead) setTimeout(() => this.connect().then(() => this._resubscribe()).catch(() => {}), this._reconnectMs); });
      ws.on('error', (err) => this.emit('error', err));
    });
  }

  async subscribe(venueSymbol) {
    this._subscriptions.add(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: venueSymbol }, { channel: 'trades', instId: venueSymbol }] }));
    }
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ op: 'unsubscribe', args: [{ channel: 'tickers', instId: venueSymbol }, { channel: 'trades', instId: venueSymbol }] }));
    }
  }

  disconnect() { this._dead = true; this._stopPing(); this._guard.destroy(); if (this._ws) this._ws.close(); }

  _startPing() { this._pingTimer = setInterval(() => { if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send('ping'); }, 25_000); }
  _stopPing()  { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
  async _resubscribe() { for (const sym of this._subscriptions) await this.subscribe(sym); }

  _onMessage(raw) {
    const receivedTs = Date.now();
    const str = raw.toString();
    if (str === 'pong') return;

    let msg;
    try { msg = JSON.parse(str); } catch { return; }
    if (msg.event) return;

    const channel = msg.arg?.channel;
    if (channel === 'tickers' && msg.data?.length) {
      this._handleTicker(msg.arg, msg.data[0], receivedTs);
    } else if (channel === 'books5' && msg.data?.length) {
      this._handleBook(msg.arg, msg.data[0], receivedTs, msg.action);
    } else if (channel === 'trades' && msg.data?.length) {
      this._handleTrades(msg.arg, msg.data, receivedTs);
    }
  }

  _handleTicker(arg, data, receivedTs) {
    const venueSymbol     = arg.instId;
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);

    this._guard.touch(venueSymbol);

    const bidPrice  = parseFloat(data.bidPx) || 0;
    const askPrice  = parseFloat(data.askPx) || 0;
    const midPrice  = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    const event = {
      venue: VENUE, instrumentClass, symbol, venueSymbol,
      exchangeTs: parseInt(data.ts) || receivedTs, receivedTs, sequenceId: null,
      bidPrice, bidSize: parseFloat(data.bidSz) || 0, bidOrderCount: 0,
      askPrice, askSize: parseFloat(data.askSz) || 0, askOrderCount: 0,
      midPrice, spreadBps, feedType: FeedType.WEBSOCKET,
    };
    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleBook(arg, data, receivedTs, action) {
    const venueSymbol     = arg.instId;
    const seqId           = data.seqId ? parseInt(data.seqId) : null;
    const isSnapshot      = action === 'snapshot';

    if (!this._guard.check(venueSymbol, seqId, isSnapshot)) return;

    // Book data processing would go here (OKX books5 channel)
    // Currently the adapter subscribes to tickers, not books, so this is a placeholder
  }

  _handleTrades(arg, trades, receivedTs) {
    const venueSymbol     = arg.instId;
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);

    this._guard.touch(venueSymbol);

    for (const t of trades) {
      const price = parseFloat(t.px) || 0;
      const size  = parseFloat(t.sz) || 0;
      const event = {
        venue: VENUE, symbol,
        exchangeTs: parseInt(t.ts) || receivedTs, receivedTs,
        tradeId: String(t.tradeId), price, size,
        side: t.side === 'buy' ? 'BUY' : 'SELL',
        isLiquidation: false, isBlockTrade: false, notionalUsd: price * size,
      };
      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }

  async _fetchSnapshot(venueSymbol) {
    const url = `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(venueSymbol)}&sz=50`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.code !== '0') throw new Error(j.msg || `OKX snapshot error ${j.code}`);
    const seqId = j.data?.[0]?.seqId ? parseInt(j.data[0].seqId) : null;
    this._guard.check(venueSymbol, seqId, true);
  }
}

// ── Standard order interface ─────────────────────────────────────────────────

OKXAdapter.mapSymbol = function(canonical) {
  const MAP = { 'BTC-PERP':'BTC-USDT-SWAP','ETH-PERP':'ETH-USDT-SWAP','SOL-PERP':'SOL-USDT-SWAP','XRP-PERP':'XRP-USDT-SWAP','BTC-USDT':'BTC-USDT','ETH-USDT':'ETH-USDT','SOL-USDT':'SOL-USDT' };
  if (MAP[canonical]) return MAP[canonical];
  const m = canonical.match(/^(\w+)-PERP$/);
  if (m) return `${m[1]}-USDT-SWAP`;
  console.warn(`[okx] Unmapped symbol: ${canonical}`);
  return canonical;
};

OKXAdapter.prototype.submitOrder = async function(order, creds) {
  const { orderResponse, OrderStatus, mapTIF, hmacSha256Base64, genClientOrderId, extractRejectReason } = require('./orderInterface');
  const base = 'https://www.okx.com';
  const sym = OKXAdapter.mapSymbol(order.symbol);
  const cid = order.clientOrderId || genClientOrderId('OKX');
  const tif = mapTIF('OKX', order.timeInForce || 'IOC');
  const path = '/api/v5/trade/order';
  const ts = new Date().toISOString();
  const bodyObj = { instId: sym, tdMode: 'cross', side: order.side.toLowerCase(), ordType: 'limit', px: String(order.limitPrice), sz: String(order.quantity), clOrdId: cid, tgtCcy: '', tag: '' };
  const bodyStr = JSON.stringify(bodyObj);
  const sign = hmacSha256Base64(creds.fields.secretKey, ts + 'POST' + path + bodyStr);
  const headers = { 'OK-ACCESS-KEY': creds.fields.apiKey, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': creds.fields.passphrase, 'Content-Type': 'application/json' };
  if (creds.testnet) headers['x-simulated-trading'] = '1';
  const r = await fetch(`${base}${path}`, { method: 'POST', headers, body: bodyStr });
  const j = await r.json();
  if (j.code !== '0') return orderResponse({ venueOrderId: null, clientOrderId: cid, status: OrderStatus.REJECTED, rejectReason: extractRejectReason('OKX', j, r.status) });
  return orderResponse({ venueOrderId: j.data?.[0]?.ordId, clientOrderId: j.data?.[0]?.clOrdId || cid, status: OrderStatus.ACKNOWLEDGED });
};

OKXAdapter.prototype.cancelOrder = async function(venueOrderId, creds) {
  const { orderResponse, OrderStatus, hmacSha256Base64 } = require('./orderInterface');
  const path = '/api/v5/trade/cancel-order';
  const ts = new Date().toISOString();
  const bodyStr = JSON.stringify({ ordId: venueOrderId, instId: '' });
  const sign = hmacSha256Base64(creds.fields.secretKey, ts + 'POST' + path + bodyStr);
  const headers = { 'OK-ACCESS-KEY': creds.fields.apiKey, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': creds.fields.passphrase, 'Content-Type': 'application/json' };
  if (creds.testnet) headers['x-simulated-trading'] = '1';
  const r = await fetch(`https://www.okx.com${path}`, { method: 'POST', headers, body: bodyStr });
  const j = await r.json();
  if (j.code !== '0') throw new Error(j.data?.[0]?.sMsg || j.msg);
  return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
};

OKXAdapter.prototype.amendOrder = async function(venueOrderId, changes, creds) {
  const { orderResponse, OrderStatus, hmacSha256Base64 } = require('./orderInterface');
  const path = '/api/v5/trade/amend-order';
  const ts = new Date().toISOString();
  const patch = { ordId: venueOrderId, instId: '' };
  if (changes.quantity) patch.newSz = String(changes.quantity);
  if (changes.price)    patch.newPx = String(changes.price);
  const bodyStr = JSON.stringify(patch);
  const sign = hmacSha256Base64(creds.fields.secretKey, ts + 'POST' + path + bodyStr);
  const headers = { 'OK-ACCESS-KEY': creds.fields.apiKey, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': creds.fields.passphrase, 'Content-Type': 'application/json' };
  if (creds.testnet) headers['x-simulated-trading'] = '1';
  const r = await fetch(`https://www.okx.com${path}`, { method: 'POST', headers, body: bodyStr });
  const j = await r.json();
  if (j.code !== '0') throw new Error(j.data?.[0]?.sMsg || j.msg);
  return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
};

OKXAdapter.prototype.getOrderStatus = async function(venueOrderId, creds) {
  const { orderResponse, OrderStatus, hmacSha256Base64 } = require('./orderInterface');
  const path = `/api/v5/trade/order?ordId=${venueOrderId}&instId=`;
  const ts = new Date().toISOString();
  const sign = hmacSha256Base64(creds.fields.secretKey, ts + 'GET' + path);
  const headers = { 'OK-ACCESS-KEY': creds.fields.apiKey, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': creds.fields.passphrase };
  if (creds.testnet) headers['x-simulated-trading'] = '1';
  const r = await fetch(`https://www.okx.com${path}`, { headers });
  const j = await r.json();
  if (j.code !== '0') throw new Error(j.data?.[0]?.sMsg || j.msg);
  const o = j.data?.[0] || {};
  const stMap = { live: OrderStatus.ACKNOWLEDGED, partially_filled: OrderStatus.PARTIAL, filled: OrderStatus.FILLED, canceled: OrderStatus.REJECTED };
  return orderResponse({ venueOrderId, clientOrderId: o.clOrdId, status: stMap[o.state] || OrderStatus.ACKNOWLEDGED, filledQty: parseFloat(o.accFillSz) || 0, avgFillPrice: parseFloat(o.avgPx) || 0 });
};

OKXAdapter.prototype.subscribePrivate = function(creds) {
  if (!creds?.fields?.apiKey) return Promise.reject(new Error('No API key'));
  console.log('[okx] subscribePrivate called, testnet:', creds.testnet);
  const { hmacSha256Base64 } = require('./orderInterface');

  return new Promise((resolve, reject) => {
    const pws = new WebSocket('wss://ws.okx.com:8443/ws/v5/private');
    this._privateWs = pws;
    const timeout = setTimeout(() => reject(new Error('WS auth timeout')), 10000);

    pws.onopen = () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const sign = hmacSha256Base64(creds.fields.secretKey, ts + 'GET' + '/users/self/verify');
      pws.send(JSON.stringify({ op: 'login', args: [{ apiKey: creds.fields.apiKey, passphrase: creds.fields.passphrase, timestamp: ts, sign }] }));
    };

    pws.onmessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.data || raw); } catch { return; }
      if (msg.event === 'login') {
        clearTimeout(timeout);
        if (msg.code === '0') {
          pws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'orders', instType: 'ANY' }, { channel: 'positions', instType: 'ANY' }, { channel: 'account' }] }));
          console.log('[okx] Private channels subscribed');
          resolve();
        } else {
          reject(new Error(msg.msg || 'Login failed'));
        }
        return;
      }
    const ch = msg.arg?.channel;
    if (ch === 'orders' && msg.data) {
      for (const o of msg.data) {
        publish(Topics.ORDERS, {
          venue: 'OKX', orderId: o.ordId, symbol: o.instId, side: o.side === 'buy' ? 'BUY' : 'SELL',
          orderType: o.ordType, quantity: parseFloat(o.sz) || 0,
          filledQuantity: parseFloat(o.accFillSz) || 0,
          remainingQuantity: (parseFloat(o.sz) || 0) - (parseFloat(o.accFillSz) || 0),
          limitPrice: parseFloat(o.px) || 0,
          state: { live:'OPEN', partially_filled:'PARTIAL', filled:'FILLED', canceled:'CANCELLED' }[o.state] || o.state,
          updatedTs: parseInt(o.uTime) || Date.now(),
        }, o.instId).catch(() => {});
        if (o.fillPx && parseFloat(o.fillSz) > 0) {
          publish(Topics.FILLS, {
            fillId: o.tradeId || o.ordId + '-' + Date.now(), orderId: o.ordId, venue: 'OKX', symbol: o.instId,
            side: o.side === 'buy' ? 'BUY' : 'SELL', fillPrice: parseFloat(o.fillPx) || 0,
            fillSize: parseFloat(o.fillSz) || 0, fillTs: parseInt(o.fillTime) || Date.now(),
            receivedTs: Date.now(), commission: parseFloat(o.fee) || 0, commissionAsset: o.feeCcy || '',
            slippageBps: 0, arrivalMid: 0,
          }, o.instId).catch(() => {});
        }
      }
    }
    if (ch === 'positions' && msg.data) {
      for (const p of msg.data) {
        const qty = parseFloat(p.pos) || 0;
        publish(Topics.POSITIONS, {
          venue: 'OKX', symbol: p.instId,
          side: qty > 0 ? 'LONG' : qty < 0 ? 'SHORT' : 'FLAT',
          size: Math.abs(qty), avgEntryPrice: parseFloat(p.avgPx) || 0,
          unrealisedPnl: parseFloat(p.upl) || 0, liquidationPrice: parseFloat(p.liqPx) || 0,
          timestamp: parseInt(p.uTime) || Date.now(),
        }, p.instId).catch(() => {});
      }
    }
    if (ch === 'account' && msg.data) {
      for (const a of msg.data) {
        for (const d of (a.details || [])) {
          publish(Topics.BALANCES, {
            venue: 'OKX', currency: d.ccy,
            available: parseFloat(d.availBal) || 0, total: parseFloat(d.cashBal) || 0,
            unrealisedPnl: parseFloat(d.upl) || 0, timestamp: parseInt(a.uTime) || Date.now(),
          }, d.ccy).catch(() => {});
        }
      }
    }
  };

    pws.onclose = () => { this._privateWs = null; };
    pws.onerror = () => { clearTimeout(timeout); reject(new Error('WS connection error')); };
  });
};

module.exports = { OKXAdapter };
