export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type OrderState = 'OPEN' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'PARTIALLY_FILLED';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTD';

export interface Order {
  orderId: string;
  venueOrderId?: string;
  clientOrderId?: string;
  exchange: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  limitPrice?: number;
  stopPrice?: number;
  avgFillPrice?: number;
  state: OrderState;
  timeInForce: TimeInForce;
  algoType?: string;
  parentOrderId?: string;
  strategyId?: string;
  createdAt: number;
  updatedAt: number;
  rejectReason?: string;
}

export interface Fill {
  fillId: string;
  orderId: string;
  exchange: string;
  symbol: string;
  side: OrderSide;
  fillPrice: number;
  fillSize: number;
  fillTs: number;
  commission: number;
  commissionAsset: string;
  slippageBps: number;
  arrivalMid: number;
}

export interface Position {
  exchange: string;
  symbol: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  size: number;
  sizeUnit: string;
  avgEntryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  realisedPnl: number;
  liquidationPrice: number;
  timestamp: number;
}

export interface Balance {
  exchange: string;
  currency: string;
  available: number;
  total: number;
  unrealisedPnl: number;
  timestamp: number;
}
