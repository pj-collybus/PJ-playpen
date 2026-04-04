/**
 * Shared types for the Collybus algo engine.
 * All strategies and the engine use these interfaces.
 */

// ── Market data tick ──────────────────────────────────────────────────────────

export interface MarketData {
  symbol: string;
  venueSymbol?: string;
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  spreadBps: number;
  lastPrice?: number;
  timestamp?: number;
}

export interface TradeData {
  symbol: string;
  venueSymbol?: string;
  venue?: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
  synthetic?: boolean;
}

export interface FillData {
  childId?: string;
  orderId?: string;
  intentId?: string;
  strategyId?: string;
  symbol: string;
  venue?: string;
  side: 'BUY' | 'SELL';
  fillSize: number;
  fillPrice: number;
}

export interface OrderUpdate {
  orderId?: string;
  intentId?: string;
  state: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
  filledSize?: number;
  price?: number;
}

// ── Strategy context (injected by engine) ────────────────────────────────────

export interface StrategyContext {
  submitIntent: (intent: OrderIntent) => string | null;
  cancelChild: (childId: string) => void;
}

export interface OrderIntent {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  limitPrice: number;
  orderType?: 'LIMIT' | 'MARKET';
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTD';
  algoType?: string;
}

// ── Strategy interface — all strategies must implement this ──────────────────

export interface IStrategy {
  symbol: string;
  side: 'BUY' | 'SELL';
  totalSize: number;
  filledSize: number;
  remainingSize: number;
  status: StrategyStatus;

  start(ctx: StrategyContext): void;
  stop(): void;
  pause(): void;
  resume(): void;
  onTick(data: MarketData): void;
  onTrade?(data: TradeData): void;
  onFill(data: FillData): void;
  onOrderUpdate?(data: OrderUpdate): void;
  getState(): Record<string, unknown>;
}

export type StrategyStatus =
  | 'WAITING'
  | 'ACTIVE'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETING'
  | 'COMPLETED'
  | 'STOPPED'
  | 'EXPIRED'
  | 'ERROR';

export type EngineState = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ERROR' | 'COMPLETED';

// ── Strategy config (used for UI param rendering) ────────────────────────────

export interface ParamDef {
  key: string;
  label: string;
  type: 'select' | 'number' | 'text' | 'ladder';
  options?: Array<string | { value: string; label: string }>;
  default?: unknown;
  min?: number;
  max?: number;
  dependsOn?: Record<string, string>;
}

export interface StrategyConfig {
  name: string;
  displayName: string;
  description: string;
  params: ParamDef[];
}

// ── Engine IPC messages ───────────────────────────────────────────────────────

export interface EngineMessage {
  type: string;
  strategyId?: string;
  payload?: unknown;
  [key: string]: unknown;
}

// ── Sniper-specific level ────────────────────────────────────────────────────

export interface SniperLevel {
  price: number;
  pct: number;
  size?: number;
  allocatedSize: number;
  filledSize: number;
  status: 'WAITING' | 'CONFIRMING' | 'FIRING' | 'COMPLETED';
  retriggerCount: number;
  currentSnipePrice: number;
  volumeAtLevel: number;
  lastVolumeWindowStart: number;
  icebergRemaining: number;
  nextIcebergAt: number;
  activeChildId: string | null;
  _intentSubmittedAt?: number;
  _retriggerAt?: number;
  enabled?: boolean;
  levelIndex?: number;
}

// ── Discretion ───────────────────────────────────────────────────────────────

export interface DiscretionLevel {
  price: number;
  pct: number;
  size?: number;
  levelIndex: number;
  enabled: boolean;
}

export interface DiscretionLevelResult extends DiscretionLevel {
  size: number;
}

export interface DiscretionCalculateResult {
  discretionPrice: number;
  discretionBps: number;
  discretionPct: number;
  side: string;
  limitPrice: number;
  levels: DiscretionLevel[];
  postSize: number | null;
  snipeSize: number | null;
}

export interface SniperParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  venue?: string;
  totalSize: number;
  tickSize?: number;
  lotSize?: number;
  executionMode?: 'snipe' | 'post_snipe';
  levelMode?: 'sequential' | 'simultaneous';
  targetPrice?: number;
  snipeLevel?: number;
  snipePct?: number;
  minSnipePct?: number;
  levels?: Array<{ price: number; pct?: number; size?: number; allocationPct?: number; enabled?: boolean; index?: number }>;
  maxSpreadBps?: number;
  expiryMode?: 'gtc' | 'time' | 'eod';
  expiryTime?: string;
  volumeConfirmEnabled?: boolean | string;
  volumeConfirmSize?: number;
  volumeConfirmWindowMs?: number;
  momentumFilterEnabled?: boolean | string;
  momentumLookbackMs?: number;
  momentumMinBps?: number;
  retriggerMode?: 'same' | 'better' | 'vwap';
  retriggerImproveTicks?: number;
  retriggerCooldownMs?: number;
  maxRetriggers?: number;
  icebergEnabled?: boolean | string;
  icebergSlicePct?: number;
  icebergDelayMinMs?: number;
  icebergDelayMaxMs?: number;
  isDiscretionOrder?: boolean;
  // Arrival prices (from OrderModal)
  arrivalMid?: number;
  arrivalBid?: number;
  arrivalAsk?: number;
  // Legacy field name support
  postPrice?: number;
  snipeCeiling?: number;
  snipeCap?: number;
}
