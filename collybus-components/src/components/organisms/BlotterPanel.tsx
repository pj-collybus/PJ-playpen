import { useState, useRef, useCallback, useMemo } from 'react'
import { BlotterTable, type BlotterColumn } from '../shared/BlotterTable'
import { StatusPill } from '../atoms/StatusPill'
import { SideChip } from '../atoms/SideChip'
import { PnlCell } from '../atoms/PnlCell'

export interface BlotterOrder {
  id: string; exchange: string; timestamp: number; instrument: string
  type: string; side: string; amount: number; filled: number; price: number; status: string
}
export interface BlotterTrade {
  id: string; exchange: string; timestamp: number; instrument: string
  side: string; amount: number; price: number; fee: number; orderId: string
}
export interface BlotterPosition {
  id: string; exchange: string; instrument: string; side: string
  size: number; sizeUnit: string; entryPrice: number; markPrice: number
  uPnl: number; rPnl: number; liqPrice: number; margin: number; updatedAt: number
}
export interface BlotterBalance {
  exchange: string; currency: string; available: number; total: number
  reservedMargin: number; unrealisedPnl: number; equity: number
}
export interface BlotterData {
  orders: BlotterOrder[]; trades: BlotterTrade[]
  positions: BlotterPosition[]; balances: BlotterBalance[]
}
export interface BlotterCallbacks {
  onCancelOrder?: (id: string, exchange: string) => void
}

interface BlotterPanelProps {
  data: BlotterData; callbacks?: BlotterCallbacks
  height: number; onHeightChange: (h: number) => void
}

const TABS = ['Orders', 'Trades', 'Positions', 'Balances'] as const
type TabType = typeof TABS[number]

const EXCH_COLORS: Record<string, string> = {
  DERIBIT: '#e03040', BITMEX: '#4a90d9', BINANCE: '#f0b90b',
  BYBIT: '#f7a600', OKX: '#aaaaaa', KRAKEN: '#8d5ff0',
}

function ExchPill({ ex }: { ex: string }) {
  const c = EXCH_COLORS[ex] ?? '#555'
  return <span style={{ background: `${c}22`, color: c, border: `1px solid ${c}44`, borderRadius: 3, padding: '1px 5px', fontSize: 9, fontWeight: 700 }}>{ex}</span>
}

const fmtTs = (ts: number) => new Date(ts).toLocaleTimeString('en-US', { hour12: false })
const fmtN = (n: number, dp = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })

export function BlotterPanel({ data, callbacks, height, onHeightChange }: BlotterPanelProps) {
  const [tab, setTab] = useState<TabType>('Orders')
  const [collapsed, setCollapsed] = useState(false)
  const [period, setPeriod] = useState<'today' | 'yesterday' | 'week'>('today')
  const prevHeightRef = useRef(height)
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null)

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

  const { filteredOrders, filteredTrades } = useMemo(() => {
    const utcNow = new Date()
    const utcTodayStart = Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate())
    const utcYesterdayStart = utcTodayStart - 86400000
    const utcWeekStart = utcTodayStart - 6 * 86400000
    const now = Date.now()

    const periodStart = period === 'today' ? utcTodayStart
      : period === 'yesterday' ? utcYesterdayStart
      : utcWeekStart
    const periodEnd = period === 'yesterday' ? utcTodayStart : now

    return {
      filteredOrders: data.orders.filter(o => o.timestamp >= periodStart && o.timestamp < periodEnd),
      filteredTrades: data.trades.filter(t => t.timestamp >= periodStart && t.timestamp < periodEnd),
    }
  }, [data.orders, data.trades, period])

  const counts: Record<TabType, number> = {
    Orders: filteredOrders.length,
    Trades: filteredTrades.length,
    Positions: data.positions.length,
    Balances: data.balances.length,
  }

  const orderCols: BlotterColumn<BlotterOrder>[] = [
    { key: 'exchange', label: 'Exch', width: 80, render: r => <ExchPill ex={r.exchange} /> },
    { key: 'timestamp', label: 'Time', width: 80, render: r => <span style={{ color: '#636e82' }}>{fmtTs(r.timestamp)}</span>, sortValue: r => r.timestamp },
    { key: 'instrument', label: 'Instrument', render: r => <span style={{ fontWeight: 600 }}>{r.instrument}</span>, sortValue: r => r.instrument },
    { key: 'type', label: 'Type', width: 60, render: r => <span style={{ color: '#636e82' }}>{r.type}</span> },
    { key: 'side', label: 'Side', width: 60, render: r => <SideChip side={r.side} /> },
    { key: 'amount', label: 'Amount', width: 90, render: r => fmtN(r.amount), sortValue: r => r.amount },
    { key: 'filled', label: 'Filled', width: 90, render: r => fmtN(r.filled), sortValue: r => r.filled },
    { key: 'remaining', label: 'Remaining', width: 90, render: r => fmtN(r.amount - r.filled) },
    { key: 'price', label: 'Price', width: 90, render: r => fmtN(r.price), sortValue: r => r.price },
    { key: 'status', label: 'Status', width: 80, render: r => <StatusPill status={r.status} /> },
    { key: 'id', label: 'Order ID', render: r => <span style={{ color: '#363C4E', fontSize: 10 }}>{r.id}</span> },
    { key: 'actions', label: '', width: 60, render: r => r.status === 'open' ? (
      <button onClick={() => callbacks?.onCancelOrder?.(r.id, r.exchange)} style={{
        background: 'rgba(251,44,54,0.12)', border: '1px solid rgba(251,44,54,0.3)',
        borderRadius: 3, color: '#FB2C36', fontSize: 9, fontWeight: 700,
        padding: '2px 6px', cursor: 'pointer', fontFamily: 'inherit',
      }}>Cancel</button>
    ) : null },
  ]

  const tradeCols: BlotterColumn<BlotterTrade>[] = [
    { key: 'exchange', label: 'Exch', width: 80, render: r => <ExchPill ex={r.exchange} /> },
    { key: 'timestamp', label: 'Time', width: 80, render: r => <span style={{ color: '#636e82' }}>{fmtTs(r.timestamp)}</span>, sortValue: r => r.timestamp },
    { key: 'instrument', label: 'Instrument', render: r => <span style={{ fontWeight: 600 }}>{r.instrument}</span>, sortValue: r => r.instrument },
    { key: 'side', label: 'Side', width: 60, render: r => <SideChip side={r.side} /> },
    { key: 'amount', label: 'Amount', width: 90, render: r => fmtN(r.amount), sortValue: r => r.amount },
    { key: 'price', label: 'Price', width: 90, render: r => fmtN(r.price), sortValue: r => r.price },
    { key: 'fee', label: 'Fee', width: 80, render: r => fmtN(r.fee, 6) },
    { key: 'orderId', label: 'Order ID', render: r => <span style={{ color: '#363C4E', fontSize: 10 }}>{r.orderId}</span> },
    { key: 'id', label: 'Trade ID', render: r => <span style={{ color: '#363C4E', fontSize: 10 }}>{r.id}</span> },
  ]

  const posCols: BlotterColumn<BlotterPosition>[] = [
    { key: 'exchange', label: 'Exch', width: 80, render: r => <ExchPill ex={r.exchange} /> },
    { key: 'instrument', label: 'Instrument', render: r => <span style={{ fontWeight: 600 }}>{r.instrument}</span>, sortValue: r => r.instrument },
    { key: 'side', label: 'Side', width: 70, render: r => <SideChip side={r.side} /> },
    { key: 'size', label: 'Size', width: 90, render: r => `${fmtN(r.size)} ${r.sizeUnit}`, sortValue: r => r.size },
    { key: 'entry', label: 'Entry', width: 90, render: r => fmtN(r.entryPrice), sortValue: r => r.entryPrice },
    { key: 'mark', label: 'Mark', width: 90, render: r => fmtN(r.markPrice) },
    { key: 'upnl', label: 'uPnL', width: 100, render: r => <PnlCell value={r.uPnl} />, sortValue: r => r.uPnl },
    { key: 'rpnl', label: 'rPnL', width: 100, render: r => <PnlCell value={r.rPnl} />, sortValue: r => r.rPnl },
    { key: 'liq', label: 'Liq Price', width: 90, render: r => r.liqPrice > 0 ? fmtN(r.liqPrice) : '—' },
    { key: 'margin', label: 'Margin', width: 90, render: r => fmtN(r.margin) },
  ]

  const balCols: BlotterColumn<BlotterBalance>[] = [
    { key: 'exchange', label: 'Exch', width: 80, render: r => <ExchPill ex={r.exchange} /> },
    { key: 'currency', label: 'Currency', width: 80, render: r => <span style={{ fontWeight: 600 }}>{r.currency}</span> },
    { key: 'available', label: 'Available', render: r => fmtN(r.available, 6), sortValue: r => r.available },
    { key: 'total', label: 'Total Balance', render: r => fmtN(r.total, 6), sortValue: r => r.total },
    { key: 'margin', label: 'Reserved Margin', render: r => fmtN(r.reservedMargin, 6) },
    { key: 'upnl', label: 'Unrealised PnL', render: r => <PnlCell value={r.unrealisedPnl} /> },
    { key: 'equity', label: 'Equity', render: r => fmtN(r.equity, 6) },
  ]

  return (
    <div style={{ position: 'relative', background: '#18171C', borderTop: '1px solid #363C4E', display: 'flex', flexDirection: 'column', height: collapsed ? 'auto' : height, flexShrink: 0 }}>
      {!collapsed && (
        <div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', top: -3, left: 0, right: 0, height: 6, cursor: 'row-resize', zIndex: 10 }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.25)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: collapsed ? 'none' : '1px solid #1e1e2a', background: '#18171C', flexShrink: 0, paddingLeft: 4 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => { setTab(t); if (collapsed) setCollapsed(false) }} style={{
            background: 'none', border: 'none',
            borderBottom: t === tab ? '2px solid #2B79DD' : '2px solid transparent',
            color: t === tab ? 'rgba(255,255,255,0.9)' : '#636e82',
            fontSize: 11, fontWeight: t === tab ? 600 : 400,
            letterSpacing: '0.02em',
            padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'color 0.15s',
          }}>
            {t}
            {counts[t] > 0 && <span style={{
              background: t === tab ? 'rgba(43,121,221,0.2)' : 'rgba(99,110,130,0.15)',
              color: t === tab ? '#2B79DD' : '#636e82',
              borderRadius: 8, padding: '0 5px', fontSize: 9, fontWeight: 700, minWidth: 16, textAlign: 'center' as const,
            }}>{counts[t]}</span>}
          </button>
        ))}
        <button onClick={handleCollapse} style={{
          background: 'none', border: 'none',
          borderBottom: '2px solid transparent',
          color: '#636e82', cursor: 'pointer',
          fontSize: 10, padding: '6px 8px',
          fontFamily: 'inherit', lineHeight: 1,
        }}
          onMouseEnter={e => e.currentTarget.style.color = 'white'}
          onMouseLeave={e => e.currentTarget.style.color = '#636e82'}
        >{collapsed ? '▲' : '▼'}</button>
      </div>
      {!collapsed && (tab === 'Orders' || tab === 'Trades') && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 10px',
          borderBottom: '1px solid #1e1e2a',
          background: '#18171C', flexShrink: 0,
        }}>
          {(['today', 'yesterday', 'week'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              background: period === p
                ? 'linear-gradient(to right, #1A3A94, #2B79DD)'
                : 'linear-gradient(to bottom, #3C3B42, #323138, #2B2A2F)',
              border: 'none', borderRadius: 4,
              color: period === p ? '#fff' : 'rgba(255,255,255,0.3)',
              fontSize: 9, padding: '3px 10px', cursor: 'pointer',
              fontFamily: 'inherit',
            }}>
              {p === 'today' ? 'Today' : p === 'yesterday' ? 'Yesterday' : '7 Days'}
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'Orders' && <BlotterTable columns={orderCols} rows={filteredOrders} rowKey={r => r.id} emptyMessage="No open orders" />}
          {tab === 'Trades' && <BlotterTable columns={tradeCols} rows={filteredTrades} rowKey={r => r.id} emptyMessage="No trades" />}
          {tab === 'Positions' && <BlotterTable columns={posCols} rows={data.positions} rowKey={r => r.id} emptyMessage="No open positions" />}
          {tab === 'Balances' && <BlotterTable columns={balCols} rows={data.balances} rowKey={r => `${r.exchange}-${r.currency}`} emptyMessage="No balance data — connect an exchange" />}
        </div>
      )}
    </div>
  )
}
