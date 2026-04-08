export interface OrderBookLevel {
  price: number
  size: number
}

export interface OrderBookData {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: number
}

export interface TickerData {
  bestBid: number
  bestAsk: number
  lastPrice: number
  markPrice: number
  high24h: number
  low24h: number
  change24h: number
  fundingRate?: number
  volume24h: number
  timestamp: number
}

export interface InstrumentInfo {
  symbol: string
  exchange?: string
  tickSize: number
  lotSize: number
  contractType: string
  baseCurrency: string
  quoteCurrency: string
  isPerp?: boolean
  kind?: string
  sizeUnit?: 'base' | 'quote' | 'contracts'
}

export type OrderTypeMode = 'LMT' | 'IOC' | 'S/L' | 'OCO'

export interface PricePanelConfig {
  exchange: string
  availableExchanges?: string[]
  granularityPresets?: { label: string; value: string }[]
  symbol: string
  granularity: number
  presetQtys: number[]
  defaultQty?: string
  selectedGranularity?: string
  favourites: string[]
  orderType: OrderTypeMode
  locked?: boolean
}

export interface PricePanelCallbacks {
  onSubmitOrder: (params: {
    exchange: string
    symbol: string
    side: 'BUY' | 'SELL'
    quantity: number
    limitPrice: number
    triggerPrice?: number
    orderType: string
    timeInForce?: string
  }) => Promise<void>
  onLaunchAlgo?: (params: any) => Promise<string>
  onMove?: (id: string, x: number, y: number) => void
  onResize?: (id: string, width: number) => void
  onClose?: (id: string) => void
  onConfigChange?: (id: string, config: Partial<PricePanelConfig>) => void
}
