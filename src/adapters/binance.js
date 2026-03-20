/**
 * Binance adapter — WebSocket market data feed (spot).
 *
 * Connects to Binance combined stream, subscribes to bookTicker and trade streams,
 * normalises to canonical L1_BBO and TRADE events, publishes to event bus.
 *
 * Usage:
 *   const adapter = new BinanceAdapter();
 *   await adapter.connect();
 *   await adapter.subscribe('BTCUSDT');
 *   adapter.on('l1', (event) => { ... });
 *   adapter.on('trade', (event) => { ... });
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');

const VENUE   = 'BINANCE';
const WS_BASE = 'wss://stream.binance.com:9443/stream?streams=';

class BinanceAdapter extends EventEmitter {
  constructor({ publishToBus = true } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this._ws            = null;
    this._subscriptions = new Set(); // venueSymbols (lowercase)
    this._dead          = false;
    this._reconnectMs   = 2000;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect() {
    // Binance combined stream URL includes streams in the path — we reconnect on change
    const streams = this._buildStreams();
    const url     = WS_BASE + (streams.length ? streams.join('/') : 'btcusdt@bookTicker');
    return this._open(url);
  }

  async subscribe(venueSymbol) {
    const sym = venueSymbol.toLowerCase();
    this._subscriptions.add(sym);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: [`${sym}@bookTicker`, `${sym}@trade`],
        id:     Date.now(),
      }));
    }
  }

  async unsubscribe(venueSymbol) {
    const sym = venueSymbol.toLowerCase();
    this._subscriptions.delete(sym);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: [`${sym}@bookTicker`, `${sym}@trade`],
        id:     Date.now(),
      }));
    }
  }

  disconnect() {
    this._dead = true;
    if (this._ws) this._ws.close();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _buildStreams() {
    const out = [];
    for (const sym of this._subscriptions) {
      out.push(`${sym}@bookTicker`, `${sym}@trade`);
    }
    return out;
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this._ws = ws;

      ws.once('open', () => {
        this.emit('connected');
        resolve();
      });
      ws.once('error', reject);
      ws.on('message', (data) => this._onMessage(data));
      ws.on('close', () => {
        this.emit('disconnected');
        if (!this._dead) {
          setTimeout(() => this.connect().catch(() => {}), this._reconnectMs);
        }
      });
      ws.on('error', (err) => this.emit('error', err));
    });
  }

  _onMessage(raw) {
    const receivedTs = Date.now(); // Capture immediately before any parsing
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Combined stream wraps: { stream: "btcusdt@bookTicker", data: {...} }
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
    const bidPrice        = parseFloat(data.b) || 0;
    const askPrice        = parseFloat(data.a) || 0;
    const midPrice        = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps       = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    /** @type {import('../schemas/events').L1_BBO} */
    const event = {
      venue: VENUE,
      instrumentClass,
      symbol,
      venueSymbol,
      exchangeTs:    receivedTs,
      receivedTs,
      sequenceId:    data.u ?? null,
      bidPrice,
      bidSize:       parseFloat(data.B) || 0,
      bidOrderCount: 0,
      askPrice,
      askSize:       parseFloat(data.A) || 0,
      askOrderCount: 0,
      midPrice,
      spreadBps,
      feedType:      FeedType.WEBSOCKET,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleTrade(data, receivedTs) {
    const venueSymbol     = (data.s || '').toUpperCase();
    const instrumentClass = InstrumentClass.CRYPTO_SPOT;
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);
    const price           = parseFloat(data.p) || 0;
    const size            = parseFloat(data.q) || 0;

    /** @type {import('../schemas/events').TRADE} */
    const event = {
      venue:          VENUE,
      symbol,
      exchangeTs:     data.T ?? receivedTs,
      receivedTs,
      tradeId:        String(data.t),
      price,
      size,
      side:           data.m ? 'SELL' : 'BUY', // m=true → buyer is market maker → taker is seller
      isLiquidation:  false,
      isBlockTrade:   false,
      notionalUsd:    price * size, // USD pair assumed
    };

    this.emit('trade', event);
    if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
  }
}

module.exports = { BinanceAdapter };
