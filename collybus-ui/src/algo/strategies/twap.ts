// @ts-nocheck
/**
 * TWAP — Time-Weighted Average Price
 * Refactored: extends BaseStrategy, decomposed into focused methods.
 */

import { parseTime, parseDurationMs } from '../utils/timeUtils';
import { BaseStrategy } from './baseStrategy';
import type { MarketData, FillData, OrderUpdate, StrategyConfig } from '../types';

export const config: StrategyConfig = {
  name: 'TWAP', displayName: 'TWAP',
  description: 'Time-weighted average price execution',
  params: [
    { key: 'venue',               label: 'Exchange',               type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',           label: 'Start',                  type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'},{value:'trigger',label:'Trigger'}], default: 'immediate' },
    { key: 'startScheduled',      label: 'Start at (15:45 or +10m)', type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'triggerType',         label: 'Trigger type',           type: 'select', options: [{value:'price_above',label:'Price Above'},{value:'price_below',label:'Price Below'}], default: 'price_above', dependsOn: { startMode: 'trigger' } },
    { key: 'triggerValue',        label: 'Trigger value',          type: 'number', default: 0, dependsOn: { startMode: 'trigger' } },
    { key: 'durationMode',        label: 'Duration',               type: 'select', options: [{value:'minutes',label:'Minutes'},{value:'until_time',label:'Until Time'}], default: 'minutes' },
    { key: 'durationMinutes',     label: 'Duration (minutes)',     type: 'number', default: 30, min: 1, dependsOn: { durationMode: 'minutes' } },
    { key: 'endTime',             label: 'End at (e.g. 16:00)',    type: 'text', default: '', dependsOn: { durationMode: 'until_time' } },
    { key: 'amountMode',          label: 'Amount in',              type: 'select', options: [{value:'base',label:'Base Currency'},{value:'terms',label:'Terms (USD)'}], default: 'base' },
    { key: 'slicesMode',          label: 'Slices',                 type: 'select', options: [{value:'auto',label:'Auto'},{value:'manual',label:'Manual'}], default: 'auto' },
    { key: 'numSlices',           label: 'Number of slices',       type: 'number', default: 10, min: 2, max: 500, dependsOn: { slicesMode: 'manual' } },
    { key: 'scheduleVariancePct', label: 'Timing randomisation %', type: 'number', default: 10, min: 0, max: 50 },
    { key: 'limitMode',           label: 'Limit price',            type: 'select', options: [{value:'none',label:'None'},{value:'market_limit',label:'Market Limit'},{value:'average_rate',label:'Average Rate'}], default: 'none' },
    { key: 'limitPrice',          label: 'Limit price',            type: 'number', default: 0, dependsOn: { limitMode: 'market_limit' } },
    { key: 'averageRateLimit',    label: 'Max average rate',       type: 'number', default: 0, dependsOn: { limitMode: 'average_rate' } },
    { key: 'urgency',             label: 'Urgency',                type: 'select', options: [{value:'passive',label:'Passive — post then cross'},{value:'aggressive',label:'Aggressive — cross immediately'}], default: 'passive' },
    { key: 'maxParticipationPct', label: 'Max participation %',    type: 'number', default: 15, min: 1, max: 100 },
    { key: 'maxSpreadBps',        label: 'Max spread (bps)',       type: 'number', default: 50, min: 0 },
  ],
};

function _rand(min: number, max: number) { return min + Math.random() * (max - min); }

export class TWAPStrategy extends BaseStrategy {
  slicesFired = 0;
  slicesTotal = 0;
  nextSliceAt = 0;
  rollingVwap = 0;
  slippageVsVwap = 0;

  private _durationMode: string;
  private _durationMin: number;
  private _endTimeStr: string;
  private _amountMode: string;
  private _rawSize: number;
  private _slicesMode: string;
  private _manualSlices: number;
  private _variancePct: number;
  private _limitMode: string;
  private _limitPrice: number;
  private _averageRateLimit: number;
  private _urgency: string;
  private _intervalMs = 0;
  private _rollingVwapNot = 0;
  private _rollingVwapQty = 0;
  private _chaseDeadline = 0;
  private _completingDeadline = 0;
  private _retryAt = 0;
  private _retrySliceSize = 0;
  private _rejectCount = 0;
  private _sliceStartTs = 0;
  private _sliceDeadlineTs = 0;
  private _sliceCrossed = false;

  get type() { return 'TWAP'; }

  constructor(params: Record<string, unknown>) {
    const dMin = (params.durationMinutes as number) || 30;
    super(params, Math.min(3600, Math.max(300, dMin * 60 + 60)));
    this._durationMode      = (params.durationMode as string) || 'minutes';
    this._durationMin       = dMin;
    this._endTimeStr        = (params.endTime as string) || '';
    this._amountMode        = (params.amountMode as string) || 'base';
    this._rawSize           = (params.totalSize as number) || 0;
    this._slicesMode        = (params.slicesMode as string) || 'auto';
    this._manualSlices      = (params.numSlices as number) || 10;
    this._variancePct       = (params.scheduleVariancePct as number) || 10;
    this._limitMode         = (params.limitMode as string) || 'none';
    this._limitPrice        = (params.limitPrice as number) || 0;
    this._averageRateLimit  = (params.averageRateLimit as number) || 0;
    this._urgency           = (params.urgency as string) || 'passive';
  }

  protected _onActivate() {
    // Terms mode: convert USD amount to base using arrival price
    if (this._amountMode === 'terms' && this.arrivalPrice > 0) {
      this.totalSize = this._rawSize / this.arrivalPrice;
      this.remainingSize = this.totalSize;
    }
    // Calculate end time
    if (this._durationMode === 'until_time') {
      const endTs = parseTime(this._endTimeStr);
      this._endTs = endTs || (Date.now() + this._durationMin * 60000);
    } else {
      this._endTs = Date.now() + this._durationMin * 60000;
    }
    const durationMs = this._endTs - Date.now();
    this.slicesTotal = this._slicesMode === 'auto'
      ? Math.max(2, Math.min(500, Math.round(durationMs / 60000)))
      : Math.max(2, Math.min(500, this._manualSlices));
    this._intervalMs = durationMs / this.slicesTotal;
    this.nextSliceAt = Date.now();
    this.status = 'RUNNING';
    console.log(`[twap] Activated: ${this.totalSize} ${this.side} in ${this.slicesTotal} slices over ${Math.round(durationMs/60000)}min urgency=${this._urgency}`);
  }

  protected _onTick(md: MarketData, bid: number, ask: number, mid: number, now: number) {
    this._checkAverageRateLimit();
    this._autoResume(md, mid);
    if (this.status !== 'RUNNING') return;
    if (this._isComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    if (this._checkWindowEnd(bid, ask, now)) return;
    if (this._checkCompleting(now)) return;
    this._checkPassiveCross(bid, ask, now);
    this._checkChase(bid, ask, now);
    this._checkEscalation(now);
    this._checkRetryOrSchedule(bid, ask, mid, now);
  }

  private _checkAverageRateLimit() {
    if (this.status !== 'RUNNING') return;
    if (this._limitMode === 'average_rate' && this._averageRateLimit > 0 && this.avgFillPrice > 0) {
      const breached = this.side === 'BUY' ? this.avgFillPrice > this._averageRateLimit : this.avgFillPrice < this._averageRateLimit;
      if (breached) { this.status = 'PAUSED'; this.pauseReason = `Avg rate breached limit`; }
    }
  }

  private _autoResume(md: MarketData, mid: number) {
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      const spreadOk = !mid || md.spreadBps <= this._maxSpreadBps;
      if (spreadOk) { this.status = 'RUNNING'; this.pauseReason = null; }
    }
  }

  private _checkWindowEnd(bid: number, ask: number, now: number): boolean {
    if (now < this._endTs || (this.status !== 'RUNNING' && this.status !== 'PAUSED')) return false;
    if (this.activeChildId) { this._ctx!.cancelChild(this.activeChildId); this.activeChildId = null; this._restingPrice = null; this._chaseDeadline = 0; }
    if (this.remainingSize > 0 && bid > 0 && ask > 0) {
      const sweep = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: this.remainingSize, limitPrice: sweep, orderType: 'LIMIT', algoType: 'TWAP-SWEEP' });
      this._restingPrice = sweep; this.status = 'COMPLETING'; this._completingDeadline = now + 10000;
    } else { this.status = 'COMPLETED'; this.stop(); }
    return true;
  }

  private _checkCompleting(now: number): boolean {
    if (this.status !== 'COMPLETING') return false;
    if (now > this._completingDeadline) { this.status = 'COMPLETED'; this.stop(); }
    return true;
  }

  private _checkPassiveCross(bid: number, ask: number, now: number) {
    if (this._urgency !== 'passive' || !this.activeChildId || this._sliceCrossed) return;
    if (this._sliceDeadlineTs <= 0 || now < this._sliceDeadlineTs || bid <= 0 || ask <= 0) return;
    this._ctx!.cancelChild(this.activeChildId); this.activeChildId = null; this._sliceCrossed = true;
    const crossPrice = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
    const crossQty = Math.min(this.remainingSize, this.totalSize / Math.max(1, this.slicesTotal));
    if (crossQty > 0.001) {
      this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: crossQty, limitPrice: crossPrice, orderType: 'LIMIT', algoType: 'TWAP-CROSS' });
      this._restingPrice = crossPrice;
    }
  }

  private _checkChase(bid: number, ask: number, now: number) {
    if (!this.activeChildId || bid <= 0 || ask <= 0) return;
    if (this._urgency !== 'aggressive' && !this._sliceCrossed) return;
    const rp = this._restingPrice || 0;
    const moved = this.side === 'BUY' ? bid > rp * 1.0001 : ask < rp * 0.9999;
    if (moved && this._chaseDeadline === 0) this._chaseDeadline = now + _rand(3000, 7000);
    else if (this._chaseDeadline > 0 && now >= this._chaseDeadline) {
      this._ctx!.cancelChild(this.activeChildId); this.activeChildId = null; this._chaseDeadline = 0; this._restingPrice = null;
    }
  }

  private _checkEscalation(now: number) {
    const timeRemaining = this._endTs - now;
    const totalDuration = this._endTs - this._startTs;
    if (timeRemaining > 0 && timeRemaining < totalDuration * 0.1 && this.remainingSize > 0 && this._urgency !== 'aggressive' && this.activeChildId) {
      this._ctx!.cancelChild(this.activeChildId); this.activeChildId = null; this._restingPrice = null; this._chaseDeadline = 0; this._urgency = 'aggressive';
    }
  }

  private _checkRetryOrSchedule(bid: number, ask: number, mid: number, now: number) {
    if (this._retryAt > 0 && now >= this._retryAt && !this.activeChildId && this.remainingSize > 0.001) {
      this._retryAt = 0; this._fireSlice(bid, ask, mid, this._retrySliceSize);
    } else if (now >= this.nextSliceAt && !this.activeChildId && this.remainingSize > 0.001 && this._retryAt === 0 && this.slicesFired < this.slicesTotal) {
      this._rejectCount = 0; this._fireSlice(bid, ask, mid);
    }
  }

  private _fireSlice(bid: number, ask: number, mid: number, overrideSize?: number) {
    if (this.remainingSize <= 0 || mid <= 0) return;
    this.slicesFired++;
    let sliceSize = overrideSize && overrideSize > 0
      ? Math.min(overrideSize, this.remainingSize)
      : Math.min(this.remainingSize / Math.max(1, this.slicesTotal - this.slicesFired + 1), this.remainingSize);
    if (sliceSize <= 0) return;
    if (this._limitMode === 'market_limit' && this._limitPrice > 0) {
      if (this.side === 'BUY' && mid > this._limitPrice) { this._scheduleNext(); return; }
      if (this.side === 'SELL' && mid < this._limitPrice) { this._scheduleNext(); return; }
    }
    let price = this._urgency === 'aggressive' ? (this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize) : (this.side === 'BUY' ? bid : ask);
    if (!price || price <= 0) price = mid;
    this._sliceStartTs = Date.now(); this._sliceDeadlineTs = this._sliceStartTs + this._intervalMs * 0.8; this._sliceCrossed = false;
    this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: sliceSize, limitPrice: price, orderType: 'LIMIT', algoType: 'TWAP' });
    this._restingPrice = price; this._chaseDeadline = 0;
    console.log(`[twap] Slice ${this.slicesFired}/${this.slicesTotal}: size=${sliceSize.toFixed(4)} price=${price}`);
    this._scheduleNext();
  }

  private _scheduleNext() {
    const jitter = 1 + _rand(-this._variancePct / 100, this._variancePct / 100);
    this.nextSliceAt = Date.now() + this._intervalMs * jitter;
  }

  protected _onFillExtended(fill: FillData, cappedFill: number) {
    this._chart.recordFill({ time: Date.now(), price: fill.fillPrice, size: cappedFill, side: this.side });
    this._rollingVwapNot += fill.fillPrice * cappedFill; this._rollingVwapQty += cappedFill;
    this.rollingVwap = this._rollingVwapQty > 0 ? this._rollingVwapNot / this._rollingVwapQty : 0;
    if (this.rollingVwap > 0) { const dir = this.side === 'BUY' ? 1 : -1; this.slippageVsVwap = (this.avgFillPrice - this.rollingVwap) / this.rollingVwap * 10000 * dir; }
    this.activeChildId = null; this._chaseDeadline = 0;
    if (this._isComplete()) { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); }
  }

  protected _onOrderUpdateExtended(order: OrderUpdate) {
    if (order.state !== 'REJECTED') return;
    if (order.orderId !== this.activeChildId && order.intentId !== this.activeChildId) return;
    if (this.status === 'COMPLETING') { this.activeChildId = null; this.status = 'COMPLETED'; this.stop(); return; }
    if (this.slicesFired > 0) this.slicesFired--;
    this._retrySliceSize = (order as any).quantity || this.remainingSize / Math.max(1, this.slicesTotal - this.slicesFired);
    this.activeChildId = null; this._restingPrice = null; this._chaseDeadline = 0;
    const reason = ((order as any).rejectReason || '').toLowerCase();
    if (reason.includes('insufficient') || reason.includes('balance') || reason.includes('margin')) { this.status = 'PAUSED'; this.pauseReason = `Insufficient balance`; this._retryAt = 0; this._rejectCount = 0; }
    else if (reason.includes('rate') || reason.includes('throttl')) { this._retryAt = Date.now() + 5000; this._rejectCount = 0; }
    else { this._rejectCount++; if (this._rejectCount >= 3) { this.status = 'PAUSED'; this.pauseReason = `3 consecutive rejections`; this._retryAt = 0; this._rejectCount = 0; } else this._retryAt = Date.now() + 2000; }
  }

  protected _strategyState(): Record<string, unknown> {
    const now = Date.now(); const isDone = this.status === 'COMPLETING' || this.status === 'COMPLETED' || this._stopped;
    const durMin = this._endTs ? Math.round((this._endTs - this._startTs) / 60000) : '?';
    return {
      summaryLine: `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via TWAP | ${this._urgency} | ${durMin} min | ${this.slicesTotal} slices`,
      rollingVwap: this.rollingVwap, slippageVsVwap: this.slippageVsVwap,
      currentSlice: this.slicesFired, numSlices: this.slicesTotal,
      nextSliceIn: isDone ? 0 : Math.max(0, this.nextSliceAt - now),
      urgency: this._urgency, sliceCrossed: this._sliceCrossed,
      startMode: (this as any)._startMode, amountMode: this._amountMode, limitMode: this._limitMode,
      maxParticipationPct: 15, chartSampleMs: this._chart.sampleMs,
    };
  }
}

export function estimateDuration(params: Record<string, unknown>): string {
  if (params.durationMode === 'until_time' && params.endTime) {
    const endTs = parseTime(params.endTime as string);
    if (endTs) { const mins = Math.round((endTs - Date.now()) / 60000); return `Until ${params.endTime} (~${mins} min)`; }
  }
  const mins = (params.durationMinutes as number) || 30;
  const slices = params.slicesMode === 'manual' ? ((params.numSlices as number) || 10) : Math.max(2, mins);
  return `~${mins} min in ~${slices} slices`;
}
