/**
 * Bybit adapter — WebSocket market data feed (spot & linear perp).
 *
 * Uses Bybit V5 public WebSocket. Subscribes to orderbook.1 (L1) and publicTrade.
 *
 * Usage:
 *   const adapter = new BybitAdapter();
 *   await adapter.connect();
 *   await adapter.subscribe('BTCUSDT', 'spot');   // category: spot | linear
 *   adapter.on('l1', (event) => { ... });
 *   adapter.on('trade', (event) => { ... });
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');

const VENUE = 'BYBIT';

const WS_URLS = {
  spot:   'wss://stream.bybit.com/v5/public/spot',
  linear: 'wss://stream.bybit.com/v5/public/linear',
};

class BybitAdapter extends EventEmitter {
  constructor({ publishToBus = true, category = 'spot' } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this.category       = category;
    this._ws            = null;
    this._subscriptions = new Set();
    this._dead          = false;
    this._reconnectMs   = 2000;
    this._pingTimer     = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URLS[this.category] || WS_URLS.spot);
      this._ws = ws;

      ws.once('open', () => {
        this._startPing();
        this.emit('connected');
        resolve();
      });
      ws.once('error', reject);
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => {
        this._stopPing();
        this.emit('disconnected');
        if (!this._dead) {
          setTimeout(() => this.connect().then(() => this._resubscribe()).catch(() => {}), this._reconnectMs);
        }
      });
      ws.on('error', (err) => this.emit('error', err));
    });
  }

  async subscribe(venueSymbol, category) {
    if (category) this.category = category;
    this._subscriptions.add(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        op:   'subscribe',
        args: [`orderbook.1.${venueSymbol}`, `publicTrade.${venueSymbol}`],
      }));
    }
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        op:   'unsubscribe',
        args: [`orderbook.1.${venueSymbol}`, `publicTrade.${venueSymbol}`],
      }));
    }
  }

  disconnect() {
    this._dead = true;
    this._stopPing();
    if (this._ws) this._ws.close();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20_000);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  async _resubscribe() {
    for (const sym of this._subscriptions) await this.subscribe(sym);
  }

  _onMessage(raw) {
    const receivedTs = Date.now(); // Capture immediately before any parsing
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.op === 'pong' || msg.op === 'subscribe') return;

    const topic = msg.topic || '';
    if (topic.startsWith('orderbook.')) {
      this._handleOrderbook(msg, receivedTs);
    } else if (topic.startsWith('publicTrade.')) {
      this._handleTrades(msg, receivedTs);
    }
  }

  _handleOrderbook(msg, receivedTs) {
    const data            = msg.data || {};
    const venueSymbol     = data.s || '';
    const instrumentClass = this.category === 'linear'
      ? InstrumentClass.CRYPTO_PERP
      : InstrumentClass.CRYPTO_SPOT;
    const symbol  = normalise(VENUE, venueSymbol, instrumentClass);
    const bids    = data.b || [];
    const asks    = data.a || [];

    const bidPrice = parseFloat(bids[0]?.[0]) || 0;
    const bidSize  = parseFloat(bids[0]?.[1]) || 0;
    const askPrice = parseFloat(asks[0]?.[0]) || 0;
    const askSize  = parseFloat(asks[0]?.[1]) || 0;
    const midPrice = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    /** @type {import('../schemas/events').L1_BBO} */
    const event = {
      venue: VENUE,
      instrumentClass,
      symbol,
      venueSymbol,
      exchangeTs:    data.ts ?? receivedTs,
      receivedTs,
      sequenceId:    data.seq ?? null,
      bidPrice,
      bidSize,
      bidOrderCount: 0,
      askPrice,
      askSize,
      askOrderCount: 0,
      midPrice,
      spreadBps,
      feedType:      FeedType.WEBSOCKET,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleTrades(msg, receivedTs) {
    const trades = Array.isArray(msg.data) ? msg.data : [];

    for (const t of trades) {
      const venueSymbol     = t.s || '';
      const instrumentClass = this.category === 'linear'
        ? InstrumentClass.CRYPTO_PERP
        : InstrumentClass.CRYPTO_SPOT;
      const symbol = normalise(VENUE, venueSymbol, instrumentClass);
      const price  = parseFloat(t.p) || 0;
      const size   = parseFloat(t.v) || 0;

      /** @type {import('../schemas/events').TRADE} */
      const event = {
        venue:         VENUE,
        symbol,
        exchangeTs:    t.T ?? receivedTs,
        receivedTs,
        tradeId:       String(t.i),
        price,
        size,
        side:          t.S === 'Buy' ? 'BUY' : 'SELL',
        isLiquidation: !!t.L,
        isBlockTrade:  false,
        notionalUsd:   price * size,
      };

      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }
}

module.exports = { BybitAdapter };
