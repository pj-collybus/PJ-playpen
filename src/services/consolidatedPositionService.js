/**
 * Consolidated position service — aggregates positions from all exchanges
 * into a unified view grouped by underlying asset and settlement type.
 *
 * Fully dynamic: adding a new exchange requires zero changes here.
 * Everything is derived from instrumentSpecService specs.
 *
 * Usage:
 *   const cps = require('./consolidatedPositionService');
 *   await cps.start();
 *   const view = await cps.getConsolidatedView();
 *   // { underlyings: { BTC: { venues: [...], netSize, netUsdValue, settlement: {...} }, ... } }
 */

'use strict';

const { subscribe, Topics } = require('../core/eventBus');
const { getBaseCurrency } = require('../adapters/orderInterface');

let _started = false;

/** @type {Map<string, object>} `${venue}::${symbol}` → enriched position */
const _positions = new Map();

async function start() {
  if (_started) return;
  _started = true;

  await subscribe(Topics.POSITIONS, 'consolidatedPositions', async (pos) => {
    const key = `${pos.venue}::${pos.symbol}`;
    console.log('[consolidated] received position:', pos.venue, pos.symbol, pos.side, 'size=' + pos.size);

    if (pos.size === 0 || pos.side === 'FLAT') {
      _positions.delete(key);
      return;
    }

    // Enrich with spec — cached after first call
    const enriched = await _enrichPosition(pos);
    _positions.set(key, enriched);
  });

  console.log('[consolidatedPositions] Started — listening for position events');
}

/**
 * Enrich a raw position event with spec-derived fields.
 * Falls back gracefully if spec is unavailable.
 */
async function _enrichPosition(pos) {
  const specService = require('./instrumentSpecService');
  const priceOracle = require('./priceOracle');

  let spec = null;
  let specAvailable = true;
  try {
    spec = await specService.getSpec(pos.venue, pos.symbol);
  } catch {
    specAvailable = false;
  }

  // Underlying asset
  let underlying;
  if (spec) {
    underlying = spec.baseCurrency === 'XBT' ? 'BTC' : spec.baseCurrency;
  } else {
    underlying = getBaseCurrency(pos.venue, pos.symbol);
    specAvailable = false;
  }

  // Settlement type
  let settlement;
  if (spec) {
    if (spec.isQuanto) settlement = 'USD-QUANTO';
    else if (spec.isInverse) settlement = 'USD-INVERSE';
    else if (spec.settleCurrency === 'USDT') settlement = 'USDT';
    else if (spec.settleCurrency === 'USDC') settlement = 'USDC';
    else if (spec.settleCurrency === 'USD') settlement = 'USD';
    else settlement = spec.settleCurrency || 'UNKNOWN';
  } else {
    settlement = 'UNKNOWN';
  }

  // USD value
  let usdValue = 0;
  let usdMethod = 'unavailable';
  let estimated = !specAvailable;
  try {
    const usdResult = await priceOracle.getUsdValue(
      pos.venue, pos.symbol, pos.size, pos.markPrice
    );
    usdValue = usdResult.usdValue;
    usdMethod = usdResult.method;
    estimated = usdResult.estimated;
  } catch {
    // Best-effort fallback
    usdValue = Math.abs(pos.size) * (pos.markPrice || 1);
    usdMethod = 'fallback';
    estimated = true;
  }

  return {
    // Original position fields
    venue: pos.venue,
    symbol: pos.symbol,
    side: pos.side,
    size: pos.size,
    sizeUnit: pos.sizeUnit || underlying,
    avgEntryPrice: pos.avgEntryPrice || 0,
    unrealisedPnl: pos.unrealisedPnl || 0,
    liquidationPrice: pos.liquidationPrice || 0,
    markPrice: pos.markPrice || 0,
    timestamp: pos.timestamp || Date.now(),

    // Enriched fields
    underlying,
    settlement,
    usdValue,
    usdMethod,
    specAvailable,
    estimated,

    // Spec details (for display)
    contractType: spec?.contractType || null,
    lotSize: spec?.lotSize || null,
    tickSize: spec?.tickSize || null,
    multiplier: spec?.multiplier || null,
  };
}

/**
 * Get the full consolidated view — positions grouped by underlying asset.
 *
 * Returns:
 * {
 *   underlyings: {
 *     BTC: {
 *       positions: [ { venue, symbol, side, size, usdValue, settlement, ... } ],
 *       netSize: 1.5,           // net long/short in base currency
 *       netUsdValue: 145000,    // net USD exposure
 *       settlements: {          // breakdown by settlement type
 *         'USDT':       { size: 0.5, usdValue: 48500 },
 *         'USD-INVERSE':{ size: 1.0, usdValue: 97000 },
 *       },
 *     },
 *     XRP: { ... },
 *   },
 *   totalUsdValue: 200000,
 *   positionCount: 5,
 *   estimatedCount: 0,
 * }
 */
async function getConsolidatedView() {
  const underlyings = {};
  let totalUsdValue = 0;
  let positionCount = 0;
  let estimatedCount = 0;

  for (const pos of _positions.values()) {
    const ul = pos.underlying || 'UNKNOWN';
    if (!underlyings[ul]) {
      underlyings[ul] = { positions: [], netSize: 0, netUsdValue: 0, settlements: {} };
    }

    const group = underlyings[ul];
    group.positions.push(pos);

    // Net size: LONG = positive, SHORT = negative
    const signedSize = pos.side === 'LONG' ? pos.size : -pos.size;
    group.netSize += signedSize;

    const signedUsd = pos.side === 'LONG' ? pos.usdValue : -pos.usdValue;
    group.netUsdValue += signedUsd;

    // Settlement breakdown
    const settl = pos.settlement || 'UNKNOWN';
    if (!group.settlements[settl]) {
      group.settlements[settl] = { size: 0, usdValue: 0 };
    }
    group.settlements[settl].size += signedSize;
    group.settlements[settl].usdValue += signedUsd;

    totalUsdValue += pos.usdValue;
    positionCount++;
    if (pos.estimated) estimatedCount++;
  }

  return { underlyings, totalUsdValue, positionCount, estimatedCount };
}

/**
 * Get flat array of all enriched positions.
 */
function getAllPositions(venue) {
  const all = Array.from(_positions.values());
  return venue ? all.filter(p => p.venue === venue) : all;
}

/** Get a single enriched position */
function getPosition(venue, symbol) {
  return _positions.get(`${venue}::${symbol}`) || null;
}

/** Stats */
function stats() {
  const venues = new Set();
  const underlyings = new Set();
  for (const p of _positions.values()) {
    venues.add(p.venue);
    underlyings.add(p.underlying);
  }
  return {
    positionCount: _positions.size,
    venues: Array.from(venues),
    underlyings: Array.from(underlyings),
  };
}

module.exports = { start, getConsolidatedView, getAllPositions, getPosition, stats };
