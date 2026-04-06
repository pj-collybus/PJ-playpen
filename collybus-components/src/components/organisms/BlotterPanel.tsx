import { useState, useRef, useCallback, useMemo } from 'react'
import { BlotterTable, col } from '../shared/BlotterTable'
import type { BlotterColumn } from '../shared/BlotterTable'

// ── Public types ──

export interface BlotterOrder {
  id: string; exchange: string; exchangeSymbol?: string; timestamp: number; updatedAt?: number
  submittedAt?: number; instrument: string; type: string; side: string
  amount: number; filled: number; price: number; avgPrice?: number; leavesQty?: number
  tickSize?: number; status: string; rejectReason?: string; exchangeOrderId?: string
  linkId?: string; contingencyType?: string; triggered?: boolean; timeInForce?: string
  user?: string; account?: string; client?: string; comments?: string
  currency?: string; settleCurrency?: string; displayAmount?: number; stopPrice?: number
  numContracts?: number; remainingContracts?: number; filledContracts?: number; displayContracts?: number
  // Options
  optionStrike?: number; optionType?: string; optionExpiry?: number; iv?: number
}

export interface BlotterTrade {
  id: string; exchange: string; exchangeSymbol?: string; timestamp: number
  instrument: string; side: string; amount: number; price: number; fee: number
  feeCurrency?: string; orderId: string; exchangeOrderId?: string
  cumQty?: number; avgPrice?: number; leavesQty?: number
  usdRate?: number; usdValue?: number; settlementDate?: number
  user?: string; account?: string; client?: string; iv?: number
}

export interface BlotterPosition {
  id: string; exchange: string; exchangeSymbol?: string; instrument: string; side: string
  size: number; sizeUnit: string; value?: number; entryPrice: number; markPrice: number
  uPnl: number; rPnl: number; liqPrice: number; margin: number; updatedAt: number
  leverage?: number; marginMode?: string; adl?: number; contracts?: number
  initialMargin?: number; maintenanceMargin?: number; timeToExpiry?: string
  // Greeks (options)
  delta?: number; gamma?: number; vega?: number; theta?: number
}

export interface BlotterBalance {
  exchange: string; account?: string; currency: string; amount?: number
  available: number; total: number; reservedMargin: number
  unrealisedPnl: number; equity: number; lastChanged?: number
}

export interface BlotterAlgoOrder {
  strategyId: string; strategyType: string; exchange: string; symbol: string
  side: string; status: string; filledSize: number; avgFillPrice: number
  totalSize: number; targetPrice?: number; priceVariance?: number; priceSpread?: number
  timeInterval?: number; duration?: number; rejectReason?: string
  updatedAt: number; user?: string; account?: string; client?: string
  exchangeSymbol?: string; numContracts?: number; remainingContracts?: number
  filledContracts?: number; displayContracts?: number
}

export interface BlotterAlert {
  id: string; symbol?: string; exchange?: string; trigger?: string
  description?: string; status?: string; triggered?: boolean
  account?: string; user?: string; createdAt?: number; updatedAt?: number
}

export interface BlotterNotification {
  id: string; timestamp: number; eventType?: string; status?: string
  orderSide?: string; description?: string; symbol?: string; type?: string
  exchange?: string; sourceId?: string; acknowledged?: boolean
  user?: string; acknowledgedOn?: number
}

export interface BlotterData {
  orders: BlotterOrder[]; trades: BlotterTrade[]
  positions: BlotterPosition[]; balances: BlotterBalance[]
  algoStrategies?: BlotterAlgoOrder[]
  alerts?: BlotterAlert[]
  notifications?: BlotterNotification[]
}

export interface BlotterCallbacks {
  onCancelOrder?: (id: string, exchange: string) => void
  onCancelAll?: () => void
  onAmendOrder?: (order: BlotterOrder) => void
  onViewOrder?: (order: BlotterOrder) => void
}

interface BlotterPanelProps {
  data: BlotterData; callbacks?: BlotterCallbacks
  height: number; onHeightChange: (h: number) => void
}

// ── Tabs ──

const TABS = [
  'Orders', 'Trades', 'Positions', 'Options Orders', 'Options Trades',
  'Options Positions', 'Alert Blotter', 'Alert Search', 'Algo Orders',
  'Notifications', 'Notification Search', 'Cash Balance',
] as const
type TabType = (typeof TABS)[number]

// ── Period filter ──

function filterByPeriod<T extends { timestamp?: number; updatedAt?: number }>(items: T[], period: 'today' | 'yesterday' | 'week'): T[] {
  const utcNow = new Date()
  const utcTodayStart = Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate())
  const periodStart = period === 'today' ? utcTodayStart
    : period === 'yesterday' ? utcTodayStart - 86400000
    : utcTodayStart - 6 * 86400000
  const periodEnd = period === 'yesterday' ? utcTodayStart : Date.now()
  return items.filter(o => {
    const ts = o.updatedAt ?? o.timestamp ?? 0
    return ts >= periodStart && ts < periodEnd
  })
}

// ── Options filter ──

function isOptions(instrument: string): boolean {
  const upper = instrument.toUpperCase()
  return upper.endsWith('-C') || upper.endsWith('-P') || /-\d+[CP]$/i.test(upper) || /-(CALL|PUT)$/i.test(upper)
}

// ── Column definitions ──

function orderColumns(callbacks?: BlotterCallbacks): BlotterColumn[] {
  return [
    col('actions', '', { width: 52, minWidth: 52, sortable: false, defaultVisible: true, align: 'center',
      render: (_v, row) => row.status === 'open' ? (
        <div style={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
          <button onClick={e => { e.stopPropagation(); callbacks?.onCancelOrder?.(row.id, row.exchange) }} title="Cancel"
            style={{ width: 20, height: 20, background: 'rgba(251,44,54,0.12)', border: '1px solid rgba(251,44,54,0.25)', borderRadius: 3, color: '#FB2C36', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontFamily: 'inherit' }}
          >✕</button>
          <button onClick={e => { e.stopPropagation(); callbacks?.onAmendOrder?.(row as BlotterOrder) }} title="Amend"
            style={{ width: 20, height: 20, background: 'rgba(43,121,221,0.12)', border: '1px solid rgba(43,121,221,0.25)', borderRadius: 3, color: '#2B79DD', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit' }}
          >✎</button>
        </div>
      ) : null }),
    col('updatedAt', 'Updated Time', { width: 90, format: 'time' }),
    col('instrument', 'Symbol', { width: 130 }),
    col('exchangeSymbol', 'Exchange Symbol', { width: 130, defaultVisible: false }),
    col('exchange', 'Exchange', { width: 80 }),
    col('type', 'Order Type', { width: 70 }),
    col('status', 'Order Status', { width: 90, format: 'status' }),
    col('side', 'Side', { width: 60, format: 'side' }),
    col('filled', 'Cum Qty', { width: 90, format: 'qty', align: 'right' }),
    col('avgPrice', 'Avg Price', { width: 100, format: 'price', align: 'right' }),
    col('amount', 'Order Qty', { width: 90, format: 'qty', align: 'right' }),
    col('price', 'Order Price', { width: 100, format: 'price', align: 'right' }),
    col('leavesQty', 'Leaves Qty', { width: 90, format: 'qty', align: 'right' }),
    col('contingencyType', 'Contingency Type', { width: 110, defaultVisible: false }),
    col('triggered', 'Triggered', { width: 70, defaultVisible: false }),
    col('timeInForce', 'Time In Force', { width: 90 }),
    col('rejectReason', 'Reject Reason', { width: 150 }),
    col('id', 'Order ID', { width: 120 }),
    col('linkId', 'Link ID', { width: 100, defaultVisible: false }),
    col('exchangeOrderId', 'Exchange Order ID', { width: 130 }),
    col('user', 'User', { width: 80, defaultVisible: false }),
    col('account', 'Account', { width: 80, defaultVisible: false }),
    col('client', 'Client', { width: 80, defaultVisible: false }),
    col('comments', 'Comments', { width: 120, defaultVisible: false }),
    col('currency', 'Currency', { width: 70, defaultVisible: false }),
    col('settleCurrency', 'Settle Currency', { width: 90, defaultVisible: false }),
    col('displayAmount', 'Display Amount', { width: 100, format: 'qty', defaultVisible: false }),
    col('stopPrice', 'Stop Price', { width: 100, format: 'price', defaultVisible: false }),
    col('submittedAt', 'Submitted Time', { width: 90, format: 'time', defaultVisible: false }),
    col('numContracts', 'Number Contracts', { width: 110, format: 'number', defaultVisible: false }),
    col('remainingContracts', 'Remaining Contracts', { width: 120, format: 'number', defaultVisible: false }),
    col('filledContracts', 'Filled Contracts', { width: 110, format: 'number', defaultVisible: false }),
    col('displayContracts', 'Display Contracts', { width: 110, format: 'number', defaultVisible: false }),
  ]
}

function optionsOrderColumns(callbacks?: BlotterCallbacks): BlotterColumn[] {
  const base = orderColumns(callbacks)
  // Insert options-specific columns after instrument
  const idx = base.findIndex(c => c.key === 'exchangeSymbol')
  const optCols = [
    col('optionStrike', 'Option Strike', { width: 100, format: 'price', align: 'right' }),
    col('optionType', 'Option Type', { width: 80 }),
    col('optionExpiry', 'Option Expiry', { width: 100, format: 'date' }),
  ]
  return [...base.slice(0, idx), ...optCols, ...base.slice(idx)]
}

const TRADE_COLUMNS: BlotterColumn[] = [
  col('timestamp', 'Execution Time', { width: 90, format: 'time' }),
  col('instrument', 'Symbol', { width: 130 }),
  col('exchangeSymbol', 'Exchange Symbol', { width: 130, defaultVisible: false }),
  col('exchange', 'Exchange', { width: 80 }),
  col('side', 'Side', { width: 60, format: 'side' }),
  col('amount', 'Last Fill Qty', { width: 100, format: 'qty', align: 'right' }),
  col('price', 'Last Fill Price', { width: 100, format: 'price', align: 'right' }),
  col('user', 'User', { width: 80, defaultVisible: false }),
  col('account', 'Account', { width: 80, defaultVisible: false }),
  col('client', 'Client', { width: 80, defaultVisible: false }),
  col('id', 'Trade ID', { width: 120 }),
  col('orderId', 'Order ID', { width: 120 }),
  col('exchangeOrderId', 'Exchange Order ID', { width: 130, defaultVisible: false }),
  col('settlementDate', 'Settlement Date', { width: 100, format: 'date', defaultVisible: false }),
  col('fee', 'Exchange Fee', { width: 90, format: 'qty', align: 'right' }),
  col('feeCurrency', 'Exchange Fee Currency', { width: 110 }),
  col('cumQty', 'Cum Qty', { width: 90, format: 'qty', align: 'right', defaultVisible: false }),
  col('avgPrice', 'Avg Price', { width: 100, format: 'price', align: 'right', defaultVisible: false }),
  col('leavesQty', 'Leaves Qty', { width: 90, format: 'qty', align: 'right', defaultVisible: false }),
  col('usdRate', 'USD Rate', { width: 90, format: 'price', align: 'right', defaultVisible: false }),
  col('usdValue', 'USD Value', { width: 100, format: 'price', align: 'right', defaultVisible: false }),
]

function optionsTradeColumns(): BlotterColumn[] {
  const base = [...TRADE_COLUMNS]
  const idx = base.findIndex(c => c.key === 'user')
  return [...base.slice(0, idx), col('iv', 'IV', { width: 80, format: 'qty', align: 'right' }), ...base.slice(idx)]
}

const POSITION_COLUMNS: BlotterColumn[] = [
  col('instrument', 'Symbol', { width: 130 }),
  col('exchangeSymbol', 'Exchange Symbol', { width: 130, defaultVisible: false }),
  col('exchange', 'Exchange', { width: 80 }),
  col('account', 'Account', { width: 80, defaultVisible: false }),
  col('size', 'Amount', { width: 90, format: 'qty', align: 'right' }),
  col('value', 'Value', { width: 100, format: 'price', align: 'right' }),
  col('entryPrice', 'Entry Price', { width: 100, format: 'price', align: 'right' }),
  col('markPrice', 'Mark Price', { width: 100, format: 'price', align: 'right' }),
  col('uPnl', 'Unrealised PnL', { width: 110, format: 'pnl', align: 'right' }),
  col('rPnl', 'Realised PnL', { width: 110, format: 'pnl', align: 'right' }),
  col('liqPrice', 'Liquidation Price', { width: 110, format: 'price', align: 'right' }),
  col('leverage', 'Leverage', { width: 70, format: 'number', align: 'right' }),
  col('marginMode', 'Margin Mode', { width: 90, defaultVisible: false }),
  col('adl', 'ADL', { width: 50, format: 'number', defaultVisible: false }),
  col('contracts', 'Contracts', { width: 80, format: 'number', defaultVisible: false }),
  col('initialMargin', 'Initial Margin', { width: 100, format: 'price', align: 'right', defaultVisible: false }),
  col('maintenanceMargin', 'Maintenance Margin', { width: 120, format: 'price', align: 'right', defaultVisible: false }),
  col('timeToExpiry', 'Time to Expiry', { width: 100, defaultVisible: false }),
  col('updatedAt', 'Update Time', { width: 90, format: 'time', defaultVisible: false }),
]

const OPTIONS_POSITION_COLUMNS: BlotterColumn[] = [
  col('instrument', 'Symbol', { width: 130 }),
  col('exchangeSymbol', 'Exchange Symbol', { width: 130, defaultVisible: false }),
  col('exchange', 'Exchange', { width: 80 }),
  col('account', 'Account', { width: 80, defaultVisible: false }),
  col('size', 'Amount', { width: 90, format: 'qty', align: 'right' }),
  col('value', 'Value', { width: 100, format: 'price', align: 'right' }),
  col('entryPrice', 'Entry Price', { width: 100, format: 'price', align: 'right' }),
  col('markPrice', 'Mark Price', { width: 100, format: 'price', align: 'right' }),
  col('uPnl', 'Unrealised PnL', { width: 110, format: 'pnl', align: 'right' }),
  col('rPnl', 'PnL', { width: 100, format: 'pnl', align: 'right' }),
  col('contracts', 'Contracts', { width: 80, format: 'number', defaultVisible: false }),
  col('initialMargin', 'Initial Margin', { width: 100, format: 'price', align: 'right', defaultVisible: false }),
  col('maintenanceMargin', 'Maintenance Margin', { width: 120, format: 'price', align: 'right', defaultVisible: false }),
  col('delta', 'Delta', { width: 70, format: 'qty', align: 'right' }),
  col('gamma', 'Gamma', { width: 70, format: 'qty', align: 'right' }),
  col('vega', 'Vega', { width: 70, format: 'qty', align: 'right' }),
  col('theta', 'Theta', { width: 70, format: 'qty', align: 'right' }),
  col('timeToExpiry', 'Time to Expiry', { width: 100 }),
  col('updatedAt', 'Update Time', { width: 90, format: 'time', defaultVisible: false }),
]

const ALERT_COLUMNS: BlotterColumn[] = [
  col('updatedAt', 'Last Updated', { width: 90, format: 'time' }),
  col('symbol', 'Symbol', { width: 130 }),
  col('exchange', 'Exchange', { width: 80 }),
  col('trigger', 'Trigger', { width: 100 }),
  col('description', 'Description', { width: 200 }),
  col('status', 'Status', { width: 80, format: 'status' }),
  col('triggered', 'Triggered', { width: 70 }),
  col('account', 'Account', { width: 80 }),
  col('user', 'User', { width: 80 }),
  col('createdAt', 'Created', { width: 90, format: 'time' }),
]

const ALERT_SEARCH_COLUMNS: BlotterColumn[] = [
  ...ALERT_COLUMNS,
  col('editAlert', 'Edit Alert', { width: 70, sortable: false, align: 'center',
    render: () => (
      <button style={{ background: 'rgba(43,121,221,0.12)', border: '1px solid rgba(43,121,221,0.25)', borderRadius: 3, color: '#2B79DD', fontSize: 9, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>Edit</button>
    ) }),
  col('deleteAlert', 'Delete', { width: 60, sortable: false, align: 'center',
    render: () => (
      <button style={{ background: 'rgba(251,44,54,0.12)', border: '1px solid rgba(251,44,54,0.25)', borderRadius: 3, color: '#FB2C36', fontSize: 9, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>Del</button>
    ) }),
]

const ALGO_ORDER_COLUMNS: BlotterColumn[] = [
  col('updatedAt', 'Updated Time', { width: 90, format: 'time' }),
  col('symbol', 'Symbol', { width: 130 }),
  col('exchange', 'Exchange', { width: 80 }),
  col('status', 'Status', { width: 90, format: 'status' }),
  col('side', 'Side', { width: 60, format: 'side' }),
  col('filledSize', 'Cum Qty', { width: 90, format: 'qty', align: 'right' }),
  col('progress', 'Progress', { width: 100, minWidth: 80, sortable: false, align: 'left',
    render: (_v, row) => {
      const filled = row.filledSize || 0
      const total = row.totalSize || 0
      if (total <= 0) return null
      const pct = Math.min(100, (filled / total) * 100)
      const st = String(row.status ?? '').toUpperCase()
      const color = st === 'COMPLETED' ? '#00c896'
        : st === 'STOPPED' || st === 'ERROR' ? '#e05252'
        : st === 'PAUSED' ? '#f0a500'
        : '#4488ff'
      return (
        <div style={{ width: '100%', position: 'relative', height: 14 }}>
          <div style={{ position: 'absolute', inset: 0, background: '#1a1a28', borderRadius: 3, border: '1px solid #2a2a3a' }} />
          <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: `${pct}%`, background: color, borderRadius: 3, opacity: 0.85, transition: 'width 0.3s ease' }} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: pct > 45 ? '#000' : '#aaa', letterSpacing: '0.03em' }}>
            {pct.toFixed(0)}%
          </div>
        </div>
      )
    },
  }),
  col('avgFillPrice', 'Avg Price', { width: 100, format: 'price', align: 'right' }),
  col('totalSize', 'Order Qty', { width: 90, format: 'qty', align: 'right' }),
  col('targetPrice', 'Order Price', { width: 100, format: 'price', align: 'right' }),
  col('priceVariance', 'Price Variance', { width: 100, format: 'qty', align: 'right', defaultVisible: false }),
  col('priceSpread', 'Price Spread', { width: 100, format: 'qty', align: 'right', defaultVisible: false }),
  col('timeInterval', 'Time Interval', { width: 100, format: 'number', defaultVisible: false }),
  col('duration', 'Duration', { width: 80, format: 'number', defaultVisible: false }),
  col('rejectReason', 'Reject Reason', { width: 150, defaultVisible: false }),
  col('strategyId', 'Cl Ord ID', { width: 120 }),
  col('strategyType', 'Order ID', { width: 100 }),
  col('user', 'User Email', { width: 120, defaultVisible: false }),
  col('account', 'Account', { width: 80, defaultVisible: false }),
  col('client', 'Client', { width: 80, defaultVisible: false }),
  col('exchangeSymbol', 'Exchange Symbol', { width: 130, defaultVisible: false }),
  col('numContracts', 'Number Contracts', { width: 110, format: 'number', defaultVisible: false }),
  col('remainingContracts', 'Remaining Contracts', { width: 120, format: 'number', defaultVisible: false }),
  col('filledContracts', 'Filled Contracts', { width: 110, format: 'number', defaultVisible: false }),
  col('displayContracts', 'Display Contracts', { width: 110, format: 'number', defaultVisible: false }),
]

const NOTIFICATION_COLUMNS: BlotterColumn[] = [
  col('timestamp', 'Date & Time', { width: 90, format: 'time' }),
  col('eventType', 'Event Type', { width: 100 }),
  col('status', 'Status', { width: 80, format: 'status' }),
  col('orderSide', 'Order Side', { width: 70, format: 'side' }),
  col('description', 'Description', { width: 200 }),
  col('symbol', 'Symbol', { width: 130 }),
  col('type', 'Type', { width: 80 }),
  col('exchange', 'Exchange', { width: 80 }),
  col('sourceId', 'Source ID', { width: 120 }),
  col('acknowledged', 'Acknowledged', { width: 90 }),
  col('user', 'User', { width: 80 }),
  col('acknowledgedOn', 'Acknowledged On', { width: 100, format: 'time', defaultVisible: false }),
]

const NOTIFICATION_SEARCH_COLUMNS: BlotterColumn[] = [
  ...NOTIFICATION_COLUMNS,
  col('markRead', 'Mark as Read', { width: 90, sortable: false, align: 'center',
    render: (_v, row) => !row.acknowledged ? (
      <button style={{ background: 'rgba(43,121,221,0.12)', border: '1px solid rgba(43,121,221,0.25)', borderRadius: 3, color: '#2B79DD', fontSize: 9, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>Read</button>
    ) : <span style={{ color: '#636e82', fontSize: 9 }}>Read</span>
  }),
]

const CASH_BALANCE_COLUMNS: BlotterColumn[] = [
  col('exchange', 'Exchange', { width: 100 }),
  col('account', 'Account', { width: 100 }),
  col('available', 'Amount', { width: 120, format: 'qty', align: 'right' }),
  col('currency', 'Asset', { width: 80 }),
  col('lastChanged', 'Last Changed', { width: 100, format: 'time' }),
]

// ── Component ──

export function BlotterPanel({ data, callbacks, height, onHeightChange }: BlotterPanelProps) {
  const [tab, setTab] = useState<TabType>('Orders')
  const [collapsed, setCollapsed] = useState(false)
  const [period, setPeriod] = useState<'today' | 'yesterday' | 'week'>('today')
  const prevHeightRef = useRef(height)
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null)
  const tabScrollRef = useRef<HTMLDivElement>(null)

  const handleCollapse = () => {
    if (!collapsed) prevHeightRef.current = height
    setCollapsed(c => !c)
  }

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizeRef.current = { startY: e.clientY, startH: height }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      onHeightChange(Math.max(80, Math.min(600, resizeRef.current.startH + (resizeRef.current.startY - ev.clientY))))
    }
    const onUp = () => { resizeRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }, [height, onHeightChange])

  // Period-filtered data
  const filteredOrders = useMemo(() => filterByPeriod(data.orders, period), [data.orders, period])
  const filteredTrades = useMemo(() => filterByPeriod(data.trades, period), [data.trades, period])

  // Options-filtered data
  const optionsOrders = useMemo(() => filteredOrders.filter(o => isOptions(o.instrument)), [filteredOrders])
  const optionsTrades = useMemo(() => filteredTrades.filter(t => isOptions(t.instrument)), [filteredTrades])
  const optionsPositions = useMemo(() => data.positions.filter(p => isOptions(p.instrument)), [data.positions])

  // Trades with computed USD Value
  const tradesWithUsd = useMemo(() => filteredTrades.map(t => ({
    ...t,
    usdValue: t.usdValue ?? (t.usdRate ? t.amount * t.price * t.usdRate : undefined),
  })), [filteredTrades])
  const optionsTradesWithUsd = useMemo(() => optionsTrades.map(t => ({
    ...t,
    usdValue: t.usdValue ?? (t.usdRate ? t.amount * t.price * t.usdRate : undefined),
  })), [optionsTrades])

  // Tab counts
  const counts: Partial<Record<TabType, number>> = {
    Orders: filteredOrders.length,
    Trades: filteredTrades.length,
    Positions: data.positions.length,
    'Options Orders': optionsOrders.length,
    'Options Trades': optionsTrades.length,
    'Options Positions': optionsPositions.length,
    'Algo Orders': data.algoStrategies?.length ?? 0,
    'Cash Balance': data.balances.length,
  }

  // Memoize column definitions that depend on callbacks
  const orderCols = useMemo(() => orderColumns(callbacks), [callbacks])
  const optOrderCols = useMemo(() => optionsOrderColumns(callbacks), [callbacks])

  // Period filter tabs
  const showPeriodFilter = ['Orders', 'Trades', 'Options Orders', 'Options Trades'].includes(tab)

  // Cancel all button
  const showCancelAll = tab === 'Orders' && filteredOrders.some(o => o.status === 'open')

  return (
    <div style={{ position: 'relative', background: '#18171C', borderTop: '1px solid #363C4E', display: 'flex', flexDirection: 'column', height: collapsed ? 'auto' : height, flexShrink: 0 }}>
      {/* Resize handle */}
      {!collapsed && (
        <div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', top: -3, left: 0, right: 0, height: 6, cursor: 'row-resize', zIndex: 10 }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.25)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'} />
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: collapsed ? 'none' : '1px solid #1e1e2a', background: '#18171C', flexShrink: 0 }}>
        <div ref={tabScrollRef} style={{
          display: 'flex', alignItems: 'center', flex: 1, overflowX: 'auto', overflowY: 'hidden',
          paddingLeft: 4,
          scrollbarWidth: 'none',
        }}>
          {TABS.map(t => (
            <button key={t} onClick={() => { setTab(t); if (collapsed) setCollapsed(false) }} style={{
              background: 'none', border: 'none',
              borderBottom: t === tab ? '2px solid #2B79DD' : '2px solid transparent',
              color: t === tab ? 'rgba(255,255,255,0.9)' : '#636e82',
              fontSize: 11, fontWeight: t === tab ? 600 : 400,
              letterSpacing: '0.02em',
              padding: '6px 10px', cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', gap: 5, transition: 'color 0.15s',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}>
              {t}
              {(counts[t] ?? 0) > 0 && <span style={{
                background: t === tab ? 'rgba(43,121,221,0.2)' : 'rgba(99,110,130,0.15)',
                color: t === tab ? '#2B79DD' : '#636e82',
                borderRadius: 8, padding: '0 5px', fontSize: 9, fontWeight: 700, minWidth: 16, textAlign: 'center' as const,
              }}>{counts[t]}</span>}
            </button>
          ))}
        </div>
        <button onClick={handleCollapse} style={{
          background: 'none', border: 'none', borderBottom: '2px solid transparent',
          color: '#636e82', cursor: 'pointer', fontSize: 10, padding: '6px 8px',
          fontFamily: 'inherit', lineHeight: 1, flexShrink: 0,
        }}
          onMouseEnter={e => e.currentTarget.style.color = 'white'}
          onMouseLeave={e => e.currentTarget.style.color = '#636e82'}
        >{collapsed ? '▲' : '▼'}</button>
      </div>

      {/* Period filter + Cancel All */}
      {!collapsed && (showPeriodFilter || showCancelAll) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderBottom: '1px solid #1e1e2a',
          background: '#18171C', flexShrink: 0,
        }}>
          {showPeriodFilter && (['today', 'yesterday', 'week'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              background: period === p
                ? 'linear-gradient(to right, #1A3A94, #2B79DD)'
                : 'linear-gradient(to bottom, #3C3B42, #323138, #2B2A2F)',
              border: 'none', borderRadius: 4,
              color: period === p ? '#fff' : 'rgba(255,255,255,0.3)',
              fontSize: 9, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit',
            }}>
              {p === 'today' ? 'Today' : p === 'yesterday' ? 'Yesterday' : '7 Days'}
            </button>
          ))}
          {showCancelAll && (
            <button onClick={() => callbacks?.onCancelAll?.()} style={{
              background: 'rgba(251,44,54,0.12)', border: '1px solid rgba(251,44,54,0.3)',
              borderRadius: 4, color: '#FB2C36', fontSize: 9, fontWeight: 700,
              padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit', marginLeft: 'auto',
            }}>✕ Cancel All</button>
          )}
        </div>
      )}

      {/* Table content */}
      {!collapsed && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'Orders' && (
            <BlotterTable columns={orderCols} rows={filteredOrders as any[]} rowKey={r => r.id} storageKey="orders" emptyMessage="No orders" statusField="status"
              defaultSortKey="updatedAt" defaultSortDir="desc"
              onRowDoubleClick={r => {
                const o = r as unknown as BlotterOrder
                o.status === 'open' ? callbacks?.onAmendOrder?.(o) : callbacks?.onViewOrder?.(o)
              }} />
          )}
          {tab === 'Trades' && (
            <BlotterTable columns={TRADE_COLUMNS} rows={tradesWithUsd as any[]} rowKey={r => r.id} storageKey="trades" emptyMessage="No trades"
              defaultSortKey="timestamp" defaultSortDir="desc" />
          )}
          {tab === 'Positions' && (
            <BlotterTable columns={POSITION_COLUMNS} rows={data.positions as any[]} rowKey={r => r.id} storageKey="positions" emptyMessage="No open positions"
              defaultSortKey="updatedAt" defaultSortDir="desc" />
          )}
          {tab === 'Options Orders' && (
            <BlotterTable columns={optOrderCols} rows={optionsOrders as any[]} rowKey={r => r.id} storageKey="options-orders" emptyMessage="No options orders" statusField="status"
              defaultSortKey="updatedAt" defaultSortDir="desc"
              onRowDoubleClick={r => {
                const o = r as unknown as BlotterOrder
                o.status === 'open' ? callbacks?.onAmendOrder?.(o) : callbacks?.onViewOrder?.(o)
              }} />
          )}
          {tab === 'Options Trades' && (
            <BlotterTable columns={optionsTradeColumns()} rows={optionsTradesWithUsd as any[]} rowKey={r => r.id} storageKey="options-trades" emptyMessage="No options trades"
              defaultSortKey="timestamp" defaultSortDir="desc" />
          )}
          {tab === 'Options Positions' && (
            <BlotterTable columns={OPTIONS_POSITION_COLUMNS} rows={optionsPositions as any[]} rowKey={r => r.id} storageKey="options-positions" emptyMessage="No options positions"
              defaultSortKey="updatedAt" defaultSortDir="desc" />
          )}
          {tab === 'Alert Blotter' && (
            <BlotterTable columns={ALERT_COLUMNS} rows={data.alerts ?? []} rowKey={r => r.id} storageKey="alerts" emptyMessage="No alerts" statusField="status"
              defaultSortKey="updatedAt" defaultSortDir="desc" />
          )}
          {tab === 'Alert Search' && (
            <BlotterTable columns={ALERT_SEARCH_COLUMNS} rows={data.alerts ?? []} rowKey={r => r.id} storageKey="alert-search" emptyMessage="No alerts" statusField="status"
              defaultSortKey="updatedAt" defaultSortDir="desc" />
          )}
          {tab === 'Algo Orders' && (
            <BlotterTable columns={ALGO_ORDER_COLUMNS} rows={(data.algoStrategies ?? []) as any[]} rowKey={r => r.strategyId} storageKey="algo-orders" emptyMessage="No algo orders" statusField="status"
              defaultSortKey="updatedAt" defaultSortDir="desc" />
          )}
          {tab === 'Notifications' && (
            <BlotterTable columns={NOTIFICATION_COLUMNS} rows={(data.notifications ?? []) as any[]} rowKey={r => r.id} storageKey="notifications" emptyMessage="No notifications"
              defaultSortKey="timestamp" defaultSortDir="desc" />
          )}
          {tab === 'Notification Search' && (
            <BlotterTable columns={NOTIFICATION_SEARCH_COLUMNS} rows={(data.notifications ?? []) as any[]} rowKey={r => r.id} storageKey="notification-search" emptyMessage="No notifications"
              defaultSortKey="timestamp" defaultSortDir="desc" />
          )}
          {tab === 'Cash Balance' && (
            <BlotterTable columns={CASH_BALANCE_COLUMNS} rows={data.balances as any[]} rowKey={r => `${r.exchange}-${r.currency}`} storageKey="cash-balance" emptyMessage="No balance data — connect an exchange"
              defaultSortKey="lastChanged" defaultSortDir="desc" />
          )}
        </div>
      )}
    </div>
  )
}
