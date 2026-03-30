/**
 * VWAP — Volume-Weighted Average Price strategy (institutional grade).
 *
 * Three modes:
 *   realtime:   only execute within a band around rolling VWAP
 *   benchmark:  execute on schedule, auto-adjust urgency to track VWAP
 *   historical: weight slice sizes using an intraday volume profile curve
 */

'use strict';

const { floorToLot } = require('../../utils/sizeUtils');

const config = {
  name: 'VWAP',
  displayName: 'VWAP',
  description: 'Volume-weighted average price — tracks and benchmarks against rolling VWAP',
  params: [
    { key: 'venue',               label: 'Exchange',             type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',           label: 'Start',                type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'},{value:'trigger',label:'Trigger'}], default: 'immediate' },
    { key: 'startScheduled',      label: 'Start at',             type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'triggerType',         label: 'Trigger type',         type: 'select', options: [{value:'price_above',label:'Price Above'},{value:'price_below',label:'Price Below'},{value:'vwap_cross',label:'Price Crosses VWAP'}], default: 'price_above', dependsOn: { startMode: 'trigger' } },
    { key: 'triggerValue',        label: 'Trigger value',        type: 'number', default: 0, dependsOn: { startMode: 'trigger' } },
    { key: 'vwapMode',            label: 'VWAP mode',            type: 'select', options: [{value:'realtime',label:'Real-time VWAP'},{value:'benchmark',label:'Benchmark VWAP'},{value:'historical',label:'Historical Profile'}], default: 'realtime' },
    { key: 'urgency',             label: 'Urgency',              type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'passive' },
    { key: 'vwapWindowMinutes',   label: 'VWAP window (min)',    type: 'number', default: 30, min: 1 },
    { key: 'participationBandBps',label: 'Participation band (bps)', type: 'number', default: 10, min: 0 },
    { key: 'maxDeviationBps',     label: 'Max deviation from VWAP (bps)', type: 'number', default: 50, min: 0 },
    { key: 'scheduleVariancePct', label: 'Timing variance %',    type: 'number', default: 10, min: 0, max: 50 },
    { key: 'maxSpreadBps',        label: 'Max spread (bps)',     type: 'number', default: 50 },
    { key: 'limitMode',           label: 'Limit price',          type: 'select', options: [{value:'none',label:'None'},{value:'hard_limit',label:'Hard Limit'}], default: 'none' },
    { key: 'limitPrice',          label: 'Limit price',          type: 'number', default: 0, dependsOn: { limitMode: 'hard_limit' } },
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

function _rand(min, max) { return min + Math.random() * (max - min); }

// U-shaped intraday volume profile (stub — replace with real data when available)
function _profileWeight(elapsedPct) {
  // elapsedPct: 0.0 (session start) to 1.0 (session end)
  // U-shape: high at 0 and 1, low at 0.5
  return 0.5 + 1.0 * Math.pow(2 * Math.abs(elapsedPct - 0.5), 2);
}

class VWAPStrategy {
  constructor(params) {
    this.symbol    = params.symbol;
    this.side      = params.side;
    this.venue     = params.venue || 'Deribit';
    this.totalSize = params.totalSize || 0;

    this._vwapMode          = params.vwapMode || 'realtime';
    this._baseUrgency       = params.urgency || 'passive';
    this._tickSize          = params.tickSize || 0.0001;
    this._lotSize           = params.lotSize || 1;
    this._vwapWindowMs      = (params.vwapWindowMinutes || 30) * 60000;
    this._bandBps           = params.participationBandBps || 10;
    this._maxDeviationBps   = params.maxDeviationBps || 50;
    this._variancePct       = params.scheduleVariancePct || 10;
    this._maxSpreadBps      = params.maxSpreadBps || 50;
    this._limitMode         = params.limitMode || 'none';
    this._limitPrice        = params.limitPrice || 0;

    // Start
    this._startMode      = params.startMode || 'immediate';
    this._startScheduled = params.startScheduled || '';
    this._triggerType    = params.triggerType || 'price_above';
    this._triggerValue   = params.triggerValue || 0;

    // Duration parsing (from simple Duration field)
    const durRaw = params.durationMinutes || params.duration || '30';
    console.log(`[vwap] Duration raw: durationMinutes=${params.durationMinutes} duration=${params.duration} durRaw=${durRaw}`);
    if (typeof durRaw === 'string' && durRaw.includes(':')) {
      const endTs = _parseTime(durRaw);
      this._durationMs = endTs ? Math.max(0, endTs - Date.now()) : 30 * 60000;
    } else {
      this._durationMs = (parseFloat(durRaw) || 30) * 60000;
    }

    // Chart
    const durationSec = Math.round(this._durationMs / 1000);
    this._chartBids = []; this._chartAsks = []; this._chartOrder = [];
    this._chartTimes = []; this._chartFills = []; this._chartVwap = [];
    this._chartSampleMs = 1000; this._chartLastSampleTs = 0;
    this._chartMaxPts = Math.min(3600, Math.max(300, durationSec + 60));

    // State
    this.status           = 'WAITING';
    this.filledSize       = 0;
    this.remainingSize    = this.totalSize;
    this.avgFillPrice     = 0;
    this.totalNotional    = 0;
    this.arrivalPrice     = 0;
    this.arrivalVwap      = 0;
    this.rollingVwap      = 0;
    this._rollingTrades   = []; // { price, size, ts }
    this.slippageVsArrival  = 0;
    this.slippageVsVwap     = 0;
    this.deviationFromVwap  = 0;
    this.inParticipationBand = false;
    this.profileWeight    = 1.0;
    this.currentUrgency   = this._baseUrgency;
    this.activeChildId    = null;
    this._restingPrice    = null;
    this._chaseAt         = 0;
    this.nextSliceAt      = 0;
    this.slicesFired      = 0;
    this.slicesTotal      = 0;
    this._intervalMs      = 0;
    this.pauseReason      = null;
    this._activated       = false;
    this._startTs         = 0;
    this._endTs           = 0;
    this._completedTs     = 0;
    this._lastMd          = null;
    this._ctx             = null;
    this._stopped         = false;
    this._startTimer      = null;
  }

  get type() { return 'VWAP'; }

  start(ctx) {
    this._ctx = ctx;
    if (this._startMode === 'scheduled') {
      const ts = _parseTime(this._startScheduled);
      if (ts && ts > Date.now()) {
        this.status = 'WAITING';
        this._startTimer = setTimeout(() => this._activate(), ts - Date.now());
        return;
      }
    }
    if (this._startMode === 'trigger') { this.status = 'WAITING'; return; }
    this._activate();
  }

  _activate() {
    if (this._stopped || this._activated) return;
    this._activated = true;
    const now = Date.now();
    this._startTs = now;
    this._endTs = now + this._durationMs;
    if (this._lastMd) {
      this.arrivalPrice = this._lastMd.midPrice || ((this._lastMd.bidPrice||0)+(this._lastMd.askPrice||0))/2;
    }
    this.arrivalVwap = this.rollingVwap || this.arrivalPrice;
    // Slices: 1 per minute
    // 1 slice per minute, minimum 2
    this.slicesTotal = Math.max(2, Math.min(500, Math.round(this._durationMs / 60000)));
    this._intervalMs = this._durationMs / this.slicesTotal;
    console.log(`[vwap] Slice calc: durationMs=${this._durationMs} durationMin=${Math.round(this._durationMs/60000)} slicesTotal=${this.slicesTotal} intervalMs=${this._intervalMs}`);
    this.nextSliceAt = now;
    this.status = 'RUNNING';
    console.log(`[vwap] Activated: ${this.totalSize} ${this.side} mode=${this._vwapMode} ${this.slicesTotal} slices over ${Math.round(this._durationMs/60000)}min`);
    console.log(`[vwap] endTime: ${new Date(this._endTs).toISOString()}`);
  }

  pause()  { if (this.status === 'RUNNING') { this.status = 'PAUSED'; this.pauseReason = 'manual'; } }
  resume() { if (this.status === 'PAUSED') { this.status = 'RUNNING'; this.pauseReason = null; } }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.status !== 'COMPLETED') this.status = 'STOPPED';
    console.log(`[vwap] Stopped: filled=${this.filledSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)} slipVsVwap=${this.slippageVsVwap.toFixed(1)}bps`);
  }

  // ── Market trades → VWAP calculation ──────────────────────────────────────

  onTrade(trade) {
    if (!trade.size || trade.size <= 0) return;
    const now = Date.now();
    this._rollingTrades.push({ price: trade.price, size: trade.size, ts: now });
    this._expireTrades(now);
    this._recalcVwap();

    // Trigger: vwap_cross
    if (this.status === 'WAITING' && this._startMode === 'trigger' && this._triggerType === 'vwap_cross') {
      const mid = this._lastMd?.midPrice || 0;
      if (mid > 0 && this.rollingVwap > 0) {
        const crossed = this.side === 'BUY' ? mid <= this.rollingVwap : mid >= this.rollingVwap;
        if (crossed) { console.log(`[vwap] Trigger: price crossed VWAP`); this._activate(); }
      }
    }
  }

  _expireTrades(now) {
    const cutoff = now - this._vwapWindowMs;
    while (this._rollingTrades.length && this._rollingTrades[0].ts < cutoff) this._rollingTrades.shift();
  }

  _recalcVwap() {
    let notional = 0, vol = 0;
    for (const t of this._rollingTrades) { notional += t.price * t.size; vol += t.size; }
    this.rollingVwap = vol > 0 ? notional / vol : this.rollingVwap;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  onTick(marketData) {
    this._lastMd = marketData;
    if (this.arrivalPrice === 0) {
      const m = marketData.midPrice || ((marketData.bidPrice||0)+(marketData.askPrice||0))/2;
      if (m > 0) this.arrivalPrice = m;
    }

    // Trigger check
    if (this.status === 'WAITING' && this._startMode === 'trigger') {
      const px = marketData.midPrice || 0;
      if (this._triggerType === 'price_above' && px > this._triggerValue) this._activate();
      else if (this._triggerType === 'price_below' && px > 0 && px < this._triggerValue) this._activate();
      return;
    }
    if (this.status === 'WAITING' || this._stopped) return;

    const now = Date.now();
    const bid = marketData.bidPrice || 0;
    const ask = marketData.askPrice || 0;
    const mid = marketData.midPrice || (bid && ask ? (bid+ask)/2 : 0);

    // Chart
    if (bid > 0 && ask > 0 && now - this._chartLastSampleTs >= this._chartSampleMs) {
      this._chartLastSampleTs = now;
      const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED';
      this._chartBids.push(bid); this._chartAsks.push(ask);
      this._chartOrder.push(isDone ? null : (this._restingPrice || null));
      this._chartTimes.push(now);
      this._chartVwap.push(this.rollingVwap || null);
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
        this._chartVwap.shift();
      }
    }

    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    // VWAP deviation
    if (mid > 0 && this.rollingVwap > 0) {
      this.deviationFromVwap = (mid - this.rollingVwap) / this.rollingVwap * 10000;
      this.inParticipationBand = Math.abs(this.deviationFromVwap) <= this._bandBps;
    }

    // Auto-pause: spread
    if (this.status === 'RUNNING' && mid > 0 && marketData.spreadBps > this._maxSpreadBps) {
      this.status = 'PAUSED'; this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps`;
      return;
    }
    // Auto-pause: VWAP deviation (realtime mode)
    if (this.status === 'RUNNING' && this._vwapMode === 'realtime' && Math.abs(this.deviationFromVwap) > this._maxDeviationBps) {
      this.status = 'PAUSED'; this.pauseReason = `VWAP deviation ${this.deviationFromVwap.toFixed(0)}bps`;
      return;
    }
    // Auto-resume
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      const spreadOk = !mid || marketData.spreadBps <= this._maxSpreadBps;
      const devOk = this._vwapMode !== 'realtime' || Math.abs(this.deviationFromVwap) <= this._maxDeviationBps;
      if (spreadOk && devOk) { this.status = 'RUNNING'; this.pauseReason = null; }
    }
    if (this.status !== 'RUNNING') return;

    // Completion
    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
    }
    // Hard end time
    if (now >= this._endTs) {
      if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
      if (this.remainingSize > 0.001 && bid > 0 && ask > 0) {
        const tick = this._tickSize;
        const sweepPrice = this.side === 'BUY' ? ask + tick : bid - tick;
        this.activeChildId = this._ctx.submitIntent({
          symbol: this.symbol, side: this.side, quantity: this.remainingSize,
          limitPrice: sweepPrice, orderType: 'LIMIT', algoType: 'VWAP-SWEEP',
        });
        this._restingPrice = sweepPrice;
        this.status = 'COMPLETING';
        this._completingDeadline = now + 10000;
      } else {
        this._completedTs = now; this.status = 'COMPLETED'; this.stop();
      }
      return;
    }
    // COMPLETING deadline
    if (this.status === 'COMPLETING' && now > this._completingDeadline) {
      this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
    }

    // Chase
    if (this.activeChildId && bid > 0 && ask > 0) {
      const rp = this._restingPrice || 0;
      const moved = this.side === 'BUY' ? (bid < rp - this._tickSize) : (ask > rp + this._tickSize);
      const back = this.side === 'BUY' ? (bid >= rp) : (ask <= rp);
      if (moved && this._chaseAt === 0) this._chaseAt = now + _rand(3000, 7000);
      else if (back) this._chaseAt = 0;
      if (this._chaseAt > 0 && now >= this._chaseAt) {
        this._ctx.cancelChild(this.activeChildId);
        this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
      }
    }

    // ── Slice scheduling ──────────────────────────────────────────────────
    if (!this.activeChildId && now >= this.nextSliceAt && this.remainingSize > 0.001 && this.slicesFired < this.slicesTotal) {
      const canFire = this._vwapMode === 'realtime' ? this.inParticipationBand : true;
      if (canFire) this._fireSlice(bid, ask, mid);
    }
  }

  _fireSlice(bid, ask, mid) {
    if (mid <= 0) return;
    this.slicesFired++;
    const remainingSlices = Math.max(1, this.slicesTotal - this.slicesFired + 1);
    let sliceSize = this.remainingSize / remainingSlices;

    // Historical mode: apply volume profile weight
    if (this._vwapMode === 'historical' && this._startTs && this._endTs) {
      const elapsed = (Date.now() - this._startTs) / (this._endTs - this._startTs);
      this.profileWeight = _profileWeight(Math.min(1, Math.max(0, elapsed)));
      sliceSize *= this.profileWeight;
    }

    sliceSize = Math.max(this._lotSize, Math.min(sliceSize, this.remainingSize));
    sliceSize = floorToLot(sliceSize, this._lotSize);
    sliceSize = Math.max(this._lotSize, Math.min(sliceSize, this.remainingSize));

    // Benchmark mode: auto-adjust urgency based on VWAP performance
    if (this._vwapMode === 'benchmark' && this.rollingVwap > 0 && this.avgFillPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      const slip = (this.avgFillPrice - this.rollingVwap) / this.rollingVwap * 10000 * dir;
      if (slip > 5) this.currentUrgency = 'aggressive';
      else if (slip > 0) this.currentUrgency = 'neutral';
      else this.currentUrgency = this._baseUrgency;
    }

    const urg = this._vwapMode === 'benchmark' ? this.currentUrgency : this._baseUrgency;
    const tick = this._tickSize;
    let price;
    if (urg === 'passive') price = this.side === 'BUY' ? bid : ask;
    else if (urg === 'aggressive') price = this.side === 'BUY' ? ask + tick : bid - tick;
    else price = mid;
    if (!price || price <= 0) price = mid;

    // Limit check
    if (this._limitMode === 'hard_limit' && this._limitPrice > 0) {
      if (this.side === 'BUY' && price > this._limitPrice) return;
      if (this.side === 'SELL' && price < this._limitPrice) return;
    }

    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: sliceSize,
      limitPrice: price, orderType: 'LIMIT', algoType: 'VWAP',
    });
    this._restingPrice = price;
    this._chaseAt = 0;

    // Schedule next
    const variance = this._variancePct / 100;
    const jitter = 1 + _rand(-variance, variance);
    this.nextSliceAt = Date.now() + this._intervalMs * jitter;

    console.log(`[vwap] Slice ${this.slicesFired}/${this.slicesTotal}: size=${sliceSize.toFixed(4)} price=${price} vwap=${this.rollingVwap.toFixed(4)} mode=${this._vwapMode} urg=${urg}`);
  }

  onFill(fill) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    this.filledSize += fill.fillSize;
    this.remainingSize = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;

    this._chartFills.push({
      time: Date.now(), price: fill.fillPrice, size: fill.fillSize,
      side: this.side, simulated: !!fill.simulated,
    });

    const dir = this.side === 'BUY' ? 1 : -1;
    if (this.arrivalPrice > 0) this.slippageVsArrival = (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    if (this.rollingVwap > 0) this.slippageVsVwap = (this.avgFillPrice - this.rollingVwap) / this.rollingVwap * 10000 * dir;

    this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;

    console.log(`[vwap] Fill: ${fill.fillSize.toFixed(4)} @ ${fill.fillPrice} — total=${this.filledSize.toFixed(4)}/${this.totalSize.toFixed(4)} slipVsVwap=${this.slippageVsVwap.toFixed(1)}bps`);

    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop();
    }
  }

  onOrderUpdate(order) {
    if (order.orderId !== this.activeChildId) return;
    if (order.state === 'REJECTED') {
      this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
    }
  }

  getState() {
    const now = Date.now();
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this._stopped;
    const totalDuration = this._endTs && this._startTs ? this._endTs - this._startTs : 0;
    let elapsed = 0;
    if (this._startTs) {
      if (isDone && this._completedTs) elapsed = Math.min(this._completedTs - this._startTs, totalDuration || Infinity);
      else if (isDone) elapsed = totalDuration;
      else elapsed = now - this._startTs;
    }
    const timeRemaining = isDone ? 0 : (this._endTs ? Math.max(0, this._endTs - now) : 0);
    const nextIn = isDone ? 0 : (this.nextSliceAt ? Math.max(0, this.nextSliceAt - now) : 0);

    const _fmtSize = v => { const s = Number(v).toFixed(4).replace(/\.?0+$/, ''); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    const _urg = { passive: 'Passive', aggressive: 'Aggressive', neutral: 'Neutral' };
    const _modes = { realtime: 'Real-time', benchmark: 'Benchmark', historical: 'Historical' };
    const durMin = this._endTs ? Math.round((this._endTs - this._startTs) / 60000) : '?';
    const startStr = this._startTs ? new Date(this._startTs).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '?';
    const summaryLine = `${this.side} ${_fmtSize(this.totalSize)} ${this.symbol} on ${this.venue} via VWAP | ${_modes[this._vwapMode]||this._vwapMode} | ${_urg[this._baseUrgency]||this._baseUrgency} | ${durMin} min`;

    return {
      type: 'VWAP', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status, vwapMode: this._vwapMode, summaryLine,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      arrivalVwap: this.arrivalVwap, rollingVwap: this.rollingVwap,
      slippageVsArrival: this.slippageVsArrival, slippageVsVwap: this.slippageVsVwap,
      deviationFromVwap: this.deviationFromVwap,
      inParticipationBand: this.inParticipationBand,
      profileWeight: this.profileWeight,
      currentSlice: this.slicesFired, numSlices: this.slicesTotal,
      elapsed, timeRemaining, nextSliceIn: nextIn,
      urgency: this.currentUrgency,
      activeOrderPrice: this._restingPrice,
      pauseReason: this.pauseReason,
      tickSize: this._tickSize,
      maxChartPoints: this._chartMaxPts,
      chartBids: this._chartBids, chartAsks: this._chartAsks,
      chartOrder: this._chartOrder, chartTimes: this._chartTimes,
      chartFills: this._chartFills, chartVwap: this._chartVwap,
    };
  }
}

function estimateDuration(params) {
  const durRaw = params.durationMinutes || params.duration || '30';
  const mode = params.vwapMode || 'realtime';
  const modeLabel = mode === 'realtime' ? 'Real-time' : mode === 'benchmark' ? 'Benchmark' : 'Historical';
  return `~${durRaw}${String(durRaw).includes(':') ? '' : ' min'} — ${modeLabel} VWAP targeting`;
}

module.exports = { config, Strategy: VWAPStrategy, estimateDuration };
