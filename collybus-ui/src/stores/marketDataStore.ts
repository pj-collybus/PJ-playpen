import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

export interface Ticker {
  symbol: string
  exchange: string
  bestBid: number
  bestAsk: number
  lastPrice: number
  markPrice: number
  indexPrice: number
  volume24h: number
  high24h: number
  low24h: number
  change24h: number
  openInterest: number
  fundingRate?: number
  timestamp: number
}

export interface OrderBookLevel {
  price: number
  size: number
}

export interface OrderBook {
  symbol: string
  exchange: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: number
}

interface MarketDataStore {
  tickers: Record<string, Ticker>
  orderBooks: Record<string, OrderBook>
  instruments: Record<string, any[]>
  setTicker: (key: string, ticker: Ticker) => void
  setOrderBook: (key: string, book: OrderBook) => void
  setInstruments: (exchange: string, instruments: any[]) => void
}

export const useMarketDataStore = create<MarketDataStore>()(
  subscribeWithSelector((set) => ({
    tickers: {},
    orderBooks: {},
    instruments: {},
    setTicker: (key, ticker) =>
      set((s) => ({ tickers: { ...s.tickers, [key]: ticker } })),
    setOrderBook: (key, book) =>
      set((s) => {
        const existing = s.orderBooks[key]
        if (existing && existing.timestamp > book.timestamp) return s
        return { orderBooks: { ...s.orderBooks, [key]: book } }
      }),
    setInstruments: (exchange, instruments) =>
      set((s) => ({ instruments: { ...s.instruments, [exchange]: instruments } })),
  }))
)
