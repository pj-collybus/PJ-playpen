// @ts-nocheck
/**
 * POV — Percentage of Volume
 * Refactored: extends BaseStrategy.
 */
import { BaseStrategy } from './baseStrategy';
import { parseDurationMs } from '../utils/timeUtils';
import type { MarketData, TradeData, FillData, OrderUpdate, StrategyConfig } from '../types';

export const config: StrategyConfig = {
  name: 'POV', displayName: 'POV',
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

export class POVStrategy extends BaseStrategy {
  windowVolume = 0; participationRate = 0;
  private _targetPct: number; private _volumeWindowSec: number;
  private _minChildSize: number; private _maxChildSize: number;
  private _limitMode: string; private _limitPrice: number; private _averageRateLimit: number;
  private _urgency: string; private _endMode: string; private _timeLimitMs: number;
  private _rollingVolume: Array<{size:number;ts:number}> = [];
  private _myRollingFills: Array<{size:number;ts:number}> = [];
  private _myWindowVolume = 0;
  private _catchupTs = 0; private _lastTradeTs = 0; private _childCount = 0;
  private _chartVolBars: number[] = [];

  get type() { return 'POV'; }

  constructor(params: Record<string, unknown>) {
    const tlRaw = (params.timeLimitMinutes || '60') as string|number;
    const tlMs = parseDurationMs(tlRaw);
    const cSec = (params.endMode as string) === 'time_limit' ? Math.round(tlMs/1000) : 3600;
    super(params, Math.min(3600, Math.max(300, cSec + 60)));
    this._targetPct       = (params.targetPct as number) || 10;
    this._volumeWindowSec = (params.volumeWindowSeconds as number) || 30;
    this._minChildSize    = (params.minChildSize as number) || 0;
    this._maxChildSize    = (params.maxChildSize as number) || 0;
    if (!this._minChildSize || this._minChildSize <= 0) this._minChildSize = this._lotSize * 2;
    this._limitMode         = (params.limitMode as string) || 'none';
    this._limitPrice        = (params.limitPrice as number) || 0;
    this._averageRateLimit  = (params.averageRateLimit as number) || 0;
    this._urgency           = (params.urgency as string) || 'neutral';
    this._endMode           = (params.endMode as string) || 'total_filled';
    this._timeLimitMs       = tlMs;
    this._chart.addSeries('volBars');
  }

  protected _onActivate() {
    if (this._endMode === 'time_limit') this._endTs = Date.now() + this._timeLimitMs;
    this.status = 'RUNNING';
    console.log(`[pov] Activated: ${this.totalSize} ${this.side} at ${this._targetPct}% participation window=${this._volumeWindowSec}s`);
  }

  protected _onTick(md: MarketData, bid: number, ask: number, mid: number, now: number) {
    // No-market-trades auto-pause
    if (this.status === 'RUNNING' && this._lastTradeTs > 0 && now - this._lastTradeTs > this._volumeWindowSec * 2000) {
      this.status = 'PAUSED'; this.pauseReason = 'No market volume detected'; return;
    }
    // Auto-resume override (base handles spread; POV also checks trade recency)
    if (this.status === 'PAUSED' && this.pauseReason !== 'manual') {
      const tradeOk = this._lastTradeTs === 0 || now - this._lastTradeTs <= this._volumeWindowSec * 2000;
      if (tradeOk) { this.status = 'RUNNING'; this.pauseReason = null; }
    }
    if (this.status !== 'RUNNING') return;
    if (this._isComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    if (this._endTs && now >= this._endTs) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    // Periodic catch-up every 5s
    if (now - this._catchupTs >= 5000) {
      this._catchupTs = now; this._expireVolume(now);
      const myTarget = this.windowVolume * (this._targetPct / 100);
      const deficit  = myTarget - this._myWindowVolume;
      const minSz    = Math.max(this._minChildSize, this._lotSize);
      if (!this.activeChildId && this.remainingSize > minSz * 0.5) {
        if (this.windowVolume > 0 && deficit >= minSz) { this._fireChild(Math.max(minSz, Math.min(deficit, this.remainingSize)), bid, ask, mid); }
        else if (this._lastTradeTs > 0 && now - this._lastTradeTs > this._volumeWindowSec * 3000) { this._fireChild(Math.min(Math.max(minSz, this.remainingSize * 0.1), this.remainingSize), bid, ask, mid); }
      }
    }
  }

  onTrade(trade: TradeData) {
    if (this.status !== 'RUNNING' || this._stopped) return;
    const now = Date.now(); this._lastTradeTs = now;
    if (!trade.size || trade.size <= 0) return;
    this._rollingVolume.push({ size: trade.size, ts: now });
    this._expireVolume(now);
    const deficit = this.windowVolume * (this._targetPct / 100) - this._myWindowVolume;
    const minSz   = Math.max(this._minChildSize, this._lotSize);
    if (deficit < minSz || this.remainingSize < minSz * 0.5 || this.activeChildId) return;
    const md = this._lastMd; if (!md) return;
    const bid = md.bidPrice||0; const ask = md.askPrice||0; const mid = md.midPrice||(bid&&ask?(bid+ask)/2:0);
    if (mid <= 0) return;
    let sz = Math.max(minSz, Math.min(deficit, this.remainingSize));
    if (this._maxChildSize > 0) sz = Math.min(sz, this._maxChildSize);
    this._fireChild(sz, bid, ask, mid);
  }

  private _fireChild(size: number, bid: number, ask: number, mid: number) {
    let price = this._urgency==='passive'?(this.side==='BUY'?bid:ask):this._urgency==='aggressive'?(this.side==='BUY'?ask+this._tickSize:bid-this._tickSize):mid;
    if (!price||price<=0) price=mid;
    if (this._limitMode==='hard_limit'&&this._limitPrice>0){if(this.side==='BUY'&&price>this._limitPrice)return;if(this.side==='SELL'&&price<this._limitPrice)return;}
    if (this._limitMode==='average_rate'&&this._averageRateLimit>0&&this.avgFillPrice>0){const projAvg=(this.totalNotional+price*size)/(this.filledSize+size);if(this.side==='BUY'&&projAvg>this._averageRateLimit)return;if(this.side==='SELL'&&projAvg<this._averageRateLimit)return;}
    this._childCount++;
    this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: size, limitPrice: price, orderType: 'LIMIT', algoType: 'POV' });
    this._restingPrice = price;
    console.log(`[pov] Child #${this._childCount}: size=${size.toFixed(4)} price=${price} participation=${this.participationRate.toFixed(1)}%`);
  }

  private _expireVolume(now: number) {
    const cutoff = now - this._volumeWindowSec * 1000;
    while (this._rollingVolume.length && this._rollingVolume[0].ts < cutoff) this._rollingVolume.shift();
    while (this._myRollingFills.length && this._myRollingFills[0].ts < cutoff) this._myRollingFills.shift();
    this.windowVolume = this._rollingVolume.reduce((s, v) => s + v.size, 0);
    this._myWindowVolume = this._myRollingFills.reduce((s, v) => s + v.size, 0);
  }

  protected _onFillExtended(fill: FillData, cappedFill: number) {
    this._myRollingFills.push({ size: cappedFill, ts: Date.now() });
    this._expireVolume(Date.now());
    this.participationRate = this.windowVolume > 0 ? (this._myWindowVolume / this.windowVolume) * 100 : 0;
    this._chart.recordFill({ time: Date.now(), price: fill.fillPrice, size: cappedFill, side: this.side });
    this.activeChildId = null; this._restingPrice = null;
    if (this._isComplete()) { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); }
  }

  protected _onOrderUpdateExtended(order: OrderUpdate) {
    if (order.state !== 'REJECTED' || order.orderId !== this.activeChildId) return;
    this.activeChildId = null; this._restingPrice = null;
  }

  protected _strategyState(): Record<string, unknown> {
    const now = Date.now(); const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this._stopped;
    const deficit = this.windowVolume > 0 ? this.windowVolume * (this._targetPct / 100) - this._myWindowVolume : 0;
    return {
      summaryLine: `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via POV | ${this._targetPct}% participation | ${this._volumeWindowSec}s window`,
      targetPct: this._targetPct, windowVolume: this.windowVolume, participationRate: this.participationRate,
      deficit: Math.max(0, deficit), lastTradeAge: this._lastTradeTs ? now - this._lastTradeTs : null,
      childCount: this._childCount, urgency: this._urgency,
      timeRemaining: isDone ? 0 : (this._endTs ? Math.max(0, this._endTs - now) : null),
    };
  }
}

export function estimateDuration(params: Record<string, unknown>): string {
  const pct = params.targetPct || 10;
  if (params.endMode === 'time_limit') return `Runs for ${params.timeLimitMinutes || '60'} min at ${pct}% participation`;
  return `Market-paced — completes when ${params.totalSize || '?'} filled at ${pct}%`;
}
