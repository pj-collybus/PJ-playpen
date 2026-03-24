/**
 * Adapter registry — single point of access for all exchange adapters and circuit breakers.
 *
 * Usage:
 *   const registry = require('./adapterRegistry');
 *   await registry.startAll();
 *   const deribit = registry.getAdapter('DERIBIT');
 *   const breaker = registry.getBreaker('DERIBIT', 'rest_orders');
 *   const health  = registry.getHealth();
 */

'use strict';

const { DeribitAdapter } = require('./deribit');
const { BinanceAdapter } = require('./binance');
const { BybitAdapter }   = require('./bybit');
const { OKXAdapter }     = require('./okx');
const { KrakenAdapter }  = require('./kraken');
const { BitMEXAdapter }  = require('./bitmex');
const { LMAXAdapter }    = require('./lmax');
const { EBSAdapter }     = require('./ebs');
const { T360Adapter }    = require('./360t');
const { CircuitBreaker, CircuitOpenError } = require('../core/circuitBreaker');

/** @type {Map<string, object>} venue ID → adapter instance */
const _adapters = new Map();

/** @type {Map<string, typeof import('events').EventEmitter>} venue ID → adapter class */
const _classes = new Map([
  ['DERIBIT', DeribitAdapter],
  ['BINANCE', BinanceAdapter],
  ['BYBIT',   BybitAdapter],
  ['OKX',     OKXAdapter],
  ['KRAKEN',  KrakenAdapter],
  ['BITMEX',  BitMEXAdapter],
  ['LMAX',    LMAXAdapter],
  ['EBS',     EBSAdapter],
  ['360T',    T360Adapter],
]);

/** @type {Map<string, CircuitBreaker>} `${venue}_${type}` → breaker */
const _breakers = new Map();

/** Breaker types per venue */
const BREAKER_TYPES = ['ws_connect', 'rest_orders', 'rest_data'];

let _started = false;

// ── Circuit breakers ─────────────────────────────────────────────────────────

function _ensureBreakers(venue) {
  for (const type of BREAKER_TYPES) {
    const key = `${venue}_${type}`;
    if (!_breakers.has(key)) {
      _breakers.set(key, new CircuitBreaker(key, { exchange: venue }));
    }
  }
}

/**
 * Get a circuit breaker for a venue + operation type.
 * @param {string} venue - e.g. 'DERIBIT'
 * @param {'ws_connect'|'rest_orders'|'rest_data'} type
 * @returns {CircuitBreaker}
 */
function getBreaker(venue, type) {
  const key = `${venue.toUpperCase()}_${type}`;
  if (!_breakers.has(key)) {
    _breakers.set(key, new CircuitBreaker(key, { exchange: venue.toUpperCase() }));
  }
  return _breakers.get(key);
}

// ── Adapters ─────────────────────────────────────────────────────────────────

function getAdapter(venue) {
  const key = venue.toUpperCase();
  if (_adapters.has(key)) return _adapters.get(key);
  const Cls = _classes.get(key);
  if (!Cls) return null;
  _ensureBreakers(key);
  const dataBreaker = getBreaker(key, 'rest_data');
  const instance = new Cls({ dataBreaker });
  _adapters.set(key, instance);
  return instance;
}

function getAllAdapters() {
  for (const venue of _classes.keys()) {
    if (!_adapters.has(venue)) getAdapter(venue);
  }
  return new Map(_adapters);
}

function listVenues() { return Array.from(_classes.keys()); }
function hasVenue(venue) { return _classes.has(venue.toUpperCase()); }

function registerClass(venue, AdapterClass) {
  const key = venue.toUpperCase();
  _classes.set(key, AdapterClass);
  if (_adapters.has(key)) {
    const old = _adapters.get(key);
    if (old.disconnect) old.disconnect();
    _adapters.delete(key);
  }
}

async function startAll(opts = {}) {
  if (_started) return { connected: Array.from(_adapters.keys()), failed: [] };
  _started = true;

  const venuesToStart = opts.venues
    ? opts.venues.map(v => v.toUpperCase())
    : Array.from(_classes.keys());

  const connected = [];
  const failed    = [];

  for (const venue of venuesToStart) {
    const adapter = getAdapter(venue);
    if (!adapter) { failed.push({ venue, error: 'Unknown venue' }); continue; }

    const wsBreaker = getBreaker(venue, 'ws_connect');
    try {
      await wsBreaker.execute(() => adapter.connect());
      connected.push(venue);
      console.log(`[adapterRegistry] ${venue} connected`);
    } catch (e) {
      failed.push({ venue, error: e.message });
      console.error(`[adapterRegistry] ${venue} failed to connect:`, e.message);
    }
  }

  if (opts.registerWithOrderService !== false) {
    try {
      const orderService = require('../services/orderService');
      for (const venue of connected) {
        const adapter = _adapters.get(venue);
        if (adapter.sendOrder) orderService.registerAdapter(venue, adapter);
      }
    } catch (e) {
      console.error('[adapterRegistry] Failed to register with orderService:', e.message);
    }
  }

  return { connected, failed };
}

async function stopAll() {
  for (const [venue, adapter] of _adapters) {
    try { adapter.disconnect(); console.log(`[adapterRegistry] ${venue} disconnected`); }
    catch (e) { console.error(`[adapterRegistry] ${venue} disconnect error:`, e.message); }
  }
  _adapters.clear();
  _started = false;
}

async function subscribe(venue, venueSymbol) {
  const adapter = getAdapter(venue);
  if (!adapter) throw new Error(`Unknown venue: ${venue}`);
  await adapter.subscribe(venueSymbol);
}

async function unsubscribe(venue, venueSymbol) {
  const adapter = getAdapter(venue);
  if (!adapter) throw new Error(`Unknown venue: ${venue}`);
  await adapter.unsubscribe(venueSymbol);
}

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * Get health status of all adapters, breakers, and feeds.
 * @returns {object} { adapters: { DERIBIT: { ws, restOrders, restData, feeds } } }
 */
function getHealth() {
  const result = {};

  for (const venue of _classes.keys()) {
    const adapter = _adapters.get(venue);
    const entry = {
      ws:         'DISCONNECTED',
      restOrders: getBreaker(venue, 'rest_orders').getStatus().state,
      restData:   getBreaker(venue, 'rest_data').getStatus().state,
      feeds:      {},
    };

    // WS connection status
    if (adapter) {
      if (adapter._ws && adapter._ws.readyState === 1) entry.ws = 'CONNECTED';
      else if (adapter._connected) entry.ws = 'CONNECTED'; // FIX stubs
      else entry.ws = getBreaker(venue, 'ws_connect').getStatus().state === 'OPEN' ? 'CIRCUIT_OPEN' : 'DISCONNECTED';

      // Feed status from BookGuard
      if (adapter._guard && adapter._guard._symbols) {
        for (const [sym, state] of adapter._guard._symbols) {
          entry.feeds[sym] = state.stale ? 'STALE' : 'LIVE';
        }
      }
    }

    result[venue] = entry;
  }

  return { adapters: result };
}

/**
 * Get status of all circuit breakers.
 * @returns {Object<string, object>}
 */
function getAllBreakerStatus() {
  const out = {};
  for (const [key, breaker] of _breakers) {
    out[key] = breaker.getStatus();
  }
  return out;
}

/**
 * Authenticate an adapter for private channel subscriptions.
 * Called when vault is unlocked — credentials passed from the UI.
 * @param {string} venue
 * @param {object} credentials - { fields, testnet, exchange, label }
 */
async function authenticateAdapter(venue, credentials) {
  const adapter = getAdapter(venue);
  if (!adapter) throw new Error(`No adapter for ${venue}`);
  if (!adapter.subscribePrivate) return; // adapter doesn't support private channels (FIX stubs)
  await adapter.subscribePrivate(credentials);
  console.log(`[adapterRegistry] ${venue} private channels authenticated`);
}

/**
 * Authenticate all adapters that have credentials.
 * @param {Object<string, object>} credentialsMap - { DERIBIT: {fields,...}, BYBIT: {fields,...} }
 */
let _storedCredentials = {};

function getStoredCredentials() { return _storedCredentials; }

async function authenticateAll(credentialsMap) {
  console.log('[registry] authenticateAll called for:', Object.keys(credentialsMap));
  // Store credentials for history API access
  _storedCredentials = { ..._storedCredentials, ...credentialsMap };
  const venues = [];
  const promises = [];
  for (const [venue, creds] of Object.entries(credentialsMap)) {
    if (creds?.fields) {
      venues.push(venue);
      promises.push(authenticateAdapter(venue, creds));
    } else {
      console.log('[registry] Skipping', venue, '— no fields');
    }
  }
  const settled = await Promise.allSettled(promises);
  const results = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      results[venues[i]] = 'subscribed';
    } else {
      const err = r.reason || {};
      results[venues[i]] = {
        status: 'failed',
        reason: err.message || 'unknown',
        ...(err.diagnostic ? { diagnostic: err.diagnostic } : {}),
      };
    }
  });
  return results;
}

module.exports = {
  getAdapter,
  getAllAdapters,
  listVenues,
  hasVenue,
  registerClass,
  startAll,
  stopAll,
  subscribe,
  unsubscribe,
  getBreaker,
  getHealth,
  getAllBreakerStatus,
  authenticateAdapter,
  authenticateAll,
  getStoredCredentials,
  CircuitOpenError,
};
