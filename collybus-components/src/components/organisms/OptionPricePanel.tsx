// @ts-nocheck
import React, { useState, useRef, useEffect, useCallback } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OptionPricePanelConfig {
  exchange: string
  currency: string
  expiry: string
  strike: number
  optionType: 'call' | 'put'
  quantity?: number
  locked?: boolean
}

export interface OptionOrder {
  exchange: string
  instrument: string
  side: 'BUY' | 'SELL'
  quantity: number
  type: string
  price: number
  currency: string
  optionType: 'call' | 'put'
  strike: number
  expiry: string
}

export interface OptionPricePanelProps {
  id: string
  x: number
  y: number
  width: number
  apiBase: string
  config: OptionPricePanelConfig
  onConfigChange?: (id: string, config: Partial<OptionPricePanelConfig>) => void
  onSubmitOrder?: (order: OptionOrder) => Promise<void>
  onClose?: (id: string) => void
  onMove?: (id: string, x: number, y: number) => void
  onResize?: (id: string, width: number) => void
}

// ── Constants ──────────────────────────────────────────────────────────────────

const S = {
  gradCard: 'linear-gradient(to bottom, #1F1E23 0%, #1E1D22 50%, #1B1A1F 100%)',
  border: '#363C4E',
  borderInner: '#303030',
  bgCardEnd: '#1B1A1F',
}

const EXCHANGE_COLORS: Record<string, string> = {
  DERIBIT: '#e03040', BITMEX: '#4a90d9', BINANCE: '#f0b90b',
  BYBIT: '#f7a600', OKX: '#aaaaaa', KRAKEN: '#8d5ff0',
}
const EXCHANGE_ABBREV: Record<string, string> = {
  DERIBIT: 'D', BITMEX: 'BX', BINANCE: 'BN', BYBIT: 'BB', OKX: 'OX', KRAKEN: 'KR',
}

const CURRENCIES = ['BTC_USDC', 'ETH_USDC', 'SOL_USDC', 'XRP_USDC']
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

// ── Helpers ────────────────────────────────────────────────────────────────────

const toDeribitExpiry = (exp: string) => {
  try {
    const d = new Date(exp)
    if (!isNaN(d.getTime())) return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`
  } catch {}
  return exp
}

const getInstrumentName = (currency: string, expiry: string, strike: number, type: 'call' | 'put') =>
  `${currency}-${toDeribitExpiry(expiry)}-${strike}-${type === 'call' ? 'C' : 'P'}`

const fmtPrice = (v: number) => {
  if (!v || v === 0) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

const fmtPct = (v: number) => {
  if (!v && v !== 0) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}%`
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SelectDropdown({ value, options, onChange, style }: {
  value: string
  options: { label: string; value: string }[]
  onChange: (v: string) => void
  style?: React.CSSProperties
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: '#252430', border: `1px solid #363C4E`, color: 'rgba(255,255,255,0.85)',
        borderRadius: 4, padding: '2px 4px', fontSize: 10, fontFamily: 'inherit',
        cursor: 'pointer', outline: 'none', flex: 1, minWidth: 0,
        ...style,
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function TypeBtn({ active, disabled, onClick, children, title }: {
  active?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode; title?: string
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      style={{
        background: active
          ? 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'
          : disabled
            ? 'rgba(255,255,255,0.04)'
            : 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)',
        border: `1px solid ${active ? '#2B79DD' : '#363C4E'}`,
        color: disabled ? 'rgba(255,255,255,0.25)' : active ? '#fff' : 'rgba(255,255,255,0.7)',
        borderRadius: 3, padding: '2px 7px', fontSize: 10, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: active ? 600 : 400,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function OptionPricePanel({
  id, x, y, width: initialWidth, apiBase, config, onConfigChange, onSubmitOrder, onClose, onMove, onResize,
}: OptionPricePanelProps) {
  // ── State ──────────────────────────────────────────────────────────────────
  const [width, setWidth] = useState(initialWidth)
  const widthRef = useRef(initialWidth)
  useEffect(() => { widthRef.current = width }, [width])

  const [exchange] = useState(config.exchange)
  const [currency, setCurrency] = useState(config.currency)
  const [expiry, setExpiry] = useState(config.expiry)
  const [strike, setStrike] = useState(config.strike)
  const [optionType, setOptionType] = useState<'call' | 'put'>(config.optionType)
  const [qty, setQty] = useState(String(config.quantity ?? ''))
  const [locked, setLocked] = useState(config.locked ?? false)
  const [submitting, setSubmitting] = useState<'buy' | 'sell' | null>(null)

  const [expiries, setExpiries] = useState<string[]>([])
  const [strikes, setStrikes] = useState<number[]>([])
  const [bid, setBid] = useState(0)
  const [ask, setAsk] = useState(0)
  const [high, setHigh] = useState(0)
  const [low, setLow] = useState(0)
  const [change, setChange] = useState<number | null>(null)
  const [iv, setIv] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const elRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null)
  const posRef = useRef({ x, y })
  const subscribed = useRef<string | null>(null)

  const QTY_PRESETS = [1, 5, 10, 25, 100]

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchExpiries = useCallback(async (cur: string) => {
    try {
      setLoading(true)
      const res = await fetch(`${apiBase}/api/options/expiries?instrument=${cur}&type=both`)
      if (!res.ok) return
      const data = await res.json()
      const exps: string[] = data.expiries ?? []
      setExpiries(exps)
      if (exps.length > 0 && !exps.includes(expiry)) {
        setExpiry(exps[0])
        onConfigChange?.(id, { expiry: exps[0] })
      }
    } catch {} finally { setLoading(false) }
  }, [apiBase, expiry, id, onConfigChange])

  const fetchStrikes = useCallback(async (cur: string, exp: string) => {
    try {
      const instrName = `${cur}-${toDeribitExpiry(exp)}`
      const res = await fetch(`${apiBase}/api/options/strikes?instrument=${instrName}`)
      if (!res.ok) return
      const data = await res.json()
      const stks: number[] = data.strikes ?? []
      setStrikes(stks)
      if (stks.length > 0 && !stks.includes(strike)) {
        setStrike(stks[0])
        onConfigChange?.(id, { strike: stks[0] })
      }
    } catch {}
  }, [apiBase, strike, id, onConfigChange])

  // Subscribe to live updates
  const subscribe = useCallback(async (cur: string) => {
    if (subscribed.current === cur) return
    // Unsubscribe previous
    if (subscribed.current) {
      try { await fetch(`${apiBase}/api/options/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: subscribed.current }) }) } catch {}
    }
    try {
      await fetch(`${apiBase}/api/options/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: cur }) })
      subscribed.current = cur
    } catch {}
  }, [apiBase])

  useEffect(() => {
    fetchExpiries(currency)
    subscribe(currency)
  }, [currency])

  useEffect(() => {
    if (currency && expiry) fetchStrikes(currency, expiry)
  }, [currency, expiry])

  // Unsubscribe on unmount
  useEffect(() => {
    return () => {
      const cur = subscribed.current
      if (cur) {
        fetch(`${apiBase}/api/options/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: cur }) }).catch(() => {})
      }
    }
  }, [apiBase])

  // ── SignalR live updates ───────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const data = e.detail
      if (!data) return
      const instrName = getInstrumentName(currency, expiry, strike, optionType)
      if (data.instrument !== instrName) return
      if (data.bid != null) setBid(data.bid)
      if (data.ask != null) setAsk(data.ask)
      if (data.high != null) setHigh(data.high)
      if (data.low != null) setLow(data.low)
      if (data.change != null) setChange(data.change)
      if (data.iv != null) setIv(data.iv)
    }
    window.addEventListener('options:update', handler as EventListener)
    return () => window.removeEventListener('options:update', handler as EventListener)
  }, [currency, expiry, strike, optionType])

  // ── Drag ──────────────────────────────────────────────────────────────────

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (locked) return
    if ((e.target as HTMLElement).closest('button, input, select')) return
    e.preventDefault()
    const el = elRef.current; if (!el) return
    dragRef.current = { ox: e.clientX - el.offsetLeft, oy: e.clientY - el.offsetTop }
    el.style.zIndex = '10'
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !el) return
      const nx = Math.max(0, ev.clientX - dragRef.current.ox)
      const ny = Math.max(0, ev.clientY - dragRef.current.oy)
      el.style.left = nx + 'px'; el.style.top = ny + 'px'
      posRef.current = { x: nx, y: ny }
    }
    const onUp = () => {
      dragRef.current = null; el.style.zIndex = ''
      onMove?.(id, posRef.current.x, posRef.current.y)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [id, locked, onMove])

  // ── Resize ────────────────────────────────────────────────────────────────

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startW: width }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      setWidth(Math.max(300, resizeRef.current.startW + (ev.clientX - resizeRef.current.startX)))
    }
    const onUp = () => {
      resizeRef.current = null
      onResize?.(id, widthRef.current)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [id, width, onResize])

  // ── Trade ─────────────────────────────────────────────────────────────────

  const handleTrade = async (side: 'buy' | 'sell') => {
    if (locked || !qty || !strike || !expiry) return
    setSubmitting(side)
    try {
      await onSubmitOrder?.({
        exchange,
        instrument: getInstrumentName(currency, expiry, strike, optionType),
        side: side.toUpperCase() as 'BUY' | 'SELL',
        quantity: parseFloat(qty) || 0,
        type: 'limit',
        price: side === 'buy' ? ask : bid,
        currency, optionType, strike, expiry,
      })
    } finally {
      setTimeout(() => setSubmitting(null), 150)
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const instrName = getInstrumentName(currency, expiry, strike, optionType)
  const exBadgeColor = EXCHANGE_COLORS[exchange] ?? '#888'
  const exBadgeLabel = EXCHANGE_ABBREV[exchange] ?? exchange.slice(0, 2)
  const changeColor = change == null ? '#888' : change >= 0 ? '#00C758' : '#FB2C36'

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div ref={elRef} style={{
      position: 'absolute', left: x, top: y, width, minWidth: 300,
      outline: submitting ? '2px solid #4488ff' : '2px solid transparent',
      border: `1.25px solid ${S.border}`, borderRadius: 4, overflow: 'visible',
      display: 'flex', flexDirection: 'column', background: S.gradCard,
      boxShadow: submitting
        ? '0 0 16px rgba(68,136,255,0.5)'
        : locked
          ? '0 0 0 1px rgba(240,160,32,0.35), 0 4px 20px rgba(0,0,0,0.6)'
          : '0 4px 20px rgba(0,0,0,0.5)',
      transition: 'outline 0.1s ease, box-shadow 0.15s ease',
      userSelect: 'none',
    }}>

      {/* ── Header ── */}
      <div onMouseDown={onHeaderMouseDown} style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px',
        height: 28, borderBottom: `1px solid ${S.borderInner}`,
        cursor: locked ? 'default' : 'grab', flexShrink: 0,
      }}>
        {/* Exchange badge */}
        <span style={{
          fontSize: 9, fontWeight: 700, color: '#fff', background: exBadgeColor,
          borderRadius: 3, padding: '1px 4px', flexShrink: 0,
        }}>{exBadgeLabel}</span>

        {/* Instrument name */}
        <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.85)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {instrName}
        </span>

        {/* Close button */}
        <button onClick={() => onClose?.(id)} style={{ height: 20, width: 20, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 13, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
        >×</button>

        {/* Lock button */}
        <button onClick={() => { const next = !locked; setLocked(next); onConfigChange?.(id, { locked: next }) }} title={locked ? 'Unlock' : 'Lock'}
          style={{ height: 20, width: 20, background: 'transparent', border: 'none', color: locked ? '#e05252' : '#666', cursor: 'pointer', fontSize: 11, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0, transition: 'color 0.15s ease' }}
          onMouseEnter={e => { if (!locked) e.currentTarget.style.color = '#aaa' }}
          onMouseLeave={e => { if (!locked) e.currentTarget.style.color = '#666' }}
        >{locked ? '🔒' : '🔓'}</button>
      </div>

      {/* ── Stats row ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '3px 8px',
        borderBottom: `1px solid ${S.borderInner}`, flexShrink: 0,
      }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>
          H: <span style={{ color: 'rgba(255,255,255,0.75)' }}>{fmtPrice(high)}</span>
          {' / '}
          <span style={{ color: 'rgba(255,255,255,0.75)' }}>{fmtPrice(low)}</span>
        </span>
        <span style={{ fontSize: 9, color: changeColor }}>
          Chg: {change != null ? fmtPct(change) : '—'}
        </span>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>
          IV: <span style={{ color: '#a78bfa' }}>{iv != null ? `${iv.toFixed(0)}%` : '—'}</span>
        </span>
      </div>

      {/* ── Dropdowns + type buttons ── */}
      <div style={{ padding: '5px 6px', borderBottom: `1px solid ${S.borderInner}`, display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        {/* Dropdowns row */}
        <div style={{ display: 'flex', gap: 4 }}>
          <SelectDropdown
            value={currency}
            options={CURRENCIES.map(c => ({ label: c.replace('_', '/'), value: c }))}
            onChange={v => {
              setCurrency(v)
              onConfigChange?.(id, { currency: v })
              setStrikes([])
            }}
          />
          <SelectDropdown
            value={expiry}
            options={expiries.length > 0 ? expiries.map(e => ({ label: toDeribitExpiry(e), value: e })) : [{ label: expiry ? toDeribitExpiry(expiry) : '—', value: expiry }]}
            onChange={v => {
              setExpiry(v)
              onConfigChange?.(id, { expiry: v })
            }}
          />
          <SelectDropdown
            value={String(strike)}
            options={strikes.length > 0 ? strikes.map(s => ({ label: s.toLocaleString(), value: String(s) })) : [{ label: strike ? String(strike) : '—', value: String(strike) }]}
            onChange={v => {
              const n = Number(v)
              setStrike(n)
              onConfigChange?.(id, { strike: n })
            }}
          />
        </div>

        {/* Type buttons row */}
        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          <TypeBtn active={optionType === 'call'} onClick={() => { setOptionType('call'); onConfigChange?.(id, { optionType: 'call' }) }}>Call</TypeBtn>
          <TypeBtn active={optionType === 'put'} onClick={() => { setOptionType('put'); onConfigChange?.(id, { optionType: 'put' }) }}>Put</TypeBtn>
          <span style={{ marginLeft: 4, color: S.borderInner, fontSize: 10 }}>|</span>
          <TypeBtn disabled title="Coming soon">C Sprd</TypeBtn>
          <TypeBtn disabled title="Coming soon">P Sprd</TypeBtn>
          <TypeBtn disabled title="Coming soon">Strad</TypeBtn>
        </div>
      </div>

      {/* ── Bid / Ask ── */}
      <div style={{
        display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${S.borderInner}`, flexShrink: 0,
      }}>
        {/* Bid / Sell */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 6px 4px', gap: 3, borderRight: `1px solid ${S.borderInner}` }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: bid > 0 ? '#FB6970' : 'rgba(255,255,255,0.3)', letterSpacing: 0.5, lineHeight: 1 }}>
            {bid > 0 ? bid.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
          </span>
          <button
            onClick={() => handleTrade('sell')}
            disabled={locked || !bid || !qty}
            style={{
              background: submitting === 'sell' ? 'linear-gradient(to right, #7B1A2A 0%, #C02030 100%)' : 'linear-gradient(to right, #5A1A24 0%, #9B2030 100%)',
              border: '1px solid #C02030', color: '#fff', borderRadius: 3,
              padding: '3px 12px', fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
              cursor: locked || !bid || !qty ? 'not-allowed' : 'pointer',
              opacity: locked || !bid || !qty ? 0.5 : 1, width: '100%',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (!locked && bid && qty) e.currentTarget.style.background = 'linear-gradient(to right, #7B1A2A 0%, #C02030 100%)' }}
            onMouseLeave={e => { if (!locked && bid && qty) e.currentTarget.style.background = 'linear-gradient(to right, #5A1A24 0%, #9B2030 100%)' }}
          >
            {`Sell ${optionType === 'call' ? 'Call' : 'Put'}`}
          </button>
        </div>

        {/* Qty input in middle */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4px 6px', gap: 2, flexShrink: 0 }}>
          <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>qty</span>
          <input
            value={qty}
            onChange={e => { setQty(e.target.value); onConfigChange?.(id, { quantity: parseFloat(e.target.value) || 0 }) }}
            placeholder="0"
            style={{
              width: 52, background: '#0e0e14', border: `1px solid #363C4E`, color: 'rgba(255,255,255,0.85)',
              borderRadius: 3, padding: '2px 4px', fontSize: 11, fontFamily: 'inherit', textAlign: 'center', outline: 'none',
            }}
            onFocus={e => e.currentTarget.style.borderColor = '#2B79DD'}
            onBlur={e => e.currentTarget.style.borderColor = '#363C4E'}
          />
        </div>

        {/* Ask / Buy */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 6px 4px', gap: 3, borderLeft: `1px solid ${S.borderInner}` }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: ask > 0 ? '#4CAF82' : 'rgba(255,255,255,0.3)', letterSpacing: 0.5, lineHeight: 1 }}>
            {ask > 0 ? ask.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
          </span>
          <button
            onClick={() => handleTrade('buy')}
            disabled={locked || !ask || !qty}
            style={{
              background: submitting === 'buy' ? 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)' : 'linear-gradient(to right, #1A2A6A 0%, #1F5AB0 100%)',
              border: '1px solid #2B79DD', color: '#fff', borderRadius: 3,
              padding: '3px 12px', fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
              cursor: locked || !ask || !qty ? 'not-allowed' : 'pointer',
              opacity: locked || !ask || !qty ? 0.5 : 1, width: '100%',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (!locked && ask && qty) e.currentTarget.style.background = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)' }}
            onMouseLeave={e => { if (!locked && ask && qty) e.currentTarget.style.background = 'linear-gradient(to right, #1A2A6A 0%, #1F5AB0 100%)' }}
          >
            {`Buy ${optionType === 'call' ? 'Call' : 'Put'}`}
          </button>
        </div>
      </div>

      {/* ── Qty presets ── */}
      <div style={{ display: 'flex', gap: 3, padding: '5px 6px', alignItems: 'center' }}>
        {QTY_PRESETS.map(p => (
          <button
            key={p}
            onClick={() => { setQty(String(p)); onConfigChange?.(id, { quantity: p }) }}
            style={{
              flex: 1, background: qty === String(p) ? 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${qty === String(p) ? '#555' : '#2a2a38'}`,
              color: qty === String(p) ? '#fff' : 'rgba(255,255,255,0.5)',
              borderRadius: 3, padding: '3px 0', fontSize: 9, fontFamily: 'inherit', cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)'; e.currentTarget.style.color = '#fff' }}
            onMouseLeave={e => {
              e.currentTarget.style.background = qty === String(p) ? 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)' : 'rgba(255,255,255,0.04)'
              e.currentTarget.style.color = qty === String(p) ? '#fff' : 'rgba(255,255,255,0.5)'
            }}
          >{p}</button>
        ))}
      </div>

      {/* ── Resize handle ── */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{ position: 'absolute', right: -3, top: 6, bottom: 6, width: 6, cursor: 'col-resize', zIndex: 20, borderRadius: 3, background: 'transparent', transition: 'background .15s' }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.35)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      />

      {/* Loading indicator */}
      {loading && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(to right, transparent, #2B79DD, transparent)', animation: 'none', opacity: 0.7, borderRadius: '4px 4px 0 0' }} />
      )}
    </div>
  )
}
