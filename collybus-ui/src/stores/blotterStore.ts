import { create } from 'zustand'
import { blotterApi } from '../services/apiClient'

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
  rejectReason?: string
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
  removeOrder: (id: string) => void
  fetchHistory: (period: 'today' | 'yesterday' | 'week') => Promise<void>
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
  removeOrder: (id) => set(s => {
    const { [id]: _, ...rest } = s.orders
    return { orders: rest }
  }),
  fetchHistory: async (period) => {
    try {
      const exchanges = ['DERIBIT', 'BITMEX']
      const results = await Promise.allSettled(
        exchanges.flatMap(exchange => [
          blotterApi.orders(exchange, period),
          blotterApi.trades(exchange, period),
        ])
      )
      set(s => {
        const mergedOrders = { ...s.orders }
        const mergedTrades = { ...s.trades }
        for (let i = 0; i < exchanges.length; i++) {
          const ordersResult = results[i * 2]
          const tradesResult = results[i * 2 + 1]
          if (ordersResult.status === 'fulfilled') {
            for (const o of ordersResult.value.data) {
              const id = o.orderId ?? o.id ?? o.order_id
              if (id && !mergedOrders[id]) {
                mergedOrders[id] = {
                  orderId: id, exchange: o.exchange ?? exchanges[i],
                  symbol: o.instrument ?? o.symbol ?? '',
                  side: ((o.side ?? '').toUpperCase() || 'BUY') as OrderSide,
                  orderType: (o.type ?? o.orderType ?? 'LIMIT').toUpperCase(),
                  quantity: o.amount ?? o.quantity ?? 0,
                  filledQuantity: o.filled ?? o.filledQuantity ?? 0,
                  remainingQuantity: (o.amount ?? o.quantity ?? 0) - (o.filled ?? o.filledQuantity ?? 0),
                  limitPrice: o.price ?? o.limitPrice ?? 0,
                  state: ((o.status ?? o.state ?? 'open').toUpperCase()) as OrderState,
                  createdAt: o.timestamp ?? o.createdAt ?? 0,
                  updatedAt: o.timestamp ?? o.updatedAt ?? 0,
                }
              }
            }
          }
          if (tradesResult.status === 'fulfilled') {
            for (const t of tradesResult.value.data) {
              const id = t.fillId ?? t.id ?? t.trade_id
              if (id && !mergedTrades[id]) {
                mergedTrades[id] = {
                  fillId: id, orderId: t.orderId ?? '',
                  exchange: t.exchange ?? exchanges[i],
                  symbol: t.instrument ?? t.symbol ?? '',
                  side: ((t.side ?? '').toUpperCase() || 'BUY') as OrderSide,
                  fillPrice: t.price ?? t.fillPrice ?? 0,
                  fillSize: t.amount ?? t.fillSize ?? 0,
                  fillTs: t.timestamp ?? t.fillTs ?? 0,
                  commission: t.fee ?? t.commission ?? 0,
                  slippageBps: 0, arrivalMid: 0,
                }
              }
            }
          }
        }
        return { orders: mergedOrders, trades: mergedTrades }
      })
    } catch (e) { console.error('[blotter] fetchHistory failed', e) }
  },
}))

if (typeof window !== 'undefined') {
  (window as any).__blotter = useBlotterStore
}
