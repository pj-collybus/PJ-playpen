/**
 * VWAP — Volume-Weighted Average Price strategy.
 *
 * Targets the rolling VWAP price. Each interval: calculate market VWAP from
 * recent trades, calculate target participation size, submit limit at VWAP.
 */

'use strict';

const config = {
  name: 'VWAP',
  displayName: 'VWAP',
  description: 'Volume-weighted average price — targets market VWAP with participation rate cap',
  params: [
    { key: 'windowMinutes',        label: 'Window (minutes)',        type: 'number', default: 5,  min: 1 },
    { key: 'maxParticipationRate', label: 'Max participation rate %', type: 'number', default: 15, min: 1, max: 100 },
    { key: 'intervalSeconds',      label: 'Interval (seconds)',      type: 'number', default: 30, min: 5 },
  ],
};

class VWAPStrategy {
  constructor(params) {
    this.symbol               = params.symbol;
    this.side                 = params.side;
    this.totalSize            = params.totalSize;
    this.windowMinutes        = params.windowMinutes || 5;
    this.maxParticipationRate = params.maxParticipationRate || 15;
    this.intervalSeconds      = params.intervalSeconds || 30;

    this.filledQty     = 0;
    this.remainingQty  = this.totalSize;
    this.avgFillPrice  = 0;
    this.totalNotional = 0;
    this.openChildId   = null;
    this._timer        = null;
    this._stopped      = false;
    this._paused       = false;
    this._recentTrades = [];
    this._lastMid      = 0;
  }

  get type() { return 'VWAP'; }

  start(ctx) {
    this._ctx = ctx;
    this._executeInterval();
    this._timer = setInterval(() => {
      if (!this._paused && !this._stopped) this._executeInterval();
    }, this.intervalSeconds * 1000);
  }

  onTick(marketData) { this._lastMid = marketData.midPrice || this._lastMid; }

  onTrade(trade) {
    this._recentTrades.push({ price: trade.price, size: trade.size, ts: Date.now() });
    const cutoff = Date.now() - this.windowMinutes * 60_000;
    while (this._recentTrades.length > 0 && this._recentTrades[0].ts < cutoff) this._recentTrades.shift();
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

  _executeInterval() {
    if (this._stopped || this.remainingQty <= 0) return;
    if (this.openChildId) { this._ctx.cancelChild(this.openChildId); this.openChildId = null; }

    let totalNotional = 0, totalVolume = 0;
    for (const t of this._recentTrades) { totalNotional += t.price * t.size; totalVolume += t.size; }
    const vwap = totalVolume > 0 ? totalNotional / totalVolume : this._lastMid;
    if (vwap <= 0) return;

    const marketVolPerInterval = totalVolume / Math.max(1, this.windowMinutes * 60 / this.intervalSeconds);
    let targetSize = marketVolPerInterval * this.maxParticipationRate / 100;
    targetSize = Math.min(targetSize, this.remainingQty);
    if (targetSize <= 0) targetSize = Math.min(this.remainingQty, this.totalSize / 20);

    this.openChildId = this._ctx.submitIntent({
      symbol: this.symbol, side: this.side, quantity: targetSize,
      limitPrice: vwap, orderType: 'LIMIT', algoType: 'VWAP',
    });
  }

  getState() {
    return {
      type: 'VWAP', symbol: this.symbol, side: this.side, totalSize: this.totalSize,
      filledQty: this.filledQty, remainingQty: this.remainingQty,
      avgFillPrice: this.avgFillPrice, recentTradeCount: this._recentTrades.length,
    };
  }
}

function estimateDuration(params) {
  return `Est. completion: ${params.windowMinutes || 5} min window`;
}

module.exports = { config, Strategy: VWAPStrategy, estimateDuration };
