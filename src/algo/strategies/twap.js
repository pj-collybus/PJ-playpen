/**
 * TWAP — Time-Weighted Average Price strategy.
 *
 * Divides parent order into equal time slices.
 * Each slice submits a limit order at mid price.
 * If a slice is unfilled after intervalSeconds, cancel and carry forward.
 */

'use strict';

const config = {
  name: 'TWAP',
  displayName: 'TWAP',
  description: 'Time-weighted average price execution — splits order into equal time slices',
  params: [
    { key: 'numSlices',            label: 'Number of slices',    type: 'number', default: 10,  min: 2, max: 100 },
    { key: 'intervalSeconds',      label: 'Interval (seconds)',  type: 'number', default: 30,  min: 5 },
    { key: 'limitPriceTolerance',  label: 'Price tolerance %',   type: 'number', default: 1,   min: 0, step: 0.1 },
  ],
};

class TWAPStrategy {
  constructor(params) {
    this.symbol               = params.symbol;
    this.side                 = params.side;
    this.totalSize            = params.totalSize;
    this.numSlices            = params.numSlices || 10;
    this.intervalSeconds      = params.intervalSeconds || 30;
    this.limitPriceTolerance  = params.limitPriceTolerance || 1;

    this.filledQty     = 0;
    this.remainingQty  = this.totalSize;
    this.avgFillPrice  = 0;
    this.totalNotional = 0;
    this.currentSlice  = 0;
    this.carryForward  = 0;
    this.openChildId   = null;
    this._timer        = null;
    this._stopped      = false;
    this._paused       = false;
    this._lastMid      = 0;
  }

  get type() { return 'TWAP'; }

  start(ctx) {
    this._ctx = ctx;
    this._executeSlice();
    this._timer = setInterval(() => {
      if (!this._paused && !this._stopped) this._executeSlice();
    }, this.intervalSeconds * 1000);
  }

  onTick(marketData) {
    if (this.openChildId && marketData.midPrice > 0 && this._lastMid > 0) {
      const drift = Math.abs(marketData.midPrice - this._lastMid) / this._lastMid * 100;
      if (drift > this.limitPriceTolerance) {
        this._ctx.cancelChild(this.openChildId);
        this.openChildId = null;
      }
    }
    this._lastMid = marketData.midPrice;
  }

  onFill(fill) {
    this.filledQty    += fill.fillSize;
    this.remainingQty  = this.totalSize - this.filledQty;
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice  = this.totalNotional / this.filledQty;
    this.openChildId   = null;
    if (this.remainingQty <= 0) this.stop();
  }

  pause()  { this._paused = true; }
  resume() { this._paused = false; }

  stop() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.openChildId) { this._ctx.cancelChild(this.openChildId); this.openChildId = null; }
  }

  _executeSlice() {
    if (this._stopped || this.remainingQty <= 0) return;
    if (this.openChildId) { this._ctx.cancelChild(this.openChildId); this.openChildId = null; }

    this.currentSlice++;
    const baseSliceSize = this.totalSize / this.numSlices;
    const sliceSize     = Math.min(baseSliceSize + this.carryForward, this.remainingQty);
    this.carryForward   = 0;
    if (sliceSize <= 0) return;

    const mid = this._lastMid || 0;
    if (mid <= 0) { this.carryForward += sliceSize; return; }

    this.openChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: sliceSize,
      limitPrice: mid, orderType: 'LIMIT', algoType: 'TWAP',
    });
  }

  getState() {
    return {
      type: 'TWAP', symbol: this.symbol, side: this.side, totalSize: this.totalSize,
      filledQty: this.filledQty, remainingQty: this.remainingQty,
      avgFillPrice: this.avgFillPrice, currentSlice: this.currentSlice, numSlices: this.numSlices,
    };
  }
}

function estimateDuration(params) {
  const secs = (params.numSlices || 10) * (params.intervalSeconds || 30);
  const mins = Math.round(secs / 60);
  return mins >= 1 ? `Est. completion: ~${mins} min` : `Est. completion: ~${secs}s`;
}

module.exports = { config, Strategy: TWAPStrategy, estimateDuration };
