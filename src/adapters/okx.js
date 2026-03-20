/**
 * OKX adapter — WebSocket market data feed.
 *
 * Connects to OKX V5 public WebSocket. Subscribes to tickers and trades channels.
 *
 * Usage:
 *   const adapter = new OKXAdapter();
 *   await adapter.connect();
 *   await adapter.subscribe('BTC-USDT-SWAP');
 *   adapter.on('l1', (event) => { ... });
 *   adapter.on('trade', (event) => { ... });
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');

const VENUE = 'OKX';
const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';

function detectInstrumentClass(venueSymbol) {
  if (venueSymbol.endsWith('-SWAP')) return InstrumentClass.CRYPTO_PERP;
  if (/\d{6}$/.test(venueSymbol))   return InstrumentClass.CRYPTO_FUTURE;
  return InstrumentClass.CRYPTO_SPOT;
}

class OKXAdapter extends EventEmitter {
  constructor({ publishToBus = true } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this._ws            = null;
    this._subscriptions = new Set();
    this._dead          = false;
    this._reconnectMs   = 2000;
    this._pingTimer     = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
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

  async subscribe(venueSymbol) {
    this._subscriptions.add(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        op: 'subscribe',
        args: [
          { channel: 'tickers', instId: venueSymbol },
          { channel: 'trades',  instId: venueSymbol },
        ],
      }));
    }
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        op: 'unsubscribe',
        args: [
          { channel: 'tickers', instId: venueSymbol },
          { channel: 'trades',  instId: venueSymbol },
        ],
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
        this._ws.send('ping');
      }
    }, 25_000);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  async _resubscribe() {
    for (const sym of this._subscriptions) await this.subscribe(sym);
  }

  _onMessage(raw) {
    const receivedTs = Date.now(); // Capture immediately before any parsing
    const str = raw.toString();
    if (str === 'pong') return;

    let msg;
    try { msg = JSON.parse(str); } catch { return; }
    if (msg.event) return; // subscribe/unsubscribe ack

    const channel = msg.arg?.channel;
    if (channel === 'tickers' && msg.data?.length) {
      this._handleTicker(msg.arg, msg.data[0], receivedTs);
    } else if (channel === 'trades' && msg.data?.length) {
      this._handleTrades(msg.arg, msg.data, receivedTs);
    }
  }

  _handleTicker(arg, data, receivedTs) {
    const venueSymbol     = arg.instId;
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);
    const bidPrice        = parseFloat(data.bidPx) || 0;
    const askPrice        = parseFloat(data.askPx) || 0;
    const midPrice        = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps       = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    /** @type {import('../schemas/events').L1_BBO} */
    const event = {
      venue: VENUE,
      instrumentClass,
      symbol,
      venueSymbol,
      exchangeTs:    parseInt(data.ts) || receivedTs,
      receivedTs,
      sequenceId:    null,
      bidPrice,
      bidSize:       parseFloat(data.bidSz) || 0,
      bidOrderCount: 0,
      askPrice,
      askSize:       parseFloat(data.askSz) || 0,
      askOrderCount: 0,
      midPrice,
      spreadBps,
      feedType:      FeedType.WEBSOCKET,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleTrades(arg, trades, receivedTs) {
    const venueSymbol     = arg.instId;
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);

    for (const t of trades) {
      const price = parseFloat(t.px) || 0;
      const size  = parseFloat(t.sz) || 0;

      /** @type {import('../schemas/events').TRADE} */
      const event = {
        venue:         VENUE,
        symbol,
        exchangeTs:    parseInt(t.ts) || receivedTs,
        receivedTs,
        tradeId:       String(t.tradeId),
        price,
        size,
        side:          t.side === 'buy' ? 'BUY' : 'SELL',
        isLiquidation: false,
        isBlockTrade:  false,
        notionalUsd:   price * size,
      };

      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }
}

module.exports = { OKXAdapter };
