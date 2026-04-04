// @ts-nocheck
/**
 * VWAP — Volume-Weighted Average Price
 * Refactored: extends BaseStrategy.
 */
import { floorToLot } from '../utils/sizeUtils';
import { parseDurationMs } from '../utils/timeUtils';
import { BaseStrategy } from './baseStrategy';
import type { MarketData, TradeData, FillData, OrderUpdate, StrategyConfig } from '../types';

export const config: StrategyConfig = {
  name: 'VWAP', displayName: 'VWAP',
  description: 'Volume-weighted average price — tracks and benchmarks against rolling VWAP',
  params: [
    { key: 'venue',                label: 'Exchange',             type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',            label: 'Start',                type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'},{value:'trigger',label:'Trigger'}], default: 'immediate' },
    { key: 'startScheduled',       label: 'Start at',             type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'triggerType',          label: 'Trigger type',         type: 'select', options: [{value:'price_above',label:'Price Above'},{value:'price_below',label:'Price Below'},{value:'vwap_cross',label:'Price Crosses VWAP'}], default: 'price_above', dependsOn: { startMode: 'trigger' } },
    { key: 'triggerValue',         label: 'Trigger value',        type: 'number', default: 0, dependsOn: { startMode: 'trigger' } },
    { key: 'vwapMode',             label: 'VWAP mode',            type: 'select', options: [{value:'realtime',label:'Real-time VWAP'},{value:'benchmark',label:'Benchmark VWAP'},{value:'historical',label:'Historical Profile'}], default: 'realtime' },
    { key: 'urgency',              label: 'Urgency',              type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'passive' },
    { key: 'vwapWindowMinutes',    label: 'VWAP window (min)',    type: 'number', default: 30, min: 1 },
    { key: 'participationBandBps', label: 'Participation band (bps)', type: 'number', default: 10, min: 0 },
    { key: 'maxDeviationBps',      label: 'Max deviation (bps)',  type: 'number', default: 50, min: 0 },
    { key: 'scheduleVariancePct',  label: 'Timing variance %',    type: 'number', default: 10, min: 0, max: 50 },
    { key: 'maxSpreadBps',         label: 'Max spread (bps)',     type: 'number', default: 50 },
    { key: 'limitMode',            label: 'Limit price',          type: 'select', options: [{value:'none',label:'None'},{value:'hard_limit',label:'Hard Limit'}], default: 'none' },
    { key: 'limitPrice',           label: 'Limit price',          type: 'number', default: 0, dependsOn: { limitMode: 'hard_limit' } },
  ],
};

function _rand(a: number, b: number) { return a + Math.random() * (b - a); }
function _profileWeight(pct: number) { return 0.5 + 1.0 * Math.pow(2 * Math.abs(pct - 0.5), 2); }

export class VWAPStrategy extends BaseStrategy {
  rollingVwap = 0; arrivalVwap = 0; deviationFromVwap = 0; inParticipationBand = false;
  profileWeight = 1.0; currentUrgency: string; slippageVsVwap = 0;
  slicesFired = 0; slicesTotal = 0; nextSliceAt = 0;

  private _vwapMode: string; private _baseUrgency: string; private _lotSize: number;
  private _vwapWindowMs: number; private _bandBps: number; private _maxDeviationBps: number;
  private _variancePct: number; private _limitMode: string; private _limitPrice: number;
  private _triggerType: string; private _durationMs: number;
  private _rollingTrades: Array<{price:number;size:number;ts:number}> = [];
  private _chaseAt = 0; private _intervalMs = 0; private _completingDeadline = 0;

  get type() { return 'VWAP'; }

  constructor(params: Record<string, unknown>) {
    const dMs = parseDurationMs((params.durationMinutes || params.duration || '30') as string|number);
    super(params, Math.min(3600, Math.max(300, Math.round(dMs/1000) + 60)));
    this._vwapMode = (params.vwapMode as string) || 'realtime';
    this._baseUrgency = (params.urgency as string) || 'passive'; this.currentUrgency = this._baseUrgency;
    this._lotSize = (params.lotSize as number) || 1;
    this._vwapWindowMs = ((params.vwapWindowMinutes as number) || 30) * 60000;
    this._bandBps = (params.participationBandBps as number) || 10;
    this._maxDeviationBps = (params.maxDeviationBps as number) || 50;
    this._variancePct = (params.scheduleVariancePct as number) || 10;
    this._limitMode = (params.limitMode as string) || 'none';
    this._limitPrice = (params.limitPrice as number) || 0;
    this._triggerType = (params.triggerType as string) || 'price_above';
    this._durationMs = dMs;
    this._chart.addSeries('vwap');
  }

  protected _onActivate() {
    this._endTs = Date.now() + this._durationMs;
    this.arrivalVwap = this.rollingVwap || this.arrivalPrice;
    this.slicesTotal = Math.max(2, Math.min(500, Math.round(this._durationMs / 60000)));
    this._intervalMs = this._durationMs / this.slicesTotal;
    this.nextSliceAt = Date.now();
    this.status = 'RUNNING';
    console.log(`[vwap] Activated: ${this.totalSize} ${this.side} mode=${this._vwapMode} ${this.slicesTotal} slices over ${Math.round(this._durationMs/60000)}min`);
  }

  onTrade(trade: TradeData) {
    if (!trade.size || trade.size <= 0) return;
    this._rollingTrades.push({ price: trade.price, size: trade.size, ts: Date.now() });
    this._expireTrades(); this._recalcVwap();
    // VWAP cross trigger
    if (this.status === 'WAITING' && this._triggerType === 'vwap_cross') {
      const mid = this._lastMd?.midPrice || 0;
      if (mid > 0 && this.rollingVwap > 0) {
        const crossed = this.side === 'BUY' ? mid <= this.rollingVwap : mid >= this.rollingVwap;
        if (crossed) this._activate();
      }
    }
  }

  private _expireTrades() { const cutoff = Date.now() - this._vwapWindowMs; while (this._rollingTrades.length && this._rollingTrades[0].ts < cutoff) this._rollingTrades.shift(); }
  private _recalcVwap() { let n=0,v=0; for (const t of this._rollingTrades){n+=t.price*t.size;v+=t.size;} this.rollingVwap=v>0?n/v:this.rollingVwap; }

  protected _onTick(md: MarketData, bid: number, ask: number, mid: number, now: number) {
    if (mid > 0 && this.rollingVwap > 0) {
      this.deviationFromVwap = (mid - this.rollingVwap) / this.rollingVwap * 10000;
      this.inParticipationBand = Math.abs(this.deviationFromVwap) <= this._bandBps;
    }
    // VWAP deviation auto-pause (realtime mode)
    if (this.status === 'RUNNING' && this._vwapMode === 'realtime' && Math.abs(this.deviationFromVwap) > this._maxDeviationBps) {
      this.status = 'PAUSED'; this.pauseReason = `VWAP deviation ${this.deviationFromVwap.toFixed(0)}bps`; return;
    }
    // Auto-resume (base class handles spread; handle VWAP here)
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      const devOk = this._vwapMode !== 'realtime' || Math.abs(this.deviationFromVwap) <= this._maxDeviationBps;
      if (devOk) { this.status = 'RUNNING'; this.pauseReason = null; }
    }
    if (this.status !== 'RUNNING') return;
    if (this._isComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    if (now >= this._endTs) { this._sweep(bid, ask, now); return; }
    if (this.status === 'COMPLETING') { if (now > this._completingDeadline) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); } return; }
    this._checkChase(bid, ask, now);
    if (!this.activeChildId && now >= this.nextSliceAt && this.remainingSize > 0.001 && this.slicesFired < this.slicesTotal) {
      const canFire = this._vwapMode === 'realtime' ? this.inParticipationBand : true;
      if (canFire) this._fireSlice(bid, ask, mid);
    }
  }

  protected _chartExtras(_mid: number): Record<string, number | null> { return { vwap: this.rollingVwap || null }; }

  private _sweep(bid: number, ask: number, now: number) {
    if (this.activeChildId) { this._ctx!.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.remainingSize > 0.001 && bid > 0 && ask > 0) {
      const sp = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: this.remainingSize, limitPrice: sp, orderType: 'LIMIT', algoType: 'VWAP-SWEEP' });
      this._restingPrice = sp; this.status = 'COMPLETING'; this._completingDeadline = now + 10000;
    } else { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); }
  }

  private _checkChase(bid: number, ask: number, now: number) {
    if (!this.activeChildId || bid <= 0 || ask <= 0) return;
    const rp = this._restingPrice || 0;
    const moved = this.side === 'BUY' ? bid < rp - this._tickSize : ask > rp + this._tickSize;
    const back  = this.side === 'BUY' ? bid >= rp : ask <= rp;
    if (moved && this._chaseAt === 0) this._chaseAt = now + _rand(3000, 7000);
    else if (back) this._chaseAt = 0;
    if (this._chaseAt > 0 && now >= this._chaseAt) { this._ctx!.cancelChild(this.activeChildId); this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0; }
  }

  private _fireSlice(bid: number, ask: number, mid: number) {
    if (mid <= 0) return;
    this.slicesFired++;
    let size = this.remainingSize / Math.max(1, this.slicesTotal - this.slicesFired + 1);
    if (this._vwapMode === 'historical' && this._startTs && this._endTs) { const e=(Date.now()-this._startTs)/(this._endTs-this._startTs); this.profileWeight=_profileWeight(Math.min(1,Math.max(0,e))); size*=this.profileWeight; }
    if (this._vwapMode === 'benchmark' && this.rollingVwap > 0 && this.avgFillPrice > 0) { const dir=this.side==='BUY'?1:-1; const slip=(this.avgFillPrice-this.rollingVwap)/this.rollingVwap*10000*dir; this.currentUrgency=slip>5?'aggressive':slip>0?'neutral':this._baseUrgency; }
    const urg = this._vwapMode === 'benchmark' ? this.currentUrgency : this._baseUrgency;
    size = Math.max(this._lotSize, Math.min(floorToLot(size, this._lotSize), this.remainingSize));
    let price = urg==='passive'?(this.side==='BUY'?bid:ask):urg==='aggressive'?(this.side==='BUY'?ask+this._tickSize:bid-this._tickSize):mid;
    if (!price||price<=0) price=mid;
    if (this._limitMode==='hard_limit'&&this._limitPrice>0){if(this.side==='BUY'&&price>this._limitPrice)return;if(this.side==='SELL'&&price<this._limitPrice)return;}
    this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: size, limitPrice: price, orderType: 'LIMIT', algoType: 'VWAP' });
    this._restingPrice = price; this._chaseAt = 0;
    this.nextSliceAt = Date.now() + this._intervalMs * (1 + _rand(-this._variancePct/100, this._variancePct/100));
    console.log(`[vwap] Slice ${this.slicesFired}/${this.slicesTotal}: size=${size.toFixed(4)} price=${price} vwap=${this.rollingVwap.toFixed(4)} urg=${urg}`);
  }

  protected _onFillExtended(fill: FillData, cappedFill: number) {
    this._chart.recordFill({ time: Date.now(), price: fill.fillPrice, size: cappedFill, side: this.side });
    if (this.rollingVwap > 0) { const dir=this.side==='BUY'?1:-1; this.slippageVsVwap=(this.avgFillPrice-this.rollingVwap)/this.rollingVwap*10000*dir; }
    this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
    if (this._isComplete()) { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); }
  }

  protected _onOrderUpdateExtended(order: OrderUpdate) {
    if (order.orderId !== this.activeChildId) return;
    if (order.state === 'REJECTED') { this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0; }
  }

  protected _strategyState(): Record<string, unknown> {
    const now = Date.now(); const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this._stopped;
    const durMin = this._endTs ? Math.round((this._endTs - this._startTs) / 60000) : '?';
    return {
      summaryLine: `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via VWAP | ${this._vwapMode} | ${this._baseUrgency} | ${durMin} min`,
      vwapMode: this._vwapMode, arrivalVwap: this.arrivalVwap, rollingVwap: this.rollingVwap,
      slippageVsVwap: this.slippageVsVwap, deviationFromVwap: this.deviationFromVwap,
      inParticipationBand: this.inParticipationBand, profileWeight: this.profileWeight,
      currentSlice: this.slicesFired, numSlices: this.slicesTotal,
      nextSliceIn: isDone ? 0 : Math.max(0, this.nextSliceAt - now),
      urgency: this.currentUrgency, chartVwap: this._chart.snapshot().vwap,
    };
  }
}

export function estimateDuration(params: Record<string, unknown>): string {
  const dur = params.durationMinutes || params.duration || '30';
  const mode = params.vwapMode || 'realtime';
  return `~${dur} min — ${mode === 'realtime' ? 'Real-time' : mode === 'benchmark' ? 'Benchmark' : 'Historical'} VWAP`;
}
