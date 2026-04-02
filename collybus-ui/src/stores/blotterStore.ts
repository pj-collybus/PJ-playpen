import { create } from 'zustand'

export type OrderSide = 'BUY' | 'SELL'
export type OrderState = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'PARTIALLY_FILLED'

export interface Order {
  orderId: string
  venueOrderId?: string
  exchange: string
  symbol: string
  side: OrderSide
  orderType: string
  quantity: number
  filledQuantity: number
  remainingQuantity: number
  limitPrice?: number
  avgFillPrice?: number
  state: OrderState
  algoType?: string
  strategyId?: string
  createdAt: number
  updatedAt: number
}

export interface Fill {
  fillId: string
  orderId: string
  exchange: string
  symbol: string
  side: OrderSide
  fillPrice: number
  fillSize: number
  fillTs: number
  commission: number
  slippageBps: number
  arrivalMid: number
}

export interface Position {
  exchange: string
  symbol: string
  side: string
  size: number
  sizeUnit: string
  avgEntryPrice: number
  markPrice: number
  unrealisedPnl: number
  realisedPnl: number
  timestamp: number
}

export interface Balance {
  exchange: string
  currency: string
  available: number
  total: number
  unrealisedPnl: number
  timestamp: number
}

interface BlotterStore {
  orders: Record<string, Order>
  trades: Record<string, Fill>
  positions: Record<string, Position>
  balances: Record<string, Balance>
  upsertOrder: (order: Order) => void
  upsertTrade: (trade: Fill) => void
  upsertPosition: (position: Position) => void
  upsertBalance: (balance: Balance) => void
}

export const useBlotterStore = create<BlotterStore>((set) => ({
  orders: {},
  trades: {},
  positions: {},
  balances: {},
  upsertOrder: (order) =>
    set((s) => ({ orders: { ...s.orders, [order.orderId]: order } })),
  upsertTrade: (trade) =>
    set((s) => ({ trades: { ...s.trades, [trade.fillId]: trade } })),
  upsertPosition: (position) => {
    const key = `${position.exchange}:${position.symbol}`
    set((s) => ({ positions: { ...s.positions, [key]: position } }))
  },
  upsertBalance: (balance) => {
    const key = `${balance.exchange}:${balance.currency}`
    set((s) => ({ balances: { ...s.balances, [key]: balance } }))
  },
}))
