// @ts-nocheck
/**
 * Sniper — Institutional-grade sniping strategy
 * Refactored: extends BaseStrategy, onTick decomposed into focused sub-methods.
 *
 * Modes:
 *   post_snipe + simultaneous → Discretion orders (resting limit + N level IOC snipes)
 *   post_snipe + sequential   → Post+Snipe (resting limit, cancel & snipe on trigger)
 *   snipe                     → Pure multi-level ladder snipe
 */

import { floorToLot } from '../utils/sizeUtils';
import { BaseStrategy } from './baseStrategy';
import type {
  StrategyContext, MarketData, FillData, OrderUpdate, TradeData,
  SniperLevel, SniperParams, StrategyConfig,
} from '../types';

export const config: StrategyConfig = {
  name: 'SNIPER',
  displayName: 'Sniper',
  description: 'Multi-level snipe with volume confirmation, momentum filter, and iceberg execution',
  params: [
    { key: 'venue',                label: 'Exchange',           type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'executionMode',        label: 'Execution mode',     type: 'select', options: [{value:'snipe',label:'Snipe'},{value:'post_snipe',label:'Post + Snipe'}], default: 'snipe' },
    { key: 'levels',               label: 'Price levels',       type: 'ladder', default: [{ price: 0, pct: 100, enabled: true }], dependsOn: { executionMode: 'snipe' } },
    { key: 'targetPrice',          label: 'Limit price',        type: 'number', default: 0, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'snipeLevel',           label: 'Snipe ceiling',      type: 'number', default: 0, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'snipePct',             label: 'Snipe %',            type: 'number', default: 50, min: 10, max: 90, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'minSnipePct',          label: 'Min snipe %',        type: 'number', default: 5, min: 1, max: 20, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'volumeConfirmEnabled', label: 'Volume confirm',     type: 'select', options: [{value:'false',label:'Disabled'},{value:'true',label:'Enabled'}], default: 'false', dependsOn: { executionMode: 'snipe' } },
    { key: 'volumeConfirmSize',    label: 'Min volume',         type: 'number', default: 50, dependsOn: { volumeConfirmEnabled: 'true' } },
    { key: 'volumeConfirmWindowMs',label: 'Volume window (ms)', type: 'number', default: 5000, dependsOn: { volumeConfirmEnabled: 'true' } },
    { key: 'momentumFilterEnabled',label: 'Momentum filter',    type: 'select', options: [{value:'false',label:'Disabled'},{value:'true',label:'Enabled'}], default: 'false', dependsOn: { executionMode: 'snipe' } },
    { key: 'momentumLookbackMs',   label: 'Momentum lookback',  type: 'number', default: 3000, dependsOn: { momentumFilterEnabled: 'true' } },
    { key: 'momentumMinBps',       label: 'Min momentum bps/s', type: 'number', default: 2, dependsOn: { momentumFilterEnabled: 'true' } },
    { key: 'retriggerMode',        label: 'Retrigger mode',     type: 'select', options: [{value:'same',label:'Same price'},{value:'better',label:'Better price'},{value:'vwap',label:'VWAP chase'}], default: 'same', dependsOn: { executionMode: 'snipe' } },
    { key: 'retriggerImproveTicks',label: 'Improve by (ticks)', type: 'number', default: 1, dependsOn: { retriggerMode: 'better' } },
    { key: 'retriggerCooldownMs',  label: 'Cooldown (ms)',      type: 'number', default: 3000, dependsOn: { executionMode: 'snipe' } },
    { key: 'maxRetriggers',        label: 'Max retriggers',     type: 'number', default: 5, dependsOn: { executionMode: 'snipe' } },
    { key: 'icebergEnabled',       label: 'Iceberg snipe',      type: 'select', options: [{value:'false',label:'Single IOC'},{value:'true',label:'Iceberg IOC'}], default: 'false', dependsOn: { executionMode: 'snipe' } },
    { key: 'icebergSlicePct',      label: 'Slice size %',       type: 'number', default: 25, min: 5, max: 100, dependsOn: { icebergEnabled: 'true' } },
    { key: 'icebergDelayMinMs',    label: 'Min delay (ms)',      type: 'number', default: 200, dependsOn: { icebergEnabled: 'true' } },
    { key: 'icebergDelayMaxMs',    label: 'Max delay (ms)',      type: 'number', default: 800, dependsOn: { icebergEnabled: 'true' } },
    { key: 'maxSpreadBps',         label: 'Max spread (bps)',    type: 'number', default: 50 },
    { key: 'expiryMode',           label: 'Expires',             type: 'select', options: [{value:'gtc',label:'Never (GTC)'},{value:'time',label:'At time'},{value:'eod',label:'End of day'}], default: 'gtc' },
    { key: 'expiryTime',           label: 'Expiry time',         type: 'text', default: '', dependsOn: { expiryMode: 'time' } },
  ],
};

export class SniperStrategy extends BaseStrategy {
  private _executionMode: 'snipe' | 'post_snipe';
  private _levelMode: 'sequential' | 'simultaneous';
  private _targetPrice: number;
  private _snipeLevel: number;
  private _levels: SniperLevel[];

  // Snipe cap
  private _snipePct: number;
  private _maxSnipeTotal: number;
  private _minSnipeSize: number;
  private _postSnipePhase: 'ACTIVE' | 'REST_ONLY' = 'ACTIVE';
  private _currentPostSize = 0;
  private _currentSnipeSize = 0;
  private _postOrderId: string | null = null;
  private _snipeChildId: string | null = null;
  private _postFilled = 0;
  private _roundNumber = 0;
  private _cancellingForSnipe = false;
  snipedSize = 0;
  passiveFillSize = 0;
  restingOrderSize = 0;
  activeLevelIndex = 0;

  // Volume / momentum
  private _volumeConfirmEnabled: boolean;
  private _volumeConfirmSize: number;
  private _volumeConfirmWindowMs: number;
  private _momentumFilterEnabled: boolean;
  private _momentumLookbackMs: number;
  private _momentumMinBps: number;
  private _priceHistory: Array<{ price: number; timestamp: number }> = [];
  private _rollingTrades: Array<{ price: number; size: number; timestamp: number }> = [];
  private _rollingVwap = 0;
  private _rollingVwapSlip = 0;
  private _retriggerAt = 0;

  // Retrigger
  private _retriggerMode: string;
  private _retriggerImproveTicks: number;
  private _retriggerCooldownMs: number;
  private _maxRetriggers: number;

  // Iceberg
  private _icebergEnabled: boolean;
  private _icebergSlicePct: number;
  private _icebergDelayMinMs: number;
  private _icebergDelayMaxMs: number;

  // Expiry
  private _expiryMode: string;
  private _expiryTs: number | null = null;

  get type() { return 'SNIPER'; }

  constructor(params: SniperParams) {
    super(params as Record<string, unknown>, 3600);
    this._executionMode = params.executionMode || 'snipe';
    this._levelMode     = (params.levelMode as 'sequential' | 'simultaneous') || 'sequential';
    this._targetPrice   = params.targetPrice || params.postPrice || 0;
    this._snipeLevel    = params.snipeLevel  || params.snipeCeiling || 0;

    const rawLevels = Array.isArray(params.levels)
      ? params.levels
      : [{ price: this._targetPrice || 0, pct: 100, enabled: true }];
    this._levels = rawLevels.filter(l => l.enabled !== false).map(l => {
      const pct = parseFloat(String(l.pct ?? l.allocationPct ?? 0)) || 0;
      const allocatedSize = l.size && l.size > 0 ? l.size : (this.totalSize * pct) / 100;
      return {
        price: parseFloat(String(l.price)) || 0, pct, allocatedSize, filledSize: 0,
        status: 'WAITING' as const, retriggerCount: 0,
        currentSnipePrice: parseFloat(String(l.price)) || 0,
        volumeAtLevel: 0, lastVolumeWindowStart: 0,
        icebergRemaining: 0, nextIcebergAt: 0, activeChildId: null,
        _intentSubmittedAt: 0, _retriggerAt: 0,
      };
    });

    this._snipePct      = Math.min(90, Math.max(10, parseFloat(String(params.snipePct ?? params.snipeCap)) || 50));
    const minSnipePct   = Math.min(20, Math.max(1, parseFloat(String(params.minSnipePct)) || 5));
    this._maxSnipeTotal = this.totalSize * this._snipePct / 100;
    this._minSnipeSize  = this.totalSize * minSnipePct / 100;

    this._volumeConfirmEnabled  = String(params.volumeConfirmEnabled) === 'true';
    this._volumeConfirmSize     = parseFloat(String(params.volumeConfirmSize)) || 50;
    this._volumeConfirmWindowMs = parseInt(String(params.volumeConfirmWindowMs)) || 5000;
    this._momentumFilterEnabled = String(params.momentumFilterEnabled) === 'true';
    this._momentumLookbackMs    = parseInt(String(params.momentumLookbackMs)) || 3000;
    this._momentumMinBps        = parseFloat(String(params.momentumMinBps)) || 2;

    this._retriggerMode         = params.retriggerMode || 'same';
    this._retriggerImproveTicks = parseInt(String(params.retriggerImproveTicks)) || 1;
    this._retriggerCooldownMs   = parseInt(String(params.retriggerCooldownMs)) || 3000;
    this._maxRetriggers         = parseInt(String(params.maxRetriggers)) || (this._levelMode === 'simultaneous' ? 20 : 5);

    this._icebergEnabled    = String(params.icebergEnabled) === 'true';
    this._icebergSlicePct   = parseFloat(String(params.icebergSlicePct)) || 25;
    this._icebergDelayMinMs = parseInt(String(params.icebergDelayMinMs)) || 200;
    this._icebergDelayMaxMs = parseInt(String(params.icebergDelayMaxMs)) || 800;

    this._expiryMode = params.expiryMode || 'gtc';
    if (this._expiryMode === 'eod') { const eod = new Date(); eod.setHours(23,59,59,999); this._expiryTs = eod.getTime(); }

    if (params.arrivalMid) this.arrivalPrice = params.arrivalMid;
    if (this._executionMode === 'post_snipe') this._chart.addSeries('vwap');

    console.log(`[sniper] mode=${this._executionMode} levelMode=${this._levelMode} totalSize=${this.totalSize} levels=${this._levels.length} snipePct=${this._snipePct}`);
  }

  protected _onActivate() {
    if (this._executionMode === 'post_snipe') { this.status = 'ACTIVE'; this._startRound(); }
  }

  protected _onTick(md: MarketData, bid: number, ask: number, mid: number, now: number) {
    if (this._expiryTs && now >= this._expiryTs) { this.status = 'EXPIRED'; this._completedTs = now; this.stop(); return; }
    if (this._executionMode === 'post_snipe') this._tickPostSnipe(md, bid, ask, now);
    else this._tickSnipe(md, bid, ask, mid, now);
  }

  protected _chartExtras(_mid: number): Record<string, number | null> {
    return { vwap: this._rollingVwap || null };
  }

  // ── Post+Snipe ───────────────────────────────────────────────────────────

  private _tickPostSnipe(md: MarketData, bid: number, ask: number, now: number) {
    if (this.status !== 'ACTIVE' || bid <= 0 || ask <= 0) return;
    if (this._isPostSnipeComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    if (this._postSnipePhase === 'REST_ONLY') return;
    if (this._levelMode === 'simultaneous') this._tickSimultaneousLevels(md, bid, ask, now);
    else this._tickSequentialSnipe(bid, ask, now);
  }

  private _tickSimultaneousLevels(md: MarketData, bid: number, ask: number, now: number) {
    for (let li = 0; li < this._levels.length; li++) {
      const lvl = this._levels[li];
      const tol = Math.max(0.001, lvl.allocatedSize * 0.01);
      if (lvl.filledSize >= lvl.allocatedSize - tol) { lvl.status = 'COMPLETED'; continue; }
      if (lvl.retriggerCount >= this._maxRetriggers) { lvl.status = 'COMPLETED'; continue; }
      if (lvl.activeChildId) {
        if (now - (lvl._intentSubmittedAt || 0) < 5000) continue;
        lvl.activeChildId = null; lvl._intentSubmittedAt = 0;
      }
      if (lvl._retriggerAt && now < lvl._retriggerAt) continue;
      const triggered = this.side === 'BUY' ? ask <= lvl.currentSnipePrice : bid >= lvl.currentSnipePrice;
      if (!triggered) { lvl.status = 'WAITING'; continue; }
      if (md.spreadBps > this._maxSpreadBps) continue;
      this._fireLevelIOC(lvl, li, bid, ask, now, 'SNIPER-SNIPE');
    }
  }

  private _fireLevelIOC(lvl: SniperLevel, li: number, bid: number, ask: number, now: number, algoType: string) {
    lvl.status = 'FIRING';
    const remaining = Math.max(0, lvl.allocatedSize - lvl.filledSize);
    if (remaining < this._lotSize * 0.01) { lvl.status = 'COMPLETED'; return; }
    const qty = floorToLot(remaining, this._lotSize);
    if (qty <= 0) { lvl.status = 'COMPLETED'; return; }
    const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
    lvl.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: qty, limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType });
    lvl._intentSubmittedAt = now;
    console.log(`[sniper] L${li+1} firing: ${qty.toFixed(4)} @ $${price} (level=$${lvl.currentSnipePrice})`);
  }

  private _tickSequentialSnipe(bid: number, ask: number, now: number) {
    if (this._snipeChildId || this._cancellingForSnipe) return;
    const triggered = this.side === 'BUY' ? (this._snipeLevel > 0 && ask <= this._snipeLevel) : (this._snipeLevel > 0 && bid >= this._snipeLevel);
    if (!triggered || this._currentSnipeSize <= 0) return;
    this._cancellingForSnipe = true;
    if (this._postOrderId) { this._ctx!.cancelChild(this._postOrderId); console.log(`[post+snipe] Snipe triggered — cancelling resting`); }
    setTimeout(() => {
      if (!this._cancellingForSnipe) return;
      this._cancellingForSnipe = false; this._postOrderId = null; this.restingOrderSize = 0; this._restingPrice = null;
      const qty = floorToLot(Math.min(this._currentSnipeSize, this.totalSize - this.filledSize), this._lotSize);
      if (qty <= 0) return;
      const md = this._lastMd;
      const price = this.side === 'BUY' ? (md?.askPrice || ask) + this._tickSize : (md?.bidPrice || bid) - this._tickSize;
      this._snipeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: qty, limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER-SNIPE' });
      console.log(`[post+snipe] Snipe fired: ${qty.toFixed(4)} @ $${price}`);
    }, 100);
  }

  // ── Pure Snipe ───────────────────────────────────────────────────────────

  private _tickSnipe(md: MarketData, bid: number, ask: number, mid: number, now: number) {
    if (mid <= 0) return;
    this._updatePriceHistory(mid, now);
    if (this._isComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    if (this._levelMode === 'simultaneous') this._tickSimultaneousSnipe(md, bid, ask, now);
    else this._tickSequentialLadder(md, bid, ask, now);
  }

  private _tickSimultaneousSnipe(md: MarketData, bid: number, ask: number, now: number) {
    this.status = 'ACTIVE';
    let allDone = true;
    for (let li = 0; li < this._levels.length; li++) {
      const lvl = this._levels[li];
      const tol = Math.max(0.001, lvl.allocatedSize * 0.01);
      if (lvl.filledSize >= lvl.allocatedSize - tol || lvl.retriggerCount >= this._maxRetriggers) { lvl.status = 'COMPLETED'; continue; }
      allDone = false;
      if (lvl.activeChildId) { if (now-(lvl._intentSubmittedAt||0)<5000) continue; lvl.activeChildId=null; lvl._intentSubmittedAt=0; }
      if (lvl._retriggerAt && now < lvl._retriggerAt) continue;
      const triggered = this.side === 'BUY' ? ask <= lvl.currentSnipePrice : bid >= lvl.currentSnipePrice;
      if (!triggered) { lvl.status = 'WAITING'; continue; }
      if (md.spreadBps > this._maxSpreadBps) continue;
      this._fireLevelIOC(lvl, li, bid, ask, now, 'SNIPER');
    }
    if (allDone && this._isComplete()) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); }
  }

  private _tickSequentialLadder(md: MarketData, bid: number, ask: number, now: number) {
    if (this.activeLevelIndex >= this._levels.length) { this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return; }
    const level = this._levels[this.activeLevelIndex];
    const tol = Math.max(0.001, level.allocatedSize * 0.01);
    if (level.filledSize >= level.allocatedSize - tol) { level.status = 'COMPLETED'; this.activeLevelIndex++; return; }
    if (this._retriggerAt > 0 && now < this._retriggerAt) { level.status = 'WAITING'; this.status = 'WAITING'; return; }
    this._retriggerAt = 0;
    const triggered = this.side === 'BUY' ? ask <= level.currentSnipePrice : bid >= level.currentSnipePrice;
    if (!triggered) { level.status = 'WAITING'; this.status = 'WAITING'; return; }
    if (!this._passesVolumeConfirm(level, now)) return;
    if (!this._passesMomentumFilter()) return;
    if (md.spreadBps > this._maxSpreadBps) { this.pauseReason = `Spread too wide`; return; }
    this.pauseReason = null;
    this.status = 'ACTIVE'; level.status = 'FIRING';
    if (level.activeChildId) return;
    const remaining = Math.max(0, level.allocatedSize - level.filledSize);
    if (remaining < this._lotSize * 0.01) { level.status = 'COMPLETED'; this.activeLevelIndex++; return; }
    if (!this._icebergEnabled) {
      const qty = remaining < this._lotSize ? remaining : floorToLot(remaining, this._lotSize);
      if (qty <= 0) return;
      const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
      level.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: qty, limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER' });
      console.log(`[sniper] L${this.activeLevelIndex+1} firing: ${qty.toFixed(4)} @ $${price}`);
    } else { this._fireIcebergSlice(level, remaining, bid, ask); }
  }

  private _fireIcebergSlice(level: SniperLevel, remaining: number, bid: number, ask: number) {
    const now = Date.now();
    if (level.icebergRemaining <= 0) level.icebergRemaining = remaining;
    level.icebergRemaining = Math.min(level.icebergRemaining, remaining);
    if (now < level.nextIcebergAt) return;
    const rawSlice = Math.min(level.icebergRemaining, level.allocatedSize * this._icebergSlicePct / 100, remaining);
    const qty = rawSlice < this._lotSize ? rawSlice : floorToLot(rawSlice, this._lotSize);
    if (qty <= 0) return;
    const price = this.side === 'BUY' ? ask + this._tickSize : bid - this._tickSize;
    level.activeChildId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: qty, limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER' });
    level.nextIcebergAt = now + this._icebergDelayMinMs + Math.random() * (this._icebergDelayMaxMs - this._icebergDelayMinMs);
  }

  // ── Round management ─────────────────────────────────────────────────────

  private _startRound() {
    const remaining = Math.max(0, this.totalSize - this.filledSize);
    if (remaining < this._lotSize * 0.01) { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); return; }
    this._postFilled = 0; this._snipeChildId = null; this._cancellingForSnipe = false; this._roundNumber++;
    if (this._levelMode === 'simultaneous' && this._levels.length > 1) { this._startSimultaneousRound(remaining); return; }
    this._startSequentialRound(remaining);
  }

  private _startSimultaneousRound(remaining: number) {
    this._postSnipePhase = 'ACTIVE';
    const totalSnipeAlloc  = this._levels.reduce((s, l) => s + l.allocatedSize, 0);
    const totalSnipeFilled = this._levels.reduce((s, l) => s + l.filledSize, 0);
    const snipeRemaining   = totalSnipeAlloc - totalSnipeFilled;
    this._currentPostSize  = Math.max(0, remaining - snipeRemaining);
    this._currentSnipeSize = snipeRemaining;
    if (this._currentPostSize > 0) {
      this._postOrderId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: this._currentPostSize, limitPrice: this._targetPrice, orderType: 'LIMIT', algoType: 'SNIPER-POST' });
      this.restingOrderSize = this._currentPostSize; this._restingPrice = this._targetPrice;
    }
  }

  private _startSequentialRound(remaining: number) {
    const snipeAllowance = Math.max(0, this._maxSnipeTotal - this.snipedSize);
    if (remaining <= this._minSnipeSize || snipeAllowance < this._lotSize) {
      this._postSnipePhase = 'REST_ONLY'; this._currentPostSize = remaining; this._currentSnipeSize = 0;
    } else {
      this._postSnipePhase = 'ACTIVE';
      let snipe = floorToLot(Math.min(remaining * 0.5, snipeAllowance), this._lotSize);
      if (snipe < this._lotSize) snipe = remaining < this._lotSize ? remaining : 0;
      this._currentSnipeSize = snipe; this._currentPostSize = remaining - snipe;
      if (this._currentPostSize < this._lotSize && this._currentPostSize > 0) this._currentPostSize = remaining < this._lotSize ? remaining : this._lotSize;
    }
    if (this._currentPostSize > 0) {
      this._postOrderId = this._ctx!.submitIntent({ symbol: this.symbol, side: this.side, quantity: this._currentPostSize, limitPrice: this._targetPrice, orderType: 'LIMIT', algoType: 'SNIPER-POST' });
      this.restingOrderSize = this._currentPostSize; this._restingPrice = this._targetPrice;
    }
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  private _passesVolumeConfirm(level: SniperLevel, now: number): boolean {
    if (!this._volumeConfirmEnabled) return true;
    const vol = this._calcVolumeAtLevel(level.currentSnipePrice, now);
    level.volumeAtLevel = vol;
    if (vol < this._volumeConfirmSize) { level.status = 'CONFIRMING'; this.status = 'ACTIVE'; return false; }
    return true;
  }

  private _passesMomentumFilter(): boolean {
    if (!this._momentumFilterEnabled) return true;
    const velocity = this._calcMomentumBps();
    return this.side === 'BUY' ? velocity <= -this._momentumMinBps : velocity >= this._momentumMinBps;
  }

  // ── Trade data ───────────────────────────────────────────────────────────

  onTrade(trade: TradeData) {
    if (!trade.size || trade.size <= 0) return;
    const now = trade.timestamp || Date.now();
    this._rollingTrades.push({ price: trade.price, size: trade.size, timestamp: now });
    const cutoff = Date.now() - Math.max(this._volumeConfirmWindowMs, 60000);
    while (this._rollingTrades.length > 0 && this._rollingTrades[0].timestamp < cutoff) this._rollingTrades.shift();
    this._recalcVwap();
  }

  // ── Fill handling ────────────────────────────────────────────────────────

  protected _onFillExtended(fill: FillData, cappedFill: number) {
    if (this._executionMode === 'post_snipe') this._handlePostSnipeFill(fill, cappedFill);
    else this._handleSnipeFill(fill, cappedFill);
    if (this.filledSize > 0 && this._rollingVwap > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this._rollingVwapSlip = (this.avgFillPrice - this._rollingVwap) / this._rollingVwap * 10000 * dir;
    }
  }

  private _handlePostSnipeFill(fill: FillData, cappedFill: number) {
    const isPostFill  = fill.childId === this._postOrderId || fill.orderId === this._postOrderId;
    const isSeqSnipe  = fill.childId === this._snipeChildId || fill.orderId === this._snipeChildId;
    const levelIdx    = this._levelMode === 'simultaneous'
      ? this._levels.findIndex(l => l.activeChildId && (fill.childId === l.activeChildId || fill.orderId === l.activeChildId))
      : -1;
    const isLevelFill = levelIdx >= 0;

    if (isLevelFill || isSeqSnipe) this.snipedSize += cappedFill;
    else this.passiveFillSize += cappedFill;
    if (isPostFill) this._postFilled += cappedFill;

    if (isLevelFill) {
      const lvl = this._levels[levelIdx];
      const lvlCapped = Math.min(cappedFill, Math.max(0, lvl.allocatedSize - lvl.filledSize));
      lvl.filledSize += lvlCapped; lvl.activeChildId = null; lvl._intentSubmittedAt = 0;
      this._chart.recordFill({ time: Date.now(), price: fill.fillPrice, size: lvlCapped, side: this.side, fillType: `snipe-L${levelIdx+1}` });
      if (lvl.filledSize < lvl.allocatedSize - Math.max(0.001, lvl.allocatedSize * 0.01)) {
        lvl.retriggerCount++; lvl._retriggerAt = Date.now() + this._retriggerCooldownMs; lvl.status = 'WAITING';
      } else { lvl.status = 'COMPLETED'; }
      console.log(`[post+snipe] L${levelIdx+1} Fill: ${lvlCapped.toFixed(4)} @ ${fill.fillPrice}`);
    } else {
      this._chart.recordFill({ time: Date.now(), price: fill.fillPrice, size: cappedFill, side: this.side, fillType: isSeqSnipe ? 'snipe' : isPostFill ? 'passive' : 'unknown' });
    }

    if (isSeqSnipe) this._snipeChildId = null;
    if (this._isPostSnipeComplete()) { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); return; }
    if (isSeqSnipe && this._levelMode !== 'simultaneous') { this._startRound(); return; }
    if (isPostFill && this._postFilled >= this._currentPostSize - Math.max(0.001, this._lotSize * 0.01)) {
      this._postOrderId = null; this.restingOrderSize = 0;
      if (this._levelMode !== 'simultaneous') this._startRound();
    }
  }

  private _handleSnipeFill(fill: FillData, cappedFill: number) {
    const levelIdx = this._levelMode === 'simultaneous'
      ? this._levels.findIndex(l => l.activeChildId && (fill.childId === l.activeChildId || fill.orderId === l.activeChildId))
      : this.activeLevelIndex;
    const level = this._levels[Math.max(0, levelIdx)];
    if (!level) return;
    const lvlCapped = Math.min(cappedFill, Math.max(0, level.allocatedSize - level.filledSize));
    level.filledSize += lvlCapped; this.snipedSize += lvlCapped;
    this._chart.recordFill({ time: Date.now(), price: fill.fillPrice, size: lvlCapped, side: this.side, fillType: `snipe-L${levelIdx+1}` });
    level.activeChildId = null; level._intentSubmittedAt = 0; this._restingPrice = null;
    const tol = Math.max(0.001, level.allocatedSize * 0.01);
    if (level.filledSize >= level.allocatedSize - tol) {
      level.status = 'COMPLETED'; this.activeLevelIndex++;
      if (this._isComplete()) { this._completedTs = Date.now(); this.status = 'COMPLETED'; this.stop(); }
      return;
    }
    if (level.retriggerCount >= this._maxRetriggers) { level.status = 'COMPLETED'; if (this._levelMode !== 'simultaneous') this.activeLevelIndex++; return; }
    if (this._levelMode !== 'simultaneous') {
      if (this._retriggerMode === 'better') { const improve = this._retriggerImproveTicks * this._tickSize; level.currentSnipePrice = this.side === 'BUY' ? level.currentSnipePrice - improve : level.currentSnipePrice + improve; }
      else if (this._retriggerMode === 'vwap') level.currentSnipePrice = this.avgFillPrice;
    }
    level.retriggerCount++; level._retriggerAt = Date.now() + this._retriggerCooldownMs;
    if (this._levelMode !== 'simultaneous') this._retriggerAt = level._retriggerAt!;
    level.status = 'WAITING'; this.status = 'WAITING';
  }

  // ── Order updates ────────────────────────────────────────────────────────

  protected _onOrderUpdateExtended(order: OrderUpdate) {
    const matchId = order.orderId || order.intentId;
    if (!matchId) return;
    for (const level of this._levels) {
      if (matchId === level.activeChildId) {
        if (order.state === 'REJECTED' || order.state === 'CANCELLED') {
          level.activeChildId = null;
          if (this._icebergEnabled) level.icebergRemaining = Math.max(0, level.icebergRemaining - (order.filledSize || 0));
        }
        return;
      }
    }
    if (matchId === this._snipeChildId && (order.state === 'REJECTED' || order.state === 'CANCELLED')) this._snipeChildId = null;
    if (matchId === this._postOrderId && (order.state === 'REJECTED' || order.state === 'CANCELLED')) {
      this._postOrderId = null; this._restingPrice = null; this.restingOrderSize = 0;
      if (!this._cancellingForSnipe) { console.log(`[post+snipe] Resting order ${order.state} — restarting round`); this._startRound(); }
    }
  }

  protected override _cancelActive() {
    for (const l of this._levels) { if (l.activeChildId) { this._ctx?.cancelChild(l.activeChildId); l.activeChildId = null; } }
    if (this.activeChildId)  { this._ctx?.cancelChild(this.activeChildId);  this.activeChildId = null; }
    if (this._snipeChildId)  { this._ctx?.cancelChild(this._snipeChildId);  this._snipeChildId = null; }
    if (this._postOrderId)   { this._ctx?.cancelChild(this._postOrderId);   this._postOrderId = null; }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private _isPostSnipeComplete(): boolean {
    if (this._isComplete()) return true;
    if (this._levelMode === 'simultaneous') {
      const restingDone  = !this._postOrderId && this._roundNumber > 0;
      const allLevelsDone = this._levels.every(l => {
        const tol = Math.max(this._lotSize || 0.001, l.allocatedSize * 0.001);
        return l.filledSize >= l.allocatedSize - tol || l.retriggerCount >= this._maxRetriggers || l.status === 'COMPLETED';
      });
      return restingDone && allLevelsDone;
    }
    return false;
  }

  private _updatePriceHistory(mid: number, now: number) {
    this._priceHistory.push({ price: mid, timestamp: now });
    const cutoff = now - Math.max(this._momentumLookbackMs, 10000);
    while (this._priceHistory.length > 0 && this._priceHistory[0].timestamp < cutoff) this._priceHistory.shift();
  }

  private _calcVolumeAtLevel(snipePrice: number, now: number): number {
    const cutoff = now - this._volumeConfirmWindowMs;
    return this._rollingTrades.reduce((vol, t) => {
      if (t.timestamp < cutoff) return vol;
      if (this.side === 'BUY' && t.price <= snipePrice) return vol + t.size;
      if (this.side === 'SELL' && t.price >= snipePrice) return vol + t.size;
      return vol;
    }, 0);
  }

  private _calcMomentumBps(): number {
    if (this._priceHistory.length < 2) return 0;
    const now = Date.now();
    const recent = this._priceHistory.filter(p => p.timestamp >= now - this._momentumLookbackMs);
    if (recent.length < 2) return 0;
    const first = recent[0], last = recent[recent.length - 1];
    const elapsed = (last.timestamp - first.timestamp) / 1000;
    if (elapsed <= 0 || first.price <= 0) return 0;
    return ((last.price - first.price) / first.price * 10000) / elapsed;
  }

  private _recalcVwap() {
    let sumPV = 0, sumV = 0;
    const cutoff = Date.now() - 60000;
    for (const t of this._rollingTrades) { if (t.timestamp < cutoff) continue; sumPV += t.price * t.size; sumV += t.size; }
    this._rollingVwap = sumV > 0 ? sumPV / sumV : 0;
  }

  // ── State ────────────────────────────────────────────────────────────────

  protected _strategyState(): Record<string, unknown> {
    const mid = this._lastMd?.midPrice || 0;
    const activeLevel = this._levels[this.activeLevelIndex];
    const activeLevelPrice = activeLevel?.currentSnipePrice || this._targetPrice;
    const distanceBps = mid > 0 && activeLevelPrice > 0 ? (mid - activeLevelPrice) / activeLevelPrice * 10000 : 0;
    const discBps = this._snipeLevel && this._targetPrice
      ? Math.round(Math.abs((this._snipeLevel - this._targetPrice) / this._targetPrice * 10000)) : '?';
    const summaryLine = this._executionMode === 'post_snipe'
      ? (this._levelMode === 'simultaneous'
          ? `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via LMT+Discretion | Limit: $${this._targetPrice} | Disc: ${discBps}bps | ${this._snipePct}% disc`
          : `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via SNIPER | Post+Snipe | Limit: $${this._targetPrice} Snipe: $${this._snipeLevel}`)
      : `${this.side} ${this._formatSize(this.totalSize)} ${this.symbol} on ${this.venue} via SNIPER | ${this._levels.map((l,i)=>`L${i+1}: $${l.price} (${l.pct}%)`).join(' ')}`;

    return {
      summaryLine, rollingVwap: this._rollingVwap, slippageVsVwap: this._rollingVwapSlip,
      targetPrice: activeLevelPrice, executionMode: this._executionMode, levelMode: this._levelMode,
      snipeLevel: this._snipeLevel, distanceBps,
      distancePct: mid > 0 && activeLevelPrice > 0 ? Math.max(0, 100 - Math.abs(distanceBps) / 2) : 0,
      triggered: this.status !== 'WAITING', expiryTs: this._expiryTs,
      restingOrderSize: this.restingOrderSize, snipedSize: this.snipedSize, passiveFillSize: this.passiveFillSize,
      postSnipePhase: this._postSnipePhase, roundNumber: this._roundNumber,
      currentPostSize: this._currentPostSize, currentSnipeSize: this._currentSnipeSize,
      snipePct: this._snipePct, maxSnipeTotal: this._maxSnipeTotal,
      snipeCapUsed: this.snipedSize, snipeCapRemaining: Math.max(0, this._maxSnipeTotal - this.snipedSize),
      levels: this._levels.map((l, i) => ({
        price: l.currentSnipePrice, pct: l.pct, allocatedSize: l.allocatedSize,
        filledSize: l.filledSize, status: l.status, retriggerCount: l.retriggerCount,
        volumeAtLevel: l.volumeAtLevel, active: i === this.activeLevelIndex,
      })),
      activeLevelIndex: this.activeLevelIndex, momentumBps: this._calcMomentumBps(),
      volumeConfirmEnabled: this._volumeConfirmEnabled, momentumFilterEnabled: this._momentumFilterEnabled,
      icebergEnabled: this._icebergEnabled,
      chartTargetPrice: this._executionMode === 'post_snipe' ? this._targetPrice : null,
      chartSnipeLevel: this._executionMode === 'post_snipe' && this._levelMode !== 'simultaneous' ? this._snipeLevel : null,
      chartLevelPrices: this._levels.map(l => ({ price: l.currentSnipePrice, status: l.status })),
    };
  }
}

export function estimateDuration(params: SniperParams): string {
  if (params.executionMode === 'post_snipe') return `Post @ $${params.targetPrice || '?'} + snipe ceiling $${params.snipeLevel || '?'}`;
  const levels = Array.isArray(params.levels) ? params.levels.filter(l => l.enabled !== false) : [];
  if (levels.length <= 1) return `Snipe @ $${levels[0]?.price || '?'}`;
  return `${levels.length}-level ladder: $${levels[0]?.price || '?'} → $${levels[levels.length-1]?.price || '?'}`;
}
