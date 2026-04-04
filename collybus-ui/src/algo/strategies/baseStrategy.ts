// @ts-nocheck
/**
 * BaseStrategy — shared base class for all algo strategies.
 *
 * Handles the concerns common to every strategy so individual strategies
 * only implement their unique execution logic:
 *   - Fill accounting (filledSize, avgFillPrice, slippage)
 *   - Arrival price capture
 *   - Scheduled / trigger start modes
 *   - Spread auto-pause / auto-resume
 *   - Completion and stop guards
 *   - Chart collection
 *   - getState() common fields
 *
 * Subclasses implement:
 *   - _onActivate()   — called once when strategy becomes active
 *   - _onTick()       — called each market data tick (after guards pass)
 *   - _strategyState() — returns strategy-specific state fields
 */

import { parseTime } from '../utils/timeUtils';
import { ChartCollector } from '../utils/chartCollector';
import type {
  IStrategy, StrategyContext, MarketData, FillData, OrderUpdate,
  TradeData, StrategyStatus,
} from '../types';

export abstract class BaseStrategy implements IStrategy {
  // ── IStrategy public fields ──────────────────────────────────────────────
  symbol: string;
  side: 'BUY' | 'SELL';
  venue: string;
  totalSize: number;
  filledSize = 0;
  remainingSize: number;
  avgFillPrice = 0;
  totalNotional = 0;
  arrivalPrice = 0;
  slippageVsArrival = 0;
  status: StrategyStatus = 'WAITING';
  pauseReason: string | null = null;
  activeChildId: string | null = null;

  // ── Shared internals ─────────────────────────────────────────────────────
  protected _tickSize: number;
  protected _lotSize: number;
  protected _maxSpreadBps: number;
  protected _ctx: StrategyContext | null = null;
  protected _stopped = false;
  protected _activated = false;
  protected _startTs = 0;
  protected _endTs = 0;
  _completedTs = 0;
  protected _lastMd: MarketData | null = null;
  protected _chart: ChartCollector;
  protected _restingPrice: number | null = null;

  // Start mode
  private _startMode: string;
  private _startScheduled: string;
  private _triggerType: string;
  private _triggerValue: number;
  private _startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(params: Record<string, unknown>, chartMaxPts?: number) {
    this.symbol    = params.symbol as string;
    this.side      = params.side as 'BUY' | 'SELL';
    this.venue     = (params.venue as string) || 'Deribit';
    this.totalSize = (params.totalSize as number) || 0;
    this.remainingSize = this.totalSize;

    this._tickSize     = (params.tickSize as number) || 0.0001;
    this._lotSize      = (params.lotSize as number) || 1;
    this._maxSpreadBps = (params.maxSpreadBps as number) || 50;

    this._startMode      = (params.startMode as string) || 'immediate';
    this._startScheduled = (params.startScheduled as string) || '';
    this._triggerType    = (params.triggerType as string) || 'price_above';
    this._triggerValue   = (params.triggerValue as number) || 0;

    this._chart = this._buildChart(params, chartMaxPts);
  }

  // ── Subclasses override these ────────────────────────────────────────────

  /** Called once when the strategy transitions to RUNNING */
  protected abstract _onActivate(): void;

  /** Called each tick after all base guards have passed */
  protected abstract _onTick(md: MarketData, bid: number, ask: number, mid: number, now: number): void;

  /** Strategy-specific fields merged into getState() */
  protected abstract _strategyState(): Record<string, unknown>;

  /** Override to handle fills beyond base accounting */
  protected _onFillExtended(_fill: FillData, _cappedFill: number): void {}

  /** Override to handle order updates */
  protected _onOrderUpdateExtended(_order: OrderUpdate): void {}

  /** Override to handle trade data */
  onTrade?(_trade: TradeData): void;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(ctx: StrategyContext) {
    this._ctx = ctx;

    if (this._startMode === 'scheduled') {
      const ts = parseTime(this._startScheduled);
      if (ts && ts > Date.now()) {
        this.status = 'WAITING';
        this._startTimer = setTimeout(() => this._activate(), ts - Date.now());
        console.log(`[${this.type}] Scheduled start at ${new Date(ts).toLocaleTimeString()}`);
        return;
      }
    }

    if (this._startMode === 'trigger') {
      this.status = 'WAITING';
      console.log(`[${this.type}] Waiting for trigger: ${this._triggerType} ${this._triggerValue}`);
      return;
    }

    this._activate();
  }

  protected _activate() {
    if (this._stopped || this._activated) return;
    this._activated = true;
    this._startTs = Date.now();

    // Capture arrival price from last known market data
    if (this.arrivalPrice === 0 && this._lastMd) {
      const m = this._lastMd.midPrice ||
        ((this._lastMd.bidPrice || 0) + (this._lastMd.askPrice || 0)) / 2;
      if (m > 0) this.arrivalPrice = m;
    }

    this._onActivate();
  }

  pause() {
    if (this.status === 'RUNNING') { this.status = 'PAUSED'; this.pauseReason = 'manual'; }
  }

  resume() {
    if (this.status === 'PAUSED') { this.status = 'RUNNING'; this.pauseReason = null; }
  }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    if (this._startTimer) { clearTimeout(this._startTimer); this._startTimer = null; }
    this._cancelActive();
    if (this.status !== 'COMPLETED') this.status = 'STOPPED';
  }

  /** Cancel the current active child order — subclasses can override for multi-child strategies */
  protected _cancelActive() {
    if (this.activeChildId) {
      this._ctx?.cancelChild(this.activeChildId);
      this.activeChildId = null;
    }
  }

  // ── Tick ─────────────────────────────────────────────────────────────────

  onTick(md: MarketData) {
    this._lastMd = md;

    // Capture arrival price on first tick
    if (this.arrivalPrice === 0) {
      const m = md.midPrice || ((md.bidPrice || 0) + (md.askPrice || 0)) / 2;
      if (m > 0) this.arrivalPrice = m;
    }

    // Trigger check
    if (this.status === 'WAITING' && this._startMode === 'trigger') {
      this._checkTrigger(md);
      return;
    }

    if (this.status === 'WAITING' || this._stopped) return;

    const now = Date.now();
    const bid = md.bidPrice || 0;
    const ask = md.askPrice || 0;
    const mid = md.midPrice || (bid && ask ? (bid + ask) / 2 : 0);
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED';

    // Chart sampling
    this._chart.autoScale(now - this._startTs);
    this._chart.sample(bid, ask, this._restingPrice, isDone, this._chartExtras(mid));

    if (isDone || this.status === 'PAUSED') return;

    // Spread auto-pause / auto-resume
    if (this.status === 'RUNNING' && mid > 0 && md.spreadBps > this._maxSpreadBps) {
      this.status = 'PAUSED';
      this.pauseReason = `Spread ${md.spreadBps.toFixed(0)}bps > ${this._maxSpreadBps}bps`;
      return;
    }
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      if (!mid || md.spreadBps <= this._maxSpreadBps) {
        this.status = 'RUNNING'; this.pauseReason = null;
      }
    }
    if (this.status !== 'RUNNING') return;

    this._onTick(md, bid, ask, mid, now);
  }

  /** Override to provide extra series values to ChartCollector */
  protected _chartExtras(_mid: number): Record<string, number | null> { return {}; }

  // ── Fill accounting ───────────────────────────────────────────────────────

  onFill(fill: FillData) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    if (this.status === 'COMPLETED' || this.status === 'STOPPED') return;

    // Cap to remaining — never overfill
    const cappedFill = Math.min(fill.fillSize, Math.max(0, this.totalSize - this.filledSize));
    if (cappedFill <= 0) return;

    this.filledSize    += cappedFill;
    this.remainingSize  = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * cappedFill;
    this.avgFillPrice   = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;

    if (this.arrivalPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.slippageVsArrival =
        (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    }

    this._onFillExtended(fill, cappedFill);
  }

  onOrderUpdate(order: OrderUpdate) {
    this._onOrderUpdateExtended(order);
  }

  // ── Trigger logic ─────────────────────────────────────────────────────────

  private _checkTrigger(md: MarketData) {
    const px = md.midPrice || md.lastPrice || 0;
    if (this._triggerType === 'price_above' && px > this._triggerValue) {
      console.log(`[${this.type}] Trigger fired: price ${px} > ${this._triggerValue}`);
      this._activate();
    } else if (this._triggerType === 'price_below' && px > 0 && px < this._triggerValue) {
      console.log(`[${this.type}] Trigger fired: price ${px} < ${this._triggerValue}`);
      this._activate();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  protected _isComplete(): boolean {
    return this.filledSize >= this.totalSize - (this._lotSize || 0.001);
  }

  protected _formatSize(v: number): string {
    return Number(v).toFixed(4).replace(/\.?0+$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ── State ─────────────────────────────────────────────────────────────────

  getState(): Record<string, unknown> {
    const now = Date.now();
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this._stopped;
    const totalDuration = this._endTs && this._startTs ? this._endTs - this._startTs : 0;
    let elapsed = 0;
    if (this._startTs) {
      if (isDone && this._completedTs) elapsed = Math.min(this._completedTs - this._startTs, totalDuration || Infinity);
      else if (isDone) elapsed = totalDuration;
      else elapsed = now - this._startTs;
    }

    const chart = this._chart.snapshot();

    return {
      // Identity
      type: this.type, symbol: this.symbol, side: this.side, venue: this.venue,
      // Execution state
      status: this.status, pauseReason: this.pauseReason,
      // Fill accounting
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival,
      // Timing
      elapsed,
      timeRemaining: isDone ? 0 : (this._endTs ? Math.max(0, this._endTs - now) : null),
      // Config
      tickSize: this._tickSize,
      activeOrderPrice: this._restingPrice,
      // Chart
      maxChartPoints: this._chart.maxPts,
      chartSampleMs: this._chart.sampleMs,
      chartBids: chart.bids, chartAsks: chart.asks,
      chartOrder: chart.order, chartTimes: chart.times,
      chartFills: chart.fills,
      // Strategy-specific
      ...this._strategyState(),
    };
  }

  abstract get type(): string;

  // ── Chart builder ─────────────────────────────────────────────────────────

  private _buildChart(params: Record<string, unknown>, maxPts?: number): ChartCollector {
    const durationMin = (params.durationMinutes as number) || 30;
    const pts = maxPts ?? Math.min(3600, Math.max(300, durationMin * 60 + 60));
    return new ChartCollector(1000, pts);
  }
}
