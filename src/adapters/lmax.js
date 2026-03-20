/**
 * LMAX adapter — FIX 4.4 stub.
 *
 * In production this would use a FIX engine (e.g. quickfix) over TCP.
 * This stub simulates:
 *   - L1 BBO at 500ms intervals with randomised FX prices
 *   - Order execution with 50-150ms ACK + FILL latency
 *
 * Required FIX message types (for production implementation):
 *   D  = New Order Single (MsgType=D)
 *   8  = Execution Report (MsgType=8)
 *   W  = Market Data Snapshot/Full Refresh (MsgType=W)
 *   X  = Market Data Incremental Refresh (MsgType=X)
 *   V  = Market Data Request (MsgType=V)
 *   F  = Order Cancel Request (MsgType=F)
 *   G  = Order Cancel/Replace Request (MsgType=G)
 *   0  = Heartbeat (MsgType=0)
 *   A  = Logon (MsgType=A)
 *   5  = Logout (MsgType=5)
 */

'use strict';

const { EventEmitter }  = require('events');
const { v4: uuidv4 }    = require('uuid');
const { normalise }     = require('../core/symbolRegistry');
const { publish }       = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType, OrderState, OrderEventType } = require('../schemas/events');
const venues            = require('../config/venues');

const VENUE = 'LMAX';

// Simulated mid prices for FX pairs
const FX_MIDS = {
  'EUR/USD': 1.0850,
  'GBP/USD': 1.2640,
  'USD/JPY': 154.50,
  'EUR/GBP': 0.8585,
};
const FX_SPREAD_BPS = 2; // 0.2 pips typical LMAX

class LMAXAdapter extends EventEmitter {
  constructor({ publishToBus = true } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this._subscriptions = new Set();
    this._timers        = [];
    this._connected     = false;
  }

  async connect() {
    this._connected = true;
    this.emit('connected');
  }

  async subscribe(venueSymbol) {
    this._subscriptions.add(venueSymbol);
    const mid = FX_MIDS[venueSymbol];
    if (!mid) return;

    const timer = setInterval(() => {
      this._emitBBO(venueSymbol, mid);
    }, 500);
    this._timers.push(timer);
    // Emit first tick immediately
    this._emitBBO(venueSymbol, mid);
  }

  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
  }

  disconnect() {
    this._connected = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this.emit('disconnected');
  }

  /**
   * Simulate sending an order. Returns simulated fill after 50-150ms.
   * @param {object} order
   * @param {string} order.symbol       - Canonical symbol e.g. "EURUSD"
   * @param {string} order.venueSymbol  - "EUR/USD"
   * @param {'BUY'|'SELL'} order.side
   * @param {number} order.quantity
   * @param {number|null} order.limitPrice
   * @returns {Promise<object>} simulated execution report
   */
  async sendOrder({ symbol, venueSymbol, side, quantity, limitPrice }) {
    const orderId      = uuidv4();
    const venueOrderId = `LMAX-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mid          = FX_MIDS[venueSymbol] || 1.0;
    const halfSpread   = mid * FX_SPREAD_BPS / 20_000;
    const fillPrice    = side === 'BUY' ? mid + halfSpread : mid - halfSpread;

    // ACK after 50-150ms
    const latency = 50 + Math.random() * 100;
    return new Promise((resolve) => {
      setTimeout(() => {
        const now = Date.now();

        // Publish fill
        const fill = {
          fillId:          uuidv4(),
          orderId,
          venue:           VENUE,
          symbol,
          side,
          fillPrice:       parseFloat(fillPrice.toFixed(5)),
          fillSize:        quantity,
          fillTs:          now,
          receivedTs:      now,
          commission:      0,
          commissionAsset: symbol.slice(3, 6) || 'USD',
          slippageBps:     0,
          arrivalMid:      mid,
        };

        this.emit('fill', fill);
        if (this.publishToBus) publish(Topics.FILLS, fill, symbol).catch(() => {});

        resolve({ orderId, venueOrderId, state: OrderState.FILLED, fill });
      }, latency);
    });
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _emitBBO(venueSymbol, baseMid) {
    const receivedTs = Date.now();
    const jitter     = (Math.random() - 0.5) * 0.0002 * baseMid; // ~2bps noise
    const mid        = baseMid + jitter;
    const halfSpread = mid * FX_SPREAD_BPS / 20_000;
    const bidPrice   = parseFloat((mid - halfSpread).toFixed(5));
    const askPrice   = parseFloat((mid + halfSpread).toFixed(5));
    const symbol     = normalise(VENUE, venueSymbol, InstrumentClass.FX_SPOT);

    /** @type {import('../schemas/events').L1_BBO} */
    const event = {
      venue: VENUE,
      instrumentClass: InstrumentClass.FX_SPOT,
      symbol,
      venueSymbol,
      exchangeTs:    receivedTs,
      receivedTs,
      sequenceId:    null,
      bidPrice,
      bidSize:       1_000_000 + Math.floor(Math.random() * 4_000_000), // 1-5M notional
      bidOrderCount: 0,
      askPrice,
      askSize:       1_000_000 + Math.floor(Math.random() * 4_000_000),
      askOrderCount: 0,
      midPrice:      parseFloat(mid.toFixed(5)),
      spreadBps:     FX_SPREAD_BPS,
      feedType:      FeedType.FIX,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }
}

module.exports = { LMAXAdapter };
