/**
 * Kraken adapter — WebSocket market data feed (spot).
 *
 * Uses Kraken V2 WebSocket. Subscribes to ticker and trade channels.
 *
 * Usage:
 *   const adapter = new KrakenAdapter();
 *   await adapter.connect();
 *   await adapter.subscribe('XBT/USD');
 *   adapter.on('l1', (event) => { ... });
 *   adapter.on('trade', (event) => { ... });
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');

const VENUE  = 'KRAKEN';
const WS_URL = 'wss://ws.kraken.com/v2';

function detectInstrumentClass(venueSymbol) {
  if (venueSymbol.startsWith('PI_') || venueSymbol.startsWith('PF_')) return InstrumentClass.CRYPTO_PERP;
  if (venueSymbol.startsWith('FI_') || venueSymbol.startsWith('FF_')) return InstrumentClass.CRYPTO_FUTURE;
  return InstrumentClass.CRYPTO_SPOT;
}

class KrakenAdapter extends EventEmitter {
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
        method: 'subscribe',
        params: {
          channel:  'ticker',
          symbol:   [venueSymbol],
        },
      }));
      this._ws.send(JSON.stringify({
        method: 'subscribe',
        params: {
          channel:  'trade',
          symbol:   [venueSymbol],
        },
      }));
    }
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({
        method: 'unsubscribe',
        params: { channel: 'ticker', symbol: [venueSymbol] },
      }));
      this._ws.send(JSON.stringify({
        method: 'unsubscribe',
        params: { channel: 'trade', symbol: [venueSymbol] },
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
        this._ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, 30_000);
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

    // V2 format: { channel: "ticker", type: "update", data: [...] }
    if (msg.channel === 'ticker' && msg.data?.length) {
      this._handleTicker(msg.data[0], receivedTs);
    } else if (msg.channel === 'trade' && msg.data?.length) {
      this._handleTrades(msg.data, receivedTs);
    }
  }

  _handleTicker(data, receivedTs) {
    const venueSymbol     = data.symbol || '';
    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol          = normalise(VENUE, venueSymbol, instrumentClass);
    const bidPrice        = parseFloat(data.bid) || 0;
    const askPrice        = parseFloat(data.ask) || 0;
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
      sequenceId:    null,
      bidPrice,
      bidSize:       parseFloat(data.bid_qty) || 0,
      bidOrderCount: 0,
      askPrice,
      askSize:       parseFloat(data.ask_qty) || 0,
      askOrderCount: 0,
      midPrice,
      spreadBps,
      feedType:      FeedType.WEBSOCKET,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  _handleTrades(trades, receivedTs) {

    for (const t of trades) {
      const venueSymbol     = t.symbol || '';
      const instrumentClass = detectInstrumentClass(venueSymbol);
      const symbol          = normalise(VENUE, venueSymbol, instrumentClass);
      const price           = parseFloat(t.price) || 0;
      const size            = parseFloat(t.qty) || 0;

      /** @type {import('../schemas/events').TRADE} */
      const event = {
        venue:         VENUE,
        symbol,
        exchangeTs:    t.timestamp ? new Date(t.timestamp).getTime() : receivedTs,
        receivedTs,
        tradeId:       String(t.trade_id || Date.now()),
        price,
        size,
        side:          t.side === 'buy' ? 'BUY' : t.side === 'sell' ? 'SELL' : 'UNKNOWN',
        isLiquidation: false,
        isBlockTrade:  false,
        notionalUsd:   price * size,
      };

      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }
}

module.exports = { KrakenAdapter };
