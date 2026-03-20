/**
 * TCA pure functions — slippage, shortfall, and cost analysis.
 *
 * All functions are pure: no database calls, no side effects.
 * Positive values = cost to the trader.
 * Negative values = price improvement.
 */

'use strict';

/**
 * Arrival price slippage in bps.
 *   BUY:  (avgFillPrice - arrivalMid) / arrivalMid * 10000
 *   SELL: (arrivalMid - avgFillPrice) / arrivalMid * 10000
 *
 * @param {object} order
 * @param {string}   order.side          - 'BUY' | 'SELL'
 * @param {number}   order.arrivalMid    - Mid price at order arrival
 * @param {object[]} order.fills         - Array of { fillPrice, fillSize }
 * @returns {number} slippage in bps (positive = cost)
 */
function arrivalSlippage(order) {
  if (!order.arrivalMid || order.arrivalMid <= 0) return 0;
  const avgFill = _avgFillPrice(order.fills);
  if (avgFill === 0) return 0;

  if (order.side === 'BUY') {
    return (avgFill - order.arrivalMid) / order.arrivalMid * 10_000;
  }
  return (order.arrivalMid - avgFill) / order.arrivalMid * 10_000;
}

/**
 * VWAP shortfall in bps — avgFillPrice vs market VWAP over execution window.
 *   BUY:  (avgFillPrice - marketVwap) / marketVwap * 10000
 *   SELL: (marketVwap - avgFillPrice) / marketVwap * 10000
 *
 * @param {object} order
 * @param {string}   order.side
 * @param {object[]} order.fills  - Array of { fillPrice, fillSize }
 * @param {number} marketVwap     - Market VWAP over the execution window
 * @returns {number} shortfall in bps
 */
function vwapShortfall(order, marketVwap) {
  if (!marketVwap || marketVwap <= 0) return 0;
  const avgFill = _avgFillPrice(order.fills);
  if (avgFill === 0) return 0;

  if (order.side === 'BUY') {
    return (avgFill - marketVwap) / marketVwap * 10_000;
  }
  return (marketVwap - avgFill) / marketVwap * 10_000;
}

/**
 * Market impact — price drift during execution.
 *   BUY:  (lastFillPrice - firstFillPrice) / firstFillPrice * 10000
 *   SELL: (firstFillPrice - lastFillPrice) / firstFillPrice * 10000
 *
 * @param {object} firstFill  - { fillPrice }
 * @param {object} lastFill   - { fillPrice }
 * @param {object} order      - { side }
 * @returns {number} impact in bps (positive = adverse drift)
 */
function marketImpact(firstFill, lastFill, order) {
  if (!firstFill || !lastFill || !firstFill.fillPrice || firstFill.fillPrice <= 0) return 0;

  if (order.side === 'BUY') {
    return (lastFill.fillPrice - firstFill.fillPrice) / firstFill.fillPrice * 10_000;
  }
  return (firstFill.fillPrice - lastFill.fillPrice) / firstFill.fillPrice * 10_000;
}

/**
 * Fill-level slippage in bps — single fill vs arrival mid.
 *   BUY:  (fillPrice - arrivalMid) / arrivalMid * 10000
 *   SELL: (arrivalMid - fillPrice) / arrivalMid * 10000
 *
 * @param {object} fill
 * @param {number} fill.fillPrice
 * @param {number} fill.arrivalMid
 * @param {string} fill.side  - 'BUY' | 'SELL'
 * @returns {number} slippage in bps
 */
function fillSlippage(fill) {
  if (!fill.arrivalMid || fill.arrivalMid <= 0) return 0;

  if (fill.side === 'BUY') {
    return (fill.fillPrice - fill.arrivalMid) / fill.arrivalMid * 10_000;
  }
  return (fill.arrivalMid - fill.fillPrice) / fill.arrivalMid * 10_000;
}

/**
 * All-in cost = slippage + fee + half spread.
 *
 * @param {number} slippageBps  - Arrival slippage in bps
 * @param {number} feeRateBps   - Fee rate in bps (taker fee)
 * @param {number} spreadBps    - Bid-ask spread in bps at arrival
 * @returns {number} total cost in bps
 */
function allInCost(slippageBps, feeRateBps, spreadBps) {
  return slippageBps + feeRateBps + (spreadBps / 2);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute VWAP (volume-weighted average fill price) from an array of fills.
 * @param {object[]} fills - Array of { fillPrice, fillSize }
 * @returns {number} VWAP, or 0 if no fills
 */
function _avgFillPrice(fills) {
  if (!fills || fills.length === 0) return 0;
  let totalNotional = 0;
  let totalSize     = 0;
  for (const f of fills) {
    totalNotional += f.fillPrice * f.fillSize;
    totalSize     += f.fillSize;
  }
  return totalSize > 0 ? totalNotional / totalSize : 0;
}

module.exports = { arrivalSlippage, vwapShortfall, marketImpact, fillSlippage, allInCost };
