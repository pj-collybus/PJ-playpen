/**
 * Sniper — waits for price to reach a target level then executes aggressively.
 *
 * States: WAITING → TRIGGERED → EXECUTING → COMPLETED
 * Execution modes: all_at_once, iceberg, twap
 * Optional retrigger for accumulating at a level.
 */

'use strict';

const config = {
  name: 'SNIPER',
  displayName: 'Sniper',
  description: 'Waits for price to reach your target level then executes aggressively',
  params: [
    { key: 'venue',              label: 'Exchange',            type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'targetPrice',        label: 'Target price',        type: 'number', default: 0 },
    { key: 'triggerCondition',   label: 'Trigger when price',  type: 'select', options: [{value:'touches',label:'Touches target'},{value:'breaks_above',label:'Breaks above target'},{value:'breaks_below',label:'Breaks below target'}], default: 'touches' },
    { key: 'executionMode',      label: 'Execution',           type: 'select', options: [{value:'all_at_once',label:'Full size immediately'},{value:'iceberg',label:'Iceberg after trigger'},{value:'twap',label:'TWAP after trigger'}], default: 'all_at_once' },
    { key: 'twapMinutes',        label: 'TWAP duration (mins)', type: 'number', default: 5, min: 1, dependsOn: { executionMode: 'twap' } },
    { key: 'icebergVisibleSize', label: 'Visible size',        type: 'number', default: 10, dependsOn: { executionMode: 'iceberg' } },
    { key: 'urgency',            label: 'Execution urgency',   type: 'select', options: [{value:'aggressive',label:'Aggressive'},{value:'neutral',label:'Neutral'}], default: 'aggressive' },
    { key: 'expiryMode',         label: 'Expires',             type: 'select', options: [{value:'gtc',label:'Never (GTC)'},{value:'time',label:'At time'},{value:'eod',label:'End of day'}], default: 'gtc' },
    { key: 'expiryTime',         label: 'Expiry time',         type: 'text', default: '', dependsOn: { expiryMode: 'time' } },
    { key: 'maxSpreadBps',       label: 'Max spread (bps)',    type: 'number', default: 50 },
    { key: 'retriggerEnabled',   label: 'Retrigger',           type: 'select', options: [{value:'false',label:'Once only'},{value:'true',label:'Retrigger if price returns'}], default: 'false' },
    { key: 'retriggerCooldownMs',label: 'Retrigger cooldown (ms)', type: 'number', default: 5000, dependsOn: { retriggerEnabled: 'true' } },
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

    this._targetPrice       = params.targetPrice || 0;
    this._triggerCondition  = params.triggerCondition || 'touches';
    this._executionMode     = params.executionMode || 'all_at_once';
    this._twapMinutes       = params.twapMinutes || 5;
    this._icebergVisible    = params.icebergVisibleSize || 10;
    this._urgency           = params.urgency || 'aggressive';
    this._tickSize          = params.tickSize || 0.0001;
    this._lotSize           = params.lotSize || 1;
    this._maxSpreadBps      = params.maxSpreadBps || 50;
    this._retriggerEnabled  = String(params.retriggerEnabled) === 'true';
    this._retriggerCooldown = params.retriggerCooldownMs || 5000;

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
    this._chartMaxPts = 1800;

    // State
    this.status          = 'WAITING';
    this.filledSize      = 0;
    this.remainingSize   = this.totalSize;
    this.avgFillPrice    = 0;
    this.totalNotional   = 0;
    this.arrivalPrice    = 0;
    this.slippageVsArrival = 0;
    this.activeChildId   = null;
    this._restingPrice   = null;
    this.pauseReason     = null;
    this._prevMid        = 0;
    this._triggerTs       = 0;
    this._retriggerAt    = 0;
    this._retryAt        = 0;
    this._retryCount     = 0;

    // TWAP/Iceberg sub-execution state
    this._subSlicesFired = 0;
    this._subSlicesTotal = 0;
    this._subIntervalMs  = 0;
    this._subNextSliceAt = 0;
    this._subRefreshAt   = 0;

    this._completedTs    = 0;
    this._startTs        = Date.now();
    this._lastMd         = null;
    this._ctx            = null;
    this._stopped        = false;
  }

  get type() { return 'SNIPER'; }

  start(ctx) {
    this._ctx = ctx;
    console.log(`[sniper] Waiting for ${this._triggerCondition} at $${this._targetPrice} — ${this._executionMode} mode`);
  }

  pause()  { if (this.status !== 'COMPLETED' && this.status !== 'EXPIRED') { this._prevStatus = this.status; this.status = 'PAUSED'; this.pauseReason = 'manual'; } }
  resume() { if (this.status === 'PAUSED') { this.status = this._prevStatus || 'WAITING'; this.pauseReason = null; } }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.status !== 'COMPLETED' && this.status !== 'EXPIRED') this.status = 'STOPPED';
    console.log(`[sniper] Stopped: filled=${this.filledSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)}`);
  }

  onTick(marketData) {
    this._lastMd = marketData;
    const now = Date.now();
    const bid = marketData.bidPrice || 0;
    const ask = marketData.askPrice || 0;
    const mid = marketData.midPrice || (bid && ask ? (bid + ask) / 2 : 0);

    if (this.arrivalPrice === 0 && mid > 0) this.arrivalPrice = mid;

    // Chart
    if (bid > 0 && ask > 0 && now - this._chartLastSampleTs >= this._chartSampleMs) {
      this._chartLastSampleTs = now;
      const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED';
      this._chartBids.push(bid); this._chartAsks.push(ask);
      this._chartOrder.push(isDone ? null : (this._restingPrice || null));
      this._chartTimes.push(now);
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
      }
    }

    if (this._stopped || this.status === 'COMPLETED' || this.status === 'EXPIRED' || this.status === 'PAUSED') return;

    // ── WAITING ─────────────────────────────────────────────────────────
    if (this.status === 'WAITING') {
      // Expiry check
      if (this._expiryTs && now >= this._expiryTs) {
        this.status = 'EXPIRED'; this._completedTs = now;
        console.log(`[sniper] Expired — target not reached`);
        return;
      }
      // Retrigger cooldown
      if (this._retriggerAt > 0 && now < this._retriggerAt) return;

      if (mid <= 0) { this._prevMid = mid; return; }

      // Trigger evaluation
      let triggered = false;
      if (this._triggerCondition === 'touches') {
        triggered = Math.abs(mid - this._targetPrice) <= this._tickSize;
      } else if (this._triggerCondition === 'breaks_above') {
        triggered = this._prevMid > 0 && this._prevMid <= this._targetPrice && bid > this._targetPrice;
      } else if (this._triggerCondition === 'breaks_below') {
        triggered = this._prevMid > 0 && this._prevMid >= this._targetPrice && ask < this._targetPrice;
      }
      this._prevMid = mid;

      if (triggered) {
        this._triggerTs = now;
        console.log(`[sniper] TRIGGERED at mid=${mid} target=${this._targetPrice} condition=${this._triggerCondition}`);
        if (marketData.spreadBps > this._maxSpreadBps) {
          this.status = 'TRIGGERED';
          this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps — waiting to narrow`;
        } else {
          this._startExecution(bid, ask, mid);
        }
      }
      return;
    }

    // ── TRIGGERED (waiting for spread) ──────────────────────────────────
    if (this.status === 'TRIGGERED') {
      if (mid > 0 && marketData.spreadBps <= this._maxSpreadBps) {
        this.pauseReason = null;
        this._startExecution(bid, ask, mid);
      }
      return;
    }

    // ── EXECUTING ───────────────────────────────────────────────────────
    if (this.status === 'EXECUTING') {
      // Completion check
      if (this.filledSize >= this.totalSize - 0.001) {
        this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
      }

      // Retry after rejection
      if (this._retryAt > 0 && now >= this._retryAt && !this.activeChildId) {
        this._retryAt = 0;
        this._fireOrder(bid, ask, mid);
        return;
      }

      if (this._executionMode === 'all_at_once') {
        // Single order already placed in _startExecution
        return;
      }

      if (this._executionMode === 'iceberg') {
        if (!this.activeChildId && now >= this._subRefreshAt && this.remainingSize > 0.001) {
          this._fireIcebergSlice(bid, ask, mid);
        }
        return;
      }

      if (this._executionMode === 'twap') {
        if (!this.activeChildId && now >= this._subNextSliceAt && this.remainingSize > 0.001 && this._subSlicesFired < this._subSlicesTotal) {
          this._fireTwapSlice(bid, ask, mid);
        }
        return;
      }
    }
  }

  _startExecution(bid, ask, mid) {
    this.status = 'EXECUTING';
    console.log(`[sniper] Executing: mode=${this._executionMode} size=${this.remainingSize}`);

    if (this._executionMode === 'all_at_once') {
      this._fireOrder(bid, ask, mid);
    } else if (this._executionMode === 'twap') {
      this._subSlicesTotal = Math.max(2, this._twapMinutes);
      this._subIntervalMs = this._twapMinutes * 60000 / this._subSlicesTotal;
      this._subNextSliceAt = Date.now();
      this._fireTwapSlice(bid, ask, mid);
    } else if (this._executionMode === 'iceberg') {
      this._subRefreshAt = Date.now();
      this._fireIcebergSlice(bid, ask, mid);
    }
  }

  _fireOrder(bid, ask, mid) {
    const tick = this._tickSize;
    let price;
    if (this._urgency === 'aggressive') {
      price = this.side === 'BUY' ? ask + tick : bid - tick;
    } else {
      price = mid;
    }
    if (!price || price <= 0) price = mid;

    // all_at_once uses IOC — take available liquidity, cancel remainder
    const tif = this._executionMode === 'all_at_once' ? 'IOC' : 'GTC';
    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: this.remainingSize,
      limitPrice: price, orderType: 'LIMIT', timeInForce: tif, algoType: 'SNIPER',
    });
    this._restingPrice = price;
    console.log(`[sniper] Order: size=${this.remainingSize.toFixed(4)} price=${price} tif=${tif}`);
  }

  _fireTwapSlice(bid, ask, mid) {
    if (mid <= 0) return;
    this._subSlicesFired++;
    const remSlices = Math.max(1, this._subSlicesTotal - this._subSlicesFired + 1);
    let size = this.remainingSize / remSlices;
    size = Math.max(this._lotSize, Math.min(size, this.remainingSize));
    size = Math.round(size / this._lotSize) * this._lotSize;

    const tick = this._tickSize;
    let price;
    if (this._urgency === 'aggressive') price = this.side === 'BUY' ? ask + tick : bid - tick;
    else price = mid;
    if (!price || price <= 0) price = mid;

    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: size,
      limitPrice: price, orderType: 'LIMIT', algoType: 'SNIPER',
    });
    this._restingPrice = price;
    const variance = 0.1;
    this._subNextSliceAt = Date.now() + this._subIntervalMs * (1 + (Math.random() * 2 - 1) * variance);
    console.log(`[sniper] TWAP slice ${this._subSlicesFired}/${this._subSlicesTotal}: size=${size.toFixed(4)} price=${price}`);
  }

  _fireIcebergSlice(bid, ask, mid) {
    if (mid <= 0) return;
    const variance = this._icebergVisible * 0.2;
    let size = this._icebergVisible + (Math.random() * 2 - 1) * variance;
    size = Math.max(this._lotSize, Math.min(size, this.remainingSize));
    size = Math.round(size / this._lotSize) * this._lotSize;
    size = Math.max(this._lotSize, Math.min(size, this.remainingSize));

    const tick = this._tickSize;
    let price;
    if (this._urgency === 'aggressive') price = this.side === 'BUY' ? ask + tick : bid - tick;
    else price = mid;
    if (!price || price <= 0) price = mid;

    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: size,
      limitPrice: price, orderType: 'LIMIT', algoType: 'SNIPER',
    });
    this._restingPrice = price;
    this._subSlicesFired++;
    console.log(`[sniper] Iceberg slice ${this._subSlicesFired}: size=${size.toFixed(4)} price=${price}`);
  }

  onFill(fill) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    if (this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED') return;

    this.filledSize += fill.fillSize;
    this.remainingSize = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;

    if (this.arrivalPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.slippageVsArrival = (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    }

    this._chartFills.push({
      time: Date.now(), price: fill.fillPrice, size: fill.fillSize,
      side: this.side, simulated: !!fill.simulated,
    });

    this.activeChildId = null; this._restingPrice = null;
    this._retryCount = 0;

    // Iceberg refresh delay
    if (this._executionMode === 'iceberg') {
      this._subRefreshAt = Date.now() + 500 + Math.random() * 2500;
    }

    console.log(`[sniper] IOC fill: ${fill.fillSize.toFixed(4)} filled, ${this.remainingSize.toFixed(4)} remaining, retrigger=${this._retriggerEnabled}`);

    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = Date.now();
      this.status = 'COMPLETED';
      console.log(`[sniper] COMPLETED at avg ${this.avgFillPrice.toFixed(4)}`);
      this.stop();
    } else if (this._executionMode === 'all_at_once' && this.remainingSize > 0.001) {
      // IOC partial fill — remaining was cancelled
      if (this._retriggerEnabled) {
        this._retriggerAt = Date.now() + this._retriggerCooldown;
        this.status = 'WAITING';
        this._prevMid = 0; // reset for fresh trigger detection
        console.log(`[sniper] Partial IOC — retrigger in ${this._retriggerCooldown}ms (${this.remainingSize.toFixed(4)} remaining)`);
      } else {
        this._completedTs = Date.now();
        this.status = 'COMPLETED';
        console.log(`[sniper] Partial IOC — completed (${this.filledSize.toFixed(4)} of ${this.totalSize.toFixed(4)}, no retrigger)`);
        this.stop();
      }
    }
  }

  onOrderUpdate(order) {
    if (order.orderId !== this.activeChildId) return;
    if (order.state === 'REJECTED') {
      console.log(`[sniper] Order rejected: ${order.rejectReason || 'unknown'}`);
      this.activeChildId = null; this._restingPrice = null;
      this._retryCount++;
      if (this._retryCount >= 2) {
        this.status = 'ERROR'; this.pauseReason = `Rejected: ${order.rejectReason}`;
      } else {
        this._retryAt = Date.now() + 1000;
      }
    }
  }

  getState() {
    const now = Date.now();
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED';
    const elapsed = this._startTs ? (isDone && this._completedTs ? this._completedTs - this._startTs : now - this._startTs) : 0;
    const mid = this._lastMd?.midPrice || 0;
    const distanceBps = mid > 0 && this._targetPrice > 0 ? (mid - this._targetPrice) / this._targetPrice * 10000 : 0;
    const distancePct = mid > 0 && this._targetPrice > 0 ? Math.max(0, 100 - Math.abs(distanceBps) / 2) : 0; // 0-100 proximity

    return {
      type: 'SNIPER', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival,
      targetPrice: this._targetPrice, triggerCondition: this._triggerCondition,
      executionMode: this._executionMode, retriggerEnabled: this._retriggerEnabled,
      distanceBps: distanceBps, distancePct: distancePct,
      triggered: this._triggerTs > 0, triggerTs: this._triggerTs,
      expiryTs: this._expiryTs,
      activeOrderPrice: this._restingPrice,
      urgency: this._urgency,
      pauseReason: this.pauseReason,
      elapsed, timeRemaining: this._expiryTs ? Math.max(0, this._expiryTs - now) : null,
      tickSize: this._tickSize,
      childCount: this._subSlicesFired,
      maxChartPoints: this._chartMaxPts,
      chartBids: this._chartBids, chartAsks: this._chartAsks,
      chartOrder: this._chartOrder, chartTimes: this._chartTimes,
      chartFills: this._chartFills,
      // Target price for chart horizontal line
      chartTargetPrice: this._targetPrice,
    };
  }
}

function estimateDuration(params) {
  const price = params.targetPrice || '?';
  const cond = params.triggerCondition || 'touches';
  const condLabel = cond === 'touches' ? 'touches' : cond === 'breaks_above' ? 'breaks above' : 'breaks below';
  return `Waiting for price ${condLabel} $${price}`;
}

module.exports = { config, Strategy: SniperStrategy, estimateDuration };
