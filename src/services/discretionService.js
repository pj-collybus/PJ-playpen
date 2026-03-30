/**
 * DiscretionService — Portable discretion order logic
 *
 * Dependencies: none — pure calculation functions
 *
 * To use in another build:
 * 1. Copy src/services/discretionService.js
 * 2. Wire calculateDiscretionLevels() output to your Sniper/Post+Snipe engine
 * 3. The UI just calls calculateDiscretionLevels() and passes result to order submission
 *
 * No UI dependencies — all functions are pure input/output.
 * The normalise step handles tick-size rounding and percentage allocation.
 */

'use strict';

class DiscretionService {

  // Calculate the discretion ceiling/floor price from bps
  calculateDiscretionPrice(limitPrice, discretionBps, side) {
    const direction = side === 'BUY' ? 1 : -1;
    return limitPrice + direction * (limitPrice * discretionBps / 10000);
  }

  // Calculate the three snipe levels for a discretion order
  // Returns array of { price, pct, levelIndex } for each snipe level
  calculateDiscretionLevels(limitPrice, discretionBps, discretionPct, side, tickSize) {
    const discretionPrice = this.calculateDiscretionPrice(limitPrice, discretionBps, side);
    const range = discretionPrice - limitPrice;
    const pctPerLevel = Math.round(discretionPct / 3 * 10) / 10;
    const lastPct = Math.round((discretionPct - 2 * pctPerLevel) * 10) / 10;

    return [
      { price: this._roundToTick(limitPrice + range * (1/3), tickSize), pct: pctPerLevel, levelIndex: 0, enabled: true },
      { price: this._roundToTick(limitPrice + range * (2/3), tickSize), pct: pctPerLevel, levelIndex: 1, enabled: true },
      { price: this._roundToTick(discretionPrice, tickSize),            pct: lastPct,     levelIndex: 2, enabled: true },
    ];
  }

  // Build the full Sniper strategy params for a discretion order
  buildSniperParams({ limitPrice, discretionBps, discretionPct, side, totalSize, symbol, venue, tickSize, lotSize }) {
    const levels = this.calculateDiscretionLevels(limitPrice, discretionBps, discretionPct, side, tickSize);
    const discretionPrice = this.calculateDiscretionPrice(limitPrice, discretionBps, side);
    const postSize = totalSize * (100 - discretionPct) / 100;
    const snipeSize = totalSize * discretionPct / 100;

    return {
      strategyType: 'SNIPER',
      params: {
        executionMode: 'post_snipe',
        levelMode: 'simultaneous',
        side: side.toUpperCase(),
        totalSize,
        symbol,
        venue,
        tickSize: tickSize || 0.0001,
        lotSize: lotSize || 1,
        targetPrice: limitPrice,
        snipeLevel: discretionPrice,
        snipePct: discretionPct,
        minSnipePct: 5,
        levels,
        isDiscretionOrder: true,
      },
    };
  }

  // Full calculation result for the REST endpoint
  calculate({ limitPrice, discretionBps, discretionPct, side, tickSize, totalSize }) {
    const discretionPrice = this.calculateDiscretionPrice(limitPrice, discretionBps, side);
    const levels = this.calculateDiscretionLevels(limitPrice, discretionBps, discretionPct, side, tickSize);
    const postSize = totalSize ? totalSize * (100 - discretionPct) / 100 : null;
    const snipeSize = totalSize ? totalSize * discretionPct / 100 : null;

    return {
      discretionPrice,
      discretionBps,
      discretionPct,
      side,
      limitPrice,
      levels,
      postSize,
      snipeSize,
    };
  }

  _roundToTick(price, tickSize) {
    if (!tickSize || tickSize <= 0) return price;
    return Math.round(price / tickSize) * tickSize;
  }
}

module.exports = new DiscretionService();
module.exports.DiscretionService = DiscretionService;
