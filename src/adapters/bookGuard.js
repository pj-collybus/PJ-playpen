/**
 * BookGuard — shared sequence gap detection, stale feed timeout, and snapshot throttling.
 *
 * Each adapter creates one BookGuard per venue. The guard tracks per-symbol state:
 *   - Last sequence number → detects gaps
 *   - Last update timestamp → detects stale feeds (5s timeout)
 *   - Snapshot cooldown → prevents cascade (2s minimum between snapshots)
 *
 * Usage inside an adapter:
 *   this._guard = new BookGuard('DERIBIT', this, snapshotFn);
 *   // In message handler:
 *   if (!this._guard.check(venueSymbol, seqId)) return; // gap detected, skip publish
 *   // On disconnect:
 *   this._guard.destroy();
 */

'use strict';

const { publish } = require('../core/eventBus');

const STALE_TIMEOUT_MS    = 5000;  // 5 seconds with no update → STALE
const SNAPSHOT_COOLDOWN_MS = 2000; // 2 seconds between snapshots per symbol

class BookGuard {
  /**
   * @param {string} venue          - e.g. 'DERIBIT'
   * @param {import('events').EventEmitter} adapter - parent adapter (for emitting feed_status)
   * @param {function} snapshotFn   - async (venueSymbol) => void — fetches REST snapshot and rebuilds book
   * @param {object} [opts]
   * @param {boolean} [opts.publishToBus=true]
   * @param {object}  [opts.dataBreaker] - CircuitBreaker for REST data calls
   */
  constructor(venue, adapter, snapshotFn, { publishToBus = true, dataBreaker = null } = {}) {
    this.venue         = venue;
    this._adapter      = adapter;
    this._snapshotFn   = snapshotFn;
    this._publishToBus = publishToBus;
    this._dataBreaker  = dataBreaker;

    /** @type {Map<string, { lastSeq: number|null, lastUpdateTs: number, stale: boolean, snapshotAt: number, rebuilding: boolean }>} */
    this._symbols = new Map();

    this._staleTimer = setInterval(() => this._checkStale(), 1000);
  }

  /**
   * Get or create per-symbol tracking state.
   */
  _getState(venueSymbol) {
    if (!this._symbols.has(venueSymbol)) {
      this._symbols.set(venueSymbol, {
        lastSeq:     null,
        lastUpdateTs: Date.now(),
        stale:        false,
        snapshotAt:   0,
        rebuilding:   false,
      });
    }
    return this._symbols.get(venueSymbol);
  }

  /**
   * Check a sequence number for a book update.
   * Returns true if the update is safe to publish, false if a gap was detected.
   *
   * @param {string} venueSymbol
   * @param {number|null} seqId         - Current sequence/change ID
   * @param {boolean} [isSnapshot=false] - True if this is a full snapshot (resets sequence)
   * @returns {boolean} true = publish normally, false = gap detected, do not publish
   */
  check(venueSymbol, seqId, isSnapshot = false) {
    const s = this._getState(venueSymbol);
    s.lastUpdateTs = Date.now();

    // If feed was stale, mark it live again
    if (s.stale) {
      s.stale = false;
      this._emitFeedStatus(venueSymbol, 'LIVE');
      console.log(`INFO: Feed restored for ${this.venue} ${venueSymbol}`);
    }

    // Snapshots reset the baseline
    if (isSnapshot || s.lastSeq === null || seqId === null || seqId === undefined) {
      s.lastSeq = seqId;
      s.rebuilding = false;
      return true;
    }

    // Check for gap
    const expected = s.lastSeq + 1;
    if (seqId > expected) {
      console.warn(`WARNING: Sequence gap detected on ${this.venue} ${venueSymbol} — expected ${expected}, got ${seqId}. Rebuilding book.`);
      s.stale = true;
      this._emitFeedStatus(venueSymbol, 'STALE');
      this._triggerSnapshot(venueSymbol, s);
      return false; // Do not publish stale data
    }

    // Normal: consecutive or same (idempotent re-delivery)
    if (seqId >= s.lastSeq) {
      s.lastSeq = seqId;
    }
    return true;
  }

  /**
   * Record that a message was received for a symbol (for stale detection on non-book channels).
   * Call this from ticker/trade handlers too.
   */
  touch(venueSymbol) {
    const s = this._getState(venueSymbol);
    s.lastUpdateTs = Date.now();
    if (s.stale) {
      s.stale = false;
      this._emitFeedStatus(venueSymbol, 'LIVE');
    }
  }

  /**
   * Clean up timers.
   */
  destroy() {
    if (this._staleTimer) { clearInterval(this._staleTimer); this._staleTimer = null; }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _triggerSnapshot(venueSymbol, state) {
    const now = Date.now();
    if (now - state.snapshotAt < SNAPSHOT_COOLDOWN_MS) {
      console.log(`[bookGuard] Snapshot throttled for ${this.venue} ${venueSymbol} — cooldown active`);
      return;
    }
    if (state.rebuilding) return;

    state.rebuilding = true;
    state.snapshotAt = now;

    try {
      if (this._dataBreaker) {
        await this._dataBreaker.execute(() => this._snapshotFn(venueSymbol));
      } else {
        await this._snapshotFn(venueSymbol);
      }
      state.stale = false;
      state.rebuilding = false;
      this._emitFeedStatus(venueSymbol, 'LIVE');
      console.log(`INFO: Order book rebuilt for ${this.venue} ${venueSymbol} after sequence gap`);
    } catch (err) {
      state.rebuilding = false;
      console.error(`[bookGuard] Snapshot failed for ${this.venue} ${venueSymbol}:`, err.message);
    }
  }

  _checkStale() {
    const now = Date.now();
    for (const [venueSymbol, s] of this._symbols) {
      if (!s.stale && (now - s.lastUpdateTs) > STALE_TIMEOUT_MS) {
        s.stale = true;
        console.warn(`WARNING: Stale feed on ${this.venue} ${venueSymbol} — no update for ${STALE_TIMEOUT_MS}ms`);
        this._emitFeedStatus(venueSymbol, 'STALE');
      }
    }
  }

  _emitFeedStatus(venueSymbol, status) {
    const event = {
      type:     'feed_status',
      venue:    this.venue,
      symbol:   venueSymbol,
      status,
      ts:       Date.now(),
    };
    this._adapter.emit('feed_status', event);
    if (this._publishToBus) {
      publish('feed.status', event, `${this.venue}.${venueSymbol}`).catch(() => {});
    }
  }
}

module.exports = { BookGuard };
