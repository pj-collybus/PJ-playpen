import { create } from 'zustand'

export type StrategyStatus = 'WAITING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'STOPPED' | 'ERROR'

export interface ChartFill {
  time: number
  price: number
  size: number
  side: string
  fillType: string
  simulated: boolean
}

export interface LevelState {
  price: number
  pct: number
  allocatedSize: number
  filledSize: number
  status: string
  retriggerCount: number
}

export interface StrategyState {
  strategyId: string
  type: string
  status: StrategyStatus
  exchange: string
  symbol: string
  side: string
  totalSize: number
  filledQty: number
  remainingQty: number
  avgFillPrice: number
  arrivalPrice: number
  slippageVsArrival: number
  slippageVsVwap: number
  startTime: number
  elapsed: number
  timeRemaining?: number
  summaryLine: string
  chartTimes: number[]
  chartBids: number[]
  chartAsks: number[]
  chartFills: ChartFill[]
  levels: LevelState[]
  chartTargetPrice?: number
  chartSnipeLevel?: number
  executionMode?: string
  levelMode?: string
  tickSize?: number
}

interface AlgoStore {
  strategies: Record<string, StrategyState>
  upsertStrategy: (state: StrategyState) => void
  removeStrategy: (strategyId: string) => void
}

export const useAlgoStore = create<AlgoStore>((set) => ({
  strategies: {},
  upsertStrategy: (strategy) =>
    set((s) => ({ strategies: { ...s.strategies, [strategy.strategyId]: strategy } })),
  removeStrategy: (strategyId) =>
    set((s) => {
      const { [strategyId]: _, ...rest } = s.strategies
      return { strategies: rest }
    }),
}))
