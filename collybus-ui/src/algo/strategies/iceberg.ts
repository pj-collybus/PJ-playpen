// @ts-nocheck
/**
 * Iceberg — hides true order size, shows small visible slices.
 * Refactored: extends BaseStrategy.
 */
import { floorToLot } from '../utils/sizeUtils';
import { BaseStrategy } from './baseStrategy';
import type { MarketData, FillData, OrderUpdate, StrategyConfig } from '../types';

export const config: StrategyConfig = {
  name: 'ICEBERG', displayName: 'Iceberg',
  description: 'Show only a small visible quantity — hides true order size from the market',
  params: [
    { key: 'venue',              label: 'Exchange',               type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',          label: 'Start',                  type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'},{value:'trigger',label:'Trigger'}], default: 'immediate' },
    { key: 'startScheduled',     label: 'Start at (15:45 or +10m)', type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'triggerType',        label: 'Trigger type',           type: 'select', options: [{value:'price_above',label:'Price Above'},{value:'price_below',label:'Price Below'}], default: 'price_above', dependsOn: { startMode: 'trigger' } },
    { key: 'triggerValue',       label: 'Trigger value',          type: 'number', default: 0, dependsOn: { startMode: 'trigger' } },
    { key: 'visibleSize',        label: 'Visible size (per slice)', type: 'number', default: 10, min: 0.001 },
    { key: 'visibleVariancePct', label: 'Size variance %',        type: 'number', default: 20, min: 0, max: 50 },
    { key: 'urgency',            label: 'Urgency',                type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'passive' },
    { key: 'minRefreshMs',       label: 'Min refresh delay (ms)', type: 'number', default: 500, min: 0 },
    { key: 'maxRefreshMs',       label: 'Max refresh delay (ms)', type: 'number', default: 3000, min: 0 },
    { key: 'priceChaseEnabled',  label: 'Price chasing',          type: 'select', options: [{value:'true',label:'Enabled'},{value:'false',label:'Disabled'}], default: 'true' },
    { key: 'priceChaseDelayMs',  label: 'Chase delay (ms)',       type: 'number', default: 2000, min: 0, dependsOn: { priceChaseEnabled: 'true' } },
    { key: 'limitMode',          label: 'Limit price',            type: 'select', options: [{value:'none',label:'None'},{value:'hard_limit',label:'Hard Limit'}], default: 'none' },
    { key: 'limitPrice',         label: 'Limit price',            type: 'number', default: 0, dependsOn: { limitMode: 'hard_limit' } },
    { key: 'maxSpreadBps',       label: 'Max spread (bps)',       type: 'number', default: 50 },
  ],
};

export class IcebergStrategy extends BaseStrategy {
  slicesFired = 0; slicesFilled = 0; currentSliceSize = 0; detectionScore = 0;

  private _visibleSize: number; private _visibleVariance: number; private _urgency: string;
  private _minRefreshMs: number; private _maxRefreshMs: number;
  private _chaseEnabled: boolean; private _chaseDelayMs: number;
  private _limitMode: string; private _limitPrice: number;
  private _refreshAt = 0; private _chaseAt = 0;
  private _lastFillTs = 0; private _fillIntervals: number[] = [];

  get type() { return 'ICEBERG'; }

  constructor(params: Record<string, unknown>) {
    super(params, 1800);
    this._visibleSize    = (params.visibleSize as number) || 10;
    this._visibleVariance= (params.visibleVariancePct as number) || 20;
    this._urgency        = (params.urgency as string) || 'passive';
    this._minRefreshMs   = (params.minRefreshMs as number) || 500;
    this._maxRefreshMs   = (params.maxRefreshMs as number) || 3000;
    this._chaseEnabled   = String(params.priceChaseEnabled) !== 'false';
    this._chaseDelayMs   = (params.priceChaseDelayMs as number) || 2000;
    this._limitMode      = (params.limitMode as string) || 'none';
    this._limitPrice     = (params.limitPrice as number) || 0;
  }

  protected _onActivate() {
    this._refreshAt = Date.now(); this.status = 'RUNNING';
    console.log(`[iceberg] Activated: ${this.totalSize} ${this.side} visible=${this._visibleSize}±${this._visibleVariance}% urgency=${this._urgency}`);
  }

  protected _onTick(md: MarketData, bid: number, ask: number, mid: number, now: number) {
    if (this._isComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    this._checkPriceChase(bid, ask, now);
    if (!this.activeChildId && now >= this._refreshAt && this.remainingSize > 0.001) {
      this._placeSlice(bid, ask, mid);
    }
  }

  /** Price chase: cancel and repost when market moves away from our resting price */
  private _checkPriceChase(bid: number, ask: number, now: number) {
    if (!this.activeChildId || !this._chaseEnabled || bid <= 0 || ask <= 0) return;
    const rp = this._restingPrice || 0;
    const movedAway = this.side === 'BUY' ? bid < rp - this._tickSize : ask > rp + this._tickSize;
    const movedBack = this.side === 'BUY' ? bid >= rp : ask <= rp;
    if (movedAway && this._chaseAt === 0) this._chaseAt = now + this._chaseDelayMs;
    else if (movedBack) this._chaseAt = 0;
    if (this._chaseAt > 0 && now >= this._chaseAt) {
      console.log(`[iceberg] Price chasing — reposting at new TOB`);
      this._ctx!.cancelChild(this.activeChildId);
      this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
      this._refreshAt = now; // repost immediately
    }
  }

  /** Place one visible slice with variance and detection-aware sizing */
  private _placeSlice(bid: number, ask: number, mid: number) {
    if (mid <= 0) return;
    // Increase variance automatically when detection risk is high
    const effectiveVariance = this.detectionScore > 70 ? Math.min(50, this._visibleVariance * 1.5) : this._visibleVariance;
    const varianceAmt = this._visibleSize * (effectiveVariance / 100);
    let size = this._visibleSize + (Math.random() * 2 - 1) * varianceAmt;
    size = Math.max(this._lotSize, Math.min(size, this.remainingSize));
    size = Math.max(this._lotSize, Math.min(floorToLot(size, this._lotSize), this.remainingSize));
    this.currentSliceSize = size;

    let price = this._urgency === 'passive' ? (this.side === 'BUY' ? bid : ask) : this._urgency === 'aggressive' ? (this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize) : mid;
    if (!price || price <= 0) price = mid;

    if (this._limitMode === 'hard_limit' && this._limitPrice > 0) {
      if (this.side === 'BUY' && price > this._limitPrice) { this.status = 'PAUSED'; this.pauseReason = `Price > limit`; return; }
      if (this.side === 'SELL' && price < this._limitPrice) { this.status = 'PAUSED'; this.pauseReason = `Price < limit`; return; }
    }

    this.slicesFired++;
    this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: size, limitPrice: price, orderType: 'LIMIT', algoType: 'ICEBERG' });
    this._restingPrice = price; this._chaseAt = 0;
    console.log(`[iceberg] Slice ${this.slicesFired}: size=${size.toFixed(4)} price=${price} detection=${this.detectionScore}`);
  }

  protected _onFillExtended(fill: FillData, cappedFill: number) {
    const now = Date.now();
    this.slicesFilled++;
    this._chart.recordFill({ time: now, price: fill.fillPrice, size: cappedFill, side: this.side });
    // Track fill intervals for detection scoring
    if (this._lastFillTs > 0) {
      this._fillIntervals.push(now - this._lastFillTs);
      if (this._fillIntervals.length > 10) this._fillIntervals.shift();
      this._updateDetectionScore();
    }
    this._lastFillTs = now;
    this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
    // Randomised delay before next slice
    this._refreshAt = now + this._minRefreshMs + Math.random() * (this._maxRefreshMs - this._minRefreshMs);
    if (this._isComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); }
  }

  protected _onOrderUpdateExtended(order: OrderUpdate) {
    if (order.orderId !== this.activeChildId) return;
    if (order.state === 'REJECTED') { this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0; this._refreshAt = Date.now() + 2000; }
    else if (order.state === 'CANCELLED') { this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0; this._refreshAt = Date.now() + 1000; }
  }

  /**
   * Detection risk: low CV (regular fill intervals) = high risk.
   * Score 0-100 where 100 = very regular = high detection risk.
   * Auto-increases variance when score > 70.
   */
  private _updateDetectionScore() {
    if (this._fillIntervals.length < 3) { this.detectionScore = 0; return; }
    const intervals = this._fillIntervals.slice(-5);
    const n = intervals.length;
    const mean = intervals.reduce((s, v) => s + v, 0) / n;
    if (mean === 0) { this.detectionScore = 0; return; }
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const cv = Math.sqrt(variance) / mean;
    this.detectionScore = Math.max(0, Math.min(100, Math.round(100 * (0.2 - cv) / 0.2)));
  }

  protected _strategyState(): Record<string, unknown> {
    const now = Date.now();
    return {
      summaryLine: `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via ICEBERG | ${this._visibleSize} ± ${this._visibleVariance}% per slice | ${this._urgency}`,
      visibleSize: this._visibleSize, visibleVariancePct: this._visibleVariance,
      currentSliceSize: this.currentSliceSize, slicesFired: this.slicesFired, slicesFilled: this.slicesFilled,
      detectionScore: this.detectionScore,
      refreshIn: Math.max(0, this._refreshAt - now),
      chaseIn: Math.max(0, this._chaseAt - now),
      chaseRequired: this._chaseAt > 0,
      urgency: this._urgency, childCount: this.slicesFired,
      timeRemaining: null,
    };
  }
}

export function estimateDuration(params: Record<string, unknown>): string {
  return `Continuous — ${params.visibleSize || 10} ± ${params.visibleVariancePct || 20}% per slice`;
}
