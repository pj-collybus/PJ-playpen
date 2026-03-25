/**
 * Price oracle — single source of truth for current mark prices and USD conversion.
 *
 * Subscribes to L1_BBO events on the event bus, maintains a cache of current
 * mark prices per venue::symbol. Exposes getUsdValue() for converting any
 * position size to USD using the correct method per contract type.
 *
 * Usage:
 *   const priceOracle = require('./priceOracle');
 *   await priceOracle.start();
 *   const usd = await priceOracle.getUsdValue('BITMEX', 'XRPUSD', 10);
 */

'use strict';

const { subscribe, Topics } = require('../core/eventBus');

/** @type {Map<string, { price: number, bid: number, ask: number, ts: number }>} */
const _prices = new Map(); // `${venue}::${symbol}` → price data

let _started = false;

// BTC/USD price — needed for QUANTO USD conversion
let _btcUsdPrice = 97000; // sensible default

async function start() {
  if (_started) return;
  _started = true;

  // Listen for L1_BBO ticker events
  await subscribe(Topics.L1_BBO, 'priceOracle-l1', async (event) => {
    const key = `${event.venue}::${event.venueSymbol || event.symbol}`;
    const mid = event.midPrice || ((event.bidPrice || 0) + (event.askPrice || 0)) / 2;
    if (mid > 0) {
      _updatePrice(key, mid, event.bidPrice || 0, event.askPrice || 0);
      const sym = (event.venueSymbol || event.symbol || '').toUpperCase();
      if ((sym === 'XBTUSD' || sym === 'BTC-PERPETUAL' || sym === 'BTCUSD') && mid > 1000) {
        _btcUsdPrice = mid;
      }
    }
  });

  // Also extract prices from POSITION events (positions carry markPrice)
  await subscribe(Topics.POSITIONS, 'priceOracle-pos', async (pos) => {
    if (pos.markPrice && pos.markPrice > 0) {
      const key = `${pos.venue}::${pos.symbol}`;
      console.log('[oracle] price from position:', pos.venue, pos.symbol, pos.markPrice);
      _updatePrice(key, pos.markPrice, 0, 0);
    }
  });

  // Also extract prices from FILL events
  await subscribe(Topics.FILLS, 'priceOracle-fills', async (fill) => {
    if (fill.fillPrice && fill.fillPrice > 0) {
      const key = `${fill.venue}::${fill.symbol}`;
      _updatePrice(key, fill.fillPrice, 0, 0);
    }
  });

  console.log('[priceOracle] Started — listening for L1_BBO, POSITIONS, FILLS');
}

function _updatePrice(key, price, bid, ask) {
  const existing = _prices.get(key);
  _prices.set(key, {
    price,
    bid: bid || existing?.bid || 0,
    ask: ask || existing?.ask || 0,
    ts: Date.now(),
  });
}

/**
 * Get current mark price for a venue + symbol.
 * @returns {{ price: number, bid: number, ask: number, ts: number } | null}
 */
function getPrice(venue, symbol) {
  return _prices.get(`${venue}::${symbol}`) || null;
}

/**
 * Get current BTC/USD price (from any venue's XBTUSD/BTC-PERPETUAL feed).
 */
function getBtcUsdPrice() {
  return _btcUsdPrice;
}

/**
 * Convert a position size to USD notional value.
 * Uses instrumentSpecService to determine the correct conversion method.
 *
 * @param {string} venue
 * @param {string} symbol
 * @param {number} size - position size (in exchange-native units or base currency)
 * @param {number} [markPrice] - optional override; uses cached price if not provided
 * @returns {Promise<{ usdValue: number, method: string, estimated: boolean }>}
 */
async function getUsdValue(venue, symbol, size, markPrice) {
  const specService = require('./instrumentSpecService');
  const spec = await specService.getSpec(venue, symbol);
  const cached = getPrice(venue, symbol);
  const px = markPrice || cached?.price || 0;

  if (!spec) {
    // Fallback: best-effort approximation
    const approx = Math.abs(size) * (px || 1);
    return { usdValue: approx, method: 'fallback', estimated: true };
  }

  let usdValue;
  let method;

  // All adapters convert position sizes to base currency before publishing.
  // USD value = |size in base| × markPrice for everything except QUANTO.
  // QUANTO: adapters already convert to base XRP, so still size × markPrice.
  if (spec.isQuanto && px > 0) {
    // Quanto positions are already converted to base units by the adapter.
    // USD value = base size × underlying mark price
    usdValue = Math.abs(size) * px;
    method = 'quanto';
  } else if (spec.isInverse && px > 0) {
    // Inverse positions converted to base units by adapter: size × markPrice = USD
    usdValue = Math.abs(size) * px;
    method = 'inverse';
  } else if (px > 0) {
    // Linear (USDT/USDC/USD): size in base × markPrice = USD
    usdValue = Math.abs(size) * px;
    const settl = spec.settleCurrency || spec.quoteCurrency || '';
    method = `linear-${settl.toLowerCase() || 'usd'}`;
  } else {
    // Coin-margined or unknown: size × markPrice as best effort
    usdValue = Math.abs(size) * (px || 1);
    method = 'coin-margined';
  }

  return { usdValue, method, estimated: false };
}

/** Cache stats */
function stats() {
  return {
    priceEntries: _prices.size,
    btcUsdPrice: _btcUsdPrice,
    symbols: Array.from(_prices.keys()),
  };
}

module.exports = { start, getPrice, getBtcUsdPrice, getUsdValue, stats };
