/**
 * Smart Order Router (SOR) — selects optimal venue for execution.
 *
 * Evaluates available venues based on:
 *   1. Best price (primary)
 *   2. Available liquidity at top of book
 *   3. Venue score from TCA history (latency, fill rate, slippage)
 *
 * Usage:
 *   const sor = require('./sorService');
 *   const result = await sor.route({ symbol: 'BTC-PERP', side: 'BUY', quantity: 1 });
 *   // result: { venue: 'DERIBIT', expectedPrice: 67000, reason: '...' }
 */

'use strict';

const marketDataService = require('./marketDataService');
const orderService      = require('./orderService');
const venueScorer       = require('../tca/venueScorer');

/**
 * Route an order to the optimal venue.
 * @param {object} params
 * @param {string} params.symbol       - Canonical symbol
 * @param {'BUY'|'SELL'} params.side
 * @param {number} params.quantity
 * @param {string[]} [params.venues]   - Restrict to these venues (optional)
 * @returns {Promise<object>} { venue, expectedPrice, venueSymbol, score, reason }
 */
async function route({ symbol, side, quantity, venues: allowedVenues }) {
  const venueBBOs = marketDataService.getVenueBBOs(symbol);
  if (!venueBBOs || venueBBOs.size === 0) {
    throw new Error(`No market data available for ${symbol}`);
  }

  const candidates = [];

  for (const [venue, bbo] of venueBBOs) {
    if (allowedVenues && !allowedVenues.includes(venue)) continue;

    const price     = side === 'BUY' ? bbo.askPrice : bbo.bidPrice;
    const size      = side === 'BUY' ? bbo.askSize  : bbo.bidSize;
    if (!price || price <= 0) continue;

    const score     = venueScorer.getScore(venue, symbol);
    const liquidity = Math.min(size / quantity, 1); // 0-1 fill probability

    // Composite score: price advantage (70%) + liquidity (15%) + venue quality (15%)
    // For BUY: lower price is better → invert
    // For SELL: higher price is better
    const priceScore = side === 'BUY' ? 1 / price : price;

    candidates.push({
      venue,
      venueSymbol: bbo.venueSymbol,
      price,
      size,
      liquidity,
      venueScore: score,
      composite:  priceScore * 0.7 + liquidity * 0.15 + (score / 100) * 0.15,
    });
  }

  if (candidates.length === 0) {
    throw new Error(`No venues with valid prices for ${symbol} ${side}`);
  }

  // Sort by composite score descending
  candidates.sort((a, b) => b.composite - a.composite);
  const best = candidates[0];

  return {
    venue:         best.venue,
    venueSymbol:   best.venueSymbol,
    expectedPrice: best.price,
    availableSize: best.size,
    score:         best.composite,
    reason:        `Best ${side} at ${best.venue}: ${best.price} (liq=${best.liquidity.toFixed(2)}, score=${best.venueScore})`,
    alternatives:  candidates.slice(1).map(c => ({
      venue: c.venue, price: c.price, score: c.composite,
    })),
  };
}

/**
 * Route and execute — convenience method.
 * Finds best venue and immediately submits the order.
 */
async function routeAndExecute({ symbol, side, quantity, orderType = 'MARKET', metadata = {} }) {
  const routing = await route({ symbol, side, quantity });

  const order = await orderService.submit({
    symbol,
    venueSymbol: routing.venueSymbol,
    venue:       routing.venue,
    side,
    quantity,
    limitPrice:  orderType === 'MARKET' ? null : routing.expectedPrice,
    orderType,
    algoType:    'SOR',
    metadata:    { ...metadata, sorRouting: routing },
  });

  return { order, routing };
}

module.exports = { route, routeAndExecute };
