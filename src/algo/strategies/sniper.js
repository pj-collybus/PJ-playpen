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

const { floorToLot, splitToLots } = require('../../utils/sizeUtils');

const config = {
  name: 'SNIPER',
  displayName: 'Sniper',
  description: 'Multi-level snipe with volume confirmation, momentum filter, and iceberg execution',
  params: [
    { key: 'venue', label: 'Exchange', type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'executionMode', label: 'Execution mode', type: 'select', options: [{value:'snipe',label:'Snipe'},{value:'post_snipe',label:'Post + Snipe'}], default: 'snipe' },

    // Ladder levels (snipe mode)
    { key: 'levels', label: 'Price levels', type: 'ladder', default: [{ price: 0, pct: 100, enabled: true }], dependsOn: { executionMode: 'snipe' } },

    // Post+Snipe params
    { key: 'targetPrice', label: 'Limit price (passive rest)', type: 'number', default: 0, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'snipeLevel', label: 'Snipe price (aggressive ceiling)', type: 'number', default: 0, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'snipePct', label: 'Snipe %', type: 'number', default: 50, min: 10, max: 90, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'minSnipePct', label: 'Min size to snipe %', type: 'number', default: 5, min: 1, max: 20, dependsOn: { executionMode: 'post_snipe' } },

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
    this._levelMode        = params.levelMode || 'sequential';  // sequential | simultaneous
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
    this._maxRetriggers        = parseInt(params.maxRetriggers) || (this._levelMode === 'simultaneous' ? 20 : 5);

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
    this._rollingTrades   = [];   // [{price, size, timestamp}] for volume confirm + VWAP
    this._rollingVwap     = 0;
    this._retriggerAt     = 0;

    // Post+Snipe state — snipe cap model
    this._snipePct        = Math.min(90, Math.max(10, parseFloat(params.snipePct) || 50));
    this._minSnipePct     = Math.min(20, Math.max(1, parseFloat(params.minSnipePct) || 5));
    this._maxSnipeTotal   = this.totalSize * this._snipePct / 100;
    this._minSnipeSize    = this.totalSize * this._minSnipePct / 100;
    console.log(`[sniper] constructor: mode=${this._executionMode} levelMode=${this._levelMode} totalSize=${this.totalSize} levels=${this._levels.length} snipePct=${this._snipePct} maxSnipeTotal=${this._maxSnipeTotal}`);
    if (this._levels.length > 1) console.log(`[sniper] levels:`, this._levels.map((l,i) => `L${i+1}: $${l.price} ${l.pct}% alloc=${l.allocatedSize}`).join(', '));
    this._postSnipePhase  = 'ACTIVE';  // ACTIVE | REST_ONLY
    this._currentRoundTotal = 0;
    this._currentPostSize = 0;
    this._currentSnipeSize = 0;
    this._postOrderId     = null;
    this._snipeChildId    = null;
    this._postFilled      = 0;
    this._roundNumber     = 0;
    this._cancellingForSnipe = false;  // true while cancelling resting before snipe
    this.snipedSize       = 0;
    this.passiveFillSize  = 0;
    this.restingOrderSize = 0;
    this._restingPrice    = null;
    this.activeChildId    = null;

    this._completedTs     = 0;
    this._startTs         = Date.now();
    this._lastMd          = null;
    this._ctx             = null;
    this._stopped         = false;
  }

  get type() { return 'SNIPER'; }

  // True completion: all quantity filled, OR all components resolved
  _isComplete() {
    if (this.filledSize >= this.totalSize - (this._lotSize || 0.001)) return true;

    // For simultaneous Post+Snipe: resting filled AND all levels done
    if (this._levelMode === 'simultaneous' && this._executionMode === 'post_snipe') {
      const restingDone = !this._postOrderId && this._roundNumber > 0;
      const allLevelsDone = this._levels.every(l => {
        const tol = Math.max(this._lotSize || 0.001, l.allocatedSize * 0.001);
        return l.filledSize >= l.allocatedSize - tol || l.retriggerCount >= this._maxRetriggers || l.status === 'COMPLETED';
      });
      if (restingDone && allLevelsDone) return true;
    }

    // For sequential snipe: all levels done
    if (this._executionMode === 'snipe' && this.activeLevelIndex >= this._levels.length) return true;

    return false;
  }

  start(ctx) {
    this._ctx = ctx;
    if (this._executionMode === 'post_snipe') {
      console.log(`[post+snipe] Start: total=${this.totalSize} limit=$${this._targetPrice} snipe=$${this._snipeLevel} snipePct=${this._snipePct}% maxSnipe=${this._maxSnipeTotal.toFixed(4)} minSnipeSize=${this._minSnipeSize.toFixed(4)}`);
      this.status = 'ACTIVE';
      this._startRound();
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
    if (this._postOrderId) { this._ctx.cancelChild(this._postOrderId); this._postOrderId = null; }
    if (this.status !== 'COMPLETED' && this.status !== 'EXPIRED') this.status = 'STOPPED';
    console.log(`[sniper] Stopped: filled=${this.filledSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)}`);
  }

  // ── Post+Snipe — round-based split execution ──────────────────────────────

  _startRound() {
    const remaining = Math.max(0, this.totalSize - this.filledSize);
    if (remaining < this._lotSize * 0.01) {
      this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); return;
    }

    this._postFilled = 0;
    this._snipeChildId = null;
    this._cancellingForSnipe = false;
    this._roundNumber++;

    // Simultaneous mode: resting order = (100 - snipePct)%, levels handle snipe independently
    if (this._levelMode === 'simultaneous' && this._levels.length > 1) {
      this._postSnipePhase = 'ACTIVE';
      this._currentRoundTotal = remaining;
      // Post size = total - sum of level allocations (remainder from lot rounding goes here)
      const totalSnipeAlloc = this._levels.reduce((s, l) => s + l.allocatedSize, 0);
      const totalSnipeFilled = this._levels.reduce((s, l) => s + l.filledSize, 0);
      const snipeRemaining = totalSnipeAlloc - totalSnipeFilled;
      this._currentPostSize = Math.max(0, remaining - snipeRemaining);
      this._currentSnipeSize = snipeRemaining;
      console.log(`[post+snipe] Round ${this._roundNumber} SIMULTANEOUS: totalSize=${this.totalSize} remaining=${remaining.toFixed(4)} snipeAlloc=${totalSnipeAlloc.toFixed(4)} snipeFilled=${totalSnipeFilled.toFixed(4)} post=${this._currentPostSize.toFixed(4)} snipeRemaining=${snipeRemaining.toFixed(4)}`);
      console.log('[sniper] simultaneous mode: activating', this._levels.length, 'levels:', this._levels.map((l,i) => `L${i+1}=$${l.currentSnipePrice} alloc=${l.allocatedSize} filled=${l.filledSize}`).join(', '));
      // Place resting order for post portion — use raw size (remainder from active rounding)
      if (this._currentPostSize > 0) {
        this._postOrderId = this._ctx.submitIntent({
          symbol: this.symbol, side: this.side, quantity: this._currentPostSize,
          limitPrice: this._targetPrice, orderType: 'LIMIT', algoType: 'SNIPER-POST',
        });
        this.restingOrderSize = this._currentPostSize;
        this._restingPrice = this._targetPrice;
      }
      return;
    }

    const remainingSnipeAllowance = Math.max(0, this._maxSnipeTotal - this.snipedSize);

    if (remaining <= this._minSnipeSize || remainingSnipeAllowance < this._lotSize) {
      // Below min snipe size or snipe cap reached — rest full remaining passively
      this._postSnipePhase = 'REST_ONLY';
      this._currentRoundTotal = remaining;
      this._currentPostSize = remaining; // passive absorbs all remainder — no rounding
      this._currentSnipeSize = 0;
      const reason = remainingSnipeAllowance < this._lotSize ? 'snipe cap reached' : 'below min snipe size';
      console.log(`[post+snipe] Round ${this._roundNumber} REST_ONLY (${reason}): ${this._currentPostSize.toFixed(4)} @ $${this._targetPrice}`);
    } else {
      this._postSnipePhase = 'ACTIVE';
      this._currentRoundTotal = remaining;
      // Snipe size = smaller of: 50% of remaining OR remaining snipe allowance
      let thisRoundSnipe = Math.min(remaining * 0.5, remainingSnipeAllowance);
      thisRoundSnipe = floorToLot(thisRoundSnipe, this._lotSize);
      if (thisRoundSnipe < this._lotSize) thisRoundSnipe = remaining < this._lotSize ? remaining : 0;
      this._currentSnipeSize = thisRoundSnipe;
      this._currentPostSize = remaining - thisRoundSnipe;
      if (this._currentPostSize < this._lotSize && this._currentPostSize > 0) this._currentPostSize = remaining < this._lotSize ? remaining : this._lotSize;
      console.log(`[post+snipe] Round ${this._roundNumber} ACTIVE: total=${remaining.toFixed(4)} post=${this._currentPostSize.toFixed(4)} snipe=${this._currentSnipeSize.toFixed(4)} snipeAllowance=${remainingSnipeAllowance.toFixed(4)}/${this._maxSnipeTotal.toFixed(4)}`);
    }

    // Place resting limit order
    const postQty = this._currentPostSize;
    if (postQty > 0) {
      this._postOrderId = this._ctx.submitIntent({
        symbol: this.symbol, side: this.side, quantity: postQty,
        limitPrice: this._targetPrice, orderType: 'LIMIT', algoType: 'SNIPER-POST',
      });
      this.restingOrderSize = postQty;
      this._restingPrice = this._targetPrice;
    }
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

    // ── Post+Snipe mode — round-based ──────────────────────────────────
    if (this._executionMode === 'post_snipe') {
      if (this.status !== 'ACTIVE' || bid <= 0 || ask <= 0) return;

      // Completion check
      if (this._isComplete()) {
        this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
      }

      // REST_ONLY: just wait for passive fills
      if (this._postSnipePhase === 'REST_ONLY') return;

      // ── Simultaneous mode: each level fires independently, resting stays ──
      if (this._levelMode === 'simultaneous' && this._levels.length > 0) {
        for (let li = 0; li < this._levels.length; li++) {
          const lvl = this._levels[li];
          const lvlTol = Math.max(0.001, lvl.allocatedSize * 0.01);
          if (lvl.filledSize >= lvl.allocatedSize - lvlTol) {
            if (lvl.status !== 'COMPLETED') console.log(`[sniper] L${li+1} completed: filled=${lvl.filledSize.toFixed(4)}/${lvl.allocatedSize.toFixed(4)}`);
            lvl.status = 'COMPLETED'; continue;
          }
          if (lvl.retriggerCount >= this._maxRetriggers) {
            if (lvl.status !== 'COMPLETED') console.log(`[sniper] L${li+1} completed: maxRetriggers exhausted (${lvl.retriggerCount}/${this._maxRetriggers}) filled=${lvl.filledSize.toFixed(4)}/${lvl.allocatedSize.toFixed(4)}`);
            lvl.status = 'COMPLETED'; continue;
          }
          if (lvl.activeChildId) {
            if (now - (lvl._intentSubmittedAt || 0) < 5000) continue;
            console.log(`[sniper] L${li+1} IOC timeout — clearing stuck activeChildId`);
            lvl.activeChildId = null;
            lvl._intentSubmittedAt = 0;
          }
          if (lvl._retriggerAt && now < lvl._retriggerAt) continue;

          const triggered = this.side === 'BUY' ? (ask <= lvl.currentSnipePrice) : (bid >= lvl.currentSnipePrice);
          if (!triggered) { lvl.status = 'WAITING'; continue; }
          if (marketData.spreadBps > this._maxSpreadBps) continue;

          lvl.status = 'FIRING';
          const lvlRemaining = Math.max(0, lvl.allocatedSize - lvl.filledSize);
          if (lvlRemaining < this._lotSize * 0.01) { lvl.status = 'COMPLETED'; continue; }
          const qty = floorToLot(lvlRemaining, this._lotSize);
          if (qty <= 0) { lvl.status = 'COMPLETED'; continue; }
          const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
          lvl.activeChildId = this._ctx.submitIntent({
            symbol: this.symbol, side: this.side, quantity: qty,
            limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER-SNIPE',
          });
          lvl._intentSubmittedAt = now;
          console.log(`[post+snipe] Simultaneous L${li+1} firing: ${qty.toFixed(4)} @ $${price} (level price=${lvl.currentSnipePrice})`);
        }
        return;
      }

      // ── Sequential mode: single snipe IOC per round ──
      if (this._snipeChildId || this._cancellingForSnipe) return;

      const snipeTriggered = this.side === 'BUY'
        ? (this._snipeLevel > 0 && ask <= this._snipeLevel)
        : (this._snipeLevel > 0 && bid >= this._snipeLevel);

      if (snipeTriggered && this._currentSnipeSize > 0) {
        this._cancellingForSnipe = true;
        if (this._postOrderId) {
          this._ctx.cancelChild(this._postOrderId);
          console.log(`[post+snipe] Snipe triggered — cancelling resting ${this._currentPostSize.toFixed(4)}`);
        }
        setTimeout(() => {
          if (!this._cancellingForSnipe) return;
          this._cancellingForSnipe = false;
          this._postOrderId = null;
          this.restingOrderSize = 0;
          this._restingPrice = null;

          const snipeQty = Math.min(this._currentSnipeSize, this.totalSize - this.filledSize);
          const roundedQty = floorToLot(snipeQty, this._lotSize);
          if (roundedQty <= 0) return;

          const price = this.side === 'BUY' ? (this._lastMd?.askPrice || ask) + this._tickSize : (this._lastMd?.bidPrice || bid) - this._tickSize;
          this._snipeChildId = this._ctx.submitIntent({
            symbol: this.symbol, side: this.side, quantity: roundedQty,
            limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER-SNIPE',
          });
          console.log(`[post+snipe] Snipe fired: ${roundedQty.toFixed(4)} @ $${price}`);
        }, 100);
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
    if (this._isComplete()) {
      this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
    }

    // ── Simultaneous mode: all levels active independently ──
    if (this._levelMode === 'simultaneous') {
      this.status = 'ACTIVE';
      let allDone = true;
      for (let li = 0; li < this._levels.length; li++) {
        const lvl = this._levels[li];
        const lvlTol = Math.max(0.001, lvl.allocatedSize * 0.01);
        if (lvl.filledSize >= lvl.allocatedSize - lvlTol) { lvl.status = 'COMPLETED'; continue; }
        if (lvl.retriggerCount >= this._maxRetriggers) { lvl.status = 'COMPLETED'; continue; }
        allDone = false;
        if (lvl.activeChildId) {
          if (now - (lvl._intentSubmittedAt || 0) < 5000) continue;
          console.log(`[sniper] L${li+1} IOC timeout — clearing stuck activeChildId`);
          lvl.activeChildId = null;
          lvl._intentSubmittedAt = 0;
        }
        if (lvl._retriggerAt && now < lvl._retriggerAt) continue;

        const triggered = this.side === 'BUY' ? (ask <= lvl.currentSnipePrice) : (bid >= lvl.currentSnipePrice);
        if (!triggered) { lvl.status = 'WAITING'; continue; }

        if (marketData.spreadBps > this._maxSpreadBps) continue;

        lvl.status = 'FIRING';
        const lvlRemaining = Math.max(0, lvl.allocatedSize - lvl.filledSize);
        if (lvlRemaining < this._lotSize * 0.01) { lvl.status = 'COMPLETED'; continue; }
        const qty = floorToLot(lvlRemaining, this._lotSize);
        if (qty <= 0) { lvl.status = 'COMPLETED'; continue; }
        const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
        lvl.activeChildId = this._ctx.submitIntent({
          symbol: this.symbol, side: this.side, quantity: qty,
          limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER',
        });
        lvl._intentSubmittedAt = now;
        console.log(`[sniper] Simultaneous L${li+1} firing: ${qty.toFixed(4)} @ $${price} (allocated=${lvl.allocatedSize.toFixed(4)} filled=${lvl.filledSize.toFixed(4)})`);
      }
      if (allDone) {
        if (this._isComplete()) {
          this._completedTs = now; this.status = 'COMPLETED'; this.stop();
        }
      }
      return;
    }

    // ── Sequential mode (default) ──
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
    if (level.status !== 'FIRING') console.log(`[sniper] L${this.activeLevelIndex+1} TRIGGERED: side=${this.side} bid=${bid} ask=${ask} snipePrice=${level.currentSnipePrice}`);

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
    if (levelRemaining < this._lotSize * 0.01) {
      level.status = 'COMPLETED'; this.activeLevelIndex++;
      console.log(`[sniper] L${this.activeLevelIndex} remaining ${levelRemaining.toFixed(4)} < dust — advancing`);
      return;
    }

    if (!this._icebergEnabled) {
      // Single IOC capped to level remaining — use remaining directly if less than 1 lot
      const qty = levelRemaining < this._lotSize ? levelRemaining : floorToLot(levelRemaining, this._lotSize);
      if (qty <= 0) return;
      const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      level.activeChildId = this._ctx.submitIntent({
        symbol: this.symbol, side: this.side, quantity: qty,
        limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER',
      });
      // Don't set _restingPrice for IOC snipe orders — only for genuine resting orders
      console.log(`[sniper] L${this.activeLevelIndex + 1} firing size=${qty.toFixed(4)} allocated=${level.allocatedSize.toFixed(4)} filled=${level.filledSize.toFixed(4)} remaining=${levelRemaining.toFixed(4)} @ $${price}`);
    } else {
      // Iceberg: fire slices capped to level remaining
      if (level.icebergRemaining <= 0) {
        level.icebergRemaining = levelRemaining;
      }
      level.icebergRemaining = Math.min(level.icebergRemaining, levelRemaining);
      if (now < level.nextIcebergAt) return;

      const rawSlice = Math.min(level.icebergRemaining, level.allocatedSize * this._icebergSlicePct / 100, levelRemaining);
      const sliceSize = rawSlice < this._lotSize ? rawSlice : floorToLot(rawSlice, this._lotSize);
      if (sliceSize <= 0) return;

      const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      level.activeChildId = this._ctx.submitIntent({
        symbol: this.symbol, side: this.side, quantity: sliceSize,
        limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER',
      });
      level.nextIcebergAt = now + this._icebergDelayMinMs + Math.random() * (this._icebergDelayMaxMs - this._icebergDelayMinMs);
      console.log(`[sniper] L${this.activeLevelIndex + 1} Iceberg firing size=${sliceSize.toFixed(4)} allocated=${level.allocatedSize.toFixed(4)} filled=${level.filledSize.toFixed(4)} remaining=${levelRemaining.toFixed(4)} @ $${price}`);
    }
  }

  // ── Trade data handler (volume confirmation) ──────────────────────────────

  onTrade(trade) {
    if (!trade.size || trade.size <= 0) return;
    const now = trade.timestamp || Date.now();
    this._rollingTrades.push({ price: trade.price, size: trade.size, timestamp: now });
    // Expire old trades (keep max 60s for VWAP, volumeConfirmWindow for volume check)
    const cutoff = Date.now() - Math.max(this._volumeConfirmWindowMs, 60000);
    while (this._rollingTrades.length > 0 && this._rollingTrades[0].timestamp < cutoff) {
      this._rollingTrades.shift();
    }
    // Update rolling VWAP from recent trades
    this._recalcVwap();
  }

  _recalcVwap() {
    let sumPV = 0, sumV = 0;
    const cutoff = Date.now() - 60000; // 60s window
    for (const t of this._rollingTrades) {
      if (t.timestamp < cutoff) continue;
      sumPV += t.price * t.size;
      sumV += t.size;
    }
    this._rollingVwap = sumV > 0 ? sumPV / sumV : 0;
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

    // ── Post+Snipe fill handling — round-based ──
    if (this._executionMode === 'post_snipe') {
      const isPostFill = fill.childId === this._postOrderId || fill.orderId === this._postOrderId;
      const isSeqSnipe = fill.childId === this._snipeChildId || fill.orderId === this._snipeChildId;

      // Simultaneous mode: match fill to level by activeChildId
      let levelFillIdx = -1;
      if (this._levelMode === 'simultaneous') {
        levelFillIdx = this._levels.findIndex(l => l.activeChildId && (fill.childId === l.activeChildId || fill.orderId === l.activeChildId));
      }
      const isLevelFill = levelFillIdx >= 0;
      const isSnipeFill = isSeqSnipe || isLevelFill;
      const fillType = isSnipeFill ? 'snipe' : isPostFill ? 'passive' : 'unknown';

      if (isSnipeFill) this.snipedSize += cappedFill;
      else this.passiveFillSize += cappedFill;
      if (isPostFill) this._postFilled += cappedFill;

      // Update level fill tracking for simultaneous mode
      if (isLevelFill) {
        const lvl = this._levels[levelFillIdx];
        const lvlCapped = Math.min(cappedFill, Math.max(0, lvl.allocatedSize - lvl.filledSize));
        lvl.filledSize += lvlCapped;
        lvl.activeChildId = null;
        lvl._intentSubmittedAt = 0;
        const levelColors = ['snipe-L1', 'snipe-L2', 'snipe-L3', 'snipe-L4', 'snipe-L5'];
        // Offset Y for overlapping fills at similar timestamps
        let fillY = fill.fillPrice;
        const lastFill = this._chartFills[this._chartFills.length - 1];
        if (lastFill && Math.abs(Date.now() - lastFill.time) < 1000) fillY += this._tickSize * 2 * (levelFillIdx + 1);
        this._chartFills.push({ time: Date.now(), price: fillY, size: lvlCapped, side: this.side, simulated: !!fill.simulated, fillType: levelColors[levelFillIdx] || 'snipe' });
        console.log(`[post+snipe] L${levelFillIdx+1} Fill: ${lvlCapped.toFixed(4)} @ ${fill.fillPrice} — level ${lvl.filledSize.toFixed(4)}/${lvl.allocatedSize.toFixed(4)}`);
        // Retrigger for level partial fill
        if (lvl.filledSize < lvl.allocatedSize - Math.max(0.001, lvl.allocatedSize * 0.01)) {
          lvl.retriggerCount++;
          lvl._retriggerAt = Date.now() + this._retriggerCooldownMs;
          lvl.status = 'WAITING';
        } else {
          lvl.status = 'COMPLETED';
        }
      } else {
        this._chartFills.push({ time: Date.now(), price: fill.fillPrice, size: cappedFill, side: this.side, simulated: !!fill.simulated, fillType });
      }

      if (isSeqSnipe) this._snipeChildId = null;
      console.log(`[post+snipe] Fill (${fillType}): ${cappedFill.toFixed(4)} @ ${fill.fillPrice} — passive=${this.passiveFillSize.toFixed(4)} sniped=${this.snipedSize.toFixed(4)} total=${this.filledSize.toFixed(4)}/${this.totalSize.toFixed(4)}`);

      // Completion check
      if (this._isComplete()) {
        this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); return;
      }

      // Sequential mode: after snipe fill start new round
      if (isSeqSnipe && this._levelMode !== 'simultaneous') {
        this._startRound();
        return;
      }

      // After passive fill: check if resting fully filled
      if (isPostFill && this._postFilled >= this._currentPostSize - Math.max(0.001, this._lotSize * 0.01)) {
        this._postOrderId = null;
        this.restingOrderSize = 0;
        if (this._levelMode !== 'simultaneous') this._startRound();
      }
      return;
    }

    // ── Snipe mode fill handling ──
    // Match fill to correct level (by activeChildId for simultaneous, or activeLevelIndex for sequential)
    let level, levelIdx;
    if (this._levelMode === 'simultaneous') {
      levelIdx = this._levels.findIndex(l => l.activeChildId && (fill.childId === l.activeChildId || fill.orderId === l.activeChildId));
      if (levelIdx < 0) levelIdx = this.activeLevelIndex;
      level = this._levels[levelIdx];
    } else {
      levelIdx = this.activeLevelIndex;
      level = this._levels[levelIdx];
    }
    if (!level) return;
    // Cap fill to level remaining — never overfill a level
    const levelCappedFill = Math.min(cappedFill, Math.max(0, level.allocatedSize - level.filledSize));
    level.filledSize += levelCappedFill;
    this.snipedSize += levelCappedFill;

    // Determine fill colour by level index
    const levelColors = ['snipe-L1', 'snipe-L2', 'snipe-L3', 'snipe-L4', 'snipe-L5'];
    // Offset Y for overlapping fills at similar timestamps
    let fillY = fill.fillPrice;
    const lastFill = this._chartFills[this._chartFills.length - 1];
    if (lastFill && Math.abs(Date.now() - lastFill.time) < 1000) fillY += this._tickSize * 2 * (levelIdx + 1);
    this._chartFills.push({
      time: Date.now(), price: fillY, size: levelCappedFill,
      side: this.side, simulated: !!fill.simulated,
      fillType: levelColors[levelIdx] || 'snipe',
    });

    console.log(`[sniper] L${levelIdx + 1} Fill: ${levelCappedFill.toFixed(4)} @ ${fill.fillPrice} (raw=${fill.fillSize.toFixed(4)}) — level ${level.filledSize.toFixed(4)}/${level.allocatedSize.toFixed(4)}, total ${this.filledSize.toFixed(4)}/${this.totalSize.toFixed(4)}`);

    level.activeChildId = null;
    level._intentSubmittedAt = 0;
    this._restingPrice = null;

    // Check level completion (99% filled = complete)
    const fillTolerance = Math.max(0.001, level.allocatedSize * 0.01);
    if (level.filledSize >= level.allocatedSize - fillTolerance) {
      level.status = 'COMPLETED';
      this.activeLevelIndex++;
      console.log(`[sniper] Level ${levelIdx + 1} COMPLETED (filled=${level.filledSize.toFixed(4)}/${level.allocatedSize.toFixed(4)}) — advancing to ${this.activeLevelIndex + 1}`);
      if (this._isComplete()) {
        this._completedTs = Date.now(); this.status = 'COMPLETED';
        console.log(`[sniper] All levels COMPLETED: avg ${this.avgFillPrice.toFixed(4)}`);
        this.stop();
      }
      return;
    }

    // Partial fill — retrigger logic
    if (level.retriggerCount >= this._maxRetriggers) {
      level.status = 'COMPLETED';
      if (this._levelMode !== 'simultaneous') this.activeLevelIndex++;
      console.log(`[sniper] L${levelIdx + 1} Max retriggers (${this._maxRetriggers}) — ${this._levelMode === 'simultaneous' ? 'level done' : 'advancing'}`);
      return;
    }

    // Calculate next snipe price (sequential mode only)
    if (this._levelMode !== 'simultaneous') {
      if (this._retriggerMode === 'better') {
        const improve = this._retriggerImproveTicks * this._tickSize;
        level.currentSnipePrice = this.side === 'BUY'
          ? level.currentSnipePrice - improve
          : level.currentSnipePrice + improve;
      } else if (this._retriggerMode === 'vwap') {
        level.currentSnipePrice = this.avgFillPrice;
      }
    }

    level.retriggerCount++;
    level.icebergRemaining = 0;
    level._retriggerAt = Date.now() + this._retriggerCooldownMs;
    if (this._levelMode !== 'simultaneous') this._retriggerAt = level._retriggerAt;
    level.status = 'WAITING';
    this.status = 'WAITING';
    const lvlRemaining = (level.allocatedSize - level.filledSize).toFixed(4);
    console.log(`[sniper] L${levelIdx + 1} partial fill: filled=${level.filledSize.toFixed(4)} allocated=${level.allocatedSize.toFixed(4)} remaining=${lvlRemaining} retriggerAt=${new Date(this._retriggerAt).toISOString()} retrigger#${level.retriggerCount}/${this._maxRetriggers} mode=${this._retriggerMode} nextPrice=${level.currentSnipePrice}`);
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
    if (matchId === this._postOrderId && (order.state === 'REJECTED' || order.state === 'CANCELLED')) {
      this._postOrderId = null; this._restingPrice = null; this.restingOrderSize = 0;
      // If cancelled for snipe, the snipe timeout handles it
      if (!this._cancellingForSnipe) {
        // Unexpected cancel — restart round
        console.log(`[post+snipe] Resting order ${order.state} — restarting round`);
        this._startRound();
      }
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

    const _fmtSize = v => { const s = Number(v).toFixed(4).replace(/\.?0+$/, ''); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    const startStr = this._startTs ? new Date(this._startTs).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '?';
    const expiryLabel = this._expiryMode === 'gtc' ? 'GTC' : this._expiryMode === 'eod' ? 'EOD' : 'Timed';
    let summaryLine;
    if (this._executionMode === 'post_snipe') {
      const modeLabel = this._levelMode === 'simultaneous' ? 'LMT+Discretion' : 'Post+Snipe';
      const discBps = this._snipeLevel && this._targetPrice ? Math.round(Math.abs((this._snipeLevel - this._targetPrice) / this._targetPrice * 10000)) : '?';
      const snipeLevelFmt = Number(this._snipeLevel).toFixed(4);
      summaryLine = this._levelMode === 'simultaneous'
        ? `${this.side} ${_fmtSize(this.totalSize)} ${this.symbol} on ${this.venue} via LMT+Discretion | Limit: $${this._targetPrice} | Disc: ${discBps}bps | ${this._snipePct}% disc`
        : `${this.side} ${_fmtSize(this.totalSize)} ${this.symbol} on ${this.venue} via SNIPER | Post+Snipe | Limit: $${this._targetPrice} Snipe: $${snipeLevelFmt} | ${this._snipePct}% snipe cap`;
    } else {
      const lvlStr = this._levels.map((l, i) => `L${i+1}: $${l.price} (${l.pct}%)`).join(' ');
      summaryLine = `${this.side} ${_fmtSize(this.totalSize)} ${this.symbol} on ${this.venue} via SNIPER | Snipe | ${lvlStr} | ${expiryLabel}`;
    }
    if (summaryLine.length > 150) summaryLine = summaryLine.slice(0, 147) + '...';

    return {
      type: 'SNIPER', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status, summaryLine,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival,
      rollingVwap: this._rollingVwap,
      slippageVsVwap: this._rollingVwap > 0 && this.avgFillPrice > 0
        ? (this.avgFillPrice - this._rollingVwap) / this._rollingVwap * 10000 * (this.side === 'BUY' ? 1 : -1)
        : 0,
      targetPrice: activeLevelPrice,
      triggerCondition: this.side === 'BUY' ? 'breaks_below' : 'breaks_above',
      executionMode: this._executionMode,
      levelMode: this._levelMode,
      snipeLevel: this._snipeLevel,
      retriggerEnabled: true,
      distanceBps, distancePct,
      triggered: this.status !== 'WAITING', triggerTs: 0,
      expiryTs: this._expiryTs,
      activeOrderPrice: this._restingPrice,
      restingOrderSize: this.restingOrderSize,
      snipedSize: this.snipedSize,
      passiveFillSize: this.passiveFillSize,
      // Post+Snipe round state
      postSnipePhase: this._postSnipePhase,
      roundNumber: this._roundNumber,
      currentPostSize: this._currentPostSize,
      currentSnipeSize: this._currentSnipeSize,
      snipePct: this._snipePct,
      maxSnipeTotal: this._maxSnipeTotal,
      snipeCapUsed: this.snipedSize,
      snipeCapRemaining: Math.max(0, this._maxSnipeTotal - this.snipedSize),
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
      // post_snipe: show resting limit price. Pure snipe: hidden (level lines cover it).
      chartTargetPrice: (this._executionMode === 'post_snipe') ? this._targetPrice : (this._executionMode === 'snipe' ? null : activeLevelPrice),
      chartSnipeLevel: (this._executionMode === 'post_snipe' && this._levelMode !== 'simultaneous') ? this._snipeLevel : null,
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
