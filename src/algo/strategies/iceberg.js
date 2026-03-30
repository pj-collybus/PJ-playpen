/**
 * Iceberg — shows only a small visible quantity per slice, hides true order size.
 *
 * Each slice is placed with randomised size (within variance) and randomised
 * refresh delay. Price chasing cancels and reposts when market moves away.
 * Detection risk scoring tracks fill regularity and auto-increases variance
 * when patterns become too predictable.
 */

'use strict';

const { floorToLot } = require('../../utils/sizeUtils');

const config = {
  name: 'ICEBERG',
  displayName: 'Iceberg',
  description: 'Show only a small visible quantity — hides true order size from the market',
  params: [
    { key: 'venue',               label: 'Exchange',               type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',           label: 'Start',                  type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'},{value:'trigger',label:'Trigger'}], default: 'immediate' },
    { key: 'startScheduled',      label: 'Start at (15:45 or +10m)', type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'triggerType',         label: 'Trigger type',           type: 'select', options: [{value:'price_above',label:'Price Above'},{value:'price_below',label:'Price Below'}], default: 'price_above', dependsOn: { startMode: 'trigger' } },
    { key: 'triggerValue',        label: 'Trigger value',          type: 'number', default: 0, dependsOn: { startMode: 'trigger' } },
    { key: 'visibleSize',         label: 'Visible size (per slice)', type: 'number', default: 10, min: 0.001 },
    { key: 'visibleVariancePct',  label: 'Size variance %',        type: 'number', default: 20, min: 0, max: 50 },
    { key: 'urgency',             label: 'Urgency',                type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'passive' },
    { key: 'minRefreshMs',        label: 'Min refresh delay (ms)', type: 'number', default: 500, min: 0 },
    { key: 'maxRefreshMs',        label: 'Max refresh delay (ms)', type: 'number', default: 3000, min: 0 },
    { key: 'priceChaseEnabled',   label: 'Price chasing',          type: 'select', options: [{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}], default: 'true' },
    { key: 'priceChaseDelayMs',   label: 'Chase delay (ms)',       type: 'number', default: 2000, min: 0, dependsOn: { priceChaseEnabled: 'true' } },
    { key: 'limitMode',           label: 'Limit price',            type: 'select', options: [{value:'none',label:'None'},{value:'hard_limit',label:'Hard Limit'}], default: 'none' },
    { key: 'limitPrice',          label: 'Limit price',            type: 'number', default: 0, dependsOn: { limitMode: 'hard_limit' } },
    { key: 'maxSpreadBps',        label: 'Max spread (bps)',       type: 'number', default: 50 },
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

class IcebergStrategy {
  constructor(params) {
    this.symbol    = params.symbol;
    this.side      = params.side;
    this.venue     = params.venue || 'Deribit';
    this.totalSize = params.totalSize || 0;

    this._visibleSize      = params.visibleSize || 10;
    this._visibleVariance  = params.visibleVariancePct || 20;
    this._urgency          = params.urgency || 'passive';
    this._tickSize         = params.tickSize || 0.0001;
    this._lotSize          = params.lotSize || 1;
    this._minRefreshMs     = params.minRefreshMs || 500;
    this._maxRefreshMs     = params.maxRefreshMs || 3000;
    this._chaseEnabled     = String(params.priceChaseEnabled) !== 'false';
    this._chaseDelayMs     = params.priceChaseDelayMs || 2000;
    this._limitMode        = params.limitMode || 'none';
    this._limitPrice       = params.limitPrice || 0;
    this._maxSpreadBps     = params.maxSpreadBps || 50;

    this._startMode      = params.startMode || 'immediate';
    this._startScheduled = params.startScheduled || '';
    this._triggerType    = params.triggerType || 'price_above';
    this._triggerValue   = params.triggerValue || 0;

    // Chart
    this._chartBids = []; this._chartAsks = []; this._chartOrder = [];
    this._chartTimes = []; this._chartFills = [];
    this._chartSampleMs = 1000; this._chartLastSampleTs = 0;
    this._chartMaxPts = 1800; // 30 min default

    // State
    this.status          = 'WAITING';
    this.filledSize      = 0;
    this.remainingSize   = this.totalSize;
    this.avgFillPrice    = 0;
    this.totalNotional   = 0;
    this.arrivalPrice    = 0;
    this.slippageVsArrival = 0;
    this.slicesFired     = 0;
    this.slicesFilled    = 0;
    this.currentSliceSize = 0;
    this.activeChildId   = null;
    this._restingPrice   = null;
    this._refreshAt      = 0;
    this._chaseAt        = 0;
    this.detectionScore  = 0;
    this._lastFillTs     = 0;
    this._fillIntervals  = [];
    this.pauseReason     = null;
    this._activated      = false;
    this._startTs        = 0;
    this._completedTs    = 0;
    this._lastMd         = null;
    this._ctx            = null;
    this._stopped        = false;
    this._startTimer     = null;
  }

  get type() { return 'ICEBERG'; }

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
    this._startTs = Date.now();
    if (this._lastMd) {
      this.arrivalPrice = this._lastMd.midPrice || ((this._lastMd.bidPrice||0)+(this._lastMd.askPrice||0))/2;
    }
    this._refreshAt = Date.now(); // first slice immediately
    this.status = 'RUNNING';
    console.log(`[iceberg] Activated: ${this.totalSize} ${this.side} visible=${this._visibleSize}±${this._visibleVariance}% urgency=${this._urgency}`);
  }

  pause()  { if (this.status === 'RUNNING') { this.status = 'PAUSED'; this.pauseReason = 'manual'; } }
  resume() { if (this.status === 'PAUSED') { this.status = 'RUNNING'; this.pauseReason = null; } }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.status !== 'COMPLETED') this.status = 'STOPPED';
    console.log(`[iceberg] Stopped: filled=${this.filledSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)} slices=${this.slicesFired} detection=${this.detectionScore}`);
  }

  onTick(marketData) {
    this._lastMd = marketData;
    if (this.arrivalPrice === 0) {
      const m = marketData.midPrice || ((marketData.bidPrice||0)+(marketData.askPrice||0))/2;
      if (m > 0) this.arrivalPrice = m;
    }

    // Trigger
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
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
      }
    }

    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    // Auto-pause: spread
    if (this.status === 'RUNNING' && mid > 0 && marketData.spreadBps > this._maxSpreadBps) {
      this.status = 'PAUSED';
      this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps > ${this._maxSpreadBps}bps`;
      return;
    }
    // Auto-resume
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      if (!mid || marketData.spreadBps <= this._maxSpreadBps) {
        this.status = 'RUNNING'; this.pauseReason = null;
      }
    }
    if (this.status !== 'RUNNING') return;

    // Completion
    if (this.filledSize >= this.totalSize - 0.001 || this.remainingSize <= 0.001) {
      this._completedTs = this._completedTs || now;
      this.status = 'COMPLETED'; this.stop(); return;
    }

    // ── Price chase for active order ──────────────────────────────────────
    if (this.activeChildId && this._chaseEnabled && bid > 0 && ask > 0) {
      const rp = this._restingPrice || 0;
      const movedAway = this.side === 'BUY'
        ? (bid < rp - this._tickSize)
        : (ask > rp + this._tickSize);
      const movedBack = this.side === 'BUY'
        ? (bid >= rp)
        : (ask <= rp);

      if (movedAway && this._chaseAt === 0) {
        this._chaseAt = now + this._chaseDelayMs;
      } else if (movedBack) {
        this._chaseAt = 0; // market came back, no chase needed
      }
      if (this._chaseAt > 0 && now >= this._chaseAt) {
        console.log(`[iceberg] Price chasing — cancelled order, reposting at new TOB`);
        this._ctx.cancelChild(this.activeChildId);
        this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
        this._refreshAt = now; // immediate repost
      }
    }

    // ── Place new slice ──────────────────────────────────────────────────
    if (!this.activeChildId && now >= this._refreshAt && this.remainingSize > 0.001) {
      this._placeSlice(bid, ask, mid);
    }
  }

  _placeSlice(bid, ask, mid) {
    if (mid <= 0) return;

    // Calculate slice size with variance
    let effectiveVariance = this._visibleVariance;
    if (this.detectionScore > 70) {
      effectiveVariance = Math.min(50, effectiveVariance * 1.5);
    }
    const varianceAmt = this._visibleSize * (effectiveVariance / 100);
    let sliceSize = this._visibleSize + (Math.random() * 2 - 1) * varianceAmt;
    sliceSize = Math.max(this._lotSize, Math.min(sliceSize, this.remainingSize));
    // Round to lotSize
    sliceSize = floorToLot(sliceSize, this._lotSize);
    sliceSize = Math.max(this._lotSize, Math.min(sliceSize, this.remainingSize));
    this.currentSliceSize = sliceSize;

    // Price
    const tick = this._tickSize;
    let price;
    if (this._urgency === 'passive') price = this.side === 'BUY' ? bid : ask;
    else if (this._urgency === 'aggressive') price = this.side === 'BUY' ? ask + tick : bid - tick;
    else price = mid;
    if (!price || price <= 0) price = mid;

    // Limit check
    if (this._limitMode === 'hard_limit' && this._limitPrice > 0) {
      if (this.side === 'BUY' && price > this._limitPrice) {
        this.status = 'PAUSED'; this.pauseReason = `Price ${price} > limit ${this._limitPrice}`;
        return;
      }
      if (this.side === 'SELL' && price < this._limitPrice) {
        this.status = 'PAUSED'; this.pauseReason = `Price ${price} < limit ${this._limitPrice}`;
        return;
      }
    }

    this.slicesFired++;
    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: sliceSize,
      limitPrice: price, orderType: 'LIMIT', algoType: 'ICEBERG',
    });
    this._restingPrice = price;
    this._chaseAt = 0;
    console.log(`[iceberg] Slice ${this.slicesFired}: size=${sliceSize.toFixed(4)} price=${price} detection=${this.detectionScore}`);
  }

  onFill(fill) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    const now = Date.now();
    this.filledSize += fill.fillSize;
    this.remainingSize = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;
    this.slicesFilled++;

    // Chart
    this._chartFills.push({
      time: now, price: fill.fillPrice, size: fill.fillSize,
      side: this.side, simulated: !!fill.simulated,
    });

    // Fill interval tracking for detection scoring
    if (this._lastFillTs > 0) {
      this._fillIntervals.push(now - this._lastFillTs);
      if (this._fillIntervals.length > 10) this._fillIntervals.shift();
      this._updateDetectionScore();
    }
    this._lastFillTs = now;

    // Slippage
    if (this.arrivalPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.slippageVsArrival = (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    }

    this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;

    // Random refresh delay before next slice
    const delay = this._minRefreshMs + Math.random() * (this._maxRefreshMs - this._minRefreshMs);
    this._refreshAt = now + delay;

    console.log(`[iceberg] Fill: ${fill.fillSize.toFixed(4)} @ ${fill.fillPrice} — total=${this.filledSize.toFixed(4)}/${this.totalSize.toFixed(4)} next in ${Math.round(delay)}ms detection=${this.detectionScore}`);

    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = now;
      this.status = 'COMPLETED'; this.stop();
    }
  }

  onOrderUpdate(order) {
    if (order.orderId !== this.activeChildId) return;
    if (order.state === 'REJECTED') {
      console.log(`[iceberg] Order rejected: ${order.rejectReason || 'unknown'}`);
      this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
      this._refreshAt = Date.now() + 2000;
    } else if (order.state === 'CANCELLED') {
      this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
      this._refreshAt = Date.now() + 1000;
    }
  }

  _updateDetectionScore() {
    if (this._fillIntervals.length < 3) { this.detectionScore = 0; return; }
    const intervals = this._fillIntervals.slice(-5);
    const n = intervals.length;
    const mean = intervals.reduce((s,v) => s+v, 0) / n;
    if (mean === 0) { this.detectionScore = 0; return; }
    const variance = intervals.reduce((s,v) => s + (v-mean)**2, 0) / n;
    const stddev = Math.sqrt(variance);
    const cv = stddev / mean; // coefficient of variation
    // CV > 0.3 = irregular (low risk), CV < 0.1 = very regular (high risk)
    this.detectionScore = Math.max(0, Math.min(100, Math.round(100 * (0.2 - cv) / 0.2)));
  }

  getState() {
    const now = Date.now();
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this._stopped;
    const elapsed = this._startTs ? (isDone && this._completedTs ? this._completedTs - this._startTs : now - this._startTs) : 0;
    const refreshIn = this._refreshAt ? Math.max(0, this._refreshAt - now) : 0;
    const chaseIn = this._chaseAt ? Math.max(0, this._chaseAt - now) : 0;

    const _fmtSize = v => { const s = Number(v).toFixed(4).replace(/\.?0+$/, ''); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    const _urg = { passive: 'Passive', aggressive: 'Aggressive', neutral: 'Neutral' };
    const startStr = this._startTs ? new Date(this._startTs).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '?';
    const summaryLine = `${this.side} ${_fmtSize(this.totalSize)} ${this.symbol} on ${this.venue} via ICEBERG | ${_fmtSize(this._visibleSize)} ± ${this._visibleVariance}% per slice | ${_urg[this._urgency]||this._urgency}`;

    return {
      type: 'ICEBERG', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status, summaryLine,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival,
      visibleSize: this._visibleSize, visibleVariancePct: this._visibleVariance,
      currentSliceSize: this.currentSliceSize,
      slicesFired: this.slicesFired, slicesFilled: this.slicesFilled,
      detectionScore: this.detectionScore,
      activeOrderPrice: this._restingPrice,
      refreshIn, chaseIn,
      chaseRequired: this._chaseAt > 0,
      urgency: this._urgency,
      pauseReason: this.pauseReason,
      elapsed, timeRemaining: null,
      tickSize: this._tickSize,
      childCount: this.slicesFired,
      maxChartPoints: this._chartMaxPts,
      chartBids: this._chartBids, chartAsks: this._chartAsks,
      chartOrder: this._chartOrder, chartTimes: this._chartTimes,
      chartFills: this._chartFills,
    };
  }
}

function estimateDuration(params) {
  const vis = params.visibleSize || 10;
  const vari = params.visibleVariancePct || 20;
  return `Continuous — ${vis} ± ${vari}% per slice`;
}

module.exports = { config, Strategy: IcebergStrategy, estimateDuration };
