/**
 * BitMEX adapter — WebSocket market data + standard order interface.
 *
 * Market data: wss://testnet.bitmex.com/realtime or wss://ws.bitmex.com/realtime
 * Order API: POST /api/v1/order, DELETE /api/v1/order, PUT /api/v1/order
 * Auth: HMAC-SHA256 signature: verb + path + expires + body
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const { BookGuard }    = require('./bookGuard');
const { orderResponse, OrderStatus, mapTIF, hmacSha256Hex, genClientOrderId, extractRejectReason, normaliseOrderSize, getBaseCurrency } = require('./orderInterface');

const VENUE = 'BITMEX';

// Module-level BTC mark price — updated from XBTUSD ticker stream
let _btcMarkPrice = 97000; // sensible default

/** Get current BTC mark price (from XBTUSD stream) */
function getBtcMarkPrice() { return _btcMarkPrice; }

class BitMEXAdapter extends EventEmitter {
  constructor({ publishToBus = true, dataBreaker = null } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this._ws            = null;
    this._subscriptions = new Set();
    this._dead          = false;
    this._reconnectMs   = 2000;
    this._guard         = new BookGuard(VENUE, this, () => {}, { publishToBus, dataBreaker });
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://ws.bitmex.com/realtime');
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
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ op: 'subscribe', args: [`trade:${venueSymbol}`, `quote:${venueSymbol}`] }));
    }
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ op: 'unsubscribe', args: [`trade:${venueSymbol}`, `quote:${venueSymbol}`] }));
    }
  }

  disconnect() { this._dead = true; this._guard.destroy(); if (this._ws) this._ws.close(); }

  _onMessage(raw) {
    const receivedTs = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.table || !msg.data?.length) return;

    if (msg.table === 'quote') this._handleQuote(msg.data, receivedTs);
    else if (msg.table === 'trade') this._handleTrade(msg.data, receivedTs);
  }

  _handleQuote(data, receivedTs) {
    for (const q of data) {
      const venueSymbol = q.symbol;
      this._guard.touch(venueSymbol);
      const instrumentClass = InstrumentClass.CRYPTO_PERP;
      const symbol  = normalise(VENUE, venueSymbol, instrumentClass);
      const bidPrice = q.bidPrice || 0, askPrice = q.askPrice || 0;
      const midPrice = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
      const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;
      const event = {
        venue: VENUE, instrumentClass, symbol, venueSymbol,
        exchangeTs: q.timestamp ? new Date(q.timestamp).getTime() : receivedTs, receivedTs,
        sequenceId: null, bidPrice, bidSize: q.bidSize || 0, bidOrderCount: 0,
        askPrice, askSize: q.askSize || 0, askOrderCount: 0,
        midPrice, spreadBps, feedType: FeedType.WEBSOCKET,
      };
      // Track XBTUSD mark price for QUANTO contract sizing
      if (venueSymbol === 'XBTUSD' && midPrice > 0) {
        _btcMarkPrice = midPrice;
      }
      this.emit('l1', event);
      if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
    }
  }

  _handleTrade(data, receivedTs) {
    for (const t of data) {
      const venueSymbol = t.symbol;
      this._guard.touch(venueSymbol);
      const symbol = normalise(VENUE, venueSymbol, InstrumentClass.CRYPTO_PERP);
      const event = {
        venue: VENUE, symbol,
        exchangeTs: t.timestamp ? new Date(t.timestamp).getTime() : receivedTs, receivedTs,
        tradeId: String(t.trdMatchID || Date.now()), price: t.price || 0, size: t.size || 0,
        side: t.side === 'Buy' ? 'BUY' : 'SELL',
        isLiquidation: false, isBlockTrade: false, notionalUsd: (t.price || 0) * (t.size || 0),
      };
      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }

  _scheduleReconnect() {
    setTimeout(async () => {
      try { await this.connect(); for (const sym of this._subscriptions) await this.subscribe(sym); }
      catch (err) { this.emit('error', err); this._scheduleReconnect(); }
    }, this._reconnectMs);
  }

  async _fetchInitialPositions(creds) {
    const base = creds.testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const path = '/api/v1/position?filter=' + encodeURIComponent('{"isOpen":true}');
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const sig = hmacSha256Hex(creds.fields.apiSecret, 'GET' + path + expires);
    const r = await fetch(`${base}${path}`, { headers: { 'api-key': creds.fields.apiKey, 'api-signature': sig, 'api-expires': expires } });
    const positions = await r.json();
    if (!Array.isArray(positions)) return;
    const specService = require('../services/instrumentSpecService');
    for (const p of positions) {
      if (!p.isOpen) continue;
      const qty = p.currentQty || 0;
      // Fetch spec to determine contract type (also seeds cache for WS handler)
      const posSpec = await specService.getSpec('BITMEX', p.symbol);
      const posCType = posSpec?.contractType || (p.symbol.endsWith('USDT') ? 'LINEAR' : 'UNKNOWN');
      let baseSize;
      if (posCType === 'INVERSE' && p.markPrice) {
        baseSize = Math.abs(qty) / p.markPrice;
      } else if (posCType === 'QUANTO' && p.markPrice) {
        const pMult = posSpec?.multiplier || 1;
        baseSize = Math.abs(qty) * (pMult / 1e8) * _btcMarkPrice / p.markPrice;
      } else {
        baseSize = Math.abs(qty);
      }
      const unit = getBaseCurrency('BITMEX', p.symbol);
      console.log('[bitmex] position raw:', {
        symbol: p.symbol, currentQty: p.currentQty, markPrice: p.markPrice,
        contractType: posCType, calculatedSize: baseSize,
      });
      // Seed position cache for WS partial updates
      if (!this._posCache) this._posCache = {};
      this._posCache[p.symbol] = p;
      const pos = {
        venue: VENUE, symbol: p.symbol,
        side: qty > 0 ? 'LONG' : qty < 0 ? 'SHORT' : 'FLAT',
        size: baseSize, sizeUnit: unit,
        avgEntryPrice: p.avgEntryPrice || 0,
        unrealisedPnl: (p.unrealisedPnl || 0) / 1e8,
        liquidationPrice: p.liquidationPrice || 0,
        markPrice: p.markPrice || 0, leverage: p.leverage || 0,
        timestamp: Date.now(),
      };
      console.log('[bitmex] Initial position:', p.symbol, pos.side, pos.size, pos.sizeUnit);
      publish(Topics.POSITIONS, pos, p.symbol).catch(() => {});
    }
  }

  // ── Standard order interface ───────────────────────────────────────────────

  static mapSymbol(canonical) {
    // Already in venue format (e.g. XRPUSD, XBTUSDT) — pass through
    if (/^[A-Z]+(USD|USDT)$/.test(canonical) && !canonical.includes('-')) return canonical;
    const MAP = { 'BTC-PERP':'XBTUSD','ETH-PERP':'ETHUSD','SOL-PERP':'SOLUSD','XRP-PERP':'XRPUSD','DOGE-PERP':'DOGEUSD','BTC-USDT':'XBTUSDT','ETH-USDT':'ETHUSDT' };
    if (MAP[canonical]) return MAP[canonical];
    const m = canonical.match(/^(\w+)-PERP$/);
    if (m) return m[1] + 'USD';
    console.warn(`[bitmex] Unmapped symbol: ${canonical}`);
    return canonical;
  }

  _sign(verb, path, expires, body, secret) {
    return hmacSha256Hex(secret, verb + path + expires + (body || ''));
  }

  async submitOrder(order, creds) {
    const base = creds?.testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const path = '/api/v1/order';
    const sym  = BitMEXAdapter.mapSymbol(order.symbol);
    const cid  = order.clientOrderId || genClientOrderId('BX');
    const tif  = mapTIF('BITMEX', order.timeInForce || 'IOC');
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    // Convert base-currency qty to exchange-native units (USD contracts for inverse)
    const orderQty = await normaliseOrderSize('BITMEX', sym, order.quantity, order.limitPrice);
    console.log('[bitmex] submitOrder payload:', {
      symbol: sym, orderQty, price: order.limitPrice, side: order.side,
      rawInputQty: order.quantity, rawInputPrice: order.limitPrice,
    });
    const bodyObj = { symbol: sym, side: order.side === 'BUY' ? 'Buy' : 'Sell', orderQty, price: order.limitPrice, ordType: 'Limit', timeInForce: tif, clOrdID: cid };
    const bodyStr = JSON.stringify(bodyObj);
    const sig = this._sign('POST', path, expires, bodyStr, creds.fields.apiSecret);
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'api-key': creds.fields.apiKey, 'api-signature': sig, 'api-expires': expires, 'Content-Type': 'application/json' }, body: bodyStr });
    const j = await r.json();
    if (j.error) {
      console.debug('[DEBUG] BITMEX rejection raw:', r.status, JSON.stringify(j));
      const reason = extractRejectReason('BITMEX', j, r.status);
      console.debug('[DEBUG] BITMEX extracted reason:', reason);
      return orderResponse({ venueOrderId: null, clientOrderId: cid, status: OrderStatus.REJECTED, rejectReason: reason });
    }
    const filled = j.cumQty || 0;
    const avg = j.avgPx || 0;
    const st = j.ordStatus === 'Filled' ? OrderStatus.FILLED : j.ordStatus === 'PartiallyFilled' ? OrderStatus.PARTIAL : OrderStatus.ACKNOWLEDGED;
    return orderResponse({ venueOrderId: j.orderID, clientOrderId: j.clOrdID || cid, status: st, filledQty: filled, avgFillPrice: avg });
  }

  async cancelOrder(venueOrderId, creds) {
    const base = creds?.testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const path = '/api/v1/order';
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const bodyStr = JSON.stringify({ orderID: venueOrderId });
    const sig = this._sign('DELETE', path, expires, bodyStr, creds.fields.apiSecret);
    const r = await fetch(`${base}${path}`, { method: 'DELETE', headers: { 'api-key': creds.fields.apiKey, 'api-signature': sig, 'api-expires': expires, 'Content-Type': 'application/json' }, body: bodyStr });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return orderResponse({ venueOrderId, clientOrderId: null, status: OrderStatus.ACKNOWLEDGED });
  }

  async amendOrder(venueOrderId, changes, creds) {
    const base = creds?.testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const path = '/api/v1/order';
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const patch = { orderID: venueOrderId };
    if (changes.quantity) patch.orderQty = changes.quantity;
    if (changes.price) patch.price = changes.price;
    const bodyStr = JSON.stringify(patch);
    const sig = this._sign('PUT', path, expires, bodyStr, creds.fields.apiSecret);
    const r = await fetch(`${base}${path}`, { method: 'PUT', headers: { 'api-key': creds.fields.apiKey, 'api-signature': sig, 'api-expires': expires, 'Content-Type': 'application/json' }, body: bodyStr });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return orderResponse({ venueOrderId: j.orderID || venueOrderId, clientOrderId: j.clOrdID, status: OrderStatus.ACKNOWLEDGED, filledQty: j.cumQty || 0, avgFillPrice: j.avgPx || 0 });
  }

  async getOrderStatus(venueOrderId, creds) {
    const base = creds?.testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const path = `/api/v1/order?filter=${encodeURIComponent(JSON.stringify({ orderID: venueOrderId }))}`;
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    const sig = this._sign('GET', path, expires, '', creds.fields.apiSecret);
    const r = await fetch(`${base}${path}`, { headers: { 'api-key': creds.fields.apiKey, 'api-signature': sig, 'api-expires': expires } });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const o = Array.isArray(j) ? j[0] : j;
    if (!o) throw new Error('Order not found');
    const stMap = { New: OrderStatus.ACKNOWLEDGED, Filled: OrderStatus.FILLED, PartiallyFilled: OrderStatus.PARTIAL, Canceled: OrderStatus.REJECTED };
    return orderResponse({ venueOrderId, clientOrderId: o.clOrdID, status: stMap[o.ordStatus] || OrderStatus.ACKNOWLEDGED, filledQty: o.cumQty || 0, avgFillPrice: o.avgPx || 0 });
  }

  // ── Private channel subscriptions ─────────────────────────────────────────

  subscribePrivate(creds) {
    if (!creds?.fields?.apiKey) return Promise.reject(new Error('No API key'));
    console.log('[bitmex] subscribePrivate called, testnet:', creds.testnet);
    const base = creds.testnet ? 'wss://testnet.bitmex.com/realtime' : 'wss://ws.bitmex.com/realtime';

    return new Promise((resolve, reject) => {
      const pws = new WebSocket(base);
      this._privateWs = pws;
      const timeout = setTimeout(() => reject(new Error('WS connect timeout')), 10000);

      pws.onopen = () => {
        clearTimeout(timeout);
        const expires = Math.floor(Date.now() / 1000) + 60;
        const sig = hmacSha256Hex(creds.fields.apiSecret, 'GET/realtime' + expires);
        pws.send(JSON.stringify({ op: 'authKeyExpires', args: [creds.fields.apiKey, expires, sig] }));
        // BitMEX doesn't send auth confirmation — subscribe after short delay then resolve
        setTimeout(() => {
          pws.send(JSON.stringify({ op: 'subscribe', args: ['order', 'execution', 'position', 'margin'] }));
          console.log('[bitmex] Private channels subscribed');
          // Fetch initial positions via REST
          this._fetchInitialPositions(creds).catch(e => console.error('[bitmex] Initial positions fetch failed:', e.message));
          resolve();
        }, 500);
      };

    pws.onmessage = (raw) => {
      let msg; try { msg = JSON.parse(raw.data || raw); } catch { return; }
      if (!msg.table || !msg.data?.length) return;
      if (msg.table === 'order') {
        for (const o of msg.data) {
          if (!o.orderID || !o.symbol) continue;
          console.log('[bitmex] order fields:', {
            orderID: o.orderID, ordType: o.ordType, orderQty: o.orderQty,
            cumQty: o.cumQty, lastQty: o.lastQty, price: o.price,
            avgPx: o.avgPx, lastPx: o.lastPx, symbol: o.symbol, ordStatus: o.ordStatus,
          });
          // Merge partial updates into order cache
          if (!this._orderCache) this._orderCache = {};
          this._orderCache[o.orderID] = { ...(this._orderCache[o.orderID] || {}), ...o };
          const merged = this._orderCache[o.orderID];
          // Determine contract type from spec cache (async-populated on first use)
          const specSvc = require('../services/instrumentSpecService');
          const cachedSpec = specSvc._peekCache ? specSvc._peekCache('BITMEX', merged.symbol) : null;
          const cType = cachedSpec?.contractType || (merged.symbol.endsWith('USDT') ? 'LINEAR' : 'UNKNOWN');
          const px = merged.price || merged.avgPx || merged.lastPx || 0;
          const rawQty = merged.orderQty || 0;
          const rawFilled = merged.cumQty || 0;
          // Convert exchange contracts → base currency for display
          let qty, filled;
          if (cType === 'INVERSE' && px) {
            qty = rawQty / px;
            filled = rawFilled / px;
          } else if (cType === 'QUANTO' && px) {
            const mult = cachedSpec?.multiplier || 1;
            const btcPx = _btcMarkPrice;
            const basePerContract = (mult / 1e8) * btcPx / px;
            qty = rawQty * basePerContract;
            filled = rawFilled * basePerContract;
          } else {
            qty = rawQty;
            filled = rawFilled;
          }
          const remaining = Math.max(0, qty - filled);
          console.log('[bitmex] order converted:', { rawQty, rawFilled, px, cType, qty: qty.toFixed(4), filled: filled.toFixed(4), remaining: remaining.toFixed(4) });
          publish(Topics.ORDERS, {
            venue: VENUE, orderId: merged.orderID, venueOrderId: merged.orderID,
            symbol: merged.symbol, side: merged.side === 'Buy' ? 'BUY' : 'SELL',
            orderType: (merged.ordType || '').toUpperCase(), quantity: qty, filledQuantity: filled,
            remainingQuantity: remaining, limitPrice: merged.price || 0,
            state: { New:'OPEN', Filled:'FILLED', PartiallyFilled:'PARTIAL', Canceled:'CANCELLED' }[merged.ordStatus] || merged.ordStatus,
            updatedTs: merged.timestamp ? new Date(merged.timestamp).getTime() : Date.now(),
          }, merged.symbol).catch(() => {});
        }
      }
      if (msg.table === 'execution') {
        for (const f of msg.data) {
          if (f.execType !== 'Trade') continue;
          const fillSpec = require('../services/instrumentSpecService')._peekCache('BITMEX', f.symbol);
          const fillCType = fillSpec?.contractType || (f.symbol.endsWith('USDT') ? 'LINEAR' : 'UNKNOWN');
          let fillBaseSize;
          if (fillCType === 'INVERSE' && f.lastPx) {
            fillBaseSize = (f.lastQty || 0) / f.lastPx;
          } else if (fillCType === 'QUANTO' && f.lastPx) {
            const fMult = fillSpec?.multiplier || 1;
            fillBaseSize = (f.lastQty || 0) * (fMult / 1e8) * _btcMarkPrice / f.lastPx;
          } else {
            fillBaseSize = f.lastQty || 0;
          }
          const fillUnit = getBaseCurrency('BITMEX', f.symbol);
          console.log('[bitmex] fill:', { symbol: f.symbol, lastQty: f.lastQty, lastPx: f.lastPx, contractType: fillCType, baseSize: fillBaseSize, unit: fillUnit });
          publish(Topics.FILLS, {
            fillId: f.execID, orderId: f.orderID, venue: VENUE, symbol: f.symbol,
            side: f.side === 'Buy' ? 'BUY' : 'SELL',
            fillPrice: f.lastPx || 0, fillSize: fillBaseSize, sizeUnit: fillUnit,
            fillTs: f.timestamp ? new Date(f.timestamp).getTime() : Date.now(), receivedTs: Date.now(),
            commission: f.commission || 0, commissionAsset: 'XBT', slippageBps: 0, arrivalMid: 0,
          }, f.symbol).catch(() => {});
        }
      }
      if (msg.table === 'position') {
        for (const p of msg.data) {
          if (!p.symbol) continue;
          // Merge partial updates into cached position state
          if (!this._posCache) this._posCache = {};
          this._posCache[p.symbol] = { ...(this._posCache[p.symbol] || {}), ...p };
          const merged = this._posCache[p.symbol];
          if (merged.isOpen === false && !merged.currentQty) continue;
          const qty = merged.currentQty || 0;
          const posSpec = require('../services/instrumentSpecService')._peekCache('BITMEX', merged.symbol);
          const posCType = posSpec?.contractType || (merged.symbol.endsWith('USDT') ? 'LINEAR' : 'UNKNOWN');
          let baseSize;
          if (posCType === 'INVERSE' && merged.markPrice) {
            baseSize = Math.abs(qty) / merged.markPrice;
          } else if (posCType === 'QUANTO' && merged.markPrice) {
            const pMult = posSpec?.multiplier || 1;
            baseSize = Math.abs(qty) * (pMult / 1e8) * _btcMarkPrice / merged.markPrice;
          } else {
            baseSize = Math.abs(qty);
          }
          const unit = getBaseCurrency('BITMEX', merged.symbol);
          console.log('[bitmex] position raw:', {
            symbol: merged.symbol, currentQty: merged.currentQty, markPrice: merged.markPrice,
            contractType: posCType, calculatedSize: baseSize, action: msg.action,
          });
          const pos = {
            venue: VENUE, symbol: merged.symbol,
            side: qty > 0 ? 'LONG' : qty < 0 ? 'SHORT' : 'FLAT',
            size: baseSize, sizeUnit: unit,
            avgEntryPrice: merged.avgEntryPrice || 0,
            unrealisedPnl: (merged.unrealisedPnl || 0) / 1e8,
            liquidationPrice: merged.liquidationPrice || 0,
            markPrice: merged.markPrice || 0, leverage: merged.leverage || 0,
            timestamp: Date.now(),
          };
          console.log('[bitmex] Position update:', merged.symbol, pos.side, 'size=' + pos.size, pos.sizeUnit);
          publish(Topics.POSITIONS, pos, merged.symbol).catch(() => {});
        }
      }
      if (msg.table === 'margin') {
        for (const m of msg.data) {
          publish(Topics.BALANCES, {
            venue: VENUE, currency: m.currency || 'XBt',
            available: (m.availableMargin || 0) / 1e8, total: (m.walletBalance || 0) / 1e8,
            unrealisedPnl: (m.unrealisedPnl || 0) / 1e8, timestamp: Date.now(),
          }, m.currency).catch(() => {});
        }
      }
    };

    pws.onclose = () => { this._privateWs = null; };
    pws.onerror = () => { clearTimeout(timeout); reject(new Error('WS connection error')); };
    });
  }
}

module.exports = { BitMEXAdapter, getBtcMarkPrice };
