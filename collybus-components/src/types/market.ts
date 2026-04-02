export interface Ticker {
  symbol: string;
  exchange: string;
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  markPrice: number;
  indexPrice: number;
  volume24h: number;
  openInterest: number;
  fundingRate?: number;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  symbol: string;
  exchange: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface InstrumentSpec {
  symbol: string;
  exchange: string;
  tickSize: number;
  lotSize: number;
  contractType: 'LINEAR' | 'INVERSE' | 'OPTION' | 'SPOT';
  baseCurrency: string;
  quoteCurrency: string;
  settleCurrency: string;
  minOrderSize: number;
  maxOrderSize: number;
}
