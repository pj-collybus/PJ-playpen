/**
 * POV — Percentage of Volume strategy (institutional grade).
 *
 * Participates as a configured percentage of market flow. Reacts to every
 * market trade by submitting proportional child orders. Periodic catch-up
 * ensures target participation even during quiet periods.
 */

'use strict';

const config = {
  name: 'POV',
  displayName: 'POV',
  description: 'Percentage of volume execution — participates as a % of market flow',
  params: [
    { key: 'venue',               label: 'Exchange',              type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',           label: 'Start',                 type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'},{value:'trigger',label:'Trigger'}], default: 'immediate' },
    { key: 'startScheduled',      label: 'Start at (15:45 or +10m)', type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'triggerType',         label: 'Trigger type',          type: 'select', options: [{value:'price_above',label:'Price Above'},{value:'price_below',label:'Price Below'}], default: 'price_above', dependsOn: { startMode: 'trigger' } },
    { key: 'triggerValue',        label: 'Trigger value',         type: 'number', default: 0, dependsOn: { startMode: 'trigger' } },
    { key: 'targetPct',           label: 'Target participation %', type: 'number', default: 10, min: 1, max: 50 },
    { key: 'volumeWindowSeconds', label: 'Volume window (seconds)', type: 'number', default: 30, min: 5, max: 300 },
    { key: 'minChildSize',        label: 'Min child order size',  type: 'number', default: 0 },
    { key: 'maxChildSize',        label: 'Max child order size',  type: 'number', default: 0 },
    { key: 'limitMode',           label: 'Limit price',           type: 'select', options: [{value:'none',label:'None'},{value:'hard_limit',label:'Hard Limit'},{value:'average_rate',label:'Average Rate'}], default: 'none' },
    { key: 'limitPrice',          label: 'Limit price',           type: 'number', default: 0, dependsOn: { limitMode: 'hard_limit' } },
    { key: 'averageRateLimit',    label: 'Max average rate',      type: 'number', default: 0, dependsOn: { limitMode: 'average_rate' } },
    { key: 'urgency',             label: 'Urgency',               type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'neutral' },
    { key: 'maxSpreadBps',        label: 'Max spread (bps)',      type: 'number', default: 50 },
    { key: 'endMode',             label: 'End condition',         type: 'select', options: [{value:'total_filled',label:'Total Filled'},{value:'time_limit',label:'Time Limit'}], default: 'total_filled' },
    { key: 'timeLimitMinutes',    label: 'Run for (mins or HH:MM)', type: 'text', default: '60', dependsOn: { endMode: 'time_limit' } },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Strategy ────────────────────────────────────────────────────────────────

class POVStrategy {
  constructor(params) {
    this.symbol    = params.symbol;
    this.side      = params.side;
    this.venue     = params.venue || 'Deribit';
    this.totalSize = params.totalSize || 0;

    // Core params
    this._targetPct          = params.targetPct || 10;
    this._volumeWindowSec    = params.volumeWindowSeconds || 30;
    this._minChildSize       = params.minChildSize || 0;
    this._maxChildSize       = params.maxChildSize || 0;
    this._tickSize           = params.tickSize || 0.0001;
    this._lotSize            = params.lotSize || 1;
    // minChildSize: user value, or 2× lotSize as sensible minimum
    if (!this._minChildSize || this._minChildSize <= 0) {
      this._minChildSize = this._lotSize * 2;
    }

    // Start
    this._startMode      = params.startMode || 'immediate';
    this._startScheduled = params.startScheduled || '';
    this._triggerType    = params.triggerType || 'price_above';
    this._triggerValue   = params.triggerValue || 0;

    // Limits
    this._limitMode        = params.limitMode || 'none';
    this._limitPrice       = params.limitPrice || 0;
    this._averageRateLimit = params.averageRateLimit || 0;
    this._urgency          = params.urgency || 'neutral';
    this._maxSpreadBps     = params.maxSpreadBps || 50;

    // End condition
    this._endMode         = params.endMode || 'total_filled';
    // Parse timeLimitMinutes: can be a number or 'HH:MM' end time string
    const tlRaw = params.timeLimitMinutes || '60';
    if (typeof tlRaw === 'string' && tlRaw.includes(':')) {
      const endTs = _parseTime(tlRaw);
      this._timeLimitMs = endTs ? Math.max(0, endTs - Date.now()) : 60 * 60000;
    } else {
      this._timeLimitMs = (parseFloat(tlRaw) || 60) * 60000;
    }

    // Chart data
    this._chartBids = []; this._chartAsks = []; this._chartOrder = [];
    this._chartTimes = []; this._chartFills = []; this._chartVolBars = [];
    this._chartSampleMs = 1000; this._chartLastSampleTs = 0;
    const chartDurationSec = this._endMode === 'time_limit' ? Math.round(this._timeLimitMs / 1000) : 3600;
    this._chartMaxPts = Math.min(3600, Math.max(300, chartDurationSec + 60));

    // State
    this.status          = 'WAITING';
    this.filledSize      = 0;
    this.remainingSize   = this.totalSize;
    this.avgFillPrice    = 0;
    this.totalNotional   = 0;
    this.arrivalPrice    = 0;
    this.slippageVsArrival = 0;
    this.windowVolume    = 0;
    this.participationRate = 0;
    this.activeChildId   = null;
    this._restingPrice   = null;
    this.pauseReason     = null;
    this._activated      = false;
    this._startTs        = 0;
    this._endTs          = null;
    this._completedTs    = 0;
    this._lastMd         = null;
    this._lastTradeTs    = 0;
    this._rollingVolume  = []; // { size, ts } — market trades
    this._myRollingFills = []; // { size, ts } — my fills in same window
    this._catchupTs      = 0;
    this._ctx            = null;
    this._stopped        = false;
    this._startTimer     = null;
    this._childCount     = 0;
  }

  get type() { return 'POV'; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

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
    if (this._lastMd) {
      this.arrivalPrice = this._lastMd.midPrice || ((this._lastMd.bidPrice||0)+(this._lastMd.askPrice||0))/2;
    }
    // End time for time_limit mode
    if (this._endMode === 'time_limit') {
      this._endTs = now + this._timeLimitMs;
      console.log(`[pov] Time limit: ends at ${new Date(this._endTs).toISOString()} (${Math.round(this._timeLimitMs/60000)}min)`);
    }
    this.status = 'RUNNING';
    console.log(`[pov] Activated: ${this.totalSize} ${this.side} at ${this._targetPct}% participation, window=${this._volumeWindowSec}s, urgency=${this._urgency}`);
  }

  pause()  { if (this.status === 'RUNNING') { this.status = 'PAUSED'; this.pauseReason = 'manual'; } }
  resume() { if (this.status === 'PAUSED') { this.status = 'RUNNING'; this.pauseReason = null; } }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.status !== 'COMPLETED') this.status = 'STOPPED';
    console.log(`[pov] Stopped: filled=${this.filledSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)} participation=${this.participationRate.toFixed(1)}%`);
  }

  // ── Market data ───────────────────────────────────────────────────────────

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

    // Chart sampling
    if (bid > 0 && ask > 0 && now - this._chartLastSampleTs >= this._chartSampleMs) {
      this._chartLastSampleTs = now;
      const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED';
      this._chartBids.push(bid); this._chartAsks.push(ask);
      this._chartOrder.push(isDone ? null : (this._restingPrice || null));
      this._chartTimes.push(now);
      // Volume bar: total volume in the last sample period
      this._chartVolBars.push(this.windowVolume);
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
        this._chartVolBars.shift();
      }
    }

    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    // Auto-pause: spread
    if (this.status === 'RUNNING' && mid > 0 && marketData.spreadBps > this._maxSpreadBps) {
      this.status = 'PAUSED';
      this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps > ${this._maxSpreadBps}bps`;
      return;
    }
    // Auto-pause: no market trades
    if (this.status === 'RUNNING' && this._lastTradeTs > 0 && now - this._lastTradeTs > this._volumeWindowSec * 2000) {
      this.status = 'PAUSED';
      this.pauseReason = 'No market volume detected';
      return;
    }
    // Auto-resume
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      const ok = (!mid || marketData.spreadBps <= this._maxSpreadBps) &&
                 (this._lastTradeTs === 0 || now - this._lastTradeTs <= this._volumeWindowSec * 2000);
      if (ok) { this.status = 'RUNNING'; this.pauseReason = null; }
    }
    if (this.status !== 'RUNNING') return;

    // Completion check
    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = this._completedTs || now;
      this.status = 'COMPLETED'; this.stop(); return;
    }
    // Time limit
    if (this._endTs && now >= this._endTs) {
      console.log(`[pov] Time limit reached`);
      this._completedTs = now;
      this.status = 'COMPLETED'; this.stop(); return;
    }

    // Periodic catch-up (every 5 seconds)
    if (now - this._catchupTs >= 5000) {
      this._catchupTs = now;
      this._expireVolume(now);
      const myTarget = this.windowVolume * (this._targetPct / 100);
      const deficit = myTarget - (this._myWindowVolume || 0);
      const minSz = Math.max(this._minChildSize, this._lotSize);

      if (!this.activeChildId && this.remainingSize > minSz * 0.5) {
        if (this.windowVolume > 0 && deficit >= minSz) {
          // Normal catch-up: behind target participation
          const sz = Math.max(minSz, Math.min(deficit, this.remainingSize));
          console.log(`[pov] catch-up: windowVol=${this.windowVolume.toFixed(1)} myTarget=${myTarget.toFixed(2)} myFills=${(this._myWindowVolume||0).toFixed(2)} deficit=${deficit.toFixed(2)} firing=${sz.toFixed(4)}`);
          this._fireChild(sz, bid, ask, mid);
        } else if (this._lastTradeTs > 0 && now - this._lastTradeTs > this._volumeWindowSec * 3000) {
          // Stall prevention: no trades for 3× window — fire minimum catch-up
          const stallSz = Math.max(minSz, this.remainingSize * 0.1);
          const sz = Math.min(stallSz, this.remainingSize);
          console.log(`[pov] stall catch-up: no trades for ${Math.round((now-this._lastTradeTs)/1000)}s, firing=${sz.toFixed(4)}`);
          this._fireChild(sz, bid, ask, mid);
        }
      }
    }
  }

  // ── Market trade handler ──────────────────────────────────────────────────

  onTrade(trade) {
    if (this.status !== 'RUNNING' || this._stopped) return;

    const now = Date.now();
    this._lastTradeTs = now;
    const tradeSize = trade.size || 0;
    if (tradeSize <= 0) return;

    // Add to rolling volume
    this._rollingVolume.push({ size: tradeSize, ts: now });
    this._expireVolume(now);

    // Calculate participation target using rolling windows for both sides
    const myTarget = this.windowVolume * (this._targetPct / 100);
    const deficit = myTarget - (this._myWindowVolume || 0);
    const minSz = Math.max(this._minChildSize, this._lotSize);

    if (deficit < minSz || this.remainingSize < minSz * 0.5) return;
    if (this.activeChildId) return;

    const bid = this._lastMd?.bidPrice || 0;
    const ask = this._lastMd?.askPrice || 0;
    const mid = this._lastMd?.midPrice || (bid && ask ? (bid+ask)/2 : 0);
    if (mid <= 0) return;

    let childSize = Math.max(minSz, Math.min(deficit, this.remainingSize));
    if (this._maxChildSize > 0) childSize = Math.min(childSize, this._maxChildSize);

    console.log(`[pov] trade trigger: windowVol=${this.windowVolume.toFixed(1)} myTarget=${myTarget.toFixed(2)} myFills=${(this._myWindowVolume||0).toFixed(2)} deficit=${deficit.toFixed(2)} childSize=${childSize.toFixed(4)}`);
    this._fireChild(childSize, bid, ask, mid);
  }

  _fireChild(size, bid, ask, mid) {
    const tick = this._tickSize;
    let price;
    if (this._urgency === 'passive') price = this.side === 'BUY' ? bid : ask;
    else if (this._urgency === 'aggressive') price = this.side === 'BUY' ? ask + tick : bid - tick;
    else price = mid;
    if (!price || price <= 0) price = mid;

    // Hard limit check
    if (this._limitMode === 'hard_limit' && this._limitPrice > 0) {
      if (this.side === 'BUY' && price > this._limitPrice) return;
      if (this.side === 'SELL' && price < this._limitPrice) return;
    }
    // Average rate check
    if (this._limitMode === 'average_rate' && this._averageRateLimit > 0 && this.avgFillPrice > 0) {
      const projFilled = this.filledSize + size;
      const projAvg = (this.totalNotional + price * size) / projFilled;
      if (this.side === 'BUY' && projAvg > this._averageRateLimit) return;
      if (this.side === 'SELL' && projAvg < this._averageRateLimit) return;
    }

    this._childCount++;
    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: size,
      limitPrice: price, orderType: 'LIMIT', algoType: 'POV',
    });
    this._restingPrice = price;
    console.log(`[pov] Child #${this._childCount}: size=${size.toFixed(4)} price=${price} windowVol=${this.windowVolume.toFixed(1)} participation=${this.participationRate.toFixed(1)}%`);
  }

  _expireVolume(now) {
    const cutoff = now - this._volumeWindowSec * 1000;
    while (this._rollingVolume.length && this._rollingVolume[0].ts < cutoff) {
      this._rollingVolume.shift();
    }
    while (this._myRollingFills.length && this._myRollingFills[0].ts < cutoff) {
      this._myRollingFills.shift();
    }
    this.windowVolume = this._rollingVolume.reduce((sum, v) => sum + v.size, 0);
    this._myWindowVolume = this._myRollingFills.reduce((sum, v) => sum + v.size, 0);
  }

  // ── Fill handling ─────────────────────────────────────────────────────────

  onFill(fill) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    this.filledSize += fill.fillSize;
    this.remainingSize = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;
    // Add to my rolling fill window (same window as market volume)
    this._myRollingFills.push({ size: fill.fillSize, ts: Date.now() });

    // Participation rate using rolling windows
    this._expireVolume(Date.now());
    this.participationRate = this.windowVolume > 0 ? ((this._myWindowVolume || 0) / this.windowVolume) * 100 : 0;

    // Slippage
    if (this.arrivalPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.slippageVsArrival = (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    }

    // Chart
    this._chartFills.push({
      time: Date.now(), price: fill.fillPrice, size: fill.fillSize,
      side: this.side, simulated: !!fill.simulated,
    });

    this.activeChildId = null;
    this._restingPrice = null;

    console.log(`[pov] Fill: ${fill.fillSize.toFixed(4)} @ ${fill.fillPrice} — total=${this.filledSize.toFixed(4)}/${this.totalSize.toFixed(4)} participation=${this.participationRate.toFixed(1)}%`);

    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = Date.now();
      this.status = 'COMPLETED';
      this.stop();
    }
  }

  onOrderUpdate(order) {
    if (order.state !== 'REJECTED') return;
    if (order.orderId !== this.activeChildId) return;
    console.log(`[pov] Order rejected: ${order.rejectReason || 'unknown'}`);
    this.activeChildId = null;
    this._restingPrice = null;
  }

  // ── State ─────────────────────────────────────────────────────────────────

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
    const timeRemaining = isDone ? 0 : (this._endTs ? Math.max(0, this._endTs - now) : null);
    const deficit = this.windowVolume > 0
      ? this.windowVolume * (this._targetPct / 100) - (this._myWindowVolume || 0) : 0;

    const _fmtSize = v => { const s = Number(v).toFixed(4).replace(/\.?0+$/, ''); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    const startStr = this._startTs ? new Date(this._startTs).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '?';
    const summaryLine = `${this.side} ${_fmtSize(this.totalSize)} ${this.symbol} on ${this.venue} via POV | ${this._targetPct}% participation | ${this._volumeWindowSec}s window`;

    return {
      type: 'POV', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status, summaryLine,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival,
      targetPct: this._targetPct,
      windowVolume: this.windowVolume,
      participationRate: this.participationRate,
      deficit: Math.max(0, deficit),
      lastTradeAge: this._lastTradeTs ? now - this._lastTradeTs : null,
      activeOrderPrice: this._restingPrice,
      childCount: this._childCount,
      urgency: this._urgency,
      pauseReason: this.pauseReason,
      elapsed, timeRemaining,
      tickSize: this._tickSize,
      maxChartPoints: this._chartMaxPts,
      chartBids: this._chartBids, chartAsks: this._chartAsks,
      chartOrder: this._chartOrder, chartTimes: this._chartTimes,
      chartFills: this._chartFills, chartVolBars: this._chartVolBars,
    };
  }
}

function estimateDuration(params) {
  const pct = params.targetPct || 10;
  if (params.endMode === 'time_limit') {
    const tl = params.timeLimitMinutes || '60';
    return `Runs for ${tl}${String(tl).includes(':') ? '' : ' min'} at ${pct}% participation`;
  }
  return `Market-paced — completes when ${params.totalSize || '?'} filled at ${pct}%`;
}

module.exports = { config, Strategy: POVStrategy, estimateDuration };
