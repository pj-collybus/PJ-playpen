/**
 * Data quality middleware — monitors all events on the bus for anomalies.
 *
 * Checks:
 *   1. Crossed book: bidPrice >= askPrice on L1 → CRITICAL
 *   2. Stale feed: receivedTs - exchangeTs > 500ms for 30 consecutive ticks → CRITICAL
 *   3. Missing arrivalMid: order event with null/undefined arrivalMid → CRITICAL (reject)
 *   4. Price spike: mid moves > 5% in < 1 second on same symbol → WARNING
 *   5. Duplicate fills: same fillId seen twice → WARNING (reject)
 *   6. Feed status: if any symbol stays STALE for > 30 seconds → CRITICAL
 *
 * Never throws — logs and continues.
 */

'use strict';

const { subscribe, Topics } = require('./eventBus');

// ── State trackers ───────────────────────────────────────────────────────────

/** Stale feed: Map<`${venue}::${symbol}`, consecutiveStaleCount> */
const _staleCounters = new Map();
const STALE_THRESHOLD_MS    = 500;
const STALE_CONSECUTIVE_MAX = 30;

/** Price spike: Map<symbol, { midPrice, ts }> */
const _lastMids = new Map();
const SPIKE_THRESHOLD_PCT = 0.05;
const SPIKE_WINDOW_MS     = 1000;

/** Duplicate fills: Set<fillId> */
const _seenFillIds = new Set();
const MAX_FILL_ID_CACHE = 50_000;

/** Feed status tracking: Map<`${venue}::${symbol}`, { status, staleAt }> */
const _feedStatus = new Map();
const FEED_STALE_CRITICAL_MS = 30_000; // 30 seconds

let _started = false;
let _feedStatusTimer = null;

async function startDataQuality() {
  if (_started) return;
  _started = true;

  // ── L1 BBO checks ─────────────────────────────────────────────────────────
  await subscribe(Topics.L1_BBO, 'dataQuality-l1', async (event) => {
    try {
      // 1. Crossed book
      if (event.bidPrice > 0 && event.askPrice > 0 && event.bidPrice >= event.askPrice) {
        console.error(`CRITICAL: crossed book on ${event.venue} ${event.symbol} — bid=${event.bidPrice} ask=${event.askPrice}`);
      }

      // 2. Stale feed (latency-based)
      const key = `${event.venue}::${event.symbol}`;
      const latency = event.receivedTs - event.exchangeTs;
      if (latency > STALE_THRESHOLD_MS) {
        const count = (_staleCounters.get(key) || 0) + 1;
        _staleCounters.set(key, count);
        if (count === STALE_CONSECUTIVE_MAX) {
          console.error(`CRITICAL: stale feed on ${event.venue} ${event.symbol} — ${STALE_CONSECUTIVE_MAX} consecutive ticks with latency > ${STALE_THRESHOLD_MS}ms (last=${latency}ms)`);
        }
      } else {
        _staleCounters.set(key, 0);
      }

      // 4. Price spike
      if (event.midPrice > 0) {
        const prev = _lastMids.get(event.symbol);
        if (prev && prev.midPrice > 0) {
          const elapsed = event.receivedTs - prev.ts;
          if (elapsed < SPIKE_WINDOW_MS && elapsed > 0) {
            const pctChange = Math.abs(event.midPrice - prev.midPrice) / prev.midPrice;
            if (pctChange > SPIKE_THRESHOLD_PCT) {
              console.warn(`WARNING: price spike on ${event.symbol} — ${(pctChange * 100).toFixed(2)}% in ${elapsed}ms (${prev.midPrice} → ${event.midPrice})`);
            }
          }
        }
        _lastMids.set(event.symbol, { midPrice: event.midPrice, ts: event.receivedTs });
      }
    } catch (err) {
      console.error('[dataQuality] L1 check error:', err.message);
    }
  });

  // ── Order checks ───────────────────────────────────────────────────────────
  await subscribe(Topics.ORDERS, 'dataQuality-orders', async (event) => {
    try {
      // 3. Missing arrivalMid
      if (event.arrivalMid == null || event.arrivalMid === undefined) {
        console.error(`CRITICAL: missing arrivalMid on order ${event.orderId} — symbol=${event.symbol} venue=${event.venue}`);
        event._dqRejected = true;
      }
    } catch (err) {
      console.error('[dataQuality] order check error:', err.message);
    }
  });

  // ── Fill checks ────────────────────────────────────────────────────────────
  await subscribe(Topics.FILLS, 'dataQuality-fills', async (event) => {
    try {
      // 5. Duplicate fills
      if (event.fillId) {
        if (_seenFillIds.has(event.fillId)) {
          console.warn(`WARNING: duplicate fill ${event.fillId} — orderId=${event.orderId} venue=${event.venue}`);
          event._dqDuplicate = true;
          return;
        }
        _seenFillIds.add(event.fillId);
        if (_seenFillIds.size > MAX_FILL_ID_CACHE) {
          const iter = _seenFillIds.values();
          for (let i = 0; i < MAX_FILL_ID_CACHE / 2; i++) _seenFillIds.delete(iter.next().value);
        }
      }
    } catch (err) {
      console.error('[dataQuality] fill check error:', err.message);
    }
  });

  // ── Feed status checks (from BookGuard in adapters) ────────────────────────
  await subscribe('feed.status', 'dataQuality-feedStatus', async (event) => {
    try {
      const key = `${event.venue}::${event.symbol}`;
      if (event.status === 'STALE') {
        if (!_feedStatus.has(key) || _feedStatus.get(key).status !== 'STALE') {
          _feedStatus.set(key, { status: 'STALE', staleAt: Date.now() });
          console.warn(`WARNING: feed STALE on ${event.venue} ${event.symbol}`);
        }
      } else if (event.status === 'LIVE') {
        const prev = _feedStatus.get(key);
        if (prev && prev.status === 'STALE') {
          const duration = Date.now() - prev.staleAt;
          console.log(`INFO: feed recovered on ${event.venue} ${event.symbol} after ${duration}ms`);
        }
        _feedStatus.set(key, { status: 'LIVE', staleAt: null });
      }
    } catch (err) {
      console.error('[dataQuality] feed status check error:', err.message);
    }
  });

  // ── Periodic check: any feed STALE > 30s → CRITICAL ───────────────────────
  _feedStatusTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of _feedStatus) {
      if (state.status === 'STALE' && state.staleAt && (now - state.staleAt) > FEED_STALE_CRITICAL_MS) {
        console.error(`CRITICAL: feed on ${key} has been STALE for ${Math.round((now - state.staleAt) / 1000)}s`);
        // Update staleAt so we don't spam every second — log again at next 30s interval
        state.staleAt = now;
      }
    }
  }, 10_000);

  console.log('[dataQuality] Data quality middleware active — monitoring L1, orders, fills, feed_status');
}

module.exports = { startDataQuality };
