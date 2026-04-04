// @ts-nocheck
/**
 * ChartCollector — encapsulates all time-series chart sampling for strategies.
 *
 * Decouples chart logic from execution logic. Each strategy creates one instance
 * and calls sample() on every tick. Extra series (VWAP, decision price etc) are
 * registered at construction time.
 *
 * Designed for future extraction to a shared charting service when the
 * market data component is connected.
 */

export interface ChartFill {
  time: number;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  simulated?: boolean;
  fillType?: string;
}

export interface ChartSnapshot {
  bids: number[];
  asks: number[];
  order: Array<number | null>;
  times: number[];
  fills: ChartFill[];
  [series: string]: unknown; // extra series e.g. vwap, decision
}

export class ChartCollector {
  private _bids: number[] = [];
  private _asks: number[] = [];
  private _order: Array<number | null> = [];
  private _times: number[] = [];
  private _fills: ChartFill[] = [];
  private _extras: Map<string, Array<number | null>> = new Map();
  private _sampleMs: number;
  private _maxPts: number;
  private _lastSampleTs = 0;

  constructor(sampleMs = 1000, maxPts = 3600) {
    this._sampleMs = sampleMs;
    this._maxPts = maxPts;
  }

  /** Register an extra series (e.g. 'vwap', 'decision') */
  addSeries(name: string) {
    this._extras.set(name, []);
    return this;
  }

  /** Called every tick. Returns true if a sample was recorded. */
  sample(
    bid: number,
    ask: number,
    restingPrice: number | null,
    isDone: boolean,
    extras: Record<string, number | null> = {},
  ): boolean {
    const now = Date.now();
    if (bid <= 0 || ask <= 0 || now - this._lastSampleTs < this._sampleMs) return false;

    this._lastSampleTs = now;
    this._bids.push(bid);
    this._asks.push(ask);
    this._order.push(isDone ? null : (restingPrice ?? null));
    this._times.push(now);

    for (const [name, arr] of this._extras) {
      arr.push(extras[name] ?? null);
    }

    if (this._bids.length > this._maxPts) {
      this._bids.shift(); this._asks.shift();
      this._order.shift(); this._times.shift();
      for (const arr of this._extras.values()) arr.shift();
    }

    return true;
  }

  /** Scale sample rate after long-running strategies (>1hr → 5s) */
  autoScale(elapsedMs: number) {
    if (elapsedMs > this._maxPts * 1000 && this._sampleMs < 5000) {
      this._sampleMs = 5000;
      this._maxPts = 7200;
    }
  }

  recordFill(fill: ChartFill) {
    this._fills.push(fill);
  }

  snapshot(): ChartSnapshot {
    const result: ChartSnapshot = {
      bids:  [...this._bids],
      asks:  [...this._asks],
      order: [...this._order],
      times: [...this._times],
      fills: [...this._fills],
    };
    for (const [name, arr] of this._extras) {
      result[name] = [...arr];
    }
    return result;
  }

  get maxPts() { return this._maxPts; }
  get sampleMs() { return this._sampleMs; }
}
