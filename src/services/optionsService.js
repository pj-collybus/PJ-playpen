/**
 * OptionsService — Portable Deribit options data service
 *
 * Dependencies: none (uses native fetch)
 *
 * To use in another build:
 * 1. Copy src/services/optionsService.js
 * 2. Add the REST endpoints from server.js (/api/options/*)
 * 3. Call GET /api/options/matrix with your filter params
 * 4. Render the returned { strikes, expiries, cells, indexPrice, atmStrike } as a grid
 *
 * The normalise() method handles all Deribit-specific price calculations
 * including inverse vs USDC option price conversion.
 */

'use strict';

class OptionsService {
  constructor() {
    this._cache = new Map();       // cacheKey → { data, timestamp }
    this._indexPrices = new Map();  // 'btc_usd' → price
    this._cacheTtlMs = 10000;      // 10 second cache
  }

  // ── Fetch all options for a currency from Deribit ──────────────────────────
  // currency: 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'USDC'
  // testnet: boolean
  async fetchBookSummary(currency, testnet = true) {
    const cacheKey = `book:${currency}:${testnet}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._cacheTtlMs) {
      return cached.data;
    }
    const base = testnet ? 'https://test.deribit.com' : 'https://www.deribit.com';
    const url = `${base}/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
    const res = await fetch(url);
    const json = await res.json();
    const data = json.result || [];
    this._cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  }

  // ── Fetch current index price ─────────────────────────────────────────────
  // indexName: 'btc_usd' | 'eth_usd' | 'sol_usd' | 'xrp_usd'
  async fetchIndexPrice(indexName, testnet = true) {
    const cacheKey = `idx:${indexName}:${testnet}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._cacheTtlMs) {
      return cached.data;
    }
    const base = testnet ? 'https://test.deribit.com' : 'https://www.deribit.com';
    const url = `${base}/api/v2/public/get_index_price?index_name=${indexName}`;
    const res = await fetch(url);
    const json = await res.json();
    const price = json.result?.index_price || 0;
    this._indexPrices.set(indexName, price);
    this._cache.set(cacheKey, { data: price, timestamp: Date.now() });
    return price;
  }

  // ── Instrument definitions ────────────────────────────────────────────────
  static INSTRUMENTS = {
    'BTC':      { currency: 'BTC',  inverse: true,  prefix: 'BTC-',      indexName: 'btc_usd' },
    'BTC_USDC': { currency: 'USDC', inverse: false, prefix: 'BTC_USDC-', indexName: 'btc_usd' },
    'ETH':      { currency: 'ETH',  inverse: true,  prefix: 'ETH-',      indexName: 'eth_usd' },
    'ETH_USDC': { currency: 'USDC', inverse: false, prefix: 'ETH_USDC-', indexName: 'eth_usd' },
    'SOL_USDC': { currency: 'USDC', inverse: false, prefix: 'SOL_USDC-', indexName: 'sol_usd' },
    'XRP_USDC': { currency: 'USDC', inverse: false, prefix: 'XRP_USDC-', indexName: 'xrp_usd' },
  };

  // ── Fetch + normalise in one call ─────────────────────────────────────────
  // instrument: 'BTC' | 'BTC_USDC' | 'ETH' | 'ETH_USDC' | 'SOL_USDC' | 'XRP_USDC'
  // filter: { type, minStrike, maxStrike, fromDays, toDays, atmOnly }
  async getMatrix(instrument, filter = {}, testnet = true) {
    const spec = OptionsService.INSTRUMENTS[instrument];
    if (!spec) throw new Error(`Unknown instrument: ${instrument}`);

    const [rawItems, indexPrice] = await Promise.all([
      this.fetchBookSummary(spec.currency, testnet),
      this.fetchIndexPrice(spec.indexName, testnet),
    ]);

    // Filter by instrument prefix
    const filtered = rawItems.filter(item => item.instrument_name.startsWith(spec.prefix));

    return this.normalise(filtered, indexPrice, spec.inverse, filter);
  }

  // ── Parse and normalise raw Deribit options data ──────────────────────────
  // Returns: { strikes[], expiries[], cells: { [strike]: { [expiry]: CellData } }, indexPrice, atmStrike }
  normalise(rawItems, indexPrice, isInverse, filter = {}) {
    const cells = {};
    const strikesSet = new Set();
    const expiriesSet = new Set();
    const now = new Date();

    for (const item of rawItems) {
      const parsed = this._parseInstrumentName(item.instrument_name);
      if (!parsed) continue;

      // Type filter
      if (filter.type && filter.type !== 'both' && parsed.type !== filter.type) continue;

      // Strike range filter
      if (filter.minStrike && parsed.strike < filter.minStrike) continue;
      if (filter.maxStrike && parsed.strike > filter.maxStrike) continue;

      // Expiry range filter (days from now)
      if (filter.fromDays != null || filter.toDays != null) {
        const expDate = this._parseExpiryStr(parsed.expiry);
        if (expDate) {
          const dte = Math.max(0, Math.ceil((expDate - now) / 86400000));
          if (filter.fromDays != null && dte < filter.fromDays) continue;
          if (filter.toDays != null && dte > filter.toDays) continue;
        }
      }

      // ATM filter: ±10% of index
      if (filter.atmOnly && indexPrice) {
        if (parsed.strike < indexPrice * 0.9 || parsed.strike > indexPrice * 1.1) continue;
      }

      const { strike, expiry, type } = parsed;
      strikesSet.add(strike);
      expiriesSet.add(expiry);

      // Price normalisation
      const bid = item.bid_price || 0;
      const ask = item.ask_price || 0;
      const mark = item.mark_price || 0;
      const bidUsd = isInverse ? bid * indexPrice : bid;
      const askUsd = isInverse ? ask * indexPrice : ask;
      const markUsd = isInverse ? mark * indexPrice : mark;

      if (!cells[strike]) cells[strike] = {};
      cells[strike][expiry] = {
        instrument: item.instrument_name,
        strike, expiry, type,
        isInverse,
        bid, ask, mark,
        bidUsd, askUsd, markUsd,
        bidIv: item.bid_iv || 0,
        askIv: item.ask_iv || 0,
        markIv: item.mark_iv || 0,
        openInterest: item.open_interest || 0,
        volume: item.volume || 0,
        underlying: item.underlying_price || 0,
      };
    }

    const strikes = [...strikesSet].sort((a, b) => a - b);
    const expiries = [...expiriesSet].sort((a, b) => {
      const da = this._parseExpiryStr(a), db = this._parseExpiryStr(b);
      return (da || 0) - (db || 0);
    });
    const atmStrike = this.getAtmStrike(strikes, indexPrice);

    return { strikes, expiries, cells, indexPrice, atmStrike };
  }

  // ── Parse instrument name ─────────────────────────────────────────────────
  // 'BTC-28MAR26-69000-C' or 'BTC_USDC-28MAR26-69000-C'
  _parseInstrumentName(name) {
    const match = name.match(/^([\w_]+)-(\d{1,2}[A-Z]{3}\d{2})-(\d+)-([CP])$/);
    if (!match) return null;
    return {
      underlying: match[1].replace('_USDC', ''),
      expiry: match[2],
      strike: parseInt(match[3]),
      type: match[4] === 'C' ? 'call' : 'put',
      isUsdc: name.includes('_USDC'),
    };
  }

  // ── Parse expiry string to Date ───────────────────────────────────────────
  _parseExpiryStr(str) {
    const m = str.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!m) return null;
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    return new Date(2000 + parseInt(m[3]), months[m[2]], parseInt(m[1]));
  }

  // ── Get ATM strike (closest to index price) ──────────────────────────────
  getAtmStrike(strikes, indexPrice) {
    if (!strikes.length || !indexPrice) return null;
    return strikes.reduce((closest, strike) =>
      Math.abs(strike - indexPrice) < Math.abs(closest - indexPrice) ? strike : closest
    , strikes[0]);
  }

  // ── Parse duration shorthand → days ───────────────────────────────────────
  // '1d' → 1, '2w' → 14, '3m' → 93, '28/03/26' → days until that date
  static parseDurationToDays(val) {
    if (!val) return null;
    val = String(val).trim().toLowerCase();
    const rel = val.match(/^(\d+)(d|w|m)$/);
    if (rel) {
      const n = parseInt(rel[1]), unit = rel[2];
      if (unit === 'd') return n;
      if (unit === 'w') return n * 7;
      if (unit === 'm') return n * 31;
    }
    // Absolute date: DD/MM/YY
    const abs = val.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (abs) {
      const d = new Date(abs[3].length === 2 ? 2000 + parseInt(abs[3]) : parseInt(abs[3]), parseInt(abs[2]) - 1, parseInt(abs[1]));
      return Math.max(0, Math.ceil((d - new Date()) / 86400000));
    }
    return null;
  }
}

module.exports = new OptionsService();
module.exports.OptionsService = OptionsService;
