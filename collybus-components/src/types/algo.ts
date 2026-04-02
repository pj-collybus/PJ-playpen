export type StrategyType = 'TWAP' | 'VWAP' | 'SNIPER' | 'ICEBERG' | 'POV' | 'IS';
export type StrategyStatus = 'WAITING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' | 'ERROR';

export interface LevelState {
  price: number;
  pct: number;
  allocatedSize: number;
  filledSize: number;
  status: 'WAITING' | 'FIRING' | 'COMPLETED';
  retriggerCount: number;
}

export interface StrategyState {
  strategyId: string;
  type: StrategyType;
  status: StrategyStatus;
  exchange: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  totalSize: number;
  filledQty: number;
  remainingQty: number;
  avgFillPrice: number;
  arrivalPrice: number;
  slippageVsArrival: number;
  slippageVsVwap: number;
  startTime: number;
  elapsed: number;
  timeRemaining: number | null;
  summaryLine: string;
  // Chart data
  chartTimes: number[];
  chartBids: number[];
  chartAsks: number[];
  chartFills: ChartFill[];
  chartLevelPrices: { price: number; status: string }[];
  chartTargetPrice: number | null;
  chartSnipeLevel: number | null;
  // Strategy-specific
  levels?: LevelState[];
  executionMode?: string;
  levelMode?: string;
  tickSize?: number;
  [key: string]: unknown;
}

export interface ChartFill {
  time: number;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  fillType: string;
  simulated: boolean;
}

export interface StrategyParams {
  venue: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  totalSize: number;
  [key: string]: unknown;
}
