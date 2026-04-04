// @ts-nocheck
/**
 * IS — Implementation Shortfall (Almgren-Chriss simplified)
 * Refactored: extends BaseStrategy.
 */
import { floorToLot } from '../utils/sizeUtils';
import { parseDurationMs } from '../utils/timeUtils';
import { BaseStrategy } from './baseStrategy';
import type { MarketData, TradeData, FillData, OrderUpdate, StrategyConfig } from '../types';

export const config: StrategyConfig = {
  name: 'IS', displayName: 'Impl. Shortfall',
  description: 'Minimises total execution cost by balancing market impact vs timing risk',
  params: [
    { key: 'venue',                      label: 'Exchange',           type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'startMode',                  label: 'Start',              type: 'select', options: [{value:'immediate',label:'Immediate'},{value:'scheduled',label:'Scheduled'}], default: 'immediate' },
    { key: 'startScheduled',             label: 'Start at',           type: 'text', default: '', dependsOn: { startMode: 'scheduled' } },
    { key: 'urgencyBias',                label: 'Urgency bias',       type: 'select', options: [{value:'risk_averse',label:'Risk Averse — faster'},{value:'balanced',label:'Balanced'},{value:'cost_averse',label:'Cost Averse — slower'}], default: 'balanced' },
    { key: 'urgency',                    label: 'Urgency',            type: 'select', options: [{value:'passive',label:'Passive'},{value:'neutral',label:'Neutral'},{value:'aggressive',label:'Aggressive'}], default: 'neutral' },
    { key: 'maxSpreadBps',               label: 'Max spread (bps)',   type: 'number', default: 50 },
    { key: 'riskAversion',               label: 'Risk aversion (λ)',  type: 'number', default: 0.5, min: 0.1, max: 2.0 },
    { key: 'volatilityLookbackMinutes',  label: 'Vol lookback (mins)',type: 'number', default: 10, min: 1 },
    { key: 'marketImpactCoeff',          label: 'Impact coefficient', type: 'number', default: 0.1, min: 0.01, max: 1.0 },
    { key: 'limitMode',                  label: 'Limit price',        type: 'select', options: [{value:'none',label:'None'},{value:'hard_limit',label:'Hard Limit'}], default: 'none' },
    { key: 'limitPrice',                 label: 'Limit price',        type: 'number', default: 0, dependsOn: { limitMode: 'hard_limit' } },
  ],
};

const BIAS_MULT: Record<string, number> = { risk_averse: 2.0, balanced: 1.0, cost_averse: 0.5 };
function _rand(a: number, b: number) { return a + Math.random() * (b - a); }

export class ISStrategy extends BaseStrategy {
  decisionPrice = 0; currentVwap = 0; estimatedVolatility = 0; optimalRate = 0.5;
  currentUrgency: string; timingCost = 0; marketImpactCost = 0; totalIsCost = 0;
  slicesFired = 0; nextSliceAt = 0;

  private _urgencyBias: string; private _baseUrgency: string; private _riskAversion: number;
  private _volLookbackMs: number; private _impactCoeff: number; private _limitMode: string;
  private _limitPrice: number; private _lotSize: number; private _durationMs: number;
  private _priceReturns: number[] = []; private _prevMid = 0;
  private _vwapNotional = 0; private _vwapVolume = 0;
  private _chaseAt = 0; private _completingDeadline = 0;

  get type() { return 'IS'; }

  constructor(params: Record<string, unknown>) {
    const dMs = parseDurationMs((params.durationMinutes || params.duration || '30') as string|number);
    super(params, Math.min(3600, Math.max(300, Math.round(dMs/1000) + 60)));
    this._urgencyBias  = (params.urgencyBias as string) || 'balanced';
    this._baseUrgency  = (params.urgency as string) || 'neutral'; this.currentUrgency = this._baseUrgency;
    this._riskAversion = (params.riskAversion as number) || 0.5;
    this._volLookbackMs= ((params.volatilityLookbackMinutes as number) || 10) * 60000;
    this._impactCoeff  = (params.marketImpactCoeff as number) || 0.1;
    this._limitMode    = (params.limitMode as string) || 'none';
    this._limitPrice   = (params.limitPrice as number) || 0;
    this._lotSize      = (params.lotSize as number) || 1;
    this._durationMs   = dMs;
    this._chart.addSeries('vwap').addSeries('decision');
  }

  protected _onActivate() {
    this._endTs = Date.now() + this._durationMs;
    if (this._lastMd) { const m=this._lastMd.midPrice||((this._lastMd.bidPrice||0)+(this._lastMd.askPrice||0))/2; if(m>0)this.decisionPrice=m; }
    this.nextSliceAt = Date.now(); this.status = 'RUNNING';
    console.log(`[is] Activated: ${this.totalSize} ${this.side} λ=${this._riskAversion} bias=${this._urgencyBias}`);
  }

  onTrade(trade: TradeData) {
    if (!trade.size||trade.size<=0) return;
    this._vwapNotional+=trade.price*trade.size; this._vwapVolume+=trade.size;
    this.currentVwap=this._vwapVolume>0?this._vwapNotional/this._vwapVolume:0;
  }

  protected _chartExtras(_mid: number): Record<string, number | null> {
    return { vwap: this.currentVwap || null, decision: this.decisionPrice || null };
  }

  protected _onTick(md: MarketData, bid: number, ask: number, mid: number, now: number) {
    if (this.decisionPrice === 0 && mid > 0) this.decisionPrice = mid;
    if (this.status === 'COMPLETING') { if (now>this._completingDeadline||!this.activeChildId){this._completedTs=now;this.status='COMPLETED';this.stop();} return; }
    if (now>=this._endTs&&(this.status==='RUNNING'||this.status==='PAUSED')){this._sweep(bid,ask,now);return;}
    this._updateVolatility(mid);
    this._updateISCosts(mid);
    this._calcOptimalRate();
    if (this.status !== 'RUNNING') return;
    if (this._isComplete()) { this._completedTs=now; this.status='COMPLETED'; this.stop(); return; }
    this._checkChase(bid, ask, now);
    if (!this.activeChildId && now >= this.nextSliceAt && this.remainingSize > 0.001) this._fireSlice(bid, ask, mid);
  }

  private _updateVolatility(mid: number) {
    if (mid > 0 && this._prevMid > 0) {
      this._priceReturns.push((mid - this._prevMid) / this._prevMid);
      const max = Math.round(this._volLookbackMs / 1000);
      while (this._priceReturns.length > max) this._priceReturns.shift();
      if (this._priceReturns.length >= 5) {
        const n=this._priceReturns.length; const mean=this._priceReturns.reduce((s,v)=>s+v,0)/n;
        this.estimatedVolatility = Math.sqrt(this._priceReturns.reduce((s,v)=>s+(v-mean)**2,0)/n) * Math.sqrt(3600);
      }
    }
    this._prevMid = mid;
  }

  private _updateISCosts(mid: number) {
    if (this.decisionPrice <= 0 || mid <= 0) return;
    const dir = this.side === 'BUY' ? 1 : -1;
    this.timingCost = (mid - this.decisionPrice) / this.decisionPrice * 10000 * dir;
    if (this.filledSize > 0 && this.avgFillPrice > 0) this.marketImpactCost = (this.avgFillPrice - this.decisionPrice) / this.decisionPrice * 10000 * dir;
    this.totalIsCost = this.timingCost + this.marketImpactCost;
  }

  private _calcOptimalRate() {
    if (this.estimatedVolatility > 0) {
      const lambda = this._riskAversion * (BIAS_MULT[this._urgencyBias] || 1.0);
      this.optimalRate = Math.min(0.95, Math.max(0.05, Math.sqrt(lambda * this.estimatedVolatility**2 / (2 * this._impactCoeff))));
    }
    this.currentUrgency = this.optimalRate < 0.25 ? 'passive' : this.optimalRate > 0.60 ? 'aggressive' : 'neutral';
  }

  private _sweep(bid: number, ask: number, now: number) {
    if (this.activeChildId) { this._ctx!.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this.remainingSize > 0.001 && bid > 0 && ask > 0) {
      const sweep = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: this.remainingSize, limitPrice: sweep, orderType: 'LIMIT', algoType: 'IS-SWEEP' });
      this._restingPrice = sweep; this.status = 'COMPLETING'; this._completingDeadline = now + 10000;
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
    const elapsed = 1 - (Math.max(1000, this._endTs - Date.now()) / (this._endTs - this._startTs));
    const effectiveRate = this.slicesFired === 1 ? Math.min(this.optimalRate, 0.5) : this.optimalRate;
    const minSlices = Math.max(5, Math.round(this.totalSize / (this._lotSize * 5)));
    let size = this.totalSize / minSlices * Math.max(0.1, effectiveRate * 2);
    if (elapsed < 0.5) size = Math.min(size, this.totalSize / 5);
    if (this.remainingSize > this._lotSize * 2) size = Math.min(size, this.remainingSize / 2);
    size = Math.max(this._lotSize, Math.min(floorToLot(size, this._lotSize), this.remainingSize));
    let price = this.currentUrgency === 'passive' ? (this.side === 'BUY' ? bid : ask) : this.currentUrgency === 'aggressive' ? (this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize) : mid;
    if (!price || price <= 0) price = mid;
    if (this._limitMode === 'hard_limit' && this._limitPrice > 0) { if (this.side==='BUY'&&price>this._limitPrice) return; if (this.side==='SELL'&&price<this._limitPrice) return; }
    this.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: size, limitPrice: price, orderType: 'LIMIT', algoType: 'IS' });
    this._restingPrice = price; this._chaseAt = 0;
    this.nextSliceAt = Date.now() + Math.max(5000, 60000 / Math.max(0.1, this.optimalRate)) * (1 + (Math.random() * 2 - 1) * 0.1);
    console.log(`[is] Slice ${this.slicesFired}: size=${size.toFixed(4)} rate=${(this.optimalRate*100).toFixed(0)}% urg=${this.currentUrgency}`);
  }

  protected _onFillExtended(fill: FillData, cappedFill: number) {
    this._chart.recordFill({ time: Date.now(), price: fill.fillPrice, size: cappedFill, side: this.side });
    if (this.decisionPrice > 0) { const dir=this.side==='BUY'?1:-1; this.marketImpactCost=(this.avgFillPrice-this.decisionPrice)/this.decisionPrice*10000*dir; this.totalIsCost=this.timingCost+this.marketImpactCost; this.slippageVsArrival=this.marketImpactCost; }
    this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
    if (this._isComplete()) { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); }
  }

  protected _onOrderUpdateExtended(order: OrderUpdate) {
    const matchId = order.orderId || order.intentId;
    if (matchId !== this.activeChildId) return;
    if (order.state === 'REJECTED' || order.state === 'CANCELLED') {
      this.activeChildId = null; this._restingPrice = null; this._chaseAt = 0;
      if (this.status === 'COMPLETING') { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); }
    }
  }

  protected _strategyState(): Record<string, unknown> {
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this._stopped;
    const biasLabel: Record<string,string> = { balanced: 'Balanced', risk_averse: 'Risk Averse', cost_averse: 'Cost Averse' };
    const durMin = this._endTs ? Math.round((this._endTs - this._startTs) / 60000) : '?';
    return {
      summaryLine: `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via IS | ${biasLabel[this._urgencyBias]||this._urgencyBias} | ${durMin} min`,
      decisionPrice: this.decisionPrice, estimatedVolatility: this.estimatedVolatility,
      optimalRate: this.optimalRate, currentUrgency: this.currentUrgency,
      totalIsCost: this.totalIsCost, timingCost: this.timingCost, marketImpactCost: this.marketImpactCost,
      currentSlice: this.slicesFired, childCount: this.slicesFired,
      chartTargetPrice: this.decisionPrice,
    };
  }
}

export function estimateDuration(params: Record<string, unknown>): string {
  const dur = params.durationMinutes || params.duration || '30';
  const bias = params.urgencyBias || 'balanced';
  return `~${dur} min — adaptive IS (${bias === 'risk_averse' ? 'risk averse' : bias === 'cost_averse' ? 'cost averse' : 'balanced'})`;
}
