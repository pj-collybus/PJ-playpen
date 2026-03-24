/**
 * Canonical event schemas — production contract.
 * All adapters and services MUST produce and consume these shapes exactly.
 * Switching from stubs to real Kafka/ClickHouse is a drop-in replacement.
 *
 * Topics:
 *   market.l1.bbo       → L1_BBO
 *   market.l2.book      → L2_BOOK
 *   market.trades       → TRADE
 *   orders.state        → ORDER
 *   orders.fills        → FILL
 *   orders.events       → ORDER_EVENT
 */

'use strict';

/**
 * @typedef {Object} L1_BBO
 * Level-1 best bid/offer snapshot.
 *
 * @property {string}  venue           - Venue ID e.g. "DERIBIT", "BINANCE"
 * @property {string}  instrumentClass - CRYPTO_SPOT | CRYPTO_PERP | CRYPTO_FUTURE | FX_SPOT
 * @property {string}  symbol          - Canonical symbol e.g. "BTC-PERP", "EURUSD"
 * @property {string}  venueSymbol     - Raw venue symbol e.g. "BTC-PERPETUAL"
 * @property {number}  exchangeTs      - Exchange timestamp (Unix ms)
 * @property {number}  receivedTs      - Local receipt timestamp (Unix ms)
 * @property {number|null} sequenceId  - Venue sequence number, null if unavailable
 * @property {number}  bidPrice
 * @property {number}  bidSize
 * @property {number}  bidOrderCount   - 0 if not provided by venue
 * @property {number}  askPrice
 * @property {number}  askSize
 * @property {number}  askOrderCount   - 0 if not provided by venue
 * @property {number}  midPrice        - (bidPrice + askPrice) / 2
 * @property {number}  spreadBps       - (askPrice - bidPrice) / midPrice * 10000
 * @property {string}  feedType        - "WEBSOCKET" | "REST" | "FIX"
 */

/**
 * @typedef {Object} L2_BOOK
 * Level-2 order book delta or snapshot.
 *
 * @property {string}  venue
 * @property {string}  symbol
 * @property {number}  exchangeTs
 * @property {number}  receivedTs
 * @property {number|null} sequenceId
 * @property {number|null} updateId    - Incremental update ID within a sequence
 * @property {'BID'|'ASK'} side
 * @property {number}  price
 * @property {number}  size            - 0 = remove level
 * @property {number}  orderCount      - 0 if not provided
 * @property {number}  levelDepth      - 0-indexed depth from best, -1 if unknown
 * @property {'SNAPSHOT'|'DELTA'|'CLEAR'} updateType
 */

/**
 * @typedef {Object} TRADE
 * Public trade print.
 *
 * @property {string}  venue
 * @property {string}  symbol
 * @property {number}  exchangeTs
 * @property {number}  receivedTs
 * @property {string}  tradeId
 * @property {number}  price
 * @property {number}  size
 * @property {'BUY'|'SELL'|'UNKNOWN'} side
 * @property {boolean} isLiquidation
 * @property {boolean} isBlockTrade
 * @property {number}  notionalUsd     - price * size * fxRate (USD)
 */

/**
 * @typedef {Object} ORDER
 * Full order lifecycle state.
 *
 * @property {string}  orderId         - Internal order ID (UUID)
 * @property {string}  venueOrderId    - Exchange-assigned ID, null until acknowledged
 * @property {string}  clientOrderId   - clOrdId sent to venue
 * @property {string}  venue
 * @property {string}  symbol
 * @property {'BUY'|'SELL'} side
 * @property {number}  quantity
 * @property {number}  filledQuantity
 * @property {number}  remainingQuantity
 * @property {number|null} limitPrice
 * @property {number|null} stopPrice
 * @property {'MARKET'|'LIMIT'|'STOP_LIMIT'|'STOP_MARKET'} orderType
 * @property {'PENDING'|'OPEN'|'PARTIAL'|'FILLED'|'CANCELLED'|'REJECTED'|'EXPIRED'} state
 * @property {number}  createdTs
 * @property {number}  updatedTs
 * @property {number|null} arrivalBid    - TCA anchor: best bid at order arrival
 * @property {number|null} arrivalAsk    - TCA anchor: best ask at order arrival
 * @property {number|null} arrivalMid    - TCA anchor: mid at order arrival
 * @property {number|null} arrivalSpreadBps
 * @property {string}  algoType        - "MANUAL" | "TWAP" | "VWAP" | "SOR" | "IOC"
 * @property {string|null} parentOrderId - For child orders from algos
 * @property {Object}  metadata        - Arbitrary key-value bag
 */

/**
 * @typedef {Object} FILL
 * Individual fill against an order.
 *
 * @property {string}  fillId
 * @property {string}  orderId
 * @property {string}  venue
 * @property {string}  symbol
 * @property {'BUY'|'SELL'} side
 * @property {number}  fillPrice
 * @property {number}  fillSize
 * @property {number}  fillTs          - Exchange fill timestamp (Unix ms)
 * @property {number}  receivedTs
 * @property {number}  commission
 * @property {string}  commissionAsset
 * @property {number}  slippageBps     - (fillPrice - arrivalMid) / arrivalMid * 10000 * sideSign
 * @property {number|null} arrivalMid  - Copied from parent ORDER at fill time
 */

/**
 * @typedef {Object} ORDER_EVENT
 * Immutable audit log entry for any order state transition or action.
 *
 * @property {string}  eventId         - UUID
 * @property {string}  orderId
 * @property {string}  eventType       - "SUBMIT" | "ACK" | "PARTIAL_FILL" | "FILL" |
 *                                       "CANCEL_REQUEST" | "CANCELLED" | "REJECT" |
 *                                       "EXPIRE" | "REPLACE_REQUEST" | "REPLACED"
 * @property {string}  stateBefore     - ORDER.state before event
 * @property {string}  stateAfter      - ORDER.state after event
 * @property {number}  eventTs         - Unix ms
 * @property {string}  actor           - "TRADER" | "ALGO" | "VENUE" | "SYSTEM"
 * @property {string|null} rawMessage  - Raw venue message (JSON string), null for internal events
 * @property {Object}  metadata        - e.g. { rejectReason: "...", fillPrice: 0 }
 */

/** Instrument class enum */
const InstrumentClass = Object.freeze({
  CRYPTO_SPOT:   'CRYPTO_SPOT',
  CRYPTO_PERP:   'CRYPTO_PERP',
  CRYPTO_FUTURE: 'CRYPTO_FUTURE',
  FX_SPOT:       'FX_SPOT',
});

/** Feed type enum */
const FeedType = Object.freeze({
  WEBSOCKET: 'WEBSOCKET',
  REST:      'REST',
  FIX:       'FIX',
});

/** Order state enum */
const OrderState = Object.freeze({
  PENDING:   'PENDING',
  OPEN:      'OPEN',
  PARTIAL:   'PARTIAL',
  FILLED:    'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED:  'REJECTED',
  EXPIRED:   'EXPIRED',
});

/** Order event type enum */
const OrderEventType = Object.freeze({
  SUBMIT:          'SUBMIT',
  ACK:             'ACK',
  PARTIAL_FILL:    'PARTIAL_FILL',
  FILL:            'FILL',
  CANCEL_REQUEST:  'CANCEL_REQUEST',
  CANCELLED:       'CANCELLED',
  REJECT:          'REJECT',
  EXPIRE:          'EXPIRE',
  REPLACE_REQUEST: 'REPLACE_REQUEST',
  REPLACED:        'REPLACED',
});

/**
 * @typedef {Object} POSITION
 * Position state from a venue.
 * @property {string}  venue
 * @property {string}  symbol
 * @property {'LONG'|'SHORT'|'FLAT'} side
 * @property {number}  size          - Absolute position size in base currency units
 * @property {string}  sizeUnit      - Base currency e.g. 'BTC', 'ETH', 'SOL'
 * @property {number}  avgEntryPrice
 * @property {number}  unrealisedPnl
 * @property {number}  liquidationPrice
 * @property {number}  timestamp
 */

/**
 * @typedef {Object} BALANCE
 * Account balance from a venue.
 * @property {string}  venue
 * @property {string}  currency
 * @property {number}  available
 * @property {number}  total
 * @property {number}  unrealisedPnl
 * @property {number}  timestamp
 */

/** Kafka topic names */
const Topics = Object.freeze({
  L1_BBO:      'market.l1.bbo',
  L2_BOOK:     'market.l2.book',
  TRADES:      'market.trades',
  ORDERS:      'orders.state',
  FILLS:       'orders.fills',
  ORDER_EVENTS:'orders.events',
  POSITIONS:   'account.positions',
  BALANCES:    'account.balances',
});

module.exports = { InstrumentClass, FeedType, OrderState, OrderEventType, Topics };
