/**
 * Symbol registry — canonical symbol normalisation.
 *
 * Canonical formats:
 *   FX Spot:       "EURUSD"           (no separator)
 *   Crypto Spot:   "BTC-USDT"         (hyphen, quote on right)
 *   Crypto Perp:   "BTC-PERP"
 *   Crypto Future: "BTC-20260926"     (YYYYMMDD expiry)
 *
 * Usage:
 *   const { normalise, register } = require('./symbolRegistry');
 *   const sym = normalise('BINANCE', 'BTCUSDT', 'CRYPTO_SPOT'); // → "BTC-USDT"
 */

'use strict';

const { InstrumentClass } = require('../schemas/events');

/**
 * Map: `${venue}::${venueSymbol}` → canonical symbol string
 * Populated by register() and the seed table below.
 */
const _registry = new Map();

/**
 * Register a venue symbol → canonical symbol mapping.
 * @param {string} venue
 * @param {string} venueSymbol   - Raw symbol as the venue uses it
 * @param {string} canonical     - Canonical symbol
 * @param {string} instrumentClass
 */
function register(venue, venueSymbol, canonical, instrumentClass) {
  _registry.set(`${venue}::${venueSymbol}`, { canonical, instrumentClass });
}

/**
 * Normalise a venue symbol to its canonical form.
 * Falls back to a best-effort heuristic if no explicit mapping exists.
 *
 * @param {string} venue
 * @param {string} venueSymbol
 * @param {string} instrumentClass
 * @returns {string} canonical symbol
 */
function normalise(venue, venueSymbol, instrumentClass) {
  const key = `${venue}::${venueSymbol}`;
  if (_registry.has(key)) return _registry.get(key).canonical;

  // Heuristic fallback
  const s = venueSymbol.toUpperCase();
  if (instrumentClass === InstrumentClass.CRYPTO_PERP) {
    const base = s.replace(/-?(PERPETUAL|PERP|USD|USDT|USDC|BUSD|SWAP|_PERP|-PERP)$/i, '');
    return `${base}-PERP`;
  }
  if (instrumentClass === InstrumentClass.FX_SPOT) {
    return s.replace(/[^A-Z]/g, '').slice(0, 6);
  }
  // Crypto spot / future — return as-is but normalised
  return s.replace('_', '-');
}

/**
 * Look up the instrumentClass for a registered symbol.
 * Returns null if not in the explicit registry.
 */
function getInstrumentClass(venue, venueSymbol) {
  const entry = _registry.get(`${venue}::${venueSymbol}`);
  return entry ? entry.instrumentClass : null;
}

/** Return all registered entries as an array of { venue, venueSymbol, canonical, instrumentClass } */
function list() {
  return Array.from(_registry.entries()).map(([k, v]) => {
    const [venue, venueSymbol] = k.split('::');
    return { venue, venueSymbol, canonical: v.canonical, instrumentClass: v.instrumentClass };
  });
}

// ── Seed table — top-20 symbols across major venues ──────────────────────────

const SEED = [
  // Deribit
  ['DERIBIT', 'BTC-PERPETUAL',   'BTC-PERP',   InstrumentClass.CRYPTO_PERP],
  ['DERIBIT', 'ETH-PERPETUAL',   'ETH-PERP',   InstrumentClass.CRYPTO_PERP],
  ['DERIBIT', 'SOL-PERPETUAL',   'SOL-PERP',   InstrumentClass.CRYPTO_PERP],
  ['DERIBIT', 'BNB-PERPETUAL',   'BNB-PERP',   InstrumentClass.CRYPTO_PERP],
  ['DERIBIT', 'XRP-PERPETUAL',   'XRP-PERP',   InstrumentClass.CRYPTO_PERP],

  // Binance — spot
  ['BINANCE', 'BTCUSDT',  'BTC-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['BINANCE', 'ETHUSDT',  'ETH-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['BINANCE', 'SOLUSDT',  'SOL-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['BINANCE', 'BNBUSDT',  'BNB-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['BINANCE', 'XRPUSDT',  'XRP-USDT',  InstrumentClass.CRYPTO_SPOT],
  // Binance — perp
  ['BINANCE', 'BTCUSDT_PERP',  'BTC-PERP',  InstrumentClass.CRYPTO_PERP],
  ['BINANCE', 'ETHUSDT_PERP',  'ETH-PERP',  InstrumentClass.CRYPTO_PERP],

  // Bybit
  ['BYBIT', 'BTCUSDT',   'BTC-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['BYBIT', 'ETHUSDT',   'ETH-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['BYBIT', 'BTCPERP',   'BTC-PERP',  InstrumentClass.CRYPTO_PERP],
  ['BYBIT', 'ETHPERP',   'ETH-PERP',  InstrumentClass.CRYPTO_PERP],

  // OKX
  ['OKX', 'BTC-USDT',      'BTC-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['OKX', 'ETH-USDT',      'ETH-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['OKX', 'BTC-USDT-SWAP', 'BTC-PERP',  InstrumentClass.CRYPTO_PERP],
  ['OKX', 'ETH-USDT-SWAP', 'ETH-PERP',  InstrumentClass.CRYPTO_PERP],
  ['OKX', 'SOL-USDT-SWAP', 'SOL-PERP',  InstrumentClass.CRYPTO_PERP],

  // Kraken
  ['KRAKEN', 'XBT/USD',   'BTC-USD',   InstrumentClass.CRYPTO_SPOT],
  ['KRAKEN', 'ETH/USD',   'ETH-USD',   InstrumentClass.CRYPTO_SPOT],
  ['KRAKEN', 'XBT/USDT',  'BTC-USDT',  InstrumentClass.CRYPTO_SPOT],
  ['KRAKEN', 'SOL/USD',   'SOL-USD',   InstrumentClass.CRYPTO_SPOT],
  ['KRAKEN', 'PI_XBTUSD', 'BTC-PERP',  InstrumentClass.CRYPTO_PERP],

  // FX — LMAX / EBS / 360T
  ['LMAX', 'EUR/USD', 'EURUSD', InstrumentClass.FX_SPOT],
  ['LMAX', 'GBP/USD', 'GBPUSD', InstrumentClass.FX_SPOT],
  ['LMAX', 'USD/JPY', 'USDJPY', InstrumentClass.FX_SPOT],
  ['LMAX', 'EUR/GBP', 'EURGBP', InstrumentClass.FX_SPOT],
  ['EBS',  'EUR/USD', 'EURUSD', InstrumentClass.FX_SPOT],
  ['EBS',  'USD/JPY', 'USDJPY', InstrumentClass.FX_SPOT],
  ['EBS',  'GBP/USD', 'GBPUSD', InstrumentClass.FX_SPOT],
  ['360T', 'EUR/USD', 'EURUSD', InstrumentClass.FX_SPOT],
  ['360T', 'GBP/USD', 'GBPUSD', InstrumentClass.FX_SPOT],
  ['360T', 'USD/JPY', 'USDJPY', InstrumentClass.FX_SPOT],
];

for (const [venue, venueSymbol, canonical, instrumentClass] of SEED) {
  register(venue, venueSymbol, canonical, instrumentClass);
}

module.exports = { normalise, register, getInstrumentClass, list, InstrumentClass };
