/**
 * Binance adapter — WebSocket market data feed (spot).
 *
 * Sequence tracking: u (final update ID) on bookTicker — gap if u > lastU + 1.
 * Gap recovery: REST GET /api/v3/depth?symbol={symbol}&limit=50.
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const { BookGuard }    = require('./bookGuard');

const VENUE   = 'BINANCE';
const WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';

class BinanceAdapter extends EventEmitter {
  constructor({ publishToBus = true, dataBreaker = null } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this._ws            = null;
    this._subscriptions = new Set();
    this._dead          = false;
    this._reconnectMs   = 2000;
    this._guard         = new BookGuard(VENUE, this, (sym) => this._fetchSnapshot(sym), { publishToBus, dataBreaker });
  }

  async connect() {
    const streams = this._buildStreams();
    const url     = WS_BASE + (streams.length ? streams.join('/') : 'btcusdt@bookTicker');
    return this._open(url);
  }

  async subscribe(venueSymbol) {
    const sym = venueSymbol.toLowerCase();
    this._subscriptions.add(sym);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${sym}@bookTicker`, `${sym}@trade`], id: Date.now() }));
    }
  }

  async unsubscribe(venueSymbol) {
    const sym = venueSymbol.toLowerCase();
    this._subscriptions.delete(sym);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [`${sym}@bookTicker`, `${sym}@trade`], id: Date.now() }));
    }
  }

  disconnect() {
    this._dead = true;
    this._guard.destroy();
    if (this._ws) this._ws.close();
  }

  _buildStreams() {
    const out = [];
    for (const sym of this._subscriptions) { out.push(`${sym}@bookTicker`, `${sym}@trade`); }
    return out;
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this._ws = ws;
      ws.once('open', () => { this.emit('connected'); resolve(); });
      ws.once('error', reject);
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => { this.emit('disconnected'); if (!this._dead) setTimeout(() => this.connect().catch(() => {}), this._reconnectMs); });
      ws.on('error', (err) => this.emit('error', err));
    });
  }

  _onMessage(raw) {
    const receivedTs = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const stream = msg.stream || '';
    const data   = msg.data || msg;

    if (stream.endsWith('@bookTicker') || data.b !== undefined) {
      this._handleBookTicker(data, receivedTs);
    } else if (stream.endsWith('@trade') || data.e === 'trade') {
      this._handleTrade(data, receivedTs);
    }
  }

  _handleBookTicker(data, receivedTs) {
    const venueSymbol     = (data.s || '').toUpperCase();
    const instrumentClass = InstrumentClass.CRYPTO_SPOT;
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);

    // Sequence check on update ID
    const seqId = data.u ?? null;
    if (seqId !== null && !this._guard.check(venueSymbol, seqId)) return;
    this._guard.touch(venueSymbol);

    const bidPrice  = parseFloat(data.b) || 0;
    const askPrice  = parseFloat(data.a) || 0;
    const midPrice  = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    const event = {
      venue: VENUE, instrumentClass, symbol, venueSymbol,
      exchangeTs: receivedTs, receivedTs, sequenceId: seqId,
      bidPrice, bidSize: parseFloat(data.B) || 0, bidOrderCount: 0,
      askPrice, askSize: parseFloat(data.A) || 0, askOrderCount: 0,
      midPrice, spreadBps, feedType: FeedType.WEBSOCKET,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleTrade(data, receivedTs) {
    const venueSymbol     = (data.s || '').toUpperCase();
    const instrumentClass = InstrumentClass.CRYPTO_SPOT;
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);

    this._guard.touch(venueSymbol);

    const price = parseFloat(data.p) || 0;
    const size  = parseFloat(data.q) || 0;
    const event = {
      venue: VENUE, symbol,
      exchangeTs: data.T ?? receivedTs, receivedTs,
      tradeId: String(data.t), price, size,
      side: data.m ? 'SELL' : 'BUY',
      isLiquidation: false, isBlockTrade: false, notionalUsd: price * size,
    };

    this.emit('trade', event);
    if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
  }

  async _fetchSnapshot(venueSymbol) {
    const url = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(venueSymbol)}&limit=50`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.code) throw new Error(j.msg || `Binance depth error ${j.code}`);
    // Reset sequence with lastUpdateId
    this._guard.check(venueSymbol, j.lastUpdateId, true);
  }

  // ── Standard order interface ───────────────────────────────────────────────

  static mapSymbol(canonical) {
    const MAP = { 'BTC-PERP':'BTCUSDT','ETH-PERP':'ETHUSDT','SOL-PERP':'SOLUSDT','BNB-PERP':'BNBUSDT','XRP-PERP':'XRPUSDT','DOGE-PERP':'DOGEUSDT','BTC-USDT':'BTCUSDT','ETH-USDT':'ETHUSDT','SOL-USDT':'SOLUSDT' };
    if (MAP[canonical]) return MAP[canonical];
    const m = canonical.match(/^(\w+)-(PERP|USDT|USD)$/);
    if (m) return m[1] + 'USDT';
    console.warn(`[binance] Unmapped symbol: ${canonical}`);
    return canonical.replace(/-/g, '');
  }

  async submitOrder(order, creds) {
    const { orderResponse, OrderStatus, mapTIF, hmacSha256Hex, genClientOrderId, extractRejectReason } = require('./orderInterface');
    const base = creds?.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const sym = BinanceAdapter.mapSymbol(order.symbol);
    const cid = order.clientOrderId || genClientOrderId('BN');
    const tif = mapTIF('BINANCE', order.timeInForce || 'IOC');
    const ts  = Date.now();
    let qs = `symbol=${sym}&side=${order.side}&type=LIMIT&timeInForce=${tif}&quantity=${order.quantity}&price=${order.limitPrice}&newClientOrderId=${cid}&timestamp=${ts}`;
    qs += `&signature=${hmacSha256Hex(creds.fields.secretKey, qs)}`;
    const r = await fetch(`${base}/fapi/v1/order?${qs}`, { method: 'POST', headers: { 'X-MBX-APIKEY': creds.fields.apiKey } });
    const j = await r.json();
    if (j.code) return orderResponse({ venueOrderId: null, clientOrderId: cid, status: OrderStatus.REJECTED, rejectReason: extractRejectReason('BINANCE', j, r.status) });
    const filled = parseFloat(j.executedQty) || 0;
    const avg = parseFloat(j.avgPrice) || 0;
    const st = j.status === 'FILLED' ? OrderStatus.FILLED : j.status === 'PARTIALLY_FILLED' ? OrderStatus.PARTIAL : OrderStatus.ACKNOWLEDGED;
    return orderResponse({ venueOrderId: String(j.orderId), clientOrderId: j.clientOrderId || cid, status: st, filledQty: filled, avgFillPrice: avg });
  }

  async cancelOrder(venueOrderId, creds) {
    const { orderResponse, OrderStatus, hmacSha256Hex } = require('./orderInterface');
    const base = creds?.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const ts = Date.now();
    let qs = `orderId=${venueOrderId}&timestamp=${ts}`;
    qs += `&signature=${hmacSha256Hex(creds.fields.secretKey, qs)}`;
    const r = await fetch(`${base}/fapi/v1/order?${qs}`, { method: 'DELETE', headers: { 'X-MBX-APIKEY': creds.fields.apiKey } });
    const j = await r.json();
    if (j.code) throw new Error(j.msg || `Error ${j.code}`);
    return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
  }

  async amendOrder(venueOrderId, changes, creds) { throw new Error('Binance does not support order amendment — cancel and re-submit'); }

  async getOrderStatus(venueOrderId, creds) {
    const { orderResponse, OrderStatus, hmacSha256Hex } = require('./orderInterface');
    const base = creds?.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const ts = Date.now();
    let qs = `orderId=${venueOrderId}&timestamp=${ts}`;
    qs += `&signature=${hmacSha256Hex(creds.fields.secretKey, qs)}`;
    const r = await fetch(`${base}/fapi/v1/order?${qs}`, { headers: { 'X-MBX-APIKEY': creds.fields.apiKey } });
    const j = await r.json();
    if (j.code) throw new Error(j.msg || `Error ${j.code}`);
    const stMap = { NEW: OrderStatus.ACKNOWLEDGED, FILLED: OrderStatus.FILLED, PARTIALLY_FILLED: OrderStatus.PARTIAL, CANCELED: OrderStatus.REJECTED, REJECTED: OrderStatus.REJECTED };
    return orderResponse({ venueOrderId, clientOrderId: j.clientOrderId, status: stMap[j.status] || OrderStatus.ACKNOWLEDGED, filledQty: parseFloat(j.executedQty) || 0, avgFillPrice: parseFloat(j.avgPrice) || 0 });
  }

  async _fetchInitialPositions(creds) {
    const { hmacSha256Hex } = require('./orderInterface');
    const base = creds.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const ts = Date.now();
    let qs = `timestamp=${ts}`;
    qs += `&signature=${hmacSha256Hex(creds.fields.secretKey, qs)}`;
    const r = await fetch(`${base}/fapi/v2/positionRisk?${qs}`, { headers: { 'X-MBX-APIKEY': creds.fields.apiKey } });
    const j = await r.json();
    if (!Array.isArray(j)) return;
    for (const p of j) {
      const amt = parseFloat(p.positionAmt) || 0;
      if (amt === 0) continue;
      const unit = (p.symbol || '').replace(/USDT$|BUSD$|USD$/i, '');
      const pos = {
        venue: VENUE, symbol: p.symbol,
        side: amt > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(amt), sizeUnit: unit,
        avgEntryPrice: parseFloat(p.entryPrice) || 0,
        unrealisedPnl: parseFloat(p.unRealizedProfit) || 0,
        liquidationPrice: parseFloat(p.liquidationPrice) || 0,
        markPrice: parseFloat(p.markPrice) || 0,
        timestamp: Date.now(),
      };
      console.log('[binance] Initial position:', p.symbol, pos.side, pos.size, pos.sizeUnit);
      publish(Topics.POSITIONS, pos, p.symbol).catch(() => {});
    }
  }

  _scheduleReconnect() {
    setTimeout(async () => {
      try { await this.connect(); } catch { this._scheduleReconnect(); }
    }, this._reconnectMs);
  }

  // ── Private channel subscriptions ─────────────────────────────────────────

  async subscribePrivate(creds) {
    if (!creds?.fields?.apiKey) throw new Error('No API key');
    console.log('[binance] subscribePrivate called, testnet:', creds.testnet);
    const base = creds.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    const wsBase = creds.testnet ? 'wss://stream.binancefuture.com/ws/' : 'wss://fstream.binance.com/ws/';

    const r = await fetch(`${base}/fapi/v1/listenKey`, { method: 'POST', headers: { 'X-MBX-APIKEY': creds.fields.apiKey } });
    const j = await r.json();
    if (!j.listenKey) throw new Error(j.msg || 'Failed to get listenKey');

    const pws = new WebSocket(wsBase + j.listenKey);
    this._privateWs = pws;
    this._listenKey = j.listenKey;

    // Keepalive every 30 min
    this._listenKeyTimer = setInterval(async () => {
      try { await fetch(`${base}/fapi/v1/listenKey`, { method: 'PUT', headers: { 'X-MBX-APIKEY': creds.fields.apiKey } }); }
      catch {}
    }, 30 * 60_000);

    pws.onopen = () => {
      console.log('[binance] Private user data stream connected');
      this._fetchInitialPositions(creds).catch(e => console.error('[binance] Initial positions failed:', e.message));
    };
    pws.onmessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.data || raw); } catch { return; }
      if (msg.e === 'ORDER_TRADE_UPDATE' && msg.o) {
        const o = msg.o;
        publish(Topics.ORDERS, {
          venue: VENUE, orderId: String(o.i), symbol: o.s, side: o.S,
          orderType: o.o, quantity: parseFloat(o.q) || 0,
          filledQuantity: parseFloat(o.z) || 0, remainingQuantity: parseFloat(o.q) - parseFloat(o.z) || 0,
          limitPrice: parseFloat(o.p) || 0,
          state: { NEW:'OPEN', FILLED:'FILLED', PARTIALLY_FILLED:'PARTIAL', CANCELED:'CANCELLED', REJECTED:'REJECTED', EXPIRED:'CANCELLED' }[o.X] || o.X,
          updatedTs: msg.T || Date.now(),
        }, o.s).catch(() => {});
        if (o.X === 'FILLED' || o.X === 'PARTIALLY_FILLED') {
          publish(Topics.FILLS, {
            fillId: String(o.t), orderId: String(o.i), venue: VENUE, symbol: o.s, side: o.S,
            fillPrice: parseFloat(o.L) || 0, fillSize: parseFloat(o.l) || 0,
            fillTs: msg.T || Date.now(), receivedTs: Date.now(),
            commission: parseFloat(o.n) || 0, commissionAsset: o.N || '', slippageBps: 0, arrivalMid: 0,
          }, o.s).catch(() => {});
        }
      }
      if (msg.e === 'ACCOUNT_UPDATE' && msg.a) {
        for (const p of (msg.a.P || [])) {
          publish(Topics.POSITIONS, {
            venue: VENUE, symbol: p.s,
            side: parseFloat(p.pa) > 0 ? 'LONG' : parseFloat(p.pa) < 0 ? 'SHORT' : 'FLAT',
            size: Math.abs(parseFloat(p.pa) || 0), avgEntryPrice: parseFloat(p.ep) || 0,
            unrealisedPnl: parseFloat(p.up) || 0, liquidationPrice: 0, timestamp: msg.T || Date.now(),
          }, p.s).catch(() => {});
        }
        for (const b of (msg.a.B || [])) {
          publish(Topics.BALANCES, {
            venue: VENUE, currency: b.a,
            available: parseFloat(b.cw) || 0, total: parseFloat(b.wb) || 0,
            unrealisedPnl: 0, timestamp: msg.T || Date.now(),
          }, b.a).catch(() => {});
        }
      }
    };
    pws.onclose = () => { clearInterval(this._listenKeyTimer); this._privateWs = null; };
    pws.onerror = () => {};
  }
}

module.exports = { BinanceAdapter };
