/**
 * Implementation Shortfall — Almgren-Chriss simplified.
 *
 * Minimises total execution cost by dynamically balancing market impact
 * (trading too fast) vs timing risk (trading too slow). The optimal
 * participation rate adjusts in real time based on estimated volatility
 * and the risk aversion parameter λ.
 *
 * IS cost = timing cost (price drift) + market impact cost (our footprint)
 */

'use strict';

const { floorToLot } = require('../../utils/sizeUtils');

const config = {
  name: 'IS',
  displayName: 'Impl. Shortfall',
  description: 'Minimises total execution cost by balancing market impact vs timing risk',
  params: [
    { key: 'venue',              label: 'Exchange',           type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',          label: 'Start',              type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'}], default: 'immediate' },
    { key: 'startScheduled',     label: 'Start at',           type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'urgencyBias',        label: 'Urgency bias',       type: 'select', options: [{value:'risk_averse',label:'Risk Averse — faster'},{value:'balanced',label:'Balanced'},{value:'cost_averse',label:'Cost Averse — slower'}], default: 'balanced' },
    { key: 'urgency',            label: 'Urgency',            type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'neutral' },
    { key: 'maxSpreadBps',       label: 'Max spread (bps)',   type: 'number', default: 50 },
    { key: 'riskAversion',       label: 'Risk aversion (λ)',  type: 'number', default: 0.5, min: 0.1, max: 2.0, step: 0.1 },
    { key: 'volatilityLookbackMinutes', label: 'Vol lookback (mins)', type: 'number', default: 10, min: 1 },
    { key: 'marketImpactCoeff',  label: 'Impact coefficient', type: 'number', default: 0.1, min: 0.01, max: 1.0, step: 0.01 },
    { key: 'limitMode',          label: 'Limit price',        type: 'select', options: [{value:'none',label:'None'},{value:'hard_limit',label:'Hard Limit'}], default: 'none' },
    { key: 'limitPrice',         label: 'Limit price',        type: 'number', default: 0, dependsOn: { limitMode: 'hard_limit' } },
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

function _rand(a, b) { return a + Math.random() * (b - a); }

const BIAS_MULT = { risk_averse: 2.0, balanced: 1.0, cost_averse: 0.5 };

class ISStrategy {
  constructor(params) {
    this.symbol    = params.symbol;
    this.side      = params.side;
    this.venue     = params.venue || 'Deribit';
    this.totalSize = params.totalSize || 0;

    this._startMode      = params.startMode || 'immediate';
    this._startScheduled = params.startScheduled || '';
    this._urgencyBias    = params.urgencyBias || 'balanced';
    this._baseUrgency    = params.urgency || 'neutral';
    this._maxSpreadBps   = params.maxSpreadBps || 50;
    this._riskAversion   = params.riskAversion || 0.5;
    this._volLookbackMs  = (params.volatilityLookbackMinutes || 10) * 60000;
    this._impactCoeff    = params.marketImpactCoeff || 0.1;
    this._limitMode      = params.limitMode || 'none';
    this._limitPrice     = params.limitPrice || 0;
    this._tickSize       = params.tickSize || 0.0001;
    this._lotSize        = params.lotSize || 1;

    // Duration
    const durRaw = params.durationMinutes || params.duration || '30';
    if (typeof durRaw === 'string' && durRaw.includes(':')) {
      const endTs = _parseTime(durRaw);
      this._durationMs = endTs ? Math.max(0, endTs - Date.now()) : 30 * 60000;
    } else {
      this._durationMs = (parseFloat(durRaw) || 30) * 60000;
    }

    // Chart
    const dSec = Math.round(this._durationMs / 1000);
    this._chartBids = []; this._chartAsks = []; this._chartOrder = [];
    this._chartTimes = []; this._chartFills = []; this._chartDecision = [];
    this._chartVwap = [];
    this._chartSampleMs = 1000; this._chartLastSampleTs = 0;
    this._chartMaxPts = Math.min(3600, Math.max(300, dSec + 60));

    // State
    this.status          = 'WAITING';
    this.filledSize      = 0;
    this.remainingSize   = this.totalSize;
    this.avgFillPrice    = 0;
    this.totalNotional   = 0;
    this.decisionPrice   = 0;
    this.currentVwap     = 0;
    this._vwapNotional   = 0;
    this._vwapVolume     = 0;
    this._priceReturns   = [];
    this._prevMid        = 0;
    this.estimatedVolatility = 0;
    this.optimalRate     = 0.5;
    this.currentUrgency  = this._baseUrgency;
    this.timingCost      = 0;
    this.marketImpactCost = 0;
    this.totalIsCost     = 0;
    this.slippageVsArrival = 0;
    this.activeChildId   = null;
    this._restingPrice   = null;
    this._chaseAt        = 0;
    this.nextSliceAt     = 0;
    this.slicesFired     = 0;
    this.pauseReason     = null;
    this._activated      = false;
    this._startTs        = 0;
    this._endTs          = 0;
    this._completedTs    = 0;
    this._lastMd         = null;
    this._ctx            = null;
    this._stopped        = false;
    this._startTimer     = null;
  }

  get type() { return 'IS'; }

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
    this._activate();
  }

  _activate() {
    if (this._stopped || this._activated) return;
    this._activated = true;
    const now = Date.now();
    this._startTs = now;
    this._endTs = now + this._durationMs;
    if (this._lastMd) {
      const m = this._lastMd.midPrice || ((this._lastMd.bidPrice||0)+(this._lastMd.askPrice||0))/2;
      if (m > 0) this.decisionPrice = m;
    }
    this.nextSliceAt = now;
    this.status = 'RUNNING';
    console.log(`[is] Activated: ${this.totalSize} ${this.side} λ=${this._riskAversion} bias=${this._urgencyBias} duration=${Math.round(this._durationMs/60000)}min`);
    console.log(`[is] Decision price: ${this.decisionPrice}`);
  }

  pause()  { if (this.status === 'RUNNING') { this.status = 'PAUSED'; this.pauseReason = 'manual'; } }
  resume() { if (this.status === 'PAUSED') { this.status = 'RUNNING'; this.pauseReason = null; } }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.status !== 'COMPLETED') this.status = 'STOPPED';
    console.log(`[is] Stopped: filled=${this.filledSize.toFixed(4)} isCost=${this.totalIsCost.toFixed(1)}bps (timing=${this.timingCost.toFixed(1)} impact=${this.marketImpactCost.toFixed(1)})`);
  }

  onTrade(trade) {
    if (!trade.size || trade.size <= 0) return;
    this._vwapNotional += trade.price * trade.size;
    this._vwapVolume += trade.size;
    this.currentVwap = this._vwapVolume > 0 ? this._vwapNotional / this._vwapVolume : 0;
  }

  onTick(marketData) {
    this._lastMd = marketData;
    const now = Date.now();
    const bid = marketData.bidPrice || 0;
    const ask = marketData.askPrice || 0;
    const mid = marketData.midPrice || (bid && ask ? (bid + ask) / 2 : 0);

    if (this.decisionPrice === 0 && mid > 0) this.decisionPrice = mid;

    // Chart
    if (bid > 0 && ask > 0 && now - this._chartLastSampleTs >= this._chartSampleMs) {
      this._chartLastSampleTs = now;
      const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED';
      this._chartBids.push(bid); this._chartAsks.push(ask);
      this._chartOrder.push(isDone ? null : (this._restingPrice || null));
      this._chartTimes.push(now);
      this._chartDecision.push(this.decisionPrice || null);
      this._chartVwap.push(this.currentVwap || null);
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
        this._chartDecision.shift(); this._chartVwap.shift();
      }
    }

    if (this.status === 'WAITING' || this._stopped || this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    // ── COMPLETING deadline check ─────────────────────────────────────────
    if (this.status === 'COMPLETING') {
      console.log(`[is] COMPLETING deadline check: now=${now} deadline=${this._completingDeadline} expired=${now > this._completingDeadline} activeChild=${this.activeChildId}`);
      if (now > this._completingDeadline || !this.activeChildId) {
        console.log(`[is] COMPLETING finalised — ${!this.activeChildId ? 'no active child (sweep rejected/filled)' : 'deadline expired'} — filled=${this.filledSize.toFixed(4)}`);
        this._completedTs = now; this.status = 'COMPLETED'; this.stop();
      }
      return; // don't fire new slices while completing
    }

    // ── Hard duration enforcement — must end at endTime (overrides pause) ──
    if (now >= this._endTs && (this.status === 'RUNNING' || this.status === 'PAUSED')) {
      console.log(`[is] Duration check: now=${now} endTs=${this._endTs} diff=${now - this._endTs}ms status=${this.status}`);
      if (this.activeChildId) {
        console.log(`[is] Duration expired — cancelling resting order ${this.activeChildId}`);
        this._ctx.cancelChild(this.activeChildId); this.activeChildId = null;
      }
      if (this.remainingSize > 0.001 && bid > 0 && ask > 0) {
        const tick = this._tickSize;
        const sweep = this.side === 'BUY' ? ask + tick : bid - tick;
        console.log(`[is] Duration expired — sweeping remaining ${this.remainingSize.toFixed(4)} @ ${sweep}`);
        this.activeChildId = this._ctx.submitIntent({
          symbol: this.symbol, side: this.side, quantity: this.remainingSize,
          limitPrice: sweep, orderType: 'LIMIT', algoType: 'IS-SWEEP',
        });
        this._restingPrice = sweep;
        this.status = 'COMPLETING';
        this._completingDeadline = now + 10000;
      } else {
        this._completedTs = now; this.status = 'COMPLETED'; this.stop();
      }
      return;
    }

    // ── Volatility estimation ─────────────────────────────────────────────
    if (mid > 0 && this._prevMid > 0) {
      const ret = (mid - this._prevMid) / this._prevMid;
      this._priceReturns.push(ret);
      const maxReturns = Math.round(this._volLookbackMs / 1000);
      while (this._priceReturns.length > maxReturns) this._priceReturns.shift();
      if (this._priceReturns.length >= 5) {
        const n = this._priceReturns.length;
        const mean = this._priceReturns.reduce((s,v) => s+v, 0) / n;
        const variance = this._priceReturns.reduce((s,v) => s + (v-mean)**2, 0) / n;
        const stddev = Math.sqrt(variance);
        this.estimatedVolatility = stddev * Math.sqrt(3600); // annualised (1s intervals)
      }
    }
    this._prevMid = mid;

    // ── IS cost decomposition ─────────────────────────────────────────────
    if (this.decisionPrice > 0 && mid > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.timingCost = (mid - this.decisionPrice) / this.decisionPrice * 10000 * dir;
      if (this.filledSize > 0 && this.avgFillPrice > 0) {
        this.marketImpactCost = (this.avgFillPrice - this.decisionPrice) / this.decisionPrice * 10000 * dir;
      }
      this.totalIsCost = this.timingCost + this.marketImpactCost;
    }

    // ── Optimal rate calculation ──────────────────────────────────────────
    if (this.estimatedVolatility > 0) {
      const lambda = this._riskAversion * (BIAS_MULT[this._urgencyBias] || 1.0);
      const sigSq = this.estimatedVolatility ** 2;
      const eta = this._impactCoeff;
      this.optimalRate = Math.min(0.95, Math.max(0.05, Math.sqrt(lambda * sigSq / (2 * eta))));
    }

    // Derive urgency
    if (this.optimalRate < 0.25) this.currentUrgency = 'passive';
    else if (this.optimalRate > 0.60) this.currentUrgency = 'aggressive';
    else this.currentUrgency = 'neutral';

    // ── Auto-pause ────────────────────────────────────────────────────────
    if (this.status === 'RUNNING' && mid > 0 && marketData.spreadBps > this._maxSpreadBps) {
      this.status = 'PAUSED';
      this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps`;
      return;
    }
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      if (!mid || marketData.spreadBps <= this._maxSpreadBps) {
        this.status = 'RUNNING'; this.pauseReason = null;
      }
    }
    if (this.status !== 'RUNNING') return;

    // Completion
    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
    }

    // ── Chase ─────────────────────────────────────────────────────────────
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
    if (!this.activeChildId && now >= this.nextSliceAt && this.remainingSize > 0.001) {
      this._fireSlice(bid, ask, mid);
    }
  }

  _fireSlice(bid, ask, mid) {
    if (mid <= 0) return;
    this.slicesFired++;

    const remainingTimeMs = Math.max(1000, this._endTs - Date.now());
    const totalDurationMs = this._endTs - this._startTs;
    const elapsedFraction = 1 - (remainingTimeMs / totalDurationMs);
    // Cap optimalRate for first slice to prevent aggressive front-loading
    const effectiveRate = this.slicesFired === 1 ? Math.min(this.optimalRate, 0.5) : this.optimalRate;

    // Target number of slices across the full duration (minimum 5 for 100-unit orders)
    const minSlices = Math.max(5, Math.round(this.totalSize / (this._lotSize * 5)));
    // Slice size = totalSize / minSlices, scaled by rate for urgency bias
    let sliceSize = this.totalSize / minSlices;
    // Rate scaling: at 5% rate → slices are ~10% of base; at 95% rate → slices are ~190% of base
    sliceSize *= Math.max(0.1, effectiveRate * 2);
    // Hard cap: never more than totalSize / 5 in the first half of the window
    if (elapsedFraction < 0.5) {
      sliceSize = Math.min(sliceSize, this.totalSize / 5);
    }
    // Never more than half remaining (unless last slice)
    const isLastSlice = this.remainingSize <= this._lotSize * 2;
    if (!isLastSlice) sliceSize = Math.min(sliceSize, this.remainingSize / 2);
    sliceSize = Math.max(this._lotSize, Math.min(sliceSize, this.remainingSize));
    sliceSize = floorToLot(sliceSize, this._lotSize);
    sliceSize = Math.max(this._lotSize, Math.min(sliceSize, this.remainingSize));
    console.log(`[is] _fireSlice entry: remainingSize=${this.remainingSize.toFixed(4)} optimalRate=${this.optimalRate.toFixed(3)} slicesFired=${this.slicesFired} elapsed=${(elapsedFraction*100).toFixed(0)}%`);
    console.log(`[is] slice sizing: base=${(this.totalSize/minSlices).toFixed(4)} rateScaled=${(this.totalSize/minSlices*Math.max(0.1,effectiveRate*2)).toFixed(4)} maxFirstHalf=${(this.totalSize/5).toFixed(4)} final=${sliceSize.toFixed(4)}`);

    // Price based on derived urgency
    const tick = this._tickSize;
    let price;
    if (this.currentUrgency === 'passive') price = this.side === 'BUY' ? bid : ask;
    else if (this.currentUrgency === 'aggressive') price = this.side === 'BUY' ? ask + tick : bid - tick;
    else price = mid;
    if (!price || price <= 0) price = mid;

    // Limit check
    if (this._limitMode === 'hard_limit' && this._limitPrice > 0) {
      if (this.side === 'BUY' && price > this._limitPrice) return;
      if (this.side === 'SELL' && price < this._limitPrice) return;
    }

    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: sliceSize,
      limitPrice: price, orderType: 'LIMIT', algoType: 'IS',
    });
    this._restingPrice = price;
    this._chaseAt = 0;

    // Adaptive interval: higher rate → shorter interval
    const interval = Math.max(5000, 60000 / Math.max(0.1, this.optimalRate));
    const variance = 0.1;
    this.nextSliceAt = Date.now() + interval * (1 + (Math.random() * 2 - 1) * variance);

    console.log(`[is] Slice ${this.slicesFired}: size=${sliceSize.toFixed(4)} price=${price} rate=${(this.optimalRate*100).toFixed(0)}% vol=${(this.estimatedVolatility*100).toFixed(2)}% urg=${this.currentUrgency}`);
  }

  onFill(fill) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    // Accept fills during COMPLETING (final sweep) — only reject after fully done
    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;
    console.log(`[is] onFill: fillSize=${fill.fillSize} filledSize before=${this.filledSize.toFixed(4)} filledSize after=${(this.filledSize + fill.fillSize).toFixed(4)} status=${this.status}`);

    this.filledSize += fill.fillSize;
    this.remainingSize = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;

    // Update IS cost
    if (this.decisionPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.marketImpactCost = (this.avgFillPrice - this.decisionPrice) / this.decisionPrice * 10000 * dir;
      this.totalIsCost = this.timingCost + this.marketImpactCost;
      this.slippageVsArrival = this.marketImpactCost;
    }

    // Always record fill to chart — including during COMPLETING and first fill before chart init
    this._chartFills.push({
      time: Date.now(), price: fill.fillPrice, size: fill.fillSize,
      side: this.side, simulated: !!fill.simulated,
    });
    console.log(`[is] chartFills push: price=${fill.fillPrice} total fills: ${this._chartFills.length}`);

    this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;

    console.log(`[is] Fill: ${fill.fillSize.toFixed(4)} @ ${fill.fillPrice} — IS cost: ${this.totalIsCost.toFixed(1)}bps (timing=${this.timingCost.toFixed(1)} impact=${this.marketImpactCost.toFixed(1)}) status=${this.status}`);

    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop();
    }
  }

  onOrderUpdate(order) {
    const matchId = order.orderId || order.intentId;
    if (matchId !== this.activeChildId && order.intentId !== this.activeChildId) return;
    if (order.state === 'REJECTED' || order.state === 'CANCELLED') {
      console.log(`[is] Order ${matchId} ${order.state} — status=${this.status} activeChild=${this.activeChildId}`);
      this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
      // If sweep was rejected/cancelled during COMPLETING, immediately finish
      if (this.status === 'COMPLETING') {
        console.log(`[is] Final sweep ${order.state} during COMPLETING — completing with ${this.filledSize.toFixed(4)} filled`);
        this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop();
      }
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

    const _fmtSize = v => { const s = Number(v).toFixed(4).replace(/\.?0+$/, ''); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    const _bias = { balanced: 'Balanced', aggressive: 'Aggressive', passive: 'Passive' };
    const durMin = this._endTs ? Math.round((this._endTs - this._startTs) / 60000) : '?';
    const startStr = this._startTs ? new Date(this._startTs).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '?';
    const summaryLine = `${this.side} ${_fmtSize(this.totalSize)} ${this.symbol} on ${this.venue} via IS | ${_bias[this._urgencyBias]||this._urgencyBias} | ${durMin} min`;

    return {
      type: 'IS', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status, summaryLine,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.decisionPrice,
      decisionPrice: this.decisionPrice,
      estimatedVolatility: this.estimatedVolatility,
      optimalRate: this.optimalRate,
      currentUrgency: this.currentUrgency,
      totalIsCost: this.totalIsCost,
      timingCost: this.timingCost,
      marketImpactCost: this.marketImpactCost,
      slippageVsArrival: this.slippageVsArrival,
      currentSlice: this.slicesFired,
      activeOrderPrice: this._restingPrice,
      urgency: this.currentUrgency,
      pauseReason: this.pauseReason,
      elapsed, timeRemaining,
      tickSize: this._tickSize,
      childCount: this.slicesFired,
      maxChartPoints: this._chartMaxPts,
      chartBids: [...this._chartBids], chartAsks: [...this._chartAsks],
      chartOrder: [...this._chartOrder], chartTimes: [...this._chartTimes],
      chartFills: [...this._chartFills], chartVwap: [...this._chartVwap],
      chartDecision: [...this._chartDecision],
      chartTargetPrice: this.decisionPrice, // decision price line on chart
    };
  }
}

function estimateDuration(params) {
  const dur = params.durationMinutes || params.duration || '30';
  const bias = params.urgencyBias || 'balanced';
  const biasLabel = bias === 'risk_averse' ? 'risk averse' : bias === 'cost_averse' ? 'cost averse' : 'balanced';
  return `~${dur}${String(dur).includes(':') ? '' : ' min'} — adaptive IS (${biasLabel})`;
}

module.exports = { config, Strategy: ISStrategy, estimateDuration };
