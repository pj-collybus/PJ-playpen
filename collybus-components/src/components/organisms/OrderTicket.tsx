import { useState, useRef, useEffect } from 'react'

export interface OrderTicketProps {
  order: {
    id: string
    exchange: string
    instrument: string
    type: string
    side: string
    amount: number
    filled: number
    price: number
    status: string
    timestamp: number
    rejectReason?: string
  }
  onClose: () => void
}

const S = {
  bg: '#18171C',
  border: '#2a2a38',
  text: 'rgba(255,255,255,0.85)',
  muted: '#636e82',
  positive: '#00C758',
  negative: '#FB2C36',
  blue: '#2B79DD',
}

function Row({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', padding: '6px 0', borderBottom: '1px solid #1e1e2a' }}>
      <span style={{ fontSize: 11, color: S.muted }}>{label}:</span>
      <span style={{ fontSize: 11, color: color ?? S.text, fontWeight: 500 }}>{value || '—'}</span>
    </div>
  )
}

function CopyableId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{value}</span>
      <button onClick={copy} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? S.positive : S.muted, fontSize: 11, padding: 0 }}>{copied ? '✓' : '⎘'}</button>
    </span>
  )
}

export function OrderTicket({ order, onClose }: OrderTicketProps) {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)

  useEffect(() => {
    setPos({ x: Math.max(0, (window.innerWidth - 420) / 2), y: Math.max(0, (window.innerHeight - 580) / 2) })
  }, [])

  const statusColor = order.status === 'filled' ? S.positive
    : order.status === 'cancelled' || order.status === 'rejected' ? S.negative
    : order.status === 'open' ? S.blue : S.muted
  const sideColor = order.side === 'BUY' ? S.positive : S.negative

  const formattedTime = new Date(order.timestamp).toLocaleDateString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(',', '')

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, pointerEvents: 'none' }}>
      <div style={{
        position: 'absolute', left: pos.x, top: pos.y,
        width: 420, maxHeight: '90vh', overflowY: 'auto',
        background: S.bg, border: `1px solid ${S.border}`,
        borderRadius: 8, boxShadow: '0 20px 60px rgba(0,0,0,0.9)',
        display: 'flex', flexDirection: 'column', pointerEvents: 'all',
      }}>
        <div
          onMouseDown={e => {
            if ((e.target as HTMLElement).closest('button')) return
            e.preventDefault()
            dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }
            const onMove = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }
            const onUp = () => { dragRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
          }}
          style={{ padding: '14px 16px', cursor: 'grab', borderBottom: `1px solid ${S.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: statusColor }}>{order.status.toUpperCase()} — {order.side} {order.instrument}</div>
            <div style={{ fontSize: 10, color: S.muted, marginTop: 2 }}>{order.exchange}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 18, lineHeight: 1, fontFamily: 'inherit' }}
            onMouseEnter={e => e.currentTarget.style.color = '#fff'}
            onMouseLeave={e => e.currentTarget.style.color = S.muted}
          >×</button>
        </div>
        <div style={{ padding: '8px 16px 16px' }}>
          <Row label="Symbol" value={order.instrument} />
          <Row label="Exchange" value={order.exchange} />
          <Row label="Type" value={order.type?.toUpperCase()} />
          <Row label="Order ID" value={<CopyableId value={order.id} />} />
          <Row label="Side" value={order.side} color={sideColor} />
          <Row label="Status" value={order.status.toUpperCase()} color={statusColor} />
          <Row label="Quantity" value={order.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })} />
          <Row label="Filled" value={order.filled.toLocaleString('en-US', { maximumFractionDigits: 8 })} />
          <Row label="Price" value={order.price.toLocaleString('en-US', { maximumFractionDigits: 8 })} />
          <Row label="Transaction Time" value={formattedTime} />
          <Row label="Rejection Reason" value={order.rejectReason ?? '—'} color={order.rejectReason ? S.negative : undefined} />
        </div>
      </div>
    </div>
  )
}
