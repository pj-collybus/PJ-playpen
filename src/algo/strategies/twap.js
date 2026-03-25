/**
 * TWAP — Time-Weighted Average Price strategy (institutional grade).
 *
 * Divides parent order into time slices with configurable start conditions,
 * urgency levels, participation limits, and schedule randomisation.
 * Supports scheduled/triggered start, terms-currency amounts, average rate
 * limits, and end-of-window aggressive completion.
 */

'use strict';

const config = {
  name: 'TWAP',
  displayName: 'TWAP',
  description: 'Time-weighted average price execution',
  params: [
    { key: 'venue',               label: 'Exchange',               type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    // Start
    { key: 'startMode',           label: 'Start',                  type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'},{value:'trigger',label:'Trigger'}], default: 'immediate' },
    { key: 'startScheduled',      label: 'Start at (15:45 or +10m)', type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'triggerType',         label: 'Trigger type',           type: 'select', options: [{value:'price_above',label:'Price Above'},{value:'price_below',label:'Price Below'}], default: 'price_above', dependsOn: { startMode: 'trigger' } },
    { key: 'triggerValue',        label: 'Trigger value',          type: 'number', default: 0, dependsOn: { startMode: 'trigger' } },
    // Duration
    { key: 'durationMode',        label: 'Duration',               type: 'select', options: [{value:'minutes',label:'Minutes'},{value:'until_time',label:'Until Time'}], default: 'minutes' },
    { key: 'durationMinutes',     label: 'Duration (minutes)',     type: 'number', default: 30, min: 1, dependsOn: { durationMode: 'minutes' } },
    { key: 'endTime',             label: 'End at (e.g. 16:00)',    type: 'text', default: '', dependsOn: { durationMode: 'until_time' } },
    // Expiry
    { key: 'expiry',              label: 'Expiry',                 type: 'select', options: [{value:'cancel_on_end',label:'Cancel on End'},{value:'GTC',label:'GTC'},{value:'GTD',label:'GTD'}], default: 'cancel_on_end' },
    // Amount
    { key: 'amountMode',          label: 'Amount in',              type: 'select', options: [{value:'base',label:'Base Currency'},{value:'terms',label:'Terms (USD)'}], default: 'base' },
    // Slices
    { key: 'slicesMode',          label: 'Slices',                 type: 'select', options: [{value:'auto',label:'Auto'},{value:'manual',label:'Manual'}], default: 'auto' },
    { key: 'numSlices',           label: 'Number of slices',       type: 'number', default: 10, min: 2, max: 500, dependsOn: { slicesMode: 'manual' } },
    // Timing
    { key: 'scheduleVariancePct', label: 'Timing randomisation %', type: 'number', default: 10, min: 0, max: 50 },
    // Limit
    { key: 'limitMode',           label: 'Limit price',            type: 'select', options: [{value:'none',label:'None'},{value:'market_limit',label:'Market Limit'},{value:'average_rate',label:'Average Rate'}], default: 'none' },
    { key: 'limitPrice',          label: 'Limit price',            type: 'number', default: 0, dependsOn: { limitMode: 'market_limit' } },
    { key: 'averageRateLimit',    label: 'Max average rate',       type: 'number', default: 0, dependsOn: { limitMode: 'average_rate' } },
    // Urgency
    { key: 'urgency',             label: 'Urgency',                type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'passive' },
    // Participation
    { key: 'maxParticipationPct', label: 'Max participation %',    type: 'number', default: 15, min: 1, max: 100 },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function _parseTime(str) {
  if (!str) return null;
  str = str.trim();
  // Relative: +10m, +5m, +1h
  const rel = str.match(/^\+(\d+)([mhMs]?)$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = (rel[2] || 'm').toLowerCase();
    const ms = unit === 'h' ? n * 3600000 : unit === 's' ? n * 1000 : n * 60000;
    return Date.now() + ms;
  }
  // HH:MM — today at that time
  const hm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); // tomorrow if past
    return d.getTime();
  }
  // HH:MM DD/MM/YYYY
  const full = str.match(/^(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (full) {
    return new Date(parseInt(full[5]), parseInt(full[4]) - 1, parseInt(full[3]),
      parseInt(full[1]), parseInt(full[2])).getTime();
  }
  return null;
}

function _rand(min, max) { return min + Math.random() * (max - min); }

const MAX_SPREAD_BPS = 50;    // auto-pause if spread > 50bps
const STALE_DATA_MS = 10000;  // auto-pause if no data for 10s
const CHASE_DELAY_MIN = 3000;
const CHASE_DELAY_MAX = 7000;

// ── Strategy ────────────────────────────────────────────────────────────────

class TWAPStrategy {
  constructor(params) {
    this.symbol    = params.symbol;
    this.side      = params.side;  // BUY or SELL
    this.venue     = params.venue || 'Deribit';

    // Start mode
    this._startMode      = params.startMode || 'immediate';
    this._startScheduled = params.startScheduled || '';
    this._triggerType    = params.triggerType || 'price_above';
    this._triggerValue   = params.triggerValue || 0;

    // Duration
    this._durationMode = params.durationMode || 'minutes';
    this._durationMin  = params.durationMinutes || 30;
    this._endTimeStr   = params.endTime || '';
    this._expiry       = params.expiry || 'cancel_on_end';

    // Amount
    this._amountMode = params.amountMode || 'base';
    this._rawSize    = params.totalSize || 0;
    this.totalSize   = this._rawSize; // may be recalculated for terms mode

    // Slices
    this._slicesMode      = params.slicesMode || 'auto';
    this._manualSlices    = params.numSlices || 10;
    this._variancePct     = params.scheduleVariancePct || 10;

    // Limit
    this._limitMode         = params.limitMode || 'none';
    this._limitPrice        = params.limitPrice || 0;
    this._averageRateLimit  = params.averageRateLimit || 0;

    // Urgency
    this._urgency           = params.urgency || 'passive';
    this._maxParticipation  = params.maxParticipationPct || 15;
    this._tickSize          = params.tickSize || 0.0001;
    this._activated         = false;

    // Chart data — scaled to duration
    this._chartBids   = [];
    this._chartAsks   = [];
    this._chartOrder  = []; // current resting order price
    this._chartTimes  = [];
    this._chartFills  = []; // { time, price, size, side, simulated }
    // Chart: 1 point per second, scaled max points to duration
    const durationSec = (this._durationMin || 5) * 60;
    this._chartSampleMs = 1000; // always 1 second
    this._chartMaxPts = Math.min(3600, Math.max(300, durationSec + 60));
    this._chartLastSampleTs = 0;

    // State
    this.status          = 'WAITING';
    this.filledSize      = 0;
    this.remainingSize   = this.totalSize;
    this.avgFillPrice    = 0;
    this.totalNotional   = 0;
    this.arrivalPrice    = 0;
    this.rollingVwap     = 0;
    this._rollingVwapNot = 0;
    this._rollingVwapQty = 0;
    this.slippageVsArrival = 0;
    this.slippageVsVwap    = 0;
    this.slicesFired     = 0;
    this.slicesTotal     = 0;
    this.activeChildId   = null;
    this.nextSliceAt     = 0;
    this.pauseReason     = null;
    this._completingDeadline = 0;
    this._completedTs    = 0;       // timestamp when fully filled (freezes elapsed)
    this._retryAt        = 0;       // timestamp for next retry after rejection
    this._retrySliceSize = 0;       // size of the rejected slice to retry
    this._rejectCount    = 0;       // consecutive rejections for same slice
    this._lastMd         = null;
    this._lastMdTs       = 0;
    this._chaseDeadline  = 0; // timestamp when chase delay expires
    this._startTs        = 0;
    this._endTs          = 0;
    this._intervalMs     = 0;
    this._ctx            = null;
    this._stopped        = false;
    this._startTimer     = null;
  }

  get type() { return 'TWAP'; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(ctx) {
    this._ctx = ctx;

    if (this._startMode === 'scheduled') {
      const ts = _parseTime(this._startScheduled);
      if (ts && ts > Date.now()) {
        this.status = 'WAITING';
        this._startTimer = setTimeout(() => this._activate(), ts - Date.now());
        console.log(`[twap] Scheduled start at ${new Date(ts).toLocaleTimeString()}`);
        return;
      }
      // Scheduled time already passed — activate immediately (no timer)
      console.log(`[twap] Scheduled time already passed — activating immediately`);
    }
    if (this._startMode === 'trigger') {
      this.status = 'WAITING';
      console.log(`[twap] Waiting for trigger: ${this._triggerType} ${this._triggerValue}`);
      return;
    }
    // immediate (or scheduled time already passed)
    this._activate();
  }

  _activate() {
    console.log(`[twap] _activate called, _startTs: ${this._startTs}, status: ${this.status}, _activated: ${this._activated}`);
    if (this._stopped) return;
    if (this._activated) {
      console.error(`[twap] DOUBLE ACTIVATION BLOCKED — already activated at ${new Date(this._startTs).toISOString()}`);
      return;
    }
    this._activated = true;
    const now = Date.now();
    this._startTs = now;

    // Capture arrival price from last market data if available
    // (will also be captured on first onTick if not set here)
    if (this.arrivalPrice === 0 && this._lastMd) {
      const m = this._lastMd.midPrice || ((this._lastMd.bidPrice || 0) + (this._lastMd.askPrice || 0)) / 2;
      if (m > 0) this.arrivalPrice = m;
    }

    // Terms mode: convert USD to base
    if (this._amountMode === 'terms' && this.arrivalPrice > 0) {
      this.totalSize = this._rawSize / this.arrivalPrice;
      this.remainingSize = this.totalSize;
      console.log(`[twap] Terms conversion: ${this._rawSize} USD → ${this.totalSize.toFixed(6)} base @ arrival=${this.arrivalPrice}`);
    }

    // Calculate end time
    if (this._durationMode === 'until_time') {
      const endTs = _parseTime(this._endTimeStr);
      this._endTs = endTs || (now + this._durationMin * 60000);
    } else {
      this._endTs = now + this._durationMin * 60000;
    }

    // Calculate slices
    const durationMs = this._endTs - now;
    if (this._slicesMode === 'auto') {
      this.slicesTotal = Math.max(2, Math.min(500, Math.round(durationMs / 60000)));
    } else {
      this.slicesTotal = Math.max(2, Math.min(500, this._manualSlices));
    }
    this._intervalMs = durationMs / this.slicesTotal;
    this.nextSliceAt = now; // first slice immediately
    this.status = 'RUNNING';
    const expectedSliceSize = this.totalSize / this.slicesTotal;
    console.log(`[twap] Activated: ${this.totalSize} ${this.side} in ${this.slicesTotal} slices over ${Math.round(durationMs/60000)}min, interval=${Math.round(this._intervalMs/1000)}s, urgency=${this._urgency}`);
    console.log(`[twap] Slice sizing: totalSize=${this.totalSize} numSlices=${this.slicesTotal} expectedSliceSize=${expectedSliceSize.toFixed(4)}`);
    console.log(`[twap] endTime set to: ${new Date(this._endTs).toISOString()} (${Math.round((this._endTs - now)/1000)}s from now)`);
  }

  pause()  {
    if (this.status === 'RUNNING') { this.status = 'PAUSED'; this.pauseReason = 'manual'; }
  }

  resume() {
    if (this.status === 'PAUSED') { this.status = 'RUNNING'; this.pauseReason = null; }
  }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now(); // freeze elapsed time
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.status !== 'COMPLETED') this.status = 'STOPPED';
    const dir = this.side === 'BUY' ? 1 : -1;
    console.log(`[twap] Stopped: filled=${this.filledSize.toFixed(6)} avg=${this.avgFillPrice.toFixed(4)} slippage=${this.slippageVsArrival.toFixed(1)}bps slices=${this.slicesFired}/${this.slicesTotal}`);
  }

  // ── Market data ───────────────────────────────────────────────────────────

  onTick(marketData) {
    this._lastMd = marketData;
    this._lastMdTs = Date.now();

    // Capture arrival price on first market data (never overwrite)
    if (this.arrivalPrice === 0) {
      const m = marketData.midPrice || ((marketData.bidPrice||0) + (marketData.askPrice||0)) / 2;
      if (m > 0) {
        this.arrivalPrice = m;
        console.log(`[twap] Arrival price captured: ${m}`);
      }
    }

    // Waiting for trigger
    if (this.status === 'WAITING' && this._startMode === 'trigger') {
      const px = marketData.midPrice || marketData.lastPrice || 0;
      if (this._triggerType === 'price_above' && px > this._triggerValue) {
        console.log(`[twap] Trigger fired: price ${px} > ${this._triggerValue}`);
        this._activate();
      } else if (this._triggerType === 'price_below' && px > 0 && px < this._triggerValue) {
        console.log(`[twap] Trigger fired: price ${px} < ${this._triggerValue}`);
        this._activate();
      }
      return;
    }

    if (this.status === 'WAITING') return;
    if (this._stopped) return;

    const now = Date.now();
    const bid = marketData.bidPrice || 0;
    const ask = marketData.askPrice || 0;
    const mid = marketData.midPrice || (bid && ask ? (bid + ask) / 2 : 0);

    // Record chart data at the configured sample rate
    if (bid > 0 && ask > 0 && now - this._chartLastSampleTs >= this._chartSampleMs) {
      this._chartLastSampleTs = now;
      this._chartBids.push(bid);
      this._chartAsks.push(ask);
      const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this._stopped;
      this._chartOrder.push(isDone ? null : (this._restingPrice || null));
      this._chartTimes.push(now);
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
      }
    }

    // ── COMPLETING state — waiting for final aggressive sweep fill ──────
    if (this.status === 'COMPLETING') {
      const expired = now > this._completingDeadline;
      if (expired) {
        console.log(`[twap] COMPLETING deadline expired — finalising with ${this.filledSize.toFixed(4)} filled`);
        this.status = 'COMPLETED'; this.stop();
      }
      return; // don't fire new slices while completing
    }

    // ── Hard duration enforcement — must end at endTime (overrides pause) ──
    if (now >= this._endTs && (this.status === 'RUNNING' || this.status === 'PAUSED')) {
      console.log(`[twap] Duration expired: now=${now} endTs=${this._endTs} diff=${now - this._endTs}ms status=${this.status}`);
      // Cancel any resting child
      if (this.activeChildId) {
        console.log(`[twap] Duration expired — cancelling resting order ${this.activeChildId}`);
        this._ctx.cancelChild(this.activeChildId);
        this.activeChildId = null; this._restingPrice = 0; this._chaseDeadline = 0;
      }
      // Final aggressive sweep for remaining
      if (this.remainingSize > 0 && bid > 0 && ask > 0) {
        const tick = this._tickSize || 0.0001;
        const sweepPrice = this.side === 'BUY' ? ask + tick : bid - tick;
        console.log(`[twap] Final sweep: ${this.remainingSize.toFixed(4)} @ ${sweepPrice} (aggressive)`);
        this.activeChildId = this._ctx.submitIntent({
          symbol: this.symbol, side: this.side, quantity: this.remainingSize,
          limitPrice: sweepPrice, orderType: 'LIMIT', algoType: 'TWAP-SWEEP',
        });
        this._restingPrice = sweepPrice;
        this.status = 'COMPLETING';
        this._completingDeadline = now + 10000; // 10s hard deadline
      } else {
        this.status = 'COMPLETED'; this.stop();
      }
      return;
    }

    // ── Auto-pause checks ─────────────────────────────────────────────────
    if (this.status === 'RUNNING') {
      // Spread check
      if (mid > 0 && marketData.spreadBps > MAX_SPREAD_BPS) {
        this.status = 'PAUSED'; this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps > ${MAX_SPREAD_BPS}bps`;
        console.log(`[twap] Auto-paused: ${this.pauseReason}`);
        return;
      }
      // Average rate limit
      if (this._limitMode === 'average_rate' && this._averageRateLimit > 0 && this.avgFillPrice > 0) {
        const breached = this.side === 'BUY'
          ? this.avgFillPrice > this._averageRateLimit
          : this.avgFillPrice < this._averageRateLimit;
        if (breached) {
          this.status = 'PAUSED'; this.pauseReason = `Avg rate ${this.avgFillPrice.toFixed(4)} breached limit ${this._averageRateLimit}`;
          console.log(`[twap] Auto-paused: ${this.pauseReason}`);
          return;
        }
      }
    }

    // ── Auto-resume ───────────────────────────────────────────────────────
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      const spreadOk = !mid || marketData.spreadBps <= MAX_SPREAD_BPS;
      if (spreadOk) { this.status = 'RUNNING'; this.pauseReason = null; console.log('[twap] Auto-resumed'); }
    }

    if (this.status !== 'RUNNING') return;

    // ── Filled check (with floating point tolerance) ──────────────────
    if (this.filledSize >= this.totalSize - 0.001 || this.remainingSize <= 0.001) {
      if (!this._completedTs) this._completedTs = Date.now();
      this.status = 'COMPLETED';
      console.log(`[twap] COMPLETED in onTick — fully filled at avg ${this.avgFillPrice.toFixed(4)}`);
      this.stop(); return;
    }

    // ── Chase logic for active child ──────────────────────────────────────
    if (this.activeChildId && bid > 0 && ask > 0) {
      // Check if market moved away from resting order price
      const restingPrice = this._restingPrice || 0;
      const marketMoved = this.side === 'BUY'
        ? (bid > restingPrice * 1.0001)   // bid moved above our resting bid
        : (ask < restingPrice * 0.9999);  // ask moved below our resting ask
      if (marketMoved && this._chaseDeadline === 0) {
        // Start chase timer (randomised 3-7s delay)
        this._chaseDeadline = now + _rand(CHASE_DELAY_MIN, CHASE_DELAY_MAX);
        console.log(`[twap] Market moved from resting ${restingPrice} — chase in ${Math.round((this._chaseDeadline - now)/1000)}s`);
      } else if (this._chaseDeadline > 0 && now >= this._chaseDeadline) {
        // Chase delay elapsed — cancel and repost at new TOB
        console.log(`[twap] Cancelling stale order — market moved from ${restingPrice} to bid=${bid} ask=${ask}`);
        this._ctx.cancelChild(this.activeChildId);
        this.activeChildId = null;
        this._chaseDeadline = 0;
        this._restingPrice = 0;
      }
    }

    // ── End-of-window urgency escalation ──────────────────────────────────
    const timeRemaining = this._endTs - now;
    const totalDuration = this._endTs - this._startTs;
    if (timeRemaining > 0 && timeRemaining < totalDuration * 0.1 && this.remainingSize > 0) {
      if (this._urgency !== 'aggressive' && this.activeChildId) {
        console.log(`[twap] Escalating to aggressive — cancelling passive order ${this.activeChildId} first`);
        this._ctx.cancelChild(this.activeChildId);
        this.activeChildId = null;
        this._restingPrice = 0;
        this._chaseDeadline = 0;
        this._urgency = 'aggressive';
      }
    }

    // ── Retry after rejection ──────────────────────────────────────────────
    if (this._retryAt > 0 && now >= this._retryAt && !this.activeChildId && this.remainingSize > 0.001) {
      this._retryAt = 0;
      console.log(`[twap] Retrying rejected slice at new TOB: bid=${bid} ask=${ask}`);
      this._fireSlice(bid, ask, mid, this._retrySliceSize);
    }
    // ── Slice scheduling — never exceed numSlices ──────────────────────────
    else if (now >= this.nextSliceAt && !this.activeChildId && this.remainingSize > 0.001 && this._retryAt === 0 && this.slicesFired < this.slicesTotal) {
      this._rejectCount = 0; // reset on successful new slice
      this._fireSlice(bid, ask, mid);
    }
  }

  _fireSlice(bid, ask, mid, overrideSize) {
    if (this.remainingSize <= 0 || mid <= 0) {
      if (mid <= 0) console.log('[twap] _fireSlice skipped: mid=0 (no market data yet)');
      return;
    }

    this.slicesFired++;
    let sliceSize;
    if (overrideSize > 0) {
      sliceSize = Math.min(overrideSize, this.remainingSize);
    } else {
      const remainingSlices = Math.max(1, this.slicesTotal - this.slicesFired + 1);
      sliceSize = this.remainingSize / remainingSlices;
      sliceSize = Math.min(sliceSize, this.remainingSize);
    }
    console.log(`[twap] fireSlice: remainingSize=${this.remainingSize.toFixed(4)} slicesFired=${this.slicesFired} slicesTotal=${this.slicesTotal} sliceSize=${sliceSize.toFixed(4)}`);
    if (sliceSize <= 0) return;

    // Limit price check
    if (this._limitMode === 'market_limit' && this._limitPrice > 0) {
      if (this.side === 'BUY' && mid > this._limitPrice) {
        console.log(`[twap] Slice ${this.slicesFired}/${this.slicesTotal}: skipped — mid ${mid} > limit ${this._limitPrice}`);
        this._scheduleNext(); return;
      }
      if (this.side === 'SELL' && mid < this._limitPrice) {
        console.log(`[twap] Slice ${this.slicesFired}/${this.slicesTotal}: skipped — mid ${mid} < limit ${this._limitPrice}`);
        this._scheduleNext(); return;
      }
    }

    // Determine child price by urgency
    const tick = this._tickSize || 0.0001;
    let price;
    if (this._urgency === 'passive') {
      price = this.side === 'BUY' ? bid : ask; // post at TOB, don't cross
    } else if (this._urgency === 'aggressive') {
      // Cross spread by 1 tick to guarantee fill
      price = this.side === 'BUY' ? ask + tick : bid - tick;
    } else {
      price = mid; // neutral
    }
    if (!price || price <= 0) price = mid;

    console.log(`[twap] emitIntent:`, { size: sliceSize, price, side: this.side, venue: this.venue, symbol: this.symbol });
    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: sliceSize,
      limitPrice: price, orderType: 'LIMIT', algoType: 'TWAP',
    });
    this._restingPrice = price;
    this._chaseDeadline = 0;

    const nextSecs = Math.round(this._intervalMs / 1000);
    console.log(`[twap] Slice ${this.slicesFired}/${this.slicesTotal}: size=${sliceSize.toFixed(4)} price=${price} next in ${nextSecs}s`);
    this._scheduleNext();
  }

  _scheduleNext() {
    const variance = this._variancePct / 100;
    const jitter = 1 + _rand(-variance, variance);
    this.nextSliceAt = Date.now() + this._intervalMs * jitter;
  }

  // ── Fill handling ─────────────────────────────────────────────────────────

  onFill(fill) {
    // Ignore zero-size fills (e.g. order acknowledgements)
    if (!fill.fillSize || fill.fillSize <= 0) return;
    // Ignore fills after completion
    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;
    console.log(`[twap] onFill: size=${fill.fillSize} price=${fill.fillPrice} filledBefore=${this.filledSize} remaining=${this.remainingSize}`);
    this.filledSize    += fill.fillSize;
    this.remainingSize  = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice   = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;

    // Record fill for chart
    this._chartFills.push({
      time: Date.now(), price: fill.fillPrice, size: fill.fillSize,
      side: this.side, simulated: !!fill.simulated,
    });
    console.log(`[twap] chartFills push: price=${fill.fillPrice} total fills=${this._chartFills.length}`);

    // Rolling VWAP from fills
    this._rollingVwapNot += fill.fillPrice * fill.fillSize;
    this._rollingVwapQty += fill.fillSize;
    this.rollingVwap = this._rollingVwapQty > 0 ? this._rollingVwapNot / this._rollingVwapQty : 0;

    // Slippage calculations
    const dir = this.side === 'BUY' ? 1 : -1;
    if (this.arrivalPrice > 0) {
      this.slippageVsArrival = (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    }
    if (this.rollingVwap > 0) {
      this.slippageVsVwap = (this.avgFillPrice - this.rollingVwap) / this.rollingVwap * 10000 * dir;
    }

    this.activeChildId = null;
    this._chaseDeadline = 0;

    console.log(`[twap] Fill: ${fill.fillSize.toFixed(4)} @ ${fill.fillPrice} — total=${this.filledSize.toFixed(4)}/${this.totalSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)} slip=${this.slippageVsArrival.toFixed(1)}bps`);

    // Check completion with floating point tolerance
    if (this.filledSize >= this.totalSize - 0.001 || this.remainingSize <= 0.001) {
      this._completedTs = Date.now();
      this.status = 'COMPLETED';
      console.log(`[twap] COMPLETED — fully filled at avg ${this.avgFillPrice.toFixed(4)}`);
      this.stop();
    }
  }

  // ── Order rejection handling ────────────────────────────────────────────

  onOrderUpdate(order) {
    if (order.state !== 'REJECTED') return;
    const reason = (order.rejectReason || '').toLowerCase();

    // Only handle if this is our active child
    if (order.orderId !== this.activeChildId && order.intentId !== this.activeChildId) return;

    console.log(`[twap] Order rejected: ${order.orderId} reason: ${order.rejectReason || 'unknown'} status: ${this.status}`);

    // If in COMPLETING (final sweep rejected), give up immediately
    if (this.status === 'COMPLETING') {
      console.log(`[twap] Final sweep rejected — completing with ${this.filledSize.toFixed(4)} filled`);
      this.activeChildId = null;
      this.status = 'COMPLETED'; this.stop();
      return;
    }

    // Don't count as a completed slice — undo slicesFired
    if (this.slicesFired > 0) this.slicesFired--;

    // Save the slice size for retry
    this._retrySliceSize = order.quantity || this.remainingSize / Math.max(1, this.slicesTotal - this.slicesFired);
    this.activeChildId = null;
    this._restingPrice = 0;
    this._chaseDeadline = 0;

    // Classify rejection type
    if (reason.includes('insufficient') || reason.includes('balance') || reason.includes('margin')) {
      // Insufficient balance — pause, don't retry
      this.status = 'PAUSED';
      this.pauseReason = `Insufficient balance: ${order.rejectReason}`;
      this._retryAt = 0;
      this._rejectCount = 0;
      console.log(`[twap] Paused — insufficient balance`);
    } else if (reason.includes('rate') || reason.includes('throttl')) {
      // Rate limit — wait 5 seconds
      this._retryAt = Date.now() + 5000;
      this._rejectCount = 0;
      console.log(`[twap] Rate limited — retrying in 5s`);
    } else {
      // Price moved or unknown — retry in 2s, pause after 3 consecutive failures
      this._rejectCount++;
      if (this._rejectCount >= 3) {
        this.status = 'PAUSED';
        this.pauseReason = `3 consecutive rejections: ${order.rejectReason}`;
        this._retryAt = 0;
        this._rejectCount = 0;
        console.log(`[twap] Paused — 3 consecutive rejections`);
      } else {
        this._retryAt = Date.now() + 2000;
        console.log(`[twap] Slice rejected — retrying in 2s at new TOB (attempt ${this._rejectCount})`);
      }
    }
  }

  // ── State report ──────────────────────────────────────────────────────────

  getState() {
    const now = Date.now();
    const totalDuration = this._endTs && this._startTs ? this._endTs - this._startTs : 0;
    const isDone = this.status === 'COMPLETING' || this.status === 'COMPLETED' || this._stopped;
    // Elapsed freezes: use completedTs if filled early, or cap at totalDuration if expired
    let elapsed = 0;
    if (this._startTs) {
      if (isDone && this._completedTs) {
        elapsed = Math.min(this._completedTs - this._startTs, totalDuration || Infinity);
      } else if (isDone) {
        elapsed = totalDuration;
      } else {
        elapsed = now - this._startTs;
      }
    }
    const timeRemaining = isDone ? 0 : (this._endTs ? Math.max(0, this._endTs - now) : 0);
    const nextIn = isDone ? 0 : (this.nextSliceAt ? Math.max(0, this.nextSliceAt - now) : 0);

    return {
      type: 'TWAP', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival, slippageVsVwap: this.slippageVsVwap,
      currentSlice: this.slicesFired, numSlices: this.slicesTotal,
      elapsed, timeRemaining,
      nextSliceIn: nextIn,
      urgency: this._urgency,
      pauseReason: this.pauseReason,
      startMode: this._startMode,
      amountMode: this._amountMode,
      limitMode: this._limitMode,
      maxParticipationPct: this._maxParticipation,
      tickSize: this._tickSize,
      activeOrderPrice: this._restingPrice || null,
      maxChartPoints: this._chartMaxPts,
      chartSampleMs: this._chartSampleMs,
      // Chart data
      chartBids: this._chartBids,
      chartAsks: this._chartAsks,
      chartOrder: this._chartOrder,
      chartTimes: this._chartTimes,
      chartFills: this._chartFills,
    };
  }
}

function estimateDuration(params) {
  if (params.durationMode === 'until_time' && params.endTime) {
    const endTs = _parseTime(params.endTime);
    if (endTs) {
      const mins = Math.round((endTs - Date.now()) / 60000);
      const slices = params.slicesMode === 'manual' ? params.numSlices : Math.max(2, mins);
      return `Until ${params.endTime} (~${mins} min in ~${slices} slices)`;
    }
  }
  const mins = params.durationMinutes || 30;
  const slices = params.slicesMode === 'manual' ? (params.numSlices || 10) : Math.max(2, mins);
  return `~${mins} min in ~${slices} slices`;
}

module.exports = { config, Strategy: TWAPStrategy, estimateDuration };
