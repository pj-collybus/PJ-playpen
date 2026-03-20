/**
 * Deribit adapter — WebSocket market data feed.
 *
 * Connects to Deribit (testnet or live), subscribes to instruments,
 * normalises raw messages to canonical L1_BBO and L2_BOOK events,
 * and publishes them to the event bus.
 *
 * Usage:
 *   const adapter = new DeribitAdapter();
 *   await adapter.connect();
 *   await adapter.subscribe('BTC-PERPETUAL');
 *   adapter.on('l1', (event) => { ... }); // L1_BBO
 *   adapter.on('l2', (event) => { ... }); // L2_BOOK
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const venues           = require('../config/venues');

const VENUE = 'DERIBIT';
const cfg   = venues.DERIBIT;

function detectInstrumentClass(venueSymbol) {
  if (venueSymbol.includes('PERPETUAL')) return InstrumentClass.CRYPTO_PERP;
  // Dated future: e.g. BTC-27DEC24
  if (/\d{2}[A-Z]{3}\d{2}$/.test(venueSymbol)) return InstrumentClass.CRYPTO_FUTURE;
  return InstrumentClass.CRYPTO_SPOT;
}

class DeribitAdapter extends EventEmitter {
  constructor({ publishToBus = true } = {}) {
    super();
    this.publishToBus  = publishToBus;
    this._ws           = null;
    this._reqId        = 1;
    this._pending      = new Map(); // reqId → { resolve, reject }
    this._subscriptions = new Set();
    this._reconnectMs  = 2000;
    this._dead         = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(cfg.wsUrl);
      this._ws = ws;

      ws.once('open', () => {
        this.emit('connected');
        resolve();
      });

      ws.once('error', reject);

      ws.on('message', (data) => this._onMessage(data));

      ws.on('close', () => {
        this.emit('disconnected');
        if (!this._dead) this._scheduleReconnect();
      });

      ws.on('error', (err) => {
        this.emit('error', err);
      });
    });
  }

  async subscribe(venueSymbol) {
    this._subscriptions.add(venueSymbol);
    const channels = [
      `book.${venueSymbol}.100ms`,
      `ticker.${venueSymbol}.100ms`,
    ];
    await this._rpc('public/subscribe', { channels });
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    const channels = [
      `book.${venueSymbol}.100ms`,
      `ticker.${venueSymbol}.100ms`,
    ];
    await this._rpc('public/unsubscribe', { channels });
  }

  disconnect() {
    this._dead = true;
    if (this._ws) this._ws.close();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this._reqId++;
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 10_000);
    });
  }

  _onMessage(raw) {
    const receivedTs = Date.now(); // Capture immediately before any parsing
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // RPC response
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }

    // Subscription notification
    if (msg.method === 'subscription' && msg.params) {
      this._onNotification(msg.params.channel, msg.params.data, receivedTs);
    }
  }

  _onNotification(channel, data, receivedTs) {

    if (channel.startsWith('ticker.')) {
      this._handleTicker(channel, data, receivedTs);
    } else if (channel.startsWith('book.')) {
      this._handleBook(channel, data, receivedTs);
    }
  }

  _handleTicker(channel, data, receivedTs) {
    // channel: ticker.BTC-PERPETUAL.100ms
    const venueSymbol    = channel.split('.')[1];
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol         = normalise(VENUE, venueSymbol, instrumentClass);

    const bidPrice = data.best_bid_price ?? 0;
    const askPrice = data.best_ask_price ?? 0;
    const midPrice = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    /** @type {import('../schemas/events').L1_BBO} */
    const event = {
      venue:          VENUE,
      instrumentClass,
      symbol,
      venueSymbol,
      exchangeTs:     data.timestamp ?? receivedTs,
      receivedTs,
      sequenceId:     null,
      bidPrice,
      bidSize:        data.best_bid_amount ?? 0,
      bidOrderCount:  0,
      askPrice,
      askSize:        data.best_ask_amount ?? 0,
      askOrderCount:  0,
      midPrice,
      spreadBps,
      feedType:       FeedType.WEBSOCKET,
    };

    this.emit('l1', event);
    if (this.publishToBus) {
      publish(Topics.L1_BBO, event, symbol).catch(() => {});
    }
  }

  _handleBook(channel, data, receivedTs) {
    // channel: book.BTC-PERPETUAL.100ms
    const venueSymbol     = channel.split('.')[1];
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);
    const updateType      = data.type === 'snapshot' ? 'SNAPSHOT' : 'DELTA';
    const sequenceId      = data.change_id ?? null;

    const emit = (side, [price, size, orderCount], depth) => {
      /** @type {import('../schemas/events').L2_BOOK} */
      const event = {
        venue: VENUE,
        symbol,
        exchangeTs:   data.timestamp ?? receivedTs,
        receivedTs,
        sequenceId,
        updateId:     null,
        side,
        price,
        size,
        orderCount:   orderCount ?? 0,
        levelDepth:   depth,
        updateType,
      };
      this.emit('l2', event);
      if (this.publishToBus) {
        publish(Topics.L2_BOOK, event, symbol).catch(() => {});
      }
    };

    (data.bids || []).forEach((level, i) => emit('BID', level, i));
    (data.asks || []).forEach((level, i) => emit('ASK', level, i));
  }

  _scheduleReconnect() {
    setTimeout(async () => {
      try {
        await this.connect();
        // Re-subscribe
        for (const sym of this._subscriptions) {
          await this.subscribe(sym);
        }
      } catch (err) {
        this.emit('error', err);
        this._scheduleReconnect();
      }
    }, this._reconnectMs);
  }
}

module.exports = { DeribitAdapter };
