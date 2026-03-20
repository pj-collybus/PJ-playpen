/**
 * Market data service — aggregates L1 BBO from all venues.
 *
 * Maintains a real-time composite best bid/offer across all connected venues
 * for each canonical symbol. Services and UI can query the latest state or
 * subscribe to updates.
 *
 * Usage:
 *   const mds = require('./marketDataService');
 *   await mds.start();
 *   const bbo = mds.getBBO('BTC-PERP');           // latest composite BBO
 *   const venues = mds.getVenueBBOs('BTC-PERP');   // per-venue breakdown
 *   mds.on('bbo', (compositeBBO) => { ... });
 */

'use strict';

const { EventEmitter } = require('events');
const { subscribe, Topics } = require('../core/eventBus');

class MarketDataService extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Map<string, object>>} symbol → (venue → L1_BBO) */
    this._bbos = new Map();
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    await subscribe(Topics.L1_BBO, 'marketDataService', async (event) => {
      this._update(event);
    });
  }

  /**
   * Get composite best bid/offer across all venues for a symbol.
   * @param {string} symbol - Canonical symbol
   * @returns {object|null} { bestBid, bestBidVenue, bestAsk, bestAskVenue, midPrice, spreadBps, venues: [...] }
   */
  getBBO(symbol) {
    const venueMap = this._bbos.get(symbol);
    if (!venueMap || venueMap.size === 0) return null;

    let bestBid = 0, bestBidVenue = '', bestBidSize = 0;
    let bestAsk = Infinity, bestAskVenue = '', bestAskSize = 0;

    for (const [venue, bbo] of venueMap) {
      if (bbo.bidPrice > bestBid) {
        bestBid      = bbo.bidPrice;
        bestBidVenue = venue;
        bestBidSize  = bbo.bidSize;
      }
      if (bbo.askPrice < bestAsk && bbo.askPrice > 0) {
        bestAsk      = bbo.askPrice;
        bestAskVenue = venue;
        bestAskSize  = bbo.askSize;
      }
    }

    if (bestAsk === Infinity) bestAsk = 0;
    const midPrice  = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
    const spreadBps = midPrice > 0 ? (bestAsk - bestBid) / midPrice * 10_000 : 0;

    return {
      symbol,
      bestBid,
      bestBidVenue,
      bestBidSize,
      bestAsk,
      bestAskVenue,
      bestAskSize,
      midPrice,
      spreadBps,
      venues: Array.from(venueMap.keys()),
      updatedTs: Date.now(),
    };
  }

  /**
   * Get per-venue BBO breakdown for a symbol.
   * @param {string} symbol
   * @returns {Map<string, object>} venue → L1_BBO
   */
  getVenueBBOs(symbol) {
    return this._bbos.get(symbol) || new Map();
  }

  /** List all symbols with at least one venue BBO */
  getSymbols() {
    return Array.from(this._bbos.keys());
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _update(event) {
    const { symbol, venue } = event;
    if (!this._bbos.has(symbol)) this._bbos.set(symbol, new Map());
    this._bbos.get(symbol).set(venue, event);

    const composite = this.getBBO(symbol);
    if (composite) this.emit('bbo', composite);
  }
}

// Singleton
const instance = new MarketDataService();
module.exports = instance;
