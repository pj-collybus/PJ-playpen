/**
 * Sniper — Institutional-grade sniping strategy
 *
 * Snipe mode (rewritten):
 *   Multi-level price ladder with volume confirmation, momentum filter,
 *   iceberg execution, and intelligent retrigger logic.
 *
 * Post+Snipe mode (unchanged):
 *   Place a resting limit order at targetPrice, plus actively snipe
 *   any liquidity that appears at or better than snipeLevel.
 *
 * Snipe states:  WAITING → CONFIRMING → FIRING → COMPLETED / EXPIRED / STOPPED
 * Level states:  WAITING → CONFIRMING → FIRING → COMPLETED
 */

'use strict';

const config = {
  name: 'SNIPER',
  displayName: 'Sniper',
  description: 'Multi-level snipe with volume confirmation, momentum filter, and iceberg execution',
  params: [
    { key: 'venue', label: 'Exchange', type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'executionMode', label: 'Execution mode', type: 'select', options: [{value:'snipe',label:'Snipe'},{value:'post_snipe',label:'Post + Snipe'}], default: 'snipe' },

    // Ladder levels (snipe mode)
    { key: 'levels', label: 'Price levels', type: 'ladder', default: [{ price: 0, pct: 100, enabled: true }], dependsOn: { executionMode: 'snipe' } },

    // Post+Snipe params (unchanged)
    { key: 'targetPrice', label: 'Limit price', type: 'number', default: 0, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'snipeLevel', label: 'Snipe price', type: 'number', default: 0, dependsOn: { executionMode: 'post_snipe' } },

    // Volume confirmation
    { key: 'volumeConfirmEnabled', label: 'Volume confirmation', type: 'select', options: [{value:'false',label:'Disabled'},{value:'true',label:'Enabled'}], default: 'false', dependsOn: { executionMode: 'snipe' } },
    { key: 'volumeConfirmSize', label: 'Min volume at level', type: 'number', default: 50, dependsOn: { volumeConfirmEnabled: 'true' } },
    { key: 'volumeConfirmWindowMs', label: 'Volume window (ms)', type: 'number', default: 5000, dependsOn: { volumeConfirmEnabled: 'true' } },

    // Momentum filter
    { key: 'momentumFilterEnabled', label: 'Momentum filter', type: 'select', options: [{value:'false',label:'Disabled'},{value:'true',label:'Enabled'}], default: 'false', dependsOn: { executionMode: 'snipe' } },
    { key: 'momentumLookbackMs', label: 'Momentum lookback (ms)', type: 'number', default: 3000, dependsOn: { momentumFilterEnabled: 'true' } },
    { key: 'momentumMinBps', label: 'Min momentum (bps/s)', type: 'number', default: 2, dependsOn: { momentumFilterEnabled: 'true' } },

    // Partial fill retry
    { key: 'retriggerMode', label: 'Retrigger mode', type: 'select', options: [{value:'same',label:'Same price'},{value:'better',label:'Better price (improve avg)'},{value:'vwap',label:'VWAP chase'}], default: 'same', dependsOn: { executionMode: 'snipe' } },
    { key: 'retriggerImproveTicks', label: 'Improve by (ticks)', type: 'number', default: 1, dependsOn: { retriggerMode: 'better' } },
    { key: 'retriggerCooldownMs', label: 'Cooldown (ms)', type: 'number', default: 3000, dependsOn: { executionMode: 'snipe' } },
    { key: 'maxRetriggers', label: 'Max retriggers per level', type: 'number', default: 5, dependsOn: { executionMode: 'snipe' } },

    // Iceberg snipe
    { key: 'icebergEnabled', label: 'Iceberg snipe', type: 'select', options: [{value:'false',label:'Single IOC'},{value:'true',label:'Iceberg IOC'}], default: 'false', dependsOn: { executionMode: 'snipe' } },
    { key: 'icebergSlicePct', label: 'Slice size (%)', type: 'number', default: 25, min: 5, max: 100, dependsOn: { icebergEnabled: 'true' } },
    { key: 'icebergDelayMinMs', label: 'Min delay (ms)', type: 'number', default: 200, dependsOn: { icebergEnabled: 'true' } },
    { key: 'icebergDelayMaxMs', label: 'Max delay (ms)', type: 'number', default: 800, dependsOn: { icebergEnabled: 'true' } },

    // Standard
    { key: 'maxSpreadBps', label: 'Max spread (bps)', type: 'number', default: 50 },
    { key: 'expiryMode', label: 'Expires', type: 'select', options: [{value:'gtc',label:'Never (GTC)'},{value:'time',label:'At time'},{value:'eod',label:'End of day'}], default: 'gtc' },
    { key: 'expiryTime', label: 'Expiry time', type: 'text', default: '', dependsOn: { expiryMode: 'time' } },
  ],
};

function _parseTime(str) {
  if (!str) return null;
  str = str.trim();
  const rel = str.match(/^\+(\d+)([mhMs]?)$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = (rel[2] || 'm').toLowerCase();
    return Date.now() + (unit === 'h' ? n * 3600000 : unit === 's' ? n * 1000 : n * 60000);
  }
  const hm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

class SniperStrategy {
  constructor(params) {
    this.symbol    = params.symbol;
    this.side      = params.side;
    this.venue     = params.venue || 'Deribit';
    this.totalSize = params.totalSize || 0;

    this._executionMode    = params.executionMode || 'snipe';
    this._tickSize         = params.tickSize || 0.0001;
    this._lotSize          = params.lotSize || 1;
    this._maxSpreadBps     = params.maxSpreadBps || 50;

    // ── Post+Snipe params (unchanged) ──
    this._targetPrice      = params.targetPrice || 0;
    this._snipeLevel       = params.snipeLevel || 0;

    // ── Snipe mode: ladder levels ──
    const rawLevels = Array.isArray(params.levels) ? params.levels : [{ price: params.targetPrice || 0, pct: 100, enabled: true }];
    this._levels = rawLevels.filter(l => l.enabled !== false).map(l => ({
      price:             parseFloat(l.price) || 0,
      pct:               parseFloat(l.pct) || 0,
      allocatedSize:     this.totalSize * (parseFloat(l.pct) || 0) / 100,
      filledSize:        0,
      status:            'WAITING',
      retriggerCount:    0,
      currentSnipePrice: parseFloat(l.price) || 0,
      volumeAtLevel:     0,
      lastVolumeWindowStart: 0,
      icebergRemaining:  0,
      nextIcebergAt:     0,
      activeChildId:     null,
    }));

    // Volume confirmation
    this._volumeConfirmEnabled = String(params.volumeConfirmEnabled) === 'true';
    this._volumeConfirmSize    = parseFloat(params.volumeConfirmSize) || 50;
    this._volumeConfirmWindowMs = parseInt(params.volumeConfirmWindowMs) || 5000;

    // Momentum filter
    this._momentumFilterEnabled = String(params.momentumFilterEnabled) === 'true';
    this._momentumLookbackMs    = parseInt(params.momentumLookbackMs) || 3000;
    this._momentumMinBps        = parseFloat(params.momentumMinBps) || 2;

    // Retrigger
    this._retriggerMode        = params.retriggerMode || 'same';
    this._retriggerImproveTicks = parseInt(params.retriggerImproveTicks) || 1;
    this._retriggerCooldownMs  = parseInt(params.retriggerCooldownMs) || 3000;
    this._maxRetriggers        = parseInt(params.maxRetriggers) || 5;

    // Iceberg
    this._icebergEnabled       = String(params.icebergEnabled) === 'true';
    this._icebergSlicePct      = parseFloat(params.icebergSlicePct) || 25;
    this._icebergDelayMinMs    = parseInt(params.icebergDelayMinMs) || 200;
    this._icebergDelayMaxMs    = parseInt(params.icebergDelayMaxMs) || 800;

    // Expiry
    this._expiryMode = params.expiryMode || 'gtc';
    if (this._expiryMode === 'time') {
      this._expiryTs = _parseTime(params.expiryTime) || null;
    } else if (this._expiryMode === 'eod') {
      const eod = new Date(); eod.setHours(23, 59, 59, 999);
      this._expiryTs = eod.getTime();
    } else {
      this._expiryTs = null;
    }

    // Chart
    this._chartBids = []; this._chartAsks = []; this._chartOrder = [];
    this._chartTimes = []; this._chartFills = [];
    this._chartSampleMs = 1000; this._chartLastSampleTs = 0;
    this._chartMaxPts = 3600; // 1 hour at 1s sample rate

    // Global state
    this.status          = 'WAITING';
    this.filledSize      = 0;
    this.remainingSize   = this.totalSize;
    this.avgFillPrice    = 0;
    this.totalNotional   = 0;
    this.arrivalPrice    = 0;
    this.slippageVsArrival = 0;
    this.pauseReason     = null;

    this.activeLevelIndex = 0;
    this._priceHistory    = [];   // [{price, timestamp}] for momentum
    this._rollingTrades   = [];   // [{price, size, timestamp}] for volume confirm
    this._retriggerAt     = 0;

    // Post+Snipe state (unchanged)
    this.restingOrderId   = null;
    this.restingOrderSize = this.totalSize;
    this.snipedSize       = 0;
    this.passiveFillSize  = 0;
    this._lastSnipeTs     = 0;
    this._snipeChildId    = null;
    this._restingPrice    = null;
    this.activeChildId    = null;

    this._completedTs     = 0;
    this._startTs         = Date.now();
    this._lastMd          = null;
    this._ctx             = null;
    this._stopped         = false;
  }

  get type() { return 'SNIPER'; }

  start(ctx) {
    this._ctx = ctx;
    if (this._executionMode === 'post_snipe') {
      console.log(`[sniper] Post+Snipe: posting ${this.totalSize} at $${this._targetPrice}, snipe ceiling $${this._snipeLevel}`);
      this._activatePostSnipe();
    } else {
      const levelSummary = this._levels.map((l, i) => `L${i+1}: $${l.price} ${l.pct}% (${l.allocatedSize.toFixed(4)})`).join(', ');
      console.log(`[sniper] Snipe: totalSize=${this.totalSize}, ${this._levels.length} levels — ${levelSummary}`);
      console.log('[sniper] Level sizes:', this._levels.map(l => l.allocatedSize));
      if (this._volumeConfirmEnabled) console.log(`[sniper] Volume confirmation: ${this._volumeConfirmSize} in ${this._volumeConfirmWindowMs}ms`);
      if (this._momentumFilterEnabled) console.log(`[sniper] Momentum filter: ${this._momentumMinBps} bps/s over ${this._momentumLookbackMs}ms`);
      if (this._icebergEnabled) console.log(`[sniper] Iceberg: ${this._icebergSlicePct}% slices, ${this._icebergDelayMinMs}-${this._icebergDelayMaxMs}ms delay`);
    }
  }

  pause()  { if (this.status !== 'COMPLETED' && this.status !== 'EXPIRED') { this._prevStatus = this.status; this.status = 'PAUSED'; this.pauseReason = 'manual'; } }
  resume() { if (this.status === 'PAUSED') { this.status = this._prevStatus || 'WAITING'; this.pauseReason = null; } }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    // Cancel all active orders
    for (const level of this._levels) {
      if (level.activeChildId) { this._ctx.cancelChild(level.activeChildId); level.activeChildId = null; }
    }
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this._snipeChildId) { this._ctx.cancelChild(this._snipeChildId); this._snipeChildId = null; }
    if (this.restingOrderId) { this._ctx.cancelChild(this.restingOrderId); this.restingOrderId = null; }
    if (this.status !== 'COMPLETED' && this.status !== 'EXPIRED') this.status = 'STOPPED';
    console.log(`[sniper] Stopped: filled=${this.filledSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)}`);
  }

  // ── Post+Snipe (unchanged) ────────────────────────────────────────────────

  _activatePostSnipe() {
    this.status = 'ACTIVE';
    this._placeRestingOrder();
  }

  _placeRestingOrder() {
    if (this.restingOrderId) { this._ctx.cancelChild(this.restingOrderId); this.restingOrderId = null; }
    this.restingOrderSize = this.remainingSize;
    if (this.restingOrderSize <= 0.001) return;
    this.restingOrderId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: this.restingOrderSize,
      limitPrice: this._targetPrice, orderType: 'LIMIT', algoType: 'SNIPER-POST',
    });
    this._restingPrice = this._targetPrice;
  }

  _firePostSnipe(bid, ask) {
    if (this._snipeChildId || this.remainingSize <= this._lotSize * 0.5) return;
    if (Date.now() - this._lastSnipeTs < 200) return;
    const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
    const qty = Math.round(Math.min(this.remainingSize, this.totalSize) / this._lotSize) * this._lotSize;
    if (qty <= 0) return;
    this._snipeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: qty,
      limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER-SNIPE',
    });
    this._lastSnipeTs = Date.now();
    console.log(`[sniper] Post+Snipe fired: ${qty.toFixed(4)} @ $${price}`);
  }

  // ── Main tick handler ─────────────────────────────────────────────────────

  onTick(marketData) {
    this._lastMd = marketData;
    const now = Date.now();
    const bid = marketData.bidPrice || 0;
    const ask = marketData.askPrice || 0;
    const mid = marketData.midPrice || (bid && ask ? (bid + ask) / 2 : 0);

    if (this.arrivalPrice === 0 && mid > 0) this.arrivalPrice = mid;

    const isDone = this._stopped || this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED';

    // Chart sampling — dynamic rate: increase to 5s after 1 hour
    const elapsed = now - this._startTs;
    if (elapsed > this._chartMaxPts * 1000 && this._chartSampleMs < 5000) {
      this._chartSampleMs = 5000;
      this._chartMaxPts = 7200; // 10 hours at 5s
    }

    // Stop adding points after completion
    if (!isDone && bid > 0 && ask > 0 && now - this._chartLastSampleTs >= this._chartSampleMs) {
      this._chartLastSampleTs = now;
      this._chartBids.push(bid); this._chartAsks.push(ask);
      this._chartOrder.push(this._restingPrice || null);
      this._chartTimes.push(now);
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
      }
    }

    if (isDone || this.status === 'PAUSED') return;

    // Expiry check
    if (this._expiryTs && now >= this._expiryTs) {
      this.status = 'EXPIRED'; this._completedTs = now;
      console.log(`[sniper] Expired`);
      this.stop(); return;
    }

    // ── Post+Snipe mode (unchanged) ──────────────────────────────────────
    if (this._executionMode === 'post_snipe') {
      if (this.status === 'ACTIVE' && bid > 0 && ask > 0) {
        if (this.filledSize >= this.totalSize - 0.001) {
          this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
        }
        const snipeTriggered = this.side === 'BUY'
          ? (this._snipeLevel > 0 && ask <= this._snipeLevel)
          : (this._snipeLevel > 0 && bid >= this._snipeLevel);
        if (snipeTriggered && !this._snipeChildId && this.remainingSize > this._lotSize * 0.5) {
          this._firePostSnipe(bid, ask);
        }
      }
      return;
    }

    // ── Snipe mode: multi-level ladder ───────────────────────────────────
    if (mid <= 0) return;

    // Update price history for momentum
    this._priceHistory.push({ price: mid, timestamp: now });
    const histCutoff = now - Math.max(this._momentumLookbackMs, 10000);
    while (this._priceHistory.length > 0 && this._priceHistory[0].timestamp < histCutoff) {
      this._priceHistory.shift();
    }

    // Check completion
    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
    }

    // Get active level
    if (this.activeLevelIndex >= this._levels.length) {
      this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
    }
    const level = this._levels[this.activeLevelIndex];
    const levelTolerance = Math.max(0.001, level.allocatedSize * 0.01); // 99% filled = complete
    if (level.filledSize >= level.allocatedSize - levelTolerance) {
      level.status = 'COMPLETED';
      this.activeLevelIndex++;
      console.log(`[sniper] Level ${this.activeLevelIndex} completed (filled=${level.filledSize.toFixed(4)}/${level.allocatedSize.toFixed(4)}) — advancing to level ${this.activeLevelIndex + 1}`);
      return; // re-evaluate on next tick
    }

    // Retrigger cooldown
    if (this._retriggerAt > 0 && now < this._retriggerAt) {
      level.status = 'WAITING';
      this.status = 'WAITING';
      return;
    }
    this._retriggerAt = 0;

    // Step 1: Check trigger condition
    const triggered = this.side === 'BUY' ? (ask <= level.currentSnipePrice) : (bid >= level.currentSnipePrice);
    if (!triggered) {
      if (level.status !== 'WAITING') console.log(`[sniper] L${this.activeLevelIndex+1} trigger check: side=${this.side} bid=${bid} ask=${ask} snipePrice=${level.currentSnipePrice} triggered=false`);
      level.status = 'WAITING';
      this.status = 'WAITING';
      return;
    }
    console.log(`[sniper] L${this.activeLevelIndex+1} TRIGGERED: side=${this.side} bid=${bid} ask=${ask} snipePrice=${level.currentSnipePrice}`);

    // Step 2: Volume confirmation (if enabled)
    if (this._volumeConfirmEnabled) {
      const volAtLevel = this._calcVolumeAtLevel(level.currentSnipePrice, now);
      level.volumeAtLevel = volAtLevel;
      if (volAtLevel < this._volumeConfirmSize) {
        level.status = 'CONFIRMING';
        this.status = 'ACTIVE';
        console.log(`[sniper] Waiting for volume confirmation: ${volAtLevel.toFixed(1)}/${this._volumeConfirmSize}`);
        return;
      }
    }

    // Step 3: Momentum filter (if enabled)
    if (this._momentumFilterEnabled) {
      const velocity = this._calcMomentumBps();
      if (this.side === 'BUY') {
        if (velocity > -this._momentumMinBps) {
          level.status = 'CONFIRMING';
          this.status = 'ACTIVE';
          return;
        }
      } else {
        if (velocity < this._momentumMinBps) {
          level.status = 'CONFIRMING';
          this.status = 'ACTIVE';
          return;
        }
      }
      console.log(`[sniper] Momentum confirmed: ${velocity.toFixed(1)} bps/s`);
    }

    // Step 4: Spread gate
    if (marketData.spreadBps > this._maxSpreadBps) {
      this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps > ${this._maxSpreadBps}bps`;
      return;
    }
    this.pauseReason = null;

    // Step 5: Fire the snipe
    this.status = 'ACTIVE';
    level.status = 'FIRING';

    if (level.activeChildId) return; // order already in flight

    const levelRemaining = Math.max(0, level.allocatedSize - level.filledSize);
    if (levelRemaining < this._lotSize * 0.5) { level.status = 'COMPLETED'; this.activeLevelIndex++; return; }

    if (!this._icebergEnabled) {
      // Single IOC capped to level remaining
      const qty = this._roundQtyDown(levelRemaining);
      if (qty <= 0) return;
      const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      level.activeChildId = this._ctx.submitIntent({
        symbol: this.symbol, side: this.side, quantity: qty,
        limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER',
      });
      this._restingPrice = price;
      console.log(`[sniper] L${this.activeLevelIndex + 1} firing size=${qty.toFixed(4)} allocated=${level.allocatedSize.toFixed(4)} filled=${level.filledSize.toFixed(4)} remaining=${levelRemaining.toFixed(4)} @ $${price}`);
    } else {
      // Iceberg: fire slices capped to level remaining
      if (level.icebergRemaining <= 0) {
        level.icebergRemaining = levelRemaining;
      }
      level.icebergRemaining = Math.min(level.icebergRemaining, levelRemaining);
      if (now < level.nextIcebergAt) return;

      const rawSlice = Math.min(level.icebergRemaining, level.allocatedSize * this._icebergSlicePct / 100, levelRemaining);
      const sliceSize = this._roundQtyDown(rawSlice);
      if (sliceSize <= 0) return;

      const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      level.activeChildId = this._ctx.submitIntent({
        symbol: this.symbol, side: this.side, quantity: sliceSize,
        limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER',
      });
      this._restingPrice = price;
      level.nextIcebergAt = now + this._icebergDelayMinMs + Math.random() * (this._icebergDelayMaxMs - this._icebergDelayMinMs);
      console.log(`[sniper] L${this.activeLevelIndex + 1} Iceberg firing size=${sliceSize.toFixed(4)} allocated=${level.allocatedSize.toFixed(4)} filled=${level.filledSize.toFixed(4)} remaining=${levelRemaining.toFixed(4)} @ $${price}`);
    }
  }

  // ── Trade data handler (volume confirmation) ──────────────────────────────

  onTrade(trade) {
    if (!trade.size || trade.size <= 0) return;
    this._rollingTrades.push({ price: trade.price, size: trade.size, timestamp: trade.timestamp || Date.now() });
    // Expire old trades
    const cutoff = Date.now() - this._volumeConfirmWindowMs;
    while (this._rollingTrades.length > 0 && this._rollingTrades[0].timestamp < cutoff) {
      this._rollingTrades.shift();
    }
  }

  // ── Fill handling ─────────────────────────────────────────────────────────

  onFill(fill) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    if (this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED') return;

    // Cap fill to total remaining — never overfill the strategy
    const cappedFill = Math.min(fill.fillSize, Math.max(0, this.totalSize - this.filledSize));
    if (cappedFill <= 0) return;

    this.filledSize += cappedFill;
    this.remainingSize = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * cappedFill;
    this.avgFillPrice = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;

    if (this.arrivalPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.slippageVsArrival = (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    }

    // ── Post+Snipe fill handling (unchanged) ──
    if (this._executionMode === 'post_snipe') {
      const isSnipeFill = fill.childId === this._snipeChildId || fill.orderId === this._snipeChildId;
      const isRestingFill = fill.childId === this.restingOrderId || fill.orderId === this.restingOrderId;
      const fillType = isSnipeFill ? 'snipe' : isRestingFill ? 'passive' : 'unknown';
      if (fillType === 'snipe') this.snipedSize += fill.fillSize;
      else this.passiveFillSize += fill.fillSize;

      this._chartFills.push({ time: Date.now(), price: fill.fillPrice, size: fill.fillSize, side: this.side, simulated: !!fill.simulated, fillType });
      if (isSnipeFill) this._snipeChildId = null;

      if (this.filledSize >= this.totalSize - 0.001) {
        this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); return;
      }
      if (isSnipeFill && this.restingOrderId) {
        if (this.remainingSize <= this._lotSize * 0.5) {
          this._ctx.cancelChild(this.restingOrderId); this.restingOrderId = null; this.restingOrderSize = 0;
        } else {
          this._placeRestingOrder();
        }
      }
      return;
    }

    // ── Snipe mode fill handling ──
    // Match fill to active level
    const level = this._levels[this.activeLevelIndex];
    if (!level) return;

    const levelIdx = this.activeLevelIndex;
    // Cap fill to level remaining — never overfill a level
    const levelCappedFill = Math.min(cappedFill, Math.max(0, level.allocatedSize - level.filledSize));
    level.filledSize += levelCappedFill;
    this.snipedSize += levelCappedFill;

    // Determine fill colour by level index
    const levelColors = ['snipe-L1', 'snipe-L2', 'snipe-L3', 'snipe-L4', 'snipe-L5'];
    this._chartFills.push({
      time: Date.now(), price: fill.fillPrice, size: levelCappedFill,
      side: this.side, simulated: !!fill.simulated,
      fillType: levelColors[levelIdx] || 'snipe',
    });

    console.log(`[sniper] L${levelIdx + 1} Fill: ${levelCappedFill.toFixed(4)} @ ${fill.fillPrice} (raw=${fill.fillSize.toFixed(4)}) — level ${level.filledSize.toFixed(4)}/${level.allocatedSize.toFixed(4)}, total ${this.filledSize.toFixed(4)}/${this.totalSize.toFixed(4)}`);

    level.activeChildId = null;
    this._restingPrice = null;

    // Check level completion (99% filled = complete)
    const fillTolerance = Math.max(0.001, level.allocatedSize * 0.01);
    if (level.filledSize >= level.allocatedSize - fillTolerance) {
      level.status = 'COMPLETED';
      this.activeLevelIndex++;
      console.log(`[sniper] Level ${levelIdx + 1} COMPLETED (filled=${level.filledSize.toFixed(4)}/${level.allocatedSize.toFixed(4)}) — advancing to ${this.activeLevelIndex + 1}`);
      if (this.activeLevelIndex >= this._levels.length || this.filledSize >= this.totalSize - 0.001) {
        this._completedTs = Date.now(); this.status = 'COMPLETED';
        console.log(`[sniper] All levels COMPLETED: avg ${this.avgFillPrice.toFixed(4)}`);
        this.stop();
      }
      return;
    }

    // Partial fill — retrigger logic
    if (level.retriggerCount >= this._maxRetriggers) {
      level.status = 'COMPLETED';
      this.activeLevelIndex++;
      console.log(`[sniper] L${levelIdx + 1} Max retriggers (${this._maxRetriggers}) — advancing`);
      return;
    }

    // Calculate next snipe price
    if (this._retriggerMode === 'better') {
      const improve = this._retriggerImproveTicks * this._tickSize;
      level.currentSnipePrice = this.side === 'BUY'
        ? level.currentSnipePrice - improve
        : level.currentSnipePrice + improve;
      console.log(`[sniper] L${levelIdx + 1} Retrigger improved price: $${level.currentSnipePrice}`);
    } else if (this._retriggerMode === 'vwap') {
      level.currentSnipePrice = this.avgFillPrice;
      console.log(`[sniper] L${levelIdx + 1} Retrigger VWAP chase: $${level.currentSnipePrice}`);
    }

    level.retriggerCount++;
    level.icebergRemaining = 0; // reset iceberg for new attempt
    this._retriggerAt = Date.now() + this._retriggerCooldownMs;
    level.status = 'WAITING';
    this.status = 'WAITING';
    console.log(`[sniper] L${levelIdx + 1} Partial — retrigger #${level.retriggerCount} in ${this._retriggerCooldownMs}ms`);
  }

  onOrderUpdate(order) {
    const matchId = order.orderId || order.intentId;
    // Check all levels for matching child
    for (const level of this._levels) {
      if (matchId === level.activeChildId) {
        if (order.state === 'REJECTED' || order.state === 'CANCELLED') {
          console.log(`[sniper] Level order ${matchId} ${order.state}`);
          level.activeChildId = null;
          if (this._icebergEnabled) {
            level.icebergRemaining = Math.max(0, level.icebergRemaining - (order.filledSize || 0));
          }
        }
        return;
      }
    }
    // Post+Snipe orders
    if (matchId === this._snipeChildId && (order.state === 'REJECTED' || order.state === 'CANCELLED')) {
      this._snipeChildId = null;
    }
    if (matchId === this.restingOrderId && (order.state === 'REJECTED' || order.state === 'CANCELLED')) {
      this.restingOrderId = null; this._restingPrice = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _roundQty(qty) {
    return Math.max(this._lotSize, Math.round(qty / this._lotSize) * this._lotSize);
  }

  // Round DOWN to lot size — never exceed the requested qty
  _roundQtyDown(qty) {
    const rounded = Math.floor(qty / this._lotSize) * this._lotSize;
    return rounded >= this._lotSize ? rounded : 0;
  }

  _calcVolumeAtLevel(snipePrice, now) {
    const cutoff = now - this._volumeConfirmWindowMs;
    let vol = 0;
    for (const t of this._rollingTrades) {
      if (t.timestamp < cutoff) continue;
      if (this.side === 'BUY' && t.price <= snipePrice) vol += t.size;
      if (this.side === 'SELL' && t.price >= snipePrice) vol += t.size;
    }
    return vol;
  }

  _calcMomentumBps() {
    if (this._priceHistory.length < 2) return 0;
    const now = Date.now();
    const lookback = now - this._momentumLookbackMs;
    const recent = this._priceHistory.filter(p => p.timestamp >= lookback);
    if (recent.length < 2) return 0;
    const first = recent[0], last = recent[recent.length - 1];
    const elapsed = (last.timestamp - first.timestamp) / 1000; // seconds
    if (elapsed <= 0 || first.price <= 0) return 0;
    return ((last.price - first.price) / first.price * 10000) / elapsed; // bps per second
  }

  // ── State for frontend ────────────────────────────────────────────────────

  getState() {
    const now = Date.now();
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED';
    const elapsed = this._startTs ? (isDone && this._completedTs ? this._completedTs - this._startTs : now - this._startTs) : 0;
    const mid = this._lastMd?.midPrice || 0;
    const activeLevel = this._levels[this.activeLevelIndex];
    const activeLevelPrice = activeLevel?.currentSnipePrice || this._targetPrice;
    const distanceBps = mid > 0 && activeLevelPrice > 0 ? (mid - activeLevelPrice) / activeLevelPrice * 10000 : 0;
    const distancePct = mid > 0 && activeLevelPrice > 0 ? Math.max(0, 100 - Math.abs(distanceBps) / 2) : 0;

    // Momentum velocity for display
    const momentumBps = this._calcMomentumBps();

    return {
      type: 'SNIPER', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival,
      targetPrice: activeLevelPrice,
      triggerCondition: this.side === 'BUY' ? 'breaks_below' : 'breaks_above',
      executionMode: this._executionMode,
      snipeLevel: this._snipeLevel,
      retriggerEnabled: true,
      distanceBps, distancePct,
      triggered: this.status !== 'WAITING', triggerTs: 0,
      expiryTs: this._expiryTs,
      activeOrderPrice: this._restingPrice,
      restingOrderSize: this.restingOrderSize,
      snipedSize: this.snipedSize,
      passiveFillSize: this.passiveFillSize,
      pauseReason: this.pauseReason,
      elapsed, timeRemaining: this._expiryTs ? Math.max(0, this._expiryTs - now) : null,
      tickSize: this._tickSize,
      maxChartPoints: this._chartMaxPts,

      // Ladder state for monitor
      levels: this._levels.map((l, i) => ({
        price: l.currentSnipePrice,
        pct: l.pct,
        allocatedSize: l.allocatedSize,
        filledSize: l.filledSize,
        status: l.status,
        retriggerCount: l.retriggerCount,
        volumeAtLevel: l.volumeAtLevel,
        active: i === this.activeLevelIndex,
      })),
      activeLevelIndex: this.activeLevelIndex,
      momentumBps,
      volumeConfirmEnabled: this._volumeConfirmEnabled,
      volumeConfirmSize: this._volumeConfirmSize,
      momentumFilterEnabled: this._momentumFilterEnabled,
      momentumMinBps: this._momentumMinBps,
      icebergEnabled: this._icebergEnabled,

      // Chart data
      chartBids: [...this._chartBids], chartAsks: [...this._chartAsks],
      chartOrder: [...this._chartOrder], chartTimes: [...this._chartTimes],
      chartFills: [...this._chartFills],
      chartTargetPrice: activeLevelPrice,
      chartSnipeLevel: this._executionMode === 'post_snipe' ? this._snipeLevel : null,
      // All level prices for chart lines
      chartLevelPrices: this._levels.map(l => ({ price: l.currentSnipePrice, status: l.status })),
    };
  }
}

function estimateDuration(params) {
  if (params.executionMode === 'post_snipe') {
    return `Post @ $${params.targetPrice || '?'} + snipe ceiling $${params.snipeLevel || '?'}`;
  }
  const levels = Array.isArray(params.levels) ? params.levels.filter(l => l.enabled !== false) : [];
  if (levels.length <= 1) {
    return `Snipe @ $${levels[0]?.price || '?'}`;
  }
  return `${levels.length}-level ladder: $${levels[0]?.price || '?'} → $${levels[levels.length - 1]?.price || '?'}`;
}

module.exports = { config, Strategy: SniperStrategy, estimateDuration };
