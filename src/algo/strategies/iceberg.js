/**
 * Iceberg — shows only a small visible quantity at a time.
 *
 * When visible quantity fills, immediately submit the next slice.
 * Visible size randomised +/- variancePct to avoid detection.
 */

'use strict';

const config = {
  name: 'ICEBERG',
  displayName: 'Iceberg',
  description: 'Hides total size — shows small visible quantity, refills on each fill',
  params: [
    { key: 'visibleSize',            label: 'Visible size',    type: 'number', default: 1, min: 0.001, step: 0.01 },
    { key: 'visibleSizeVariancePct', label: 'Variance %',      type: 'number', default: 10, min: 0, max: 50 },
    { key: 'limitPrice',             label: 'Limit price',     type: 'number', default: 0,  min: 0, step: 0.01 },
  ],
};

class IcebergStrategy {
  constructor(params) {
    this.symbol                 = params.symbol;
    this.side                   = params.side;
    this.totalSize              = params.totalSize;
    this.visibleSize            = params.visibleSize;
    this.visibleSizeVariancePct = params.visibleSizeVariancePct || 10;
    this.limitPrice             = params.limitPrice;

    this.filledQty     = 0;
    this.remainingQty  = this.totalSize;
    this.avgFillPrice  = 0;
    this.totalNotional = 0;
    this.openChildId   = null;
    this._stopped      = false;
    this._paused       = false;
  }

  get type() { return 'ICEBERG'; }

  start(ctx) { this._ctx = ctx; this._submitNextSlice(); }
  onTick() {}

  onFill(fill) {
    this.filledQty    += fill.fillSize;
    this.remainingQty  = this.totalSize - this.filledQty;
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice  = this.totalNotional / this.filledQty;
    this.openChildId   = null;
    if (this.remainingQty <= 0) this.stop();
    else if (!this._paused && !this._stopped) this._submitNextSlice();
  }

  pause()  { this._paused = true; }
  resume() { this._paused = false; if (!this.openChildId && this.remainingQty > 0) this._submitNextSlice(); }

  stop() {
    this._stopped = true;
    if (this.openChildId) { this._ctx.cancelChild(this.openChildId); this.openChildId = null; }
  }

  _submitNextSlice() {
    if (this._stopped || this.remainingQty <= 0) return;
    const variance   = this.visibleSize * this.visibleSizeVariancePct / 100;
    const randomised = this.visibleSize + (Math.random() - 0.5) * 2 * variance;
    const sliceSize  = Math.min(Math.max(randomised, 0.001), this.remainingQty);
    this.openChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: sliceSize,
      limitPrice: this.limitPrice, orderType: 'LIMIT', algoType: 'ICEBERG',
    });
  }

  getState() {
    return {
      type: 'ICEBERG', symbol: this.symbol, side: this.side, totalSize: this.totalSize,
      filledQty: this.filledQty, remainingQty: this.remainingQty,
      avgFillPrice: this.avgFillPrice, visibleSize: this.visibleSize,
    };
  }
}

function estimateDuration(params) {
  return `Est. completion: continuous until ${params.totalSize || '?'} filled`;
}

module.exports = { config, Strategy: IcebergStrategy, estimateDuration };
