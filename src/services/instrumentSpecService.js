/**
 * Instrument spec service — fetches and caches full instrument specifications
 * from each exchange. Single source of truth for lotSize, tickSize, contractType,
 * multiplier, baseCurrency, quoteCurrency, etc.
 *
 * Usage:
 *   const specService = require('./instrumentSpecService');
 *   const spec = await specService.getSpec('BITMEX', 'XRPUSD');
 *   // { lotSize: 1, tickSize: 0.0001, contractType: 'INVERSE', multiplier: -100000000, ... }
 */

'use strict';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes (short for development)

/** @type {Map<string, { spec: object, fetchedAt: number }>} */
const _cache = new Map();

/** Exchange-wide instrument lists (fetched once per exchange per TTL) */
const _listCache = new Map();

const TESTNET = process.env.USE_TESTNET !== 'false';

// ── Fetchers per exchange ────────────────────────────────────────────────────

const FETCHERS = {
  async BITMEX(symbol) {
    const base = TESTNET ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const r = await fetch(`${base}/api/v1/instrument?symbol=${encodeURIComponent(symbol)}`);
    const arr = await r.json();
    const i = Array.isArray(arr) ? arr[0] : arr;
    if (!i || i.error) return null;

    const settl = (i.settlCurrency || '').toUpperCase();
    const quote = (i.quoteCurrency || '').toUpperCase();

    // Use BitMEX's own boolean fields — never infer from currency names
    let contractType;
    if (i.isQuanto) contractType = 'QUANTO';
    else if (i.isInverse) contractType = 'INVERSE';
    else contractType = 'LINEAR';

    return {
      exchange: 'BITMEX', symbol: i.symbol,
      lotSize: i.lotSize || 1,
      tickSize: i.tickSize || 0.0001,
      contractType,
      multiplier: i.multiplier || 1,
      baseCurrency: i.rootSymbol || (i.underlying || '').replace('.', '') || symbol.replace(/USD.*/, ''),
      quoteCurrency: quote,
      settleCurrency: settl === 'XBT' ? 'BTC' : settl,
      minOrderSize: i.lotSize || 1,
      maxOrderSize: i.maxOrderQty || 10000000,
      contractValue: i.multiplier ? Math.abs(i.multiplier) / 1e8 : 1,
      isInverse: !!i.isInverse,
      isQuanto: !!i.isQuanto,
    };
  },

  async BYBIT(symbol) {
    const cat = symbol.endsWith('USDT') || symbol.endsWith('USDC') ? 'linear' : 'inverse';
    const r = await fetch(`https://api.bybit.com/v5/market/instruments-info?category=${cat}&symbol=${encodeURIComponent(symbol)}`);
    const j = await r.json();
    const i = j.result?.list?.[0];
    if (!i) return null;

    return {
      exchange: 'BYBIT', symbol: i.symbol,
      lotSize: parseFloat(i.lotSizeFilter?.qtyStep) || 1,
      tickSize: parseFloat(i.priceFilter?.tickSize) || 0.01,
      contractType: cat === 'inverse' ? 'INVERSE' : 'LINEAR',
      multiplier: 1,
      baseCurrency: i.baseCoin || symbol.replace(/USDT$|USDC$|USD$/, ''),
      quoteCurrency: i.quoteCoin || 'USDT',
      settleCurrency: i.settleCoin || i.quoteCoin || 'USDT',
      minOrderSize: parseFloat(i.lotSizeFilter?.minOrderQty) || 0.001,
      maxOrderSize: parseFloat(i.lotSizeFilter?.maxOrderQty) || 100000,
      isInverse: cat === 'inverse',
    };
  },

  async DERIBIT(symbol) {
    const base = TESTNET ? 'https://test.deribit.com' : 'https://www.deribit.com';
    const r = await fetch(`${base}/api/v2/public/get_instrument?instrument_name=${encodeURIComponent(symbol)}`);
    const j = await r.json();
    const i = j.result;
    if (!i) return null;

    const isInv = i.quote_currency === 'USD';
    return {
      exchange: 'DERIBIT', symbol: i.instrument_name,
      lotSize: i.min_trade_amount || (isInv ? 10 : 0.001),
      tickSize: i.tick_size || 0.01,
      contractType: isInv ? 'INVERSE' : 'LINEAR',
      multiplier: i.contract_size || 1,
      baseCurrency: i.base_currency || symbol.split('-')[0],
      quoteCurrency: i.quote_currency || 'USD',
      settleCurrency: i.settlement_currency || i.quote_currency || 'USD',
      minOrderSize: i.min_trade_amount || (isInv ? 10 : 0.001),
      maxOrderSize: i.max_trade_amount || 1000000,
      isInverse: isInv,
    };
  },

  async OKX(symbol) {
    const instType = symbol.endsWith('-SWAP') ? 'SWAP' : symbol.includes('-') ? 'SPOT' : 'SWAP';
    const r = await fetch(`https://www.okx.com/api/v5/public/instruments?instType=${instType}&instId=${encodeURIComponent(symbol)}`);
    const j = await r.json();
    const i = j.data?.[0];
    if (!i) return null;

    const ctType = (i.ctType || '').toLowerCase();
    return {
      exchange: 'OKX', symbol: i.instId,
      lotSize: parseFloat(i.lotSz) || 1,
      tickSize: parseFloat(i.tickSz) || 0.01,
      contractType: ctType === 'inverse' ? 'INVERSE' : 'LINEAR',
      multiplier: parseFloat(i.ctMul) || 1,
      baseCurrency: i.ctValCcy || i.baseCcy || symbol.split('-')[0],
      quoteCurrency: i.quoteCcy || i.settleCcy || 'USDT',
      settleCurrency: i.settleCcy || i.quoteCcy || 'USDT',
      minOrderSize: parseFloat(i.minSz) || 1,
      maxOrderSize: parseFloat(i.maxLmtSz) || 100000,
      isInverse: ctType === 'inverse',
    };
  },

  async KRAKEN(symbol) {
    // Futures symbols (PF_, PI_, FI_)
    if (/^(PF_|PI_|FI_)/.test(symbol)) {
      const r = await fetch('https://futures.kraken.com/derivatives/api/v3/instruments');
      const j = await r.json();
      const i = (j.instruments || []).find(x => x.symbol === symbol);
      if (!i) return null;
      const isInv = i.type === 'inverse_futures' || (i.marginLevels && !symbol.includes('USDT'));
      return {
        exchange: 'KRAKEN', symbol: i.symbol,
        lotSize: i.contractSize || 1,
        tickSize: i.tickSize || 0.01,
        contractType: isInv ? 'INVERSE' : 'LINEAR',
        multiplier: i.contractSize || 1,
        baseCurrency: (i.symbol || '').replace(/^(PF_|PI_|FI_)/, '').replace(/USD$/, ''),
        quoteCurrency: 'USD',
        settleCurrency: 'USD',
        minOrderSize: i.contractSize || 1,
        maxOrderSize: 1000000,
        isInverse: isInv,
      };
    }
    // Spot
    const r = await fetch('https://api.kraken.com/0/public/AssetPairs');
    const j = await r.json();
    const pair = j.result?.[symbol];
    if (!pair) return null;
    return {
      exchange: 'KRAKEN', symbol,
      lotSize: parseFloat(pair.lot_decimals ? Math.pow(10, -pair.lot_decimals) : 0.001),
      tickSize: parseFloat(pair.pair_decimals ? Math.pow(10, -pair.pair_decimals) : 0.01),
      contractType: 'LINEAR',
      multiplier: 1,
      baseCurrency: pair.base || symbol.split('/')[0],
      quoteCurrency: pair.quote || 'USD',
      settleCurrency: pair.quote || 'USD',
      minOrderSize: parseFloat(pair.ordermin) || 0.001,
      maxOrderSize: 1000000,
      isInverse: false,
    };
  },

  async BINANCE(symbol) {
    const r = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const j = await r.json();
    const i = (j.symbols || []).find(x => x.symbol === symbol);
    if (!i) return null;
    const priceFilter = (i.filters || []).find(f => f.filterType === 'PRICE_FILTER');
    const lotFilter = (i.filters || []).find(f => f.filterType === 'LOT_SIZE');
    return {
      exchange: 'BINANCE', symbol: i.symbol,
      lotSize: parseFloat(lotFilter?.stepSize) || 0.001,
      tickSize: parseFloat(priceFilter?.tickSize) || 0.01,
      contractType: 'LINEAR',
      multiplier: 1,
      baseCurrency: i.baseAsset || symbol.replace(/USDT$|USDC$|BUSD$/, ''),
      quoteCurrency: i.quoteAsset || 'USDT',
      settleCurrency: i.marginAsset || i.quoteAsset || 'USDT',
      minOrderSize: parseFloat(lotFilter?.minQty) || 0.001,
      maxOrderSize: parseFloat(lotFilter?.maxQty) || 1000000,
      isInverse: false,
    };
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the instrument spec for a given exchange + symbol.
 * Fetches from the exchange API on first call, caches for 1 hour.
 *
 * @param {string} exchange - e.g. 'BITMEX', 'BYBIT'
 * @param {string} symbol   - venue-native symbol e.g. 'XRPUSD', 'XRPUSDT'
 * @returns {Promise<object|null>} spec or null if not found
 */
async function getSpec(exchange, symbol) {
  const exch = (exchange || '').toUpperCase();
  const key = `${exch}::${symbol}`;

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    console.log(`[spec] CACHE HIT: ${exch} ${symbol} contractType=${cached.spec.contractType}`);
    return cached.spec;
  }

  const fetcher = FETCHERS[exch];
  if (!fetcher) {
    console.warn(`[instrumentSpec] No fetcher for exchange: ${exch}`);
    return null;
  }

  try {
    const spec = await fetcher(symbol);
    if (spec) {
      _cache.set(key, { spec, fetchedAt: Date.now() });
      console.log(`[spec] FRESH FETCH: ${exch} ${symbol} contractType=${spec.contractType} lotSize=${spec.lotSize} isQuanto=${spec.isQuanto} isInverse=${spec.isInverse}`);
    }
    return spec;
  } catch (e) {
    console.error(`[instrumentSpec] Fetch failed for ${exch}::${symbol}:`, e.message);
    return cached?.spec || null;
  }
}

/**
 * Invalidate a cached spec (e.g. after an exchange listing change).
 */
function invalidate(exchange, symbol) {
  _cache.delete(`${(exchange || '').toUpperCase()}::${symbol}`);
}

/** Clear entire cache */
function clearAll() { _cache.clear(); }

/** Get cache stats */
function stats() {
  return { entries: _cache.size, keys: Array.from(_cache.keys()) };
}

/**
 * Synchronous cache peek — returns cached spec or null.
 * Used in hot WS paths that can't await. Does NOT trigger a fetch.
 */
function _peekCache(exchange, symbol) {
  const key = `${(exchange || '').toUpperCase()}::${symbol}`;
  const cached = _cache.get(key);
  return (cached && Date.now() - cached.fetchedAt < CACHE_TTL) ? cached.spec : null;
}

/** Get the live BTC mark price from BitMEX XBTUSD stream */
function getBtcMarkPrice() {
  try {
    return require('../adapters/bitmex').getBtcMarkPrice();
  } catch { return 97000; }
}

module.exports = { getSpec, invalidate, clearAll, stats, _peekCache, getBtcMarkPrice };
