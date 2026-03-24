/**
 * Standard order interface — shared types and helpers for all adapters.
 *
 * Every adapter's submitOrder/cancelOrder/amendOrder/getOrderStatus must
 * return normalised responses using these shapes.
 */

'use strict';

const crypto = require('crypto');

/** Normalised order response shape */
function orderResponse({ venueOrderId, clientOrderId, status, filledQty = 0, avgFillPrice = 0, rejectReason = null }) {
  return { venueOrderId, clientOrderId, status, filledQty, avgFillPrice, rejectReason };
}

/** Status constants */
const OrderStatus = Object.freeze({
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  REJECTED:     'REJECTED',
  FILLED:       'FILLED',
  PARTIAL:      'PARTIAL',
});

/** TIF mapping per exchange */
const TIF_MAP = {
  DERIBIT: { IOC: 'immediate_or_cancel', GTC: 'good_til_cancelled', FOK: 'fill_or_kill' },
  BINANCE: { IOC: 'IOC', GTC: 'GTC', FOK: 'FOK' },
  BYBIT:   { IOC: 'IOC', GTC: 'GTC', FOK: 'FOK' },
  OKX:     { IOC: 'ioc', GTC: 'gtc', FOK: 'fok' },
  KRAKEN:  { IOC: 'IOC', GTC: 'GTC', FOK: 'FOK' },
  BITMEX:  { IOC: 'ImmediateOrCancel', GTC: 'GoodTillCancel', FOK: 'FillOrKill' },
  LMAX:    { IOC: 'IOC', GTC: 'GTC', FOK: 'FOK' },
  EBS:     { IOC: 'IOC', GTC: 'GTC', FOK: 'FOK' },
  '360T':  { IOC: 'IOC', GTC: 'GTC', FOK: 'FOK' },
};

function mapTIF(exchange, tif) {
  const map = TIF_MAP[exchange?.toUpperCase()] || TIF_MAP.BINANCE;
  return map[tif?.toUpperCase()] || map.IOC;
}

/** Side mapping per exchange */
const SIDE_MAP = {
  DERIBIT: { BUY: 'buy', SELL: 'sell' },
  BINANCE: { BUY: 'BUY', SELL: 'SELL' },
  BYBIT:   { BUY: 'Buy', SELL: 'Sell' },
  OKX:     { BUY: 'buy', SELL: 'sell' },
  KRAKEN:  { BUY: 'buy', SELL: 'sell' },
  BITMEX:  { BUY: 'Buy', SELL: 'Sell' },
};

function mapSide(exchange, side) {
  const map = SIDE_MAP[exchange?.toUpperCase()] || SIDE_MAP.BINANCE;
  return map[side?.toUpperCase()] || side;
}

/**
 * HMAC-SHA256 signature helper (used by Binance, Bybit, BitMEX).
 * @param {string} secret
 * @param {string} message
 * @returns {string} hex digest
 */
function hmacSha256Hex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * HMAC-SHA256 base64 (used by OKX).
 */
function hmacSha256Base64(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

/**
 * Generate a client order ID.
 */
function genClientOrderId(prefix = 'CLB') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Extract a human-readable rejection reason from any exchange's error response.
 * Adding a new exchange = adding one entry to the extractors object.
 * @param {string} exchange
 * @param {object} rawResponse - Parsed JSON response body
 * @param {number} httpStatus
 * @returns {string}
 */
function extractRejectReason(exchange, rawResponse, httpStatus) {
  if (httpStatus === 429) return 'Rate limit exceeded — try again in a few seconds';
  if (httpStatus === 401) return 'Authentication failed — check your API key';
  if (httpStatus === 403) return 'Permission denied — check API key permissions';

  const extractors = {
    DERIBIT: r => r?.error?.message || r?.error?.data?.reason,
    BITMEX:  r => r?.error?.message,
    BYBIT:   r => r?.retMsg,
    BINANCE: r => r?.msg,
    OKX:     r => r?.data?.[0]?.sMsg || r?.msg,
    KRAKEN:  r => Array.isArray(r?.error) ? r.error.join(', ') : r?.error,
    LMAX:    r => r?.rejectReason || r?.message,
    EBS:     r => r?.rejectReason || r?.message,
    '360T':  r => r?.rejectReason || r?.message,
  };

  const extractor = extractors[exchange?.toUpperCase()];
  const reason = extractor ? extractor(rawResponse) : null;
  return reason || `Order rejected by ${exchange} (HTTP ${httpStatus || '?'})`;
}

/**
 * Normalise exchange name to uppercase. Must be called before setting
 * the venue field on any event published to the bus.
 */
function normaliseExchange(name) {
  return (name || '').toUpperCase().trim();
}

/**
 * Extract the base currency from an instrument name.
 * Works for all exchanges — single source of truth.
 */
function getBaseCurrency(exchange, instrument) {
  const exch = (exchange || '').toUpperCase();
  const instr = (instrument || '').toUpperCase();
  // Deribit: BTC-PERPETUAL → BTC, ETH-28MAR25 → ETH, SOL_USDC-PERPETUAL → SOL
  if (exch === 'DERIBIT') return instr.replace(/_USDC/,'').replace(/_USDT/,'').split('-')[0];
  // Kraken Futures: PF_XRPUSD → XRP, PI_XBTUSD → BTC
  if (instr.startsWith('PF_') || instr.startsWith('PI_') || instr.startsWith('FI_')) {
    const stripped = instr.replace(/^(PF_|PI_|FI_)/, '').replace(/USD[T]?$/, '');
    return stripped === 'XBT' ? 'BTC' : stripped;
  }
  // Linear USDT/USDC pairs: BTCUSDT → BTC, XRPUSDT → XRP
  if (instr.endsWith('USDT')) return instr.replace(/USDT$/, '');
  if (instr.endsWith('USDC')) return instr.replace(/USDC$/, '');
  // Inverse USD pairs: XBTUSD → BTC, XRPUSD → XRP, ETHUSD → ETH
  if (instr.endsWith('USD')) {
    const base = instr.replace(/USD$/, '');
    return base === 'XBT' ? 'BTC' : base;
  }
  // Fallback: take letters before first non-alpha
  const m = instr.match(/^([A-Z]+)/);
  return m ? m[1].substring(0, 5) : instr;
}

/**
 * Convert a base-currency quantity to the units the exchange expects.
 * UI always works in base currency; this converts at the adapter boundary.
 *
 * @param {string} exchange  - uppercase venue name
 * @param {string} instrument - exchange-native symbol
 * @param {number} sizeInBaseCurrency - user-entered size in base asset
 * @param {number} markPrice - current mark/last price (needed for inverse)
 * @returns {number} size in exchange-native units
 */
/**
 * Convert base-currency quantity to exchange-native units using instrument spec.
 * Async — fetches spec from instrumentSpecService on first call (cached 1h).
 *
 * @param {string} exchange
 * @param {string} instrument - venue-native symbol
 * @param {number} sizeInBaseCurrency
 * @param {number} currentPrice - limit price or mark price
 * @returns {Promise<number>} size in exchange-native units, rounded to lotSize
 */
async function normaliseOrderSize(exchange, instrument, sizeInBaseCurrency, currentPrice) {
  console.log('[normalise] ENTRY exchange:', exchange, 'symbol:', instrument, 'inputSize:', sizeInBaseCurrency, 'price:', currentPrice);
  const specService = require('../services/instrumentSpecService');
  const spec = await specService.getSpec(exchange, instrument);
  console.log('[normalise] spec result:', { contractType: spec?.contractType, lotSize: spec?.lotSize, fetched: !!spec });

  if (spec) {
    const lot = spec.lotSize || 1;
    let result;
    switch (spec.contractType) {
      case 'INVERSE':
        // INVERSE (XBTUSD): contracts = baseSize × price, rounded to lotSize
        result = Math.round((sizeInBaseCurrency * currentPrice) / lot) * lot;
        break;
      case 'QUANTO': {
        // QUANTO (XRPUSD): each contract = (multiplier/1e8) × btcPrice / underlyingPrice in base units
        const btcPrice = specService.getBtcMarkPrice();
        const mult = spec.multiplier || 1;
        const xrpPerContract = (mult / 1e8) * btcPrice / currentPrice;
        const contracts = Math.round(sizeInBaseCurrency / xrpPerContract / lot) * lot;
        result = Math.max(contracts, lot); // minimum 1 lot
        console.log('[normalise] QUANTO detail:', { mult, btcPrice, currentPrice, xrpPerContract, contracts: result });
        break;
      }
      case 'LINEAR':
      default:
        // LINEAR (XRPUSDT): size in base currency, rounded to lotSize
        result = Math.round(sizeInBaseCurrency / lot) * lot;
        if (spec.minOrderSize && result < spec.minOrderSize) result = spec.minOrderSize;
        break;
    }
    console.log('[normalise] OUTPUT:', result, 'contractType:', spec.contractType);
    return result;
  }

  // Fallback: no spec available — use legacy heuristic
  const exch = (exchange || '').toUpperCase();
  const instr = (instrument || '').toUpperCase();
  if (exch === 'BITMEX' && !instr.endsWith('USDT') && instr.endsWith('USD')) {
    if (!currentPrice) throw new Error('currentPrice required for inverse contract size conversion');
    const contracts = Math.round(sizeInBaseCurrency * currentPrice);
    console.log('[normalise] FALLBACK INVERSE output:', contracts);
    return contracts;
  }
  console.log('[normalise] FALLBACK LINEAR output:', sizeInBaseCurrency);
  return sizeInBaseCurrency;
}

/**
 * Reverse conversion: exchange-native contracts → base currency for display.
 *
 * INVERSE (XBTUSD): contracts are USD → divide by price → base currency
 * QUANTO  (XRPUSD): contracts × (mult/1e8) × btcPrice / markPrice → base currency
 * LINEAR  (XRPUSDT): already in base currency → pass through
 */
async function exchangeToBaseSize(exchange, instrument, exchangeQty, price) {
  const specService = require('../services/instrumentSpecService');
  const spec = await specService.getSpec(exchange, instrument);

  if (spec) {
    if (spec.contractType === 'INVERSE' && price) {
      return exchangeQty / price;
    }
    if (spec.contractType === 'QUANTO' && price) {
      const btcPrice = specService.getBtcMarkPrice();
      const mult = spec.multiplier || 1;
      const basePerContract = (mult / 1e8) * btcPrice / price;
      return exchangeQty * basePerContract;
    }
    return exchangeQty;
  }
  // Fallback
  const exch = (exchange || '').toUpperCase();
  const instr = (instrument || '').toUpperCase();
  if (exch === 'BITMEX' && instr === 'XBTUSD' && price) return exchangeQty / price;
  return exchangeQty;
}

module.exports = {
  orderResponse,
  OrderStatus,
  TIF_MAP,
  mapTIF,
  SIDE_MAP,
  mapSide,
  hmacSha256Hex,
  hmacSha256Base64,
  genClientOrderId,
  extractRejectReason,
  normaliseExchange,
  getBaseCurrency,
  normaliseOrderSize,
  exchangeToBaseSize,
};
