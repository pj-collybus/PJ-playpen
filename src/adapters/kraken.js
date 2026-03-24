/**
 * Kraken adapter — WebSocket market data feed (spot).
 *
 * Sequence tracking: sequence field on V2 book messages.
 * Gap recovery: REST GET /0/public/Depth?pair={pair}.
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const { BookGuard }    = require('./bookGuard');

const VENUE  = 'KRAKEN';
const WS_URL = 'wss://ws.kraken.com/v2';

function detectInstrumentClass(venueSymbol) {
  if (venueSymbol.startsWith('PI_') || venueSymbol.startsWith('PF_')) return InstrumentClass.CRYPTO_PERP;
  if (venueSymbol.startsWith('FI_') || venueSymbol.startsWith('FF_')) return InstrumentClass.CRYPTO_FUTURE;
  return InstrumentClass.CRYPTO_SPOT;
}

class KrakenAdapter extends EventEmitter {
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
      this._ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: [venueSymbol] } }));
      this._ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: [venueSymbol] } }));
    }
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ method: 'unsubscribe', params: { channel: 'ticker', symbol: [venueSymbol] } }));
      this._ws.send(JSON.stringify({ method: 'unsubscribe', params: { channel: 'trade', symbol: [venueSymbol] } }));
    }
  }

  disconnect() { this._dead = true; this._stopPing(); this._guard.destroy(); if (this._ws) this._ws.close(); }

  _startPing() { this._pingTimer = setInterval(() => { if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify({ method: 'ping' })); }, 30_000); }
  _stopPing()  { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
  async _resubscribe() { for (const sym of this._subscriptions) await this.subscribe(sym); }

  _onMessage(raw) {
    const receivedTs = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.channel === 'ticker' && msg.data?.length) {
      this._handleTicker(msg.data[0], receivedTs);
    } else if (msg.channel === 'book' && msg.data?.length) {
      this._handleBook(msg.data, msg.type, receivedTs);
    } else if (msg.channel === 'trade' && msg.data?.length) {
      this._handleTrades(msg.data, receivedTs);
    }
  }

  _handleTicker(data, receivedTs) {
    const venueSymbol     = data.symbol || '';
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);

    this._guard.touch(venueSymbol);

    const bidPrice  = parseFloat(data.bid) || 0;
    const askPrice  = parseFloat(data.ask) || 0;
    const midPrice  = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    const event = {
      venue: VENUE, instrumentClass, symbol, venueSymbol,
      exchangeTs: receivedTs, receivedTs, sequenceId: null,
      bidPrice, bidSize: parseFloat(data.bid_qty) || 0, bidOrderCount: 0,
      askPrice, askSize: parseFloat(data.ask_qty) || 0, askOrderCount: 0,
      midPrice, spreadBps, feedType: FeedType.WEBSOCKET,
    };
    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleBook(dataArr, type, receivedTs) {
    // Kraken V2 book updates have a sequence field
    for (const data of dataArr) {
      const venueSymbol = data.symbol || '';
      const seqId       = data.sequence ?? null;
      const isSnapshot  = type === 'snapshot';

      if (!this._guard.check(venueSymbol, seqId, isSnapshot)) continue;
      // Book level processing would go here if we subscribe to the book channel
    }
  }

  _handleTrades(trades, receivedTs) {
    for (const t of trades) {
      const venueSymbol     = t.symbol || '';
      const instrumentClass = detectInstrumentClass(venueSymbol);
      const symbol          = normalise(VENUE, venueSymbol, instrumentClass);

      this._guard.touch(venueSymbol);

      const price = parseFloat(t.price) || 0;
      const size  = parseFloat(t.qty) || 0;
      const event = {
        venue: VENUE, symbol,
        exchangeTs: t.timestamp ? new Date(t.timestamp).getTime() : receivedTs, receivedTs,
        tradeId: String(t.trade_id || Date.now()), price, size,
        side: t.side === 'buy' ? 'BUY' : t.side === 'sell' ? 'SELL' : 'UNKNOWN',
        isLiquidation: false, isBlockTrade: false, notionalUsd: price * size,
      };
      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }

  async _fetchSnapshot(venueSymbol) {
    const url = `https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(venueSymbol)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error && j.error.length > 0) throw new Error(j.error.join(', '));
    // Reset sequence baseline (Kraken REST doesn't provide sequence, so null resets)
    this._guard.check(venueSymbol, null, true);
  }
}

// ── Standard order interface ─────────────────────────────────────────────────

KrakenAdapter.mapSymbol = function(canonical) {
  const MAP = { 'BTC-USD':'XBT/USD','BTC-USDT':'XBT/USDT','ETH-USD':'ETH/USD','ETH-USDT':'ETH/USDT','SOL-USD':'SOL/USD','BTC-PERP':'PI_XBTUSD','ETH-PERP':'PI_ETHUSD' };
  if (MAP[canonical]) return MAP[canonical];
  const m = canonical.match(/^(\w+)-(USD|USDT)$/);
  if (m) return `${m[1]}/${m[2]}`;
  console.warn(`[kraken] Unmapped symbol: ${canonical}`);
  return canonical;
};

KrakenAdapter.prototype.submitOrder = async function(order, creds) {
  const { orderResponse, OrderStatus, genClientOrderId, extractRejectReason } = require('./orderInterface');
  const crypto = require('crypto');
  const sym = KrakenAdapter.mapSymbol(order.symbol);
  const isPerp = sym.startsWith('PI_') || sym.startsWith('PF_');

  if (isPerp) {
    // Kraken Futures (derivatives)
    const base = 'https://futures.kraken.com';
    const path = '/derivatives/api/v3/sendorder';
    const cid = order.clientOrderId || genClientOrderId('KR');
    const bodyStr = `orderType=lmt&symbol=${encodeURIComponent(sym)}&side=${order.side.toLowerCase()}&size=${order.quantity}&limitPrice=${order.limitPrice}&cliOrdId=${cid}`;
    const nonce = Date.now().toString();
    const hash = crypto.createHash('sha256').update(bodyStr + nonce).digest();
    const keyBuf = Buffer.from(creds.fields.privateKey || creds.fields.secretKey, 'base64');
    const sig = crypto.createHmac('sha512', keyBuf).update(Buffer.concat([Buffer.from(path), hash])).digest('base64');
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'APIKey': creds.fields.apiKey, 'Authent': sig, 'Nonce': nonce, 'Content-Type': 'application/x-www-form-urlencoded' }, body: bodyStr });
    const j = await r.json();
    if (j.error) return orderResponse({ venueOrderId: null, clientOrderId: cid, status: OrderStatus.REJECTED, rejectReason: extractRejectReason('KRAKEN', j, r.status) });
    return orderResponse({ venueOrderId: j.sendStatus?.order_id, clientOrderId: cid, status: OrderStatus.ACKNOWLEDGED });
  } else {
    // Kraken Spot
    const path = '/0/private/AddOrder';
    const nonce = Date.now().toString();
    const body = `nonce=${nonce}&ordertype=limit&type=${order.side.toLowerCase()}&volume=${order.quantity}&price=${order.limitPrice}&pair=${sym}`;
    const hash = crypto.createHash('sha256').update(nonce + body).digest();
    const keyBuf = Buffer.from(creds.fields.privateKey || creds.fields.secretKey, 'base64');
    const sig = crypto.createHmac('sha512', keyBuf).update(Buffer.concat([Buffer.from(path), hash])).digest('base64');
    const r = await fetch(`https://api.kraken.com${path}`, { method: 'POST', headers: { 'API-Key': creds.fields.apiKey, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json();
    if (j.error?.length) return orderResponse({ venueOrderId: null, clientOrderId: null, status: OrderStatus.REJECTED, rejectReason: extractRejectReason('KRAKEN', j, r.status) });
    const txid = j.result?.txid?.[0];
    return orderResponse({ venueOrderId: txid, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
  }
};

KrakenAdapter.prototype.cancelOrder = async function(venueOrderId, creds) {
  const { orderResponse, OrderStatus } = require('./orderInterface');
  const crypto = require('crypto');
  const path = '/0/private/CancelOrder';
  const nonce = Date.now().toString();
  const body = `nonce=${nonce}&txid=${venueOrderId}`;
  const hash = crypto.createHash('sha256').update(nonce + body).digest();
  const keyBuf = Buffer.from(creds.fields.privateKey || creds.fields.secretKey, 'base64');
  const sig = crypto.createHmac('sha512', keyBuf).update(Buffer.concat([Buffer.from(path), hash])).digest('base64');
  const r = await fetch(`https://api.kraken.com${path}`, { method: 'POST', headers: { 'API-Key': creds.fields.apiKey, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (j.error?.length) throw new Error(j.error.join(', '));
  return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
};

KrakenAdapter.prototype.amendOrder = async function() { throw new Error('Kraken does not support order amendment — cancel and re-submit'); };

KrakenAdapter.prototype.getOrderStatus = async function(venueOrderId, creds) {
  const { orderResponse, OrderStatus } = require('./orderInterface');
  const crypto = require('crypto');
  const path = '/0/private/QueryOrders';
  const nonce = Date.now().toString();
  const body = `nonce=${nonce}&txid=${venueOrderId}`;
  const hash = crypto.createHash('sha256').update(nonce + body).digest();
  const keyBuf = Buffer.from(creds.fields.privateKey || creds.fields.secretKey, 'base64');
  const sig = crypto.createHmac('sha512', keyBuf).update(Buffer.concat([Buffer.from(path), hash])).digest('base64');
  const r = await fetch(`https://api.kraken.com${path}`, { method: 'POST', headers: { 'API-Key': creds.fields.apiKey, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (j.error?.length) throw new Error(j.error.join(', '));
  const o = j.result?.[venueOrderId] || {};
  const stMap = { open: OrderStatus.ACKNOWLEDGED, closed: OrderStatus.FILLED, canceled: OrderStatus.REJECTED };
  return orderResponse({ venueOrderId, clientOrderId: null, status: stMap[o.status] || OrderStatus.ACKNOWLEDGED, filledQty: parseFloat(o.vol_exec) || 0, avgFillPrice: parseFloat(o.price) || 0 });
};

KrakenAdapter.prototype.subscribePrivate = async function(creds) {
  const keyType = creds.fields?.keyType || 'spot';
  const isFutures = keyType === 'futures';
  console.log('[kraken] subscribePrivate:', { keyType, testnet: creds.testnet, fields: Object.keys(creds?.fields || {}) });
  if (!creds?.fields?.apiKey) throw new Error('No API key');
  const rawPrivateKey = creds.fields.privateKey || creds.fields.secretKey;
  if (!rawPrivateKey) throw new Error('No privateKey');
  const crypto = require('crypto');
  const apiKey = creds.fields.apiKey.trim();
  // Handle base64url encoding (Kraken Futures uses - and _ instead of + and /)
  const cleanKey = rawPrivateKey.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').trim();
  const padded = cleanKey + '='.repeat((4 - cleanKey.length % 4) % 4);
  const keyBuf = Buffer.from(padded, 'base64');
  console.log('[kraken] Key encoding:', {
    hasHyphen: rawPrivateKey.includes('-'), hasUnderscore: rawPrivateKey.includes('_'),
    rawLength: rawPrivateKey.length, cleanLength: cleanKey.length,
    paddedLength: padded.length, decodedLength: keyBuf.length,
  });

  if (isFutures) {
    // ── Kraken Futures (demo or live) ────────────────────────────────────────
    const restBase = creds.testnet ? 'https://demo-futures.kraken.com' : 'https://futures.kraken.com';
    const wsUrl    = creds.testnet ? 'wss://demo-futures.kraken.com/ws/v1' : 'wss://futures.kraken.com/ws/v1';

    // Step 1: Validate keys via REST
    // Kraken Futures SDK: strip '/derivatives' prefix before hashing
    // sign_message: message = postData + nonce + endpoint (without /derivatives prefix)
    const fullPath = '/derivatives/api/v3/accounts';
    const signPath = '/api/v3/accounts'; // stripped prefix per official SDK
    const postData = '';
    const nonce = String(Date.now());
    const hashInput = postData + nonce + signPath;
    const sha256Bytes = crypto.createHash('sha256').update(hashInput).digest();
    const sig = crypto.createHmac('sha512', keyBuf).update(sha256Bytes).digest('base64');

    console.log('[kraken futures] Signature debug:', {
      hashInput,
      signPath,
      nonce,
      sha256ByteLength: sha256Bytes.length,
      hmacKeyLength: keyBuf.length,
      sigLength: sig.length,
      endpoint: restBase + fullPath,
      apiKeyFirst6: apiKey.substring(0, 6),
    });

    const testR = await fetch(`${restBase}${fullPath}`, {
      method: 'GET',
      headers: { 'APIKey': apiKey, 'Authent': sig, 'Nonce': nonce },
    });
    const testJ = await testR.json();
    console.log('[kraken futures] REST auth test:', { status: testR.status, result: testJ.result, error: testJ.error });
    if (testJ.error) {
      const err = new Error('Futures auth: ' + testJ.error);
      err.diagnostic = {
        endpoint: restBase + authPath,
        apiKeyFirst6: apiKey.substring(0, 6),
        sha256ByteLength: sha256Bytes.length,
        isBuffer: Buffer.isBuffer(sha256Bytes),
        hmacKeyLength: keyBuf.length,
        sigLength: sig.length,
        sigFirst10: sig.substring(0, 10),
        httpStatus: testR.status,
        exchangeError: testJ.error,
      };
      throw err;
    }

    // Step 2: Connect WS, challenge-response auth
    const pws = new WebSocket(wsUrl);
    this._privateWs = pws;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Futures WS timeout')), 10000);

      pws.onopen = () => {
        pws.send(JSON.stringify({ event: 'challenge', api_key: apiKey }));
        console.log('[kraken] Futures WS connected, challenge requested');
      };

      pws.onmessage = (raw) => {
        let msg; try { msg = JSON.parse(raw.data || raw); } catch { return; }

        if (msg.event === 'challenge' && msg.message) {
          const challengeHash = crypto.createHash('sha256').update(msg.message).digest();
          const signed = crypto.createHmac('sha512', keyBuf).update(challengeHash).digest('base64');
          console.log('[kraken] Challenge received, signing. challengeLen:', msg.message.length, 'sigLen:', signed.length);
          const authPayload = { api_key: apiKey, original_challenge: msg.message, signed_challenge: signed };
          for (const feed of ['open_orders', 'fills', 'open_positions', 'balances']) {
            pws.send(JSON.stringify({ event: 'subscribe', feed, ...authPayload }));
          }
          console.log('[kraken] Futures challenge signed, channels subscribed');
          clearTimeout(timeout);
          this._fetchInitialPositionsFutures(creds).catch(e => console.error('[kraken] Initial positions failed:', e.message));
          resolve();
          return;
        }

        if (msg.event === 'error') {
          console.error('[kraken] Futures WS error:', msg.message);
          clearTimeout(timeout);
          reject(new Error(msg.message || 'Futures WS error'));
          return;
        }

        this._handleFuturesMessage(msg);
      };

      pws.onerror = () => { clearTimeout(timeout); reject(new Error('Futures WS connection error')); };
      pws.onclose = () => { this._privateWs = null; };
    });

  } else {
    // ── Kraken Spot ──────────────────────────────────────────────────────────
    const path = '/0/private/GetWebSocketsToken';
    const nonce = Date.now().toString();
    const postData = `nonce=${nonce}`;
    const sha256Hash = crypto.createHash('sha256').update(nonce + postData).digest();
    const hmacInput = Buffer.concat([Buffer.from(path), sha256Hash]);
    const sig = crypto.createHmac('sha512', keyBuf).update(hmacInput).digest('base64');

    console.log('[kraken] Spot auth: nonce=' + nonce + ' keyLen=' + keyBuf.length);
    const r = await fetch(`https://api.kraken.com${path}`, {
      method: 'POST',
      headers: { 'API-Key': apiKey, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postData,
    });
    const j = await r.json();
    console.log('[kraken] Spot GetWebSocketsToken:', { status: r.status, error: j.error, hasToken: !!j.result?.token });
    if (j.error?.length) throw new Error('WS token: ' + j.error.join(', '));
    const token = j.result?.token;
    if (!token) throw new Error('No WS token returned');

    const pws = new WebSocket('wss://ws-auth.kraken.com');
    this._privateWs = pws;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Spot WS timeout')), 10000);
      pws.onopen = () => {
        clearTimeout(timeout);
        pws.send(JSON.stringify({ event: 'subscribe', subscription: { name: 'openOrders', token } }));
        pws.send(JSON.stringify({ event: 'subscribe', subscription: { name: 'ownTrades', token } }));
        console.log('[kraken] Spot private channels subscribed');
        resolve();
      };
      pws.onerror = () => { clearTimeout(timeout); reject(new Error('Spot WS error')); };
    });
    // Spot onmessage handler — set on the pws created in this block
    pws.onmessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.data || raw); } catch { return; }
      if (!Array.isArray(msg)) return;
      const channelName = msg[msg.length - 1];
      if (channelName === 'openOrders') {
        for (const batch of msg.slice(0, -2)) {
          for (const [oid, o] of Object.entries(batch)) {
            publish(Topics.ORDERS, {
              venue: 'KRAKEN', orderId: oid, symbol: o.descr?.pair || '', side: o.descr?.type === 'buy' ? 'BUY' : 'SELL',
              orderType: o.descr?.ordertype || '', quantity: parseFloat(o.vol) || 0,
              filledQuantity: parseFloat(o.vol_exec) || 0,
              remainingQuantity: (parseFloat(o.vol) || 0) - (parseFloat(o.vol_exec) || 0),
              limitPrice: parseFloat(o.descr?.price) || 0,
              state: { open:'OPEN', closed:'FILLED', canceled:'CANCELLED', expired:'CANCELLED' }[o.status] || o.status,
              updatedTs: Date.now(),
            }, o.descr?.pair).catch(() => {});
          }
        }
      }
      if (channelName === 'ownTrades') {
        for (const batch of msg.slice(0, -2)) {
          for (const [tid, t] of Object.entries(batch)) {
            publish(Topics.FILLS, {
              fillId: tid, orderId: t.ordertxid, venue: 'KRAKEN', symbol: t.pair || '',
              side: t.type === 'buy' ? 'BUY' : 'SELL',
              fillPrice: parseFloat(t.price) || 0, fillSize: parseFloat(t.vol) || 0,
              fillTs: parseFloat(t.time) * 1000 || Date.now(), receivedTs: Date.now(),
              commission: parseFloat(t.fee) || 0, commissionAsset: '', slippageBps: 0, arrivalMid: 0,
            }, t.pair).catch(() => {});
          }
        }
      }
    };
    pws.onclose = () => { this._privateWs = null; };
  }
};

KrakenAdapter.prototype._fetchInitialPositionsFutures = async function(creds) {
  const crypto = require('crypto');
  const restBase = creds.testnet ? 'https://demo-futures.kraken.com' : 'https://futures.kraken.com';
  const fullPath = '/derivatives/api/v3/openpositions';
  const signPath = '/api/v3/openpositions'; // strip /derivatives prefix per SDK
  const postData = '';
  const nonce = Date.now().toString();
  const rawKey = creds.fields.privateKey || creds.fields.secretKey;
  const cleanKey = rawKey.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleanKey + '='.repeat((4 - cleanKey.length % 4) % 4);
  const keyBuf = Buffer.from(padded, 'base64');
  const hash = crypto.createHash('sha256').update(postData + nonce + signPath).digest();
  const sig = crypto.createHmac('sha512', keyBuf).update(hash).digest('base64');
  const r = await fetch(`${restBase}${fullPath}`, {
    method: 'GET',
    headers: { 'APIKey': creds.fields.apiKey.trim(), 'Authent': sig, 'Nonce': nonce },
  });
  const j = await r.json();
  if (j.error) { console.error('[kraken] Open positions error:', j.error); return; }
  const positions = j.openPositions || [];
  for (const p of positions) {
    const size = Math.abs(parseFloat(p.size) || 0);
    if (size === 0) continue;
    const unit = (p.symbol || '').replace(/^pi_|^pf_|usd$/gi, '').toUpperCase();
    const pos = {
      venue: 'KRAKEN', symbol: p.symbol,
      side: (parseFloat(p.size) || 0) > 0 ? 'LONG' : 'SHORT',
      size, sizeUnit: unit,
      avgEntryPrice: parseFloat(p.price) || 0,
      unrealisedPnl: parseFloat(p.unrealizedFunding) || 0,
      liquidationPrice: 0,
      timestamp: Date.now(),
    };
    console.log('[kraken] Initial position:', p.symbol, pos.side, pos.size, pos.sizeUnit);
    publish(Topics.POSITIONS, pos, p.symbol).catch(() => {});
  }
};

KrakenAdapter.prototype._handleFuturesMessage = function(msg) {
  if (!msg?.feed) return;
  if (msg.feed === 'open_orders') {
    const o = msg;
    if (o.order_id) {
      publish(Topics.ORDERS, {
        venue: 'KRAKEN', orderId: o.order_id, symbol: o.instrument || '', side: o.direction === 'buy' ? 'BUY' : 'SELL',
        orderType: o.order_type || '', quantity: parseFloat(o.qty) || 0,
        filledQuantity: parseFloat(o.filled) || 0, remainingQuantity: parseFloat(o.qty) - parseFloat(o.filled) || 0,
        limitPrice: parseFloat(o.limit_price) || 0,
        state: { untouched:'OPEN', partiallyFilled:'PARTIAL', filled:'FILLED', cancelled:'CANCELLED' }[o.status] || 'OPEN',
        updatedTs: o.timestamp ? new Date(o.timestamp).getTime() : Date.now(),
      }, o.instrument).catch(() => {});
    }
  }
  if (msg.feed === 'fills') {
    const f = msg;
    if (f.fill_id) {
      publish(Topics.FILLS, {
        fillId: f.fill_id, orderId: f.order_id || '', venue: 'KRAKEN', symbol: f.instrument || '',
        side: f.buy ? 'BUY' : 'SELL', fillPrice: parseFloat(f.price) || 0, fillSize: parseFloat(f.qty) || 0,
        fillTs: f.time ? new Date(f.time).getTime() : Date.now(), receivedTs: Date.now(),
        commission: parseFloat(f.fee) || 0, commissionAsset: '', slippageBps: 0, arrivalMid: 0,
      }, f.instrument).catch(() => {});
    }
  }
  if (msg.feed === 'open_positions') {
    if (msg.positions) {
      for (const p of msg.positions) {
        const qty = parseFloat(p.balance) || 0;
        publish(Topics.POSITIONS, {
          venue: 'KRAKEN', symbol: p.instrument || '', side: qty > 0 ? 'LONG' : qty < 0 ? 'SHORT' : 'FLAT',
          size: Math.abs(qty), avgEntryPrice: parseFloat(p.entry_price) || 0,
          unrealisedPnl: parseFloat(p.pnl) || 0, liquidationPrice: parseFloat(p.liquidation_threshold) || 0,
          timestamp: Date.now(),
        }, p.instrument).catch(() => {});
      }
    }
  }
  if (msg.feed === 'balances') {
    if (msg.flex_futures) {
      publish(Topics.BALANCES, {
        venue: 'KRAKEN', currency: 'USD', available: parseFloat(msg.flex_futures.available_margin) || 0,
        total: parseFloat(msg.flex_futures.portfolio_value) || 0,
        unrealisedPnl: parseFloat(msg.flex_futures.pnl) || 0, timestamp: Date.now(),
      }, 'USD').catch(() => {});
    }
  }
};

module.exports = { KrakenAdapter };
