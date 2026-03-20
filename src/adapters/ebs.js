/**
 * EBS adapter — FIX 4.4 stub.
 *
 * Simulates EBS Market (interbank FX) with:
 *   - L1 BBO at 500ms with randomised FX prices (tighter spreads than LMAX)
 *   - Order execution with 50-150ms ACK + FILL latency
 *
 * Required FIX message types (production):
 *   D  = New Order Single
 *   8  = Execution Report
 *   W  = Market Data Snapshot/Full Refresh
 *   X  = Market Data Incremental Refresh
 *   F  = Order Cancel Request
 *   0  = Heartbeat
 *   A  = Logon
 *   5  = Logout
 */

'use strict';

const { EventEmitter }  = require('events');
const { v4: uuidv4 }    = require('uuid');
const { normalise }     = require('../core/symbolRegistry');
const { publish }       = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType, OrderState } = require('../schemas/events');

const VENUE = 'EBS';

const FX_MIDS = {
  'EUR/USD': 1.0850,
  'USD/JPY': 154.50,
  'GBP/USD': 1.2640,
};
const FX_SPREAD_BPS = 1; // EBS is tighter — ~0.1 pips on majors

class EBSAdapter extends EventEmitter {
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

    const timer = setInterval(() => this._emitBBO(venueSymbol, mid), 500);
    this._timers.push(timer);
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

  async sendOrder({ symbol, venueSymbol, side, quantity, limitPrice }) {
    const orderId      = uuidv4();
    const venueOrderId = `EBS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const mid          = FX_MIDS[venueSymbol] || 1.0;
    const halfSpread   = mid * FX_SPREAD_BPS / 20_000;
    const fillPrice    = side === 'BUY' ? mid + halfSpread : mid - halfSpread;

    const latency = 50 + Math.random() * 100;
    return new Promise((resolve) => {
      setTimeout(() => {
        const now = Date.now();
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
          commissionAsset: 'USD',
          slippageBps:     0,
          arrivalMid:      mid,
        };

        this.emit('fill', fill);
        if (this.publishToBus) publish(Topics.FILLS, fill, symbol).catch(() => {});
        resolve({ orderId, venueOrderId, state: OrderState.FILLED, fill });
      }, latency);
    });
  }

  _emitBBO(venueSymbol, baseMid) {
    const receivedTs = Date.now();
    const jitter     = (Math.random() - 0.5) * 0.00015 * baseMid;
    const mid        = baseMid + jitter;
    const halfSpread = mid * FX_SPREAD_BPS / 20_000;
    const bidPrice   = parseFloat((mid - halfSpread).toFixed(5));
    const askPrice   = parseFloat((mid + halfSpread).toFixed(5));
    const symbol     = normalise(VENUE, venueSymbol, InstrumentClass.FX_SPOT);

    const event = {
      venue: VENUE,
      instrumentClass: InstrumentClass.FX_SPOT,
      symbol,
      venueSymbol,
      exchangeTs:    receivedTs,
      receivedTs,
      sequenceId:    null,
      bidPrice,
      bidSize:       2_000_000 + Math.floor(Math.random() * 8_000_000),
      bidOrderCount: 0,
      askPrice,
      askSize:       2_000_000 + Math.floor(Math.random() * 8_000_000),
      askOrderCount: 0,
      midPrice:      parseFloat(mid.toFixed(5)),
      spreadBps:     FX_SPREAD_BPS,
      feedType:      FeedType.FIX,
    };

    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }
}

module.exports = { EBSAdapter };
