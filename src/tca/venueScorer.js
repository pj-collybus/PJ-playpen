/**
 * Venue scorer — tracks venue execution quality and ranks venues for order routing.
 *
 * Two modes:
 *   1. Historical tracking: recordFill() builds running scores per venue.
 *   2. Live scoring: scoreVenues() ranks venues for a specific order using
 *      price (40%), liquidity (30%), fees (20%), latency (10%).
 *
 * Usage:
 *   const scorer = require('./venueScorer');
 *   scorer.recordFill('DERIBIT', 'BTC-PERP', { slippageBps: 1.2, latencyMs: 45 });
 *   const ranked = scorer.scoreVenues(venueBBOs, 'BUY', 10);
 */

'use strict';

const fees = require('../config/fees');

const DEFAULT_SCORE = 50;
const MAX_HISTORY   = 500;

/** @type {Map<string, object>} venue → { score, fills[], lastUpdate } */
const _scores = new Map();

function _getEntry(venue) {
  if (!_scores.has(venue)) {
    _scores.set(venue, { score: DEFAULT_SCORE, fills: [], lastUpdate: Date.now() });
  }
  return _scores.get(venue);
}

/**
 * Record a fill and update the venue's historical score.
 * @param {string} venue
 * @param {string} symbol
 * @param {object} analysis
 * @param {number} analysis.slippageBps
 * @param {number} [analysis.latencyMs]
 */
function recordFill(venue, symbol, analysis) {
  const entry = _getEntry(venue);
  entry.fills.push({
    symbol,
    slippageBps: analysis.slippageBps || 0,
    latencyMs:   analysis.latencyMs || 0,
    timestamp:   Date.now(),
  });

  if (entry.fills.length > MAX_HISTORY) {
    entry.fills.splice(0, entry.fills.length - MAX_HISTORY);
  }

  entry.score     = _computeHistoricalScore(entry.fills);
  entry.lastUpdate = Date.now();
}

/**
 * Get historical score for a venue.
 * @param {string} venue
 * @param {string} [symbol] - Filter by symbol (optional)
 * @returns {number} 0-100
 */
function getScore(venue, symbol) {
  const entry = _getEntry(venue);
  if (symbol) {
    const filtered = entry.fills.filter(f => f.symbol === symbol);
    if (filtered.length === 0) return DEFAULT_SCORE;
    return _computeHistoricalScore(filtered);
  }
  return entry.score;
}

/** Get all venue historical scores */
function getAllScores() {
  const out = {};
  for (const [venue, entry] of _scores) {
    out[venue] = entry.score;
  }
  return out;
}

/** Reset all scores */
function reset() {
  _scores.clear();
}

/**
 * Score and rank venues for a specific order.
 *
 * Weights:
 *   priceScore:     40% — best bid (sell) or ask (buy)
 *   liquidityScore: 30% — available size at top 5 levels
 *   feeScore:       20% — estimated fee after rebate
 *   latencyScore:   10% — current connection health (ms)
 *
 * @param {object[]} venues - Array of venue data:
 *   {
 *     venue: string,
 *     bidPrice: number, askPrice: number,
 *     bidSize: number,  askSize: number,
 *     levels: [{ price, size }],   // top 5 levels (optional)
 *     latencyMs: number,           // current WS round-trip (optional)
 *   }
 * @param {'BUY'|'SELL'} side
 * @param {number} size - Order size in base units
 * @returns {{ venue: string, totalScore: number, breakdown: object }[]} Ranked array (best first)
 */
function scoreVenues(venues, side, size) {
  if (!venues || venues.length === 0) return [];

  // Collect raw values for normalisation
  const prices = venues.map(v => side === 'BUY' ? v.askPrice : v.bidPrice).filter(p => p > 0);
  const bestPrice  = side === 'BUY' ? Math.min(...prices) : Math.max(...prices);
  const worstPrice = side === 'BUY' ? Math.max(...prices) : Math.min(...prices);
  const priceRange = Math.abs(bestPrice - worstPrice) || 1;

  const results = [];

  for (const v of venues) {
    const price = side === 'BUY' ? v.askPrice : v.bidPrice;
    if (!price || price <= 0) continue;

    // 1. Price score (40%): 100 = best price, 0 = worst
    let priceScore;
    if (side === 'BUY') {
      priceScore = 100 * (1 - (price - bestPrice) / priceRange);
    } else {
      priceScore = 100 * (1 - (bestPrice - price) / priceRange);
    }
    priceScore = Math.max(0, Math.min(100, priceScore));

    // 2. Liquidity score (30%): ratio of available top-5 size to order size, capped at 100
    let availableSize;
    if (v.levels && v.levels.length > 0) {
      availableSize = v.levels.reduce((sum, lvl) => sum + (lvl.size || 0), 0);
    } else {
      availableSize = side === 'BUY' ? (v.askSize || 0) : (v.bidSize || 0);
    }
    const liquidityScore = Math.min(100, (availableSize / size) * 100);

    // 3. Fee score (20%): lower fee = higher score
    const venueFees = fees[v.venue] || { maker: 5, taker: 5 };
    const takerFee  = venueFees.taker;
    // Normalise: 0 bps → 100, 10 bps → 0
    const feeScore = Math.max(0, Math.min(100, 100 - takerFee * 10));

    // 4. Latency score (10%): lower latency = higher score
    const latencyMs = v.latencyMs || 100; // default 100ms if unknown
    // Normalise: 0ms → 100, 500ms → 0
    const latencyScore = Math.max(0, Math.min(100, 100 - latencyMs / 5));

    const totalScore =
      priceScore     * 0.40 +
      liquidityScore * 0.30 +
      feeScore       * 0.20 +
      latencyScore   * 0.10;

    results.push({
      venue: v.venue,
      totalScore: Math.round(totalScore * 100) / 100,
      breakdown: {
        priceScore:     Math.round(priceScore * 100) / 100,
        liquidityScore: Math.round(liquidityScore * 100) / 100,
        feeScore:       Math.round(feeScore * 100) / 100,
        latencyScore:   Math.round(latencyScore * 100) / 100,
      },
    });
  }

  // Sort descending by totalScore
  results.sort((a, b) => b.totalScore - a.totalScore);
  return results;
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _computeHistoricalScore(fills) {
  if (fills.length === 0) return DEFAULT_SCORE;

  const avgSlippage = fills.reduce((s, f) => s + Math.abs(f.slippageBps), 0) / fills.length;
  const slippageScore = Math.max(0, 100 - avgSlippage * 10);

  const avgLatency = fills.reduce((s, f) => s + f.latencyMs, 0) / fills.length;
  const latencyScore = Math.max(0, 100 - avgLatency / 5);

  const recentWindow = 60_000;
  const now = Date.now();
  const recentFills = fills.filter(f => now - f.timestamp < recentWindow).length;
  const reliabilityScore = Math.min(100, recentFills * 20);

  return Math.round(
    slippageScore    * 0.4 +
    latencyScore     * 0.3 +
    reliabilityScore * 0.3
  );
}

module.exports = { recordFill, getScore, getAllScores, reset, scoreVenues };
