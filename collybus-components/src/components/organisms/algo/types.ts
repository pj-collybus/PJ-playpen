// Shared types for AlgoMonitor components

export interface AlgoStatusReport {
  strategyId: string; strategyType: string; exchange: string; symbol: string; side: string
  status: string; totalSize: number; filledSize: number; remainingSize: number
  avgFillPrice: number; arrivalMid: number; slippageBps: number; vwapShortfallBps: number
  currentSlice: number; totalSlices: number; nextSliceAt: number | null
  pauseReason?: string | null; errorMessage: string | null; summaryLine?: string | null
  startedAt: number; updatedAt: number
  // Strategy-specific fields
  urgency?: string; activeOrderPrice?: number | null
  // SNIPER
  levels?: LevelState[]; activeLevelIndex?: number
  executionMode?: string; levelMode?: string
  restingOrderSize?: number; snipedSize?: number; passiveFillSize?: number
  postSnipePhase?: string; roundNumber?: number
  currentPostSize?: number; currentSnipeSize?: number
  snipePct?: number; maxSnipeTotal?: number; snipeCapUsed?: number; snipeCapRemaining?: number
  targetPrice?: number; snipeLevel?: number
  // TWAP/VWAP
  rollingVwap?: number; deviationFromVwap?: number; inParticipationBand?: boolean
  profileWeight?: number; currentUrgency?: string
  // IS
  isCostBps?: number; timingCostBps?: number; impactCostBps?: number
  optimalRate?: number; estimatedVolatility?: number
  // POV
  participationRate?: number; targetParticipation?: number
  windowVolume?: number; deficit?: number
  // ICEBERG
  visibleSize?: number; detectionRiskScore?: number
  // Chart
  chartBids?: number[]; chartAsks?: number[]; chartOrder?: (number | null)[]
  chartTimes?: number[]; chartFills?: ChartFill[]; chartVwap?: number[]
  chartTargetPrice?: number | null; chartSnipeLevel?: number | null
  chartLevelPrices?: { price: number; status: string }[]
  tickSize?: number
  // Fills list
  fills?: FillEntry[]
}

export interface LevelState {
  price: number; pct: number; allocatedSize: number; filledSize: number
  status: string; retriggerCount: number; active?: boolean
}

export interface ChartFill {
  time: number; price: number; size: number; side: string
  simulated?: boolean; fillType?: string
}

export interface FillEntry {
  fillPrice: number; fillSize: number; timestamp: number
  clientOrderId?: string; exchangeOrderId?: string; tag?: string
}

export const STATUS_COLORS: Record<string, string> = {
  Running: '#2B79DD', Waiting: '#636e82', Paused: '#F59E0B', Active: '#2B79DD',
  Completing: '#00C758', Completed: '#00C758', Stopped: '#636e82', Error: '#FB2C36', Expired: '#636e82',
}

export const LEVEL_COLORS = ['#00BFFF', '#FFD700', '#FF00FF', '#00FF7F', '#FF6347']

export const S = {
  bg: '#18171C', panel: '#141418', border: '#2a2a38', bgInput: '#0e0e14',
  positive: '#00C758', negative: '#FB2C36', blue: '#2B79DD', amber: '#F59E0B',
  text: 'rgba(255,255,255,0.85)', muted: '#636e82', dim: 'rgba(255,255,255,0.4)',
}
