/**
 * POV — Percentage of Volume strategy.
 *
 * Each time a market trade arrives, submit a child order for targetPct
 * of that trade's size, up to remaining parent size. Price limit acts
 * as a hard ceiling (buy) or floor (sell).
 */

'use strict';

const config = {
  name: 'POV',
  displayName: 'POV',
  description: 'Percentage of volume — trades a target % of market volume with price limit',
  params: [
    { key: 'targetPct',  label: 'Target volume %', type: 'number', default: 10, min: 1, max: 100 },
    { key: 'priceLimit', label: 'Price limit',      type: 'number', default: 0,  min: 0, step: 0.01 },
  ],
};

class POVStrategy {
  constructor(params) {
    this.symbol     = params.symbol;
    this.side       = params.side;
    this.totalSize  = params.totalSize;
    this.targetPct  = params.targetPct || 10;
    this.priceLimit = params.priceLimit || null;

    this.filledQty     = 0;
    this.remainingQty  = this.totalSize;
    this.avgFillPrice  = 0;
    this.totalNotional = 0;
    this.childIds      = new Set();
    this._stopped      = false;
    this._paused       = false;
  }

  get type() { return 'POV'; }

  start(ctx) { this._ctx = ctx; }
  onTick() {}

  onTrade(trade) {
    if (this._stopped || this._paused || this.remainingQty <= 0) return;
    if (trade.symbol !== this.symbol) return;

    let childSize = trade.size * this.targetPct / 100;
    childSize = Math.min(childSize, this.remainingQty);
    if (childSize <= 0) return;

    const price = trade.price;
    if (this.priceLimit) {
      if (this.side === 'BUY' && price > this.priceLimit) return;
      if (this.side === 'SELL' && price < this.priceLimit) return;
    }

    const childId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: childSize,
      limitPrice: price, orderType: 'LIMIT', algoType: 'POV',
    });
    this.childIds.add(childId);
  }

  onFill(fill) {
    this.filledQty    += fill.fillSize;
    this.remainingQty  = this.totalSize - this.filledQty;
    this.totalNotional += fill.fillPrice * fill.fillSize;
    this.avgFillPrice  = this.totalNotional / this.filledQty;
    this.childIds.delete(fill.childId);
    if (this.remainingQty <= 0) this.stop();
  }

  pause()  { this._paused = true; }
  resume() { this._paused = false; }

  stop() {
    this._stopped = true;
    for (const cid of this.childIds) this._ctx.cancelChild(cid);
    this.childIds.clear();
  }

  getState() {
    return {
      type: 'POV', symbol: this.symbol, side: this.side, totalSize: this.totalSize,
      filledQty: this.filledQty, remainingQty: this.remainingQty,
      avgFillPrice: this.avgFillPrice, targetPct: this.targetPct, openChildren: this.childIds.size,
    };
  }
}

function estimateDuration(params) {
  return `Est. completion: market-paced — target ${params.targetPct || 10}% of volume`;
}

module.exports = { config, Strategy: POVStrategy, estimateDuration };
