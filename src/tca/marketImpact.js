/**
 * Market impact estimation.
 *
 * Uses a simplified square-root model (Almgren-Chriss inspired):
 *   impact_bps = sigma * sqrt(quantity / ADV) * coefficient
 *
 * Where:
 *   sigma       = daily volatility (bps, estimated or from config)
 *   ADV         = average daily volume
 *   coefficient = asset-class-specific scaling factor
 *
 * This is a stub — in production, sigma and ADV would come from the tick store.
 *
 * Usage:
 *   const mi = require('./marketImpact');
 *   const bps = mi.estimate({ symbol: 'BTC-PERP', side: 'BUY', size: 10, price: 67000 });
 */

'use strict';

// Default parameters per asset class (will be replaced by real data)
const DEFAULTS = {
  CRYPTO_PERP:   { sigma: 200, adv: 50_000,    coeff: 0.5 },   // ~2% daily vol, 50K BTC/day
  CRYPTO_SPOT:   { sigma: 200, adv: 30_000,    coeff: 0.5 },
  CRYPTO_FUTURE: { sigma: 200, adv: 20_000,    coeff: 0.5 },
  FX_SPOT:       { sigma: 50,  adv: 500_000_000, coeff: 0.3 },  // ~0.5% daily vol, $500M+/day
};

// Override cache: symbol → { sigma, adv }
const _overrides = new Map();

/**
 * Estimate market impact in basis points.
 * @param {object} params
 * @param {string} params.symbol
 * @param {'BUY'|'SELL'} params.side
 * @param {number} params.size        - Order size in base units
 * @param {number} params.price       - Current price
 * @param {string} [params.instrumentClass] - If known
 * @returns {number} Estimated impact in bps (always positive)
 */
function estimate({ symbol, side, size, price, instrumentClass }) {
  const cls = instrumentClass || _inferClass(symbol);
  const defaults = DEFAULTS[cls] || DEFAULTS.CRYPTO_PERP;
  const override = _overrides.get(symbol) || {};

  const sigma = override.sigma || defaults.sigma;
  const adv   = override.adv   || defaults.adv;
  const coeff = defaults.coeff;

  const notional = size * price;
  const participation = cls.startsWith('FX') ? notional / adv : size / adv;

  // Square-root model
  const impact = sigma * Math.sqrt(Math.max(0, participation)) * coeff;

  return Math.round(impact * 100) / 100; // 2 decimal places
}

/**
 * Set override parameters for a specific symbol.
 * @param {string} symbol
 * @param {object} params
 * @param {number} [params.sigma] - Daily volatility in bps
 * @param {number} [params.adv]   - Average daily volume
 */
function setParams(symbol, params) {
  _overrides.set(symbol, params);
}

function _inferClass(symbol) {
  if (symbol.length === 6 && /^[A-Z]{6}$/.test(symbol)) return 'FX_SPOT';
  if (symbol.endsWith('-PERP')) return 'CRYPTO_PERP';
  if (/\d{8}$/.test(symbol))   return 'CRYPTO_FUTURE';
  return 'CRYPTO_SPOT';
}

module.exports = { estimate, setParams };
