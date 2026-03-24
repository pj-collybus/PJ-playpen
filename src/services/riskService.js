/**
 * Risk service — pre-trade checks that sit between orderService and exchange adapters.
 *
 * No order reaches an exchange without passing through riskService.check().
 * Checks run in order, failing fast on the first violation.
 * Never throws — always returns { rejected, reason?, detail? }.
 *
 * Usage:
 *   const riskService = require('./riskService');
 *   const result = riskService.check(order);
 *   if (result.rejected) { // block order }
 */

'use strict';

const { publish } = require('../core/eventBus');
const limits      = require('../config/riskLimits');

// ── In-memory state ──────────────────────────────────────────────────────────

/** Duplicate detection: Map<hash, expiryTimestamp> — cleared on module load */
const _recentOrders = new Map();

/** Position tracking: Map<symbol, number> (signed: positive=long, negative=short) */
const _positions = new Map();

/** Open notional tracking: Map<symbol, number> */
const _openNotional = new Map();

/** Recent order sizes for fat-finger: Map<symbol, number[]> (last 100 sizes) */
const _recentSizes = new Map();

/** Last known exchange timestamps: Map<venue, number> */
const _exchangeClocks = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function _getLimits(symbol, accountId) {
  const d = limits.default;
  const s = limits.symbols?.[symbol] || {};
  const a = limits.accounts?.[accountId] || {};
  return { ...d, ...s, ...a };
}

function _reject(reason, detail, order) {
  const event = {
    type:      'risk_rejection',
    reason,
    detail,
    symbol:    order.symbol,
    side:      order.side,
    size:      order.quantity,
    price:     order.limitPrice,
    accountId: order.accountId || order.metadata?.accountId || 'default',
    timestamp: Date.now(),
  };
  console.warn(`[riskService] REJECTED: ${reason} — ${detail} (symbol=${order.symbol} side=${order.side} qty=${order.quantity})`);
  publish('system.risk_rejection', event, order.symbol).catch(() => {});
  return { rejected: true, reason, detail };
}

function _pass() {
  return { rejected: false };
}

// ── Clean expired duplicate entries inline (no periodic timer needed) ────────
function _cleanExpiredDuplicates() {
  const now = Date.now();
  for (const [key, expiry] of _recentOrders) {
    if (expiry < now) {
      _recentOrders.delete(key);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all pre-trade risk checks on an order. Fails fast on first violation.
 *
 * @param {object} order
 * @param {string}  order.symbol
 * @param {string}  order.venue
 * @param {'BUY'|'SELL'} order.side
 * @param {number}  order.quantity
 * @param {number|null} order.limitPrice
 * @param {string}  [order.orderType='MARKET']
 * @param {number}  [order.arrivalMid]     - Current mid price
 * @param {string}  [order.accountId]      - Account for per-account limits
 * @param {object}  [order.metadata]
 * @returns {{ rejected: boolean, reason?: string, detail?: string }}
 */
function check(order) {
  const cfg = _getLimits(order.symbol, order.accountId || order.metadata?.accountId);

  // 1. Fat finger — price
  const r1 = _checkFatFingerPrice(order, cfg);
  if (r1.rejected) return r1;

  // 2. Fat finger — size
  const r2 = _checkFatFingerSize(order, cfg);
  if (r2.rejected) return r2;

  // 3. Position limits
  const r3 = _checkPositionLimit(order, cfg);
  if (r3.rejected) return r3;

  // 4. Notional limits
  const r4 = _checkNotionalLimit(order, cfg);
  if (r4.rejected) return r4;

  // 5. Duplicate order detection
  const r5 = _checkDuplicate(order, cfg);
  if (r5.rejected) return r5;

  // 6. Circuit breaker check
  const r6 = _checkCircuitBreaker(order);
  if (r6.rejected) return r6;

  // 7. Clock skew check
  const r7 = _checkClockSkew(order, cfg);
  if (r7.rejected) return r7;

  // All checks passed — record for duplicate detection and size tracking
  _recordOrder(order);

  return _pass();
}

// ── Individual checks ────────────────────────────────────────────────────────

function _checkFatFingerPrice(order, cfg) {
  if (!order.limitPrice || !order.arrivalMid || order.arrivalMid <= 0) return _pass();
  if (order.orderType === 'MARKET') return _pass(); // market orders have no limit price

  const deviation = Math.abs(order.limitPrice - order.arrivalMid) / order.arrivalMid * 100;
  if (deviation > cfg.fatFingerPct) {
    return _reject('FAT_FINGER', `Limit price ${order.limitPrice} deviates ${deviation.toFixed(1)}% from mid ${order.arrivalMid} (max ${cfg.fatFingerPct}%)`, order);
  }
  return _pass();
}

function _checkFatFingerSize(order, cfg) {
  const recent = _recentSizes.get(order.symbol);
  if (!recent || recent.length < 5) return _pass(); // not enough history to compare

  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg > 0 && order.quantity > avg * cfg.fatFingerSizeMultiple) {
    return _reject('FAT_FINGER', `Order size ${order.quantity} exceeds ${cfg.fatFingerSizeMultiple}x average (${avg.toFixed(2)}) for ${order.symbol}`, order);
  }
  return _pass();
}

function _checkPositionLimit(order, cfg) {
  const currentPos = _positions.get(order.symbol) || 0;
  const delta = order.side === 'BUY' ? order.quantity : -order.quantity;
  const newPos = Math.abs(currentPos + delta);

  if (newPos > cfg.maxPositionSize) {
    return _reject('POSITION_LIMIT', `New position ${newPos.toFixed(2)} would exceed max ${cfg.maxPositionSize} for ${order.symbol} (current: ${currentPos})`, order);
  }
  return _pass();
}

function _checkNotionalLimit(order, cfg) {
  const price = order.limitPrice || order.arrivalMid || 0;
  if (price <= 0) return _pass();

  const orderNotional = price * order.quantity;
  const accountId = order.accountId || 'default';

  // Single order notional
  if (orderNotional > cfg.maxSingleOrderNotional) {
    return _reject('NOTIONAL_LIMIT', `Order notional $${orderNotional.toLocaleString()} exceeds max single order $${cfg.maxSingleOrderNotional.toLocaleString()}`, order);
  }

  // Total open notional
  let totalNotional = orderNotional;
  for (const [, notional] of _openNotional) {
    totalNotional += notional;
  }
  if (totalNotional > cfg.maxTotalNotional) {
    return _reject('NOTIONAL_LIMIT', `Total notional $${totalNotional.toLocaleString()} would exceed max $${cfg.maxTotalNotional.toLocaleString()}`, order);
  }

  return _pass();
}

function _checkDuplicate(order, cfg) {
  const hash = `${order.venue || ''}|${order.symbol}|${order.side}|${order.quantity}|${order.limitPrice || 'MKT'}`;
  const now  = Date.now();

  // Clean expired entries before checking
  _cleanExpiredDuplicates();

  const isAlgo = order.algoType === 'ALGO' || order.metadata?.source === 'algo';
  const windowMs = isAlgo ? (cfg.duplicateWindowMsAlgo || 500) : (cfg.duplicateWindowMsManual || 2000);

  if (_recentOrders.has(hash)) {
    const detail = isAlgo
      ? `Duplicate order detected within ${windowMs}ms — possible runaway algo`
      : `Duplicate order detected — please wait ${windowMs / 1000} seconds between manual orders`;
    return _reject('DUPLICATE', detail, order);
  }
  return _pass();
}

function _checkCircuitBreaker(order) {
  try {
    const registry = require('../adapters/adapterRegistry');
    const breaker  = registry.getBreaker(order.venue, 'rest_orders');
    const status   = breaker.getStatus();
    if (status.state === 'OPEN') {
      return _reject('CIRCUIT_OPEN', `Circuit breaker for ${order.venue} REST orders is OPEN — exchange temporarily unavailable`, order);
    }
  } catch {
    // Registry not available — skip check
  }
  return _pass();
}

function _checkClockSkew(order, cfg) {
  const lastExchangeTs = _exchangeClocks.get(order.venue);
  if (!lastExchangeTs) return _pass(); // no reference yet

  const localNow = Date.now();
  const skew = Math.abs(localNow - lastExchangeTs);

  if (skew > cfg.clockSkewMaxMs) {
    console.error(`CRITICAL: Clock skew detected for ${order.venue} — local=${localNow} exchange=${lastExchangeTs} skew=${skew}ms`);
    return _reject('CLOCK_SKEW', `Local clock is ${skew}ms out of sync with ${order.venue} (max ${cfg.clockSkewMaxMs}ms)`, order);
  }
  return _pass();
}

// ── State management ─────────────────────────────────────────────────────────

function _recordOrder(order) {
  // Record for duplicate detection — store expiry timestamp
  const isAlgo = order.algoType === 'ALGO' || order.metadata?.source === 'algo';
  const cfg = _getLimits(order.symbol, order.accountId);
  const windowMs = isAlgo ? (cfg.duplicateWindowMsAlgo || 500) : (cfg.duplicateWindowMsManual || 2000);
  const hash = `${order.venue || ''}|${order.symbol}|${order.side}|${order.quantity}|${order.limitPrice || 'MKT'}`;
  _recentOrders.set(hash, Date.now() + windowMs);

  // Record size for fat-finger averaging
  if (!_recentSizes.has(order.symbol)) _recentSizes.set(order.symbol, []);
  const sizes = _recentSizes.get(order.symbol);
  sizes.push(order.quantity);
  if (sizes.length > 100) sizes.shift();
}

/**
 * Update the tracked position for a symbol (call after fills).
 * @param {string} symbol
 * @param {number} delta - positive for buy fill, negative for sell fill
 */
function updatePosition(symbol, delta) {
  const current = _positions.get(symbol) || 0;
  _positions.set(symbol, current + delta);
}

/**
 * Set the current position for a symbol directly.
 * @param {string} symbol
 * @param {number} position
 */
function setPosition(symbol, position) {
  _positions.set(symbol, position);
}

/**
 * Update open notional for a symbol.
 * @param {string} symbol
 * @param {number} notional
 */
function setOpenNotional(symbol, notional) {
  _openNotional.set(symbol, notional);
}

/**
 * Update the last known exchange server timestamp (for clock skew detection).
 * Call this from adapters on every message that contains an exchange timestamp.
 * @param {string} venue
 * @param {number} exchangeTs - Unix ms from the exchange
 */
function updateExchangeClock(venue, exchangeTs) {
  if (exchangeTs && exchangeTs > 0) {
    _exchangeClocks.set(venue, exchangeTs);
  }
}

/**
 * Get current risk state for debugging / health endpoints.
 */
function getState() {
  return {
    positions:    Object.fromEntries(_positions),
    openNotional: Object.fromEntries(_openNotional),
    recentOrderCount: _recentOrders.size,
    exchangeClocks:   Object.fromEntries(_exchangeClocks),
  };
}

module.exports = {
  check,
  updatePosition,
  setPosition,
  setOpenNotional,
  updateExchangeClock,
  getState,
};
