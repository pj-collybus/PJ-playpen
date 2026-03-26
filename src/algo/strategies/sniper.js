/**
 * Sniper — two execution modes:
 *
 * Snipe:        Wait for price to touch/cross targetPrice, then fire full size as IOC.
 * Post+Snipe:   Place a resting limit order at targetPrice, plus actively snipe
 *               any liquidity that appears at or better than snipeLevel.
 *
 * States: WAITING → ACTIVE → COMPLETING → COMPLETED / EXPIRED / STOPPED
 */

'use strict';

const config = {
  name: 'SNIPER',
  displayName: 'Sniper',
  description: 'Snipe at a price level, or post a passive bid with a snipe ceiling',
  params: [
    { key: 'venue',              label: 'Exchange',                       type: 'select', options: ['Deribit','Binance','Bybit','OKX','Kraken','BitMEX'] },
    { key: 'executionMode',      label: 'Execution mode',                 type: 'select', options: [{value:'snipe',label:'Snipe — cross spread at trigger price'},{value:'post_snipe',label:'Post + Snipe — passive bid with snipe ceiling'}], default: 'snipe' },
    { key: 'targetPrice',        label: 'Target price (trigger / post level)', type: 'number', default: 0 },
    { key: 'triggerCondition',   label: 'Trigger when price',             type: 'select', options: [{value:'touches',label:'Touches target'},{value:'breaks_above',label:'Breaks above target'},{value:'breaks_below',label:'Breaks below target'}], default: 'touches', dependsOn: { executionMode: 'snipe' } },
    { key: 'snipeLevel',         label: 'Snipe ceiling (for Post+Snipe)', type: 'number', default: 0, dependsOn: { executionMode: 'post_snipe' } },
    { key: 'expiryMode',         label: 'Expires',                        type: 'select', options: [{value:'gtc',label:'Never (GTC)'},{value:'time',label:'At time'},{value:'eod',label:'End of day'}], default: 'gtc' },
    { key: 'expiryTime',         label: 'Expiry time',                    type: 'text', default: '', dependsOn: { expiryMode: 'time' } },
    { key: 'maxSpreadBps',       label: 'Max spread (bps)',               type: 'number', default: 50 },
    { key: 'retriggerEnabled',   label: 'Retrigger',                      type: 'select', options: [{value:'false',label:'Once only'},{value:'true',label:'Retrigger if price returns'}], default: 'false', dependsOn: { executionMode: 'snipe' } },
    { key: 'retriggerCooldownMs',label: 'Retrigger cooldown (ms)',        type: 'number', default: 5000, dependsOn: { retriggerEnabled: 'true' } },
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

class SniperStrategy {
  constructor(params) {
    this.symbol    = params.symbol;
    this.side      = params.side;
    this.venue     = params.venue || 'Deribit';
    this.totalSize = params.totalSize || 0;

    this._executionMode     = params.executionMode || 'snipe';
    this._targetPrice       = params.targetPrice || 0;
    this._triggerCondition  = params.triggerCondition || 'touches';
    this._snipeLevel        = params.snipeLevel || 0;
    this._tickSize          = params.tickSize || 0.0001;
    this._lotSize           = params.lotSize || 1;
    this._maxSpreadBps      = params.maxSpreadBps || 50;
    this._retriggerEnabled  = String(params.retriggerEnabled) === 'true';
    this._retriggerCooldown = params.retriggerCooldownMs || 5000;

    // Expiry
    this._expiryMode = params.expiryMode || 'gtc';
    if (this._expiryMode === 'time') {
      this._expiryTs = _parseTime(params.expiryTime) || null;
    } else if (this._expiryMode === 'eod') {
      const eod = new Date(); eod.setHours(23, 59, 59, 999);
      this._expiryTs = eod.getTime();
    } else {
      this._expiryTs = null;
    }

    // Chart
    this._chartBids = []; this._chartAsks = []; this._chartOrder = [];
    this._chartTimes = []; this._chartFills = [];
    this._chartSampleMs = 1000; this._chartLastSampleTs = 0;
    this._chartMaxPts = 1800;

    // State
    this.status          = 'WAITING';
    this.filledSize      = 0;
    this.remainingSize   = this.totalSize;
    this.avgFillPrice    = 0;
    this.totalNotional   = 0;
    this.arrivalPrice    = 0;
    this.slippageVsArrival = 0;
    this.activeChildId   = null;  // snipe IOC order
    this._restingPrice   = null;
    this.pauseReason     = null;
    this._prevMid        = 0;
    this._triggerTs       = 0;
    this._retriggerAt    = 0;
    this._retryAt        = 0;
    this._retryCount     = 0;

    // Post+Snipe state
    this.restingOrderId   = null;   // the passive resting order
    this.restingOrderSize = this.totalSize;
    this.snipedSize       = 0;
    this.passiveFillSize  = 0;
    this._lastSnipeTs     = 0;
    this._snipeChildId    = null;   // current snipe IOC in flight

    this._completedTs    = 0;
    this._startTs        = Date.now();
    this._lastMd         = null;
    this._ctx            = null;
    this._stopped        = false;
  }

  get type() { return 'SNIPER'; }

  start(ctx) {
    this._ctx = ctx;
    if (this._executionMode === 'post_snipe') {
      console.log(`[sniper] Post+Snipe: posting ${this.totalSize} at $${this._targetPrice}, snipe ceiling $${this._snipeLevel}`);
      this._activatePostSnipe();
    } else {
      console.log(`[sniper] Snipe: waiting for ${this._triggerCondition} at $${this._targetPrice}`);
    }
  }

  pause()  { if (this.status !== 'COMPLETED' && this.status !== 'EXPIRED') { this._prevStatus = this.status; this.status = 'PAUSED'; this.pauseReason = 'manual'; } }
  resume() { if (this.status === 'PAUSED') { this.status = this._prevStatus || 'WAITING'; this.pauseReason = null; } }

  stop() {
    this._stopped = true;
    if (!this._completedTs) this._completedTs = Date.now();
    if (this.activeChildId) { this._ctx.cancelChild(this.activeChildId); this.activeChildId = null; }
    if (this._snipeChildId) { this._ctx.cancelChild(this._snipeChildId); this._snipeChildId = null; }
    if (this.restingOrderId) { this._ctx.cancelChild(this.restingOrderId); this.restingOrderId = null; }
    if (this.status !== 'COMPLETED' && this.status !== 'EXPIRED') this.status = 'STOPPED';
    console.log(`[sniper] Stopped: filled=${this.filledSize.toFixed(4)} avg=${this.avgFillPrice.toFixed(4)} (passive=${this.passiveFillSize.toFixed(4)} sniped=${this.snipedSize.toFixed(4)})`);
  }

  // ── Post+Snipe activation ───────────────────────────────────────────────

  _activatePostSnipe() {
    this.status = 'ACTIVE';
    this._triggerTs = Date.now();
    // Place resting order at targetPrice
    this._placeRestingOrder();
  }

  _placeRestingOrder() {
    if (this.restingOrderId) {
      this._ctx.cancelChild(this.restingOrderId);
      this.restingOrderId = null;
    }
    this.restingOrderSize = this.remainingSize;
    if (this.restingOrderSize <= 0.001) return;

    this.restingOrderId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: this.restingOrderSize,
      limitPrice: this._targetPrice, orderType: 'LIMIT', algoType: 'SNIPER-POST',
    });
    this._restingPrice = this._targetPrice;
    console.log(`[sniper] Resting order placed: ${this.restingOrderSize.toFixed(4)} @ $${this._targetPrice}`);
  }

  _fireSnipe(bid, ask) {
    if (this._snipeChildId || this.remainingSize <= this._lotSize * 0.5) return;
    const now = Date.now();
    if (now - this._lastSnipeTs < 200) return; // min 200ms between snipes

    const tick = this._tickSize;
    const price = this.side === 'BUY' ? ask + tick : bid - tick;
    const qty = Math.min(this.remainingSize, this.totalSize); // full remaining
    if (qty < this._lotSize) return;

    const snipeQty = Math.round(qty / this._lotSize) * this._lotSize;
    if (snipeQty <= 0) return;

    this._snipeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: snipeQty,
      limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER-SNIPE',
    });
    this._lastSnipeTs = now;
    console.log(`[sniper] Snipe fired: ${snipeQty.toFixed(4)} @ $${price} (ceiling $${this._snipeLevel})`);
  }

  // ── Main tick handler ───────────────────────────────────────────────────

  onTick(marketData) {
    this._lastMd = marketData;
    const now = Date.now();
    const bid = marketData.bidPrice || 0;
    const ask = marketData.askPrice || 0;
    const mid = marketData.midPrice || (bid && ask ? (bid + ask) / 2 : 0);

    if (this.arrivalPrice === 0 && mid > 0) this.arrivalPrice = mid;

    // Chart
    if (bid > 0 && ask > 0 && now - this._chartLastSampleTs >= this._chartSampleMs) {
      this._chartLastSampleTs = now;
      const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED';
      this._chartBids.push(bid); this._chartAsks.push(ask);
      this._chartOrder.push(isDone ? null : (this._restingPrice || null));
      this._chartTimes.push(now);
      if (this._chartBids.length > this._chartMaxPts) {
        this._chartBids.shift(); this._chartAsks.shift();
        this._chartOrder.shift(); this._chartTimes.shift();
      }
    }

    if (this._stopped || this.status === 'COMPLETED' || this.status === 'EXPIRED' || this.status === 'PAUSED') return;

    // ── Expiry check ─────────────────────────────────────────────────
    if (this._expiryTs && now >= this._expiryTs) {
      this.status = 'EXPIRED'; this._completedTs = now;
      console.log(`[sniper] Expired`);
      this.stop(); return;
    }

    // ── Post+Snipe mode ──────────────────────────────────────────────
    if (this._executionMode === 'post_snipe') {
      if (this.status === 'ACTIVE' && bid > 0 && ask > 0) {
        // Completion check
        if (this.filledSize >= this.totalSize - 0.001) {
          this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
        }
        // Snipe mechanism: check if price is at or within snipe level
        const snipeTriggered = this.side === 'BUY'
          ? (this._snipeLevel > 0 && ask <= this._snipeLevel)
          : (this._snipeLevel > 0 && bid >= this._snipeLevel);
        if (snipeTriggered && !this._snipeChildId && this.remainingSize > this._lotSize * 0.5) {
          this._fireSnipe(bid, ask);
        }
      }
      return;
    }

    // ── Snipe mode (pure IOC) ────────────────────────────────────────
    if (this.status === 'WAITING') {
      if (this._retriggerAt > 0 && now < this._retriggerAt) return;
      if (mid <= 0) { this._prevMid = mid; return; }

      let triggered = false;
      if (this._triggerCondition === 'touches') {
        triggered = Math.abs(mid - this._targetPrice) <= this._tickSize;
      } else if (this._triggerCondition === 'breaks_above') {
        triggered = this._prevMid > 0 && this._prevMid <= this._targetPrice && bid > this._targetPrice;
      } else if (this._triggerCondition === 'breaks_below') {
        triggered = this._prevMid > 0 && this._prevMid >= this._targetPrice && ask < this._targetPrice;
      }
      this._prevMid = mid;

      if (triggered) {
        this._triggerTs = now;
        console.log(`[sniper] TRIGGERED at mid=${mid} target=${this._targetPrice}`);
        if (marketData.spreadBps > this._maxSpreadBps) {
          this.status = 'TRIGGERED';
          this.pauseReason = `Spread ${marketData.spreadBps.toFixed(0)}bps — waiting to narrow`;
        } else {
          this._startSnipe(bid, ask, mid);
        }
      }
      return;
    }

    if (this.status === 'TRIGGERED') {
      if (mid > 0 && marketData.spreadBps <= this._maxSpreadBps) {
        this.pauseReason = null;
        this._startSnipe(bid, ask, mid);
      }
      return;
    }

    if (this.status === 'ACTIVE') {
      if (this.filledSize >= this.totalSize - 0.001) {
        this._completedTs = now; this.status = 'COMPLETED'; this.stop(); return;
      }
      if (this._retryAt > 0 && now >= this._retryAt && !this.activeChildId) {
        this._retryAt = 0;
        this._fireSnipeOrder(bid, ask);
      }
    }
  }

  _startSnipe(bid, ask, mid) {
    this.status = 'ACTIVE';
    console.log(`[sniper] Snipe mode — IOC only, no resting order should exist. restingOrderId=${this.restingOrderId}`);
    console.log(`[sniper] Executing snipe: size=${this.remainingSize}`);
    this._fireSnipeOrder(bid, ask);
  }

  _fireSnipeOrder(bid, ask) {
    const tick = this._tickSize;
    const price = this.side === 'BUY' ? ask + tick : bid - tick;
    if (!price || price <= 0) return;

    this.activeChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: this.remainingSize,
      limitPrice: price, orderType: 'LIMIT', timeInForce: 'IOC', algoType: 'SNIPER',
    });
    this._restingPrice = price;
    console.log(`[sniper] Snipe order: size=${this.remainingSize.toFixed(4)} price=${price} IOC`);
  }

  // ── Fill handling ───────────────────────────────────────────────────────

  onFill(fill) {
    if (!fill.fillSize || fill.fillSize <= 0) return;
    if (this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED') return;

    this.filledSize += fill.fillSize;
    this.remainingSize = Math.max(0, this.totalSize - this.filledSize);
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice = this.filledSize > 0 ? this.totalNotional / this.filledSize : 0;

    if (this.arrivalPrice > 0) {
      const dir = this.side === 'BUY' ? 1 : -1;
      this.slippageVsArrival = (this.avgFillPrice - this.arrivalPrice) / this.arrivalPrice * 10000 * dir;
    }

    // Determine fill source
    const isSnipeFill = fill.childId === this._snipeChildId || fill.orderId === this._snipeChildId;
    const isRestingFill = fill.childId === this.restingOrderId || fill.orderId === this.restingOrderId;
    const fillType = isSnipeFill ? 'snipe' : isRestingFill ? 'passive' : (this._executionMode === 'snipe' ? 'snipe' : 'unknown');

    if (fillType === 'snipe' || this._executionMode === 'snipe') {
      this.snipedSize += fill.fillSize;
    } else {
      this.passiveFillSize += fill.fillSize;
    }

    this._chartFills.push({
      time: Date.now(), price: fill.fillPrice, size: fill.fillSize,
      side: this.side, simulated: !!fill.simulated,
      fillType, // 'snipe' or 'passive'
    });

    console.log(`[sniper] Fill (${fillType}): ${fill.fillSize.toFixed(4)} @ ${fill.fillPrice} — remaining=${this.remainingSize.toFixed(4)} (passive=${this.passiveFillSize.toFixed(4)} sniped=${this.snipedSize.toFixed(4)})`);

    // Clear the child that filled
    if (isSnipeFill) this._snipeChildId = null;
    if (isRestingFill || (!isSnipeFill && !isRestingFill)) {
      this.activeChildId = null;
      this._restingPrice = null;
    }
    this._retryCount = 0;

    if (this.filledSize >= this.totalSize - 0.001) {
      this._completedTs = Date.now(); this.status = 'COMPLETED';
      console.log(`[sniper] COMPLETED at avg ${this.avgFillPrice.toFixed(4)}`);
      this.stop();
      return;
    }

    // Post+Snipe: after snipe fill, reduce resting order
    if (this._executionMode === 'post_snipe' && isSnipeFill && this.restingOrderId) {
      if (this.remainingSize <= this._lotSize * 0.5) {
        // Cancel resting — nothing left
        this._ctx.cancelChild(this.restingOrderId);
        this.restingOrderId = null;
        this.restingOrderSize = 0;
        console.log(`[sniper] Resting order cancelled — fully sniped`);
      } else {
        // Replace resting order with reduced size
        console.log(`[sniper] Reducing resting order: ${this.restingOrderSize.toFixed(4)} → ${this.remainingSize.toFixed(4)}`);
        this._placeRestingOrder();
      }
    }

    // Snipe mode: retrigger logic
    if (this._executionMode === 'snipe' && this.remainingSize > 0.001) {
      if (this._retriggerEnabled) {
        this._retriggerAt = Date.now() + this._retriggerCooldown;
        this.status = 'WAITING';
        this._prevMid = 0;
        console.log(`[sniper] Partial IOC — retrigger in ${this._retriggerCooldown}ms (${this.remainingSize.toFixed(4)} remaining)`);
      } else {
        this._completedTs = Date.now(); this.status = 'COMPLETED';
        console.log(`[sniper] Partial IOC — completed (${this.filledSize.toFixed(4)} of ${this.totalSize.toFixed(4)}, no retrigger)`);
        this.stop();
      }
    }
  }

  onOrderUpdate(order) {
    const matchId = order.orderId || order.intentId;
    if (matchId === this.activeChildId) {
      if (order.state === 'REJECTED' || order.state === 'CANCELLED') {
        console.log(`[sniper] Order ${matchId} ${order.state}`);
        this.activeChildId = null; this._restingPrice = null;
        this._retryCount++;
        if (this._retryCount >= 2) {
          this.pauseReason = `Rejected: ${order.rejectReason || order.state}`;
        } else {
          this._retryAt = Date.now() + 1000;
        }
      }
    }
    if (matchId === this._snipeChildId) {
      if (order.state === 'REJECTED' || order.state === 'CANCELLED') {
        console.log(`[sniper] Snipe order ${matchId} ${order.state}`);
        this._snipeChildId = null;
      }
    }
    if (matchId === this.restingOrderId) {
      if (order.state === 'REJECTED' || order.state === 'CANCELLED') {
        console.log(`[sniper] Resting order ${matchId} ${order.state}`);
        this.restingOrderId = null;
        this._restingPrice = null;
      }
    }
  }

  getState() {
    const now = Date.now();
    const isDone = this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'EXPIRED';
    const elapsed = this._startTs ? (isDone && this._completedTs ? this._completedTs - this._startTs : now - this._startTs) : 0;
    const mid = this._lastMd?.midPrice || 0;
    const distanceBps = mid > 0 && this._targetPrice > 0 ? (mid - this._targetPrice) / this._targetPrice * 10000 : 0;
    const distancePct = mid > 0 && this._targetPrice > 0 ? Math.max(0, 100 - Math.abs(distanceBps) / 2) : 0;

    return {
      type: 'SNIPER', symbol: this.symbol, side: this.side, venue: this.venue,
      status: this.status,
      totalSize: this.totalSize, filledQty: this.filledSize, remainingQty: this.remainingSize,
      avgFillPrice: this.avgFillPrice, arrivalPrice: this.arrivalPrice,
      slippageVsArrival: this.slippageVsArrival,
      targetPrice: this._targetPrice, triggerCondition: this._triggerCondition,
      executionMode: this._executionMode,
      snipeLevel: this._snipeLevel,
      retriggerEnabled: this._retriggerEnabled,
      distanceBps, distancePct,
      triggered: this._triggerTs > 0, triggerTs: this._triggerTs,
      expiryTs: this._expiryTs,
      activeOrderPrice: this._restingPrice,
      restingOrderSize: this.restingOrderSize,
      snipedSize: this.snipedSize,
      passiveFillSize: this.passiveFillSize,
      pauseReason: this.pauseReason,
      elapsed, timeRemaining: this._expiryTs ? Math.max(0, this._expiryTs - now) : null,
      tickSize: this._tickSize,
      maxChartPoints: this._chartMaxPts,
      chartBids: [...this._chartBids], chartAsks: [...this._chartAsks],
      chartOrder: [...this._chartOrder], chartTimes: [...this._chartTimes],
      chartFills: [...this._chartFills],
      chartTargetPrice: this._targetPrice,
      chartSnipeLevel: this._executionMode === 'post_snipe' ? this._snipeLevel : null,
    };
  }
}

function estimateDuration(params) {
  const price = params.targetPrice || '?';
  const mode = params.executionMode || 'snipe';
  if (mode === 'post_snipe') {
    const snipe = params.snipeLevel || '?';
    return `Post @ $${price} + snipe ceiling $${snipe}`;
  }
  const cond = params.triggerCondition || 'touches';
  const condLabel = cond === 'touches' ? 'touches' : cond === 'breaks_above' ? 'breaks above' : 'breaks below';
  return `Waiting for price ${condLabel} $${price}`;
}

module.exports = { config, Strategy: SniperStrategy, estimateDuration };
