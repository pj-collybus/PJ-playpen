// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'
import { BidAskDisplay } from '../molecules/BidAskDisplay'
import { OrderSizeSelector } from '../molecules/OrderSizeSelector'
import { ExchangeSelector } from '../molecules/ExchangeSelector'

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

// ── Constants (same as PricePanel) ────────────────────────────────────────────

const S = {
  gradCard: 'linear-gradient(to bottom, #1F1E23 0%, #1E1D22 50%, #1B1A1F 100%)',
  border: '#363C4E',
  borderInner: '#303030',
  bgCardEnd: '#1B1A1F',
}

const EXCHANGE_LOGOS: Record<string, string> = {
  DERIBIT: 'https://www.deribit.com/favicon.ico',
  BITMEX: 'https://www.bitmex.com/favicon.ico',
  BINANCE: 'https://bin.bnbstatic.com/static/images/common/favicon.ico',
  BYBIT: 'https://www.bybit.com/favicon.ico',
  OKX: 'https://static.okx.com/cdn/assets/imgs/221/E74C5D512FA4211E.png',
  KRAKEN: 'https://www.kraken.com/favicon.ico',
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
const QTY_PRESETS = [1, 5, 10, 25, 100]

// ── Helpers ────────────────────────────────────────────────────────────────────

const toDeribitExpiry = (exp: string) => {
  try { const d = new Date(exp); if (!isNaN(d.getTime())) return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}` } catch {}
  return exp
}

const getInstrumentName = (currency: string, expiry: string, strike: number, type: 'call' | 'put') =>
  `${currency}-${toDeribitExpiry(expiry)}-${strike}-${type === 'call' ? 'C' : 'P'}`

function baseCurrency(symbol: string): string {
  return symbol.split('-')[0].split('_')[0]
}

const fmtPrice = (v: number, _tick?: number) => {
  if (!v || v === 0) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SelectDropdown({ value, options, onChange, style }: {
  value: string; options: { label: string; value: string }[]; onChange: (v: string) => void; style?: React.CSSProperties
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ background: '#252430', border: `1px solid #363C4E`, color: 'rgba(255,255,255,0.85)', borderRadius: 4, padding: '2px 4px', fontSize: 10, fontFamily: 'inherit', cursor: 'pointer', outline: 'none', flex: 1, minWidth: 0, ...style }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

function TypeBtn({ active, disabled, onClick, children, title }: {
  active?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode; title?: string
}) {
  return (
    <button onClick={disabled ? undefined : onClick} title={title}
      style={{
        background: active ? 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)' : disabled ? 'rgba(255,255,255,0.04)' : 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)',
        border: `1px solid ${active ? '#2B79DD' : '#363C4E'}`,
        color: disabled ? 'rgba(255,255,255,0.25)' : active ? '#fff' : 'rgba(255,255,255,0.7)',
        borderRadius: 3, padding: '2px 7px', fontSize: 10, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: active ? 600 : 400, flexShrink: 0,
        boxShadow: active ? 'inset 0px 3px 1px rgba(255,255,255,0.25), inset 0px -3px 1px rgba(0,0,0,0.25)' : 'inset 0px 1px 1px rgba(255,255,255,0.1), inset 0px -1px 1px rgba(0,0,0,0.15)',
      }}>
      {children}
    </button>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function OptionPricePanel({
  id, x, y, width: initialWidth, apiBase, config, onConfigChange, onSubmitOrder, onClose, onMove, onResize,
}: OptionPricePanelProps) {
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
      const res = await fetch(`${apiBase}/api/options/matrix?instrument=${cur}&type=${optionType === 'call' ? 'calls' : 'puts'}&expiryTo=${exp}`)
      if (!res.ok) return
      const data = await res.json()
      const stks: number[] = data.strikes ?? []
      setStrikes(stks)
      if (stks.length > 0 && !stks.includes(strike)) {
        // Pick ATM strike if available
        const atm = data.atmStrike ?? stks[Math.floor(stks.length / 2)]
        setStrike(atm)
        onConfigChange?.(id, { strike: atm })
      }
    } catch {}
  }, [apiBase, optionType, strike, id, onConfigChange])

  const subscribe = useCallback(async (cur: string) => {
    if (subscribed.current === cur) return
    if (subscribed.current) {
      try { await fetch(`${apiBase}/api/options/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: subscribed.current }) }) } catch {}
    }
    try {
      await fetch(`${apiBase}/api/options/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: cur }) })
      subscribed.current = cur
    } catch {}
  }, [apiBase])

  useEffect(() => { fetchExpiries(currency); subscribe(currency) }, [currency])
  useEffect(() => { if (currency && expiry) fetchStrikes(currency, expiry) }, [currency, expiry])
  useEffect(() => {
    return () => {
      const cur = subscribed.current
      if (cur) fetch(`${apiBase}/api/options/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: cur }) }).catch(() => {})
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
    window.addEventListener('options:update', handler)
    return () => window.removeEventListener('options:update', handler)
  }, [currency, expiry, strike, optionType])

  // ── Drag (identical to PricePanel) ────────────────────────────────────────

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (locked) return
    if ((e.target as HTMLElement).closest('button, input, select')) return
    e.preventDefault()
    const el = elRef.current; if (!el) return
    dragRef.current = { ox: e.clientX - el.offsetLeft, oy: e.clientY - el.offsetTop }
    el.style.zIndex = '10'
    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current || !el) return
      const nx = Math.max(0, ev.clientX - dragRef.current.ox)
      const ny = Math.max(0, ev.clientY - dragRef.current.oy)
      el.style.left = nx + 'px'; el.style.top = ny + 'px'
      posRef.current = { x: nx, y: ny }
    }
    const handleUp = () => {
      dragRef.current = null; el.style.zIndex = ''
      onMove?.(id, posRef.current.x, posRef.current.y)
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [id, locked, onMove])

  // ── Resize (identical to PricePanel) ──────────────────────────────────────

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startW: width }
    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      setWidth(Math.max(300, resizeRef.current.startW + (ev.clientX - resizeRef.current.startX)))
    }
    const handleUp = () => {
      resizeRef.current = null
      onResize?.(id, widthRef.current)
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [id, width, onResize])

  // ── Trade ─────────────────────────────────────────────────────────────────

  const handleTrade = async (side: 'buy' | 'sell') => {
    if (locked || !qty || !strike || !expiry) return
    setSubmitting(side)
    try {
      await onSubmitOrder?.({
        exchange, instrument: getInstrumentName(currency, expiry, strike, optionType),
        side: side.toUpperCase() as 'BUY' | 'SELL',
        quantity: parseFloat(qty) || 0, type: 'limit',
        price: side === 'buy' ? ask : bid,
        currency, optionType, strike, expiry,
      })
    } finally { setTimeout(() => setSubmitting(null), 150) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const instrName = getInstrumentName(currency, expiry, strike, optionType)
  const base = baseCurrency(currency)
  const qtyNum = parseFloat(qty) || 0
  const sellPrice = bid > 0 ? fmtPrice(bid) : '—'
  const buyPrice = ask > 0 ? fmtPrice(ask) : '—'
  const spread = bid > 0 && ask > 0 ? fmtPrice(ask - bid) : '—'
  const label = 'rgba(99,110,130,0.9)'
  const val = 'rgba(255,255,255,0.8)'
  const pos = 'rgba(34,197,94,0.8)'
  const neg = 'rgba(251,44,54,0.8)'

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div ref={elRef} style={{
      position: 'absolute', left: x, top: y, width, minWidth: 200,
      outline: submitting ? '2px solid #4488ff' : '2px solid transparent',
      border: `1.25px solid ${S.border}`, borderRadius: 4, overflow: 'visible',
      display: 'flex', flexDirection: 'column', background: S.gradCard,
      boxShadow: submitting ? '0 0 16px rgba(68,136,255,0.5)' : locked ? '0 0 0 1px rgba(240,160,32,0.35), 0 4px 20px rgba(0,0,0,0.6)' : '0 4px 20px rgba(0,0,0,0.5)',
      transition: 'outline 0.1s ease, box-shadow 0.15s ease', userSelect: 'none',
    }}>
      {/* Panel body — matching PricePanel's main row structure */}
      <div onMouseDown={onHeaderMouseDown} style={{
        display: 'flex', flexDirection: 'row', overflow: 'hidden',
        borderRadius: 4, cursor: locked ? 'default' : 'grab',
      }}>
        {/* Centre column — same structure as PricePanel centre column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
          padding: '4px 4px', gap: 3, overflow: 'hidden', justifyContent: 'center',
        }}>
          {/* Instrument header */}
          <div style={{ height: 28, display: 'flex', alignItems: 'center', padding: '0 4px' }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.85)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{instrName}</span>
            <span style={{ fontSize: 9, color: '#888', flexShrink: 0 }}>{exchange}</span>
          </div>

          {/* Stats row — same as PriceStats */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, color: label, whiteSpace: 'nowrap' }}>
              H <span style={{ color: val }}>{fmtPrice(high)}</span> / <span style={{ color: val }}>{fmtPrice(low)}</span>
            </span>
            <span style={{ fontSize: 9, fontWeight: 600, color: change != null ? (change >= 0 ? pos : neg) : label }}>
              {change != null ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}
            </span>
            <span style={{ fontSize: 9, color: label }}>
              IV <span style={{ color: '#a78bfa' }}>{iv != null ? `${iv.toFixed(0)}%` : '—'}</span>
            </span>
          </div>

          {/* Dropdowns + type buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '2px 0' }}>
            <div style={{ display: 'flex', gap: 3 }}>
              <SelectDropdown value={currency}
                options={CURRENCIES.map(c => ({ label: c.replace('_', '/'), value: c }))}
                onChange={v => { setCurrency(v); onConfigChange?.(id, { currency: v }); setStrikes([]) }} />
              <SelectDropdown value={expiry}
                options={expiries.length > 0 ? expiries.map(e => ({ label: toDeribitExpiry(e), value: e })) : [{ label: expiry ? toDeribitExpiry(expiry) : '—', value: expiry }]}
                onChange={v => { setExpiry(v); onConfigChange?.(id, { expiry: v }) }} />
              <SelectDropdown value={String(strike)}
                options={strikes.length > 0 ? strikes.map(s => ({ label: s.toLocaleString(), value: String(s) })) : [{ label: strike ? String(strike) : '—', value: String(strike) }]}
                onChange={v => { const n = Number(v); setStrike(n); onConfigChange?.(id, { strike: n }) }} />
            </div>
            <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              <TypeBtn active={optionType === 'call'} onClick={() => { setOptionType('call'); onConfigChange?.(id, { optionType: 'call' }) }}>Call</TypeBtn>
              <TypeBtn active={optionType === 'put'} onClick={() => { setOptionType('put'); onConfigChange?.(id, { optionType: 'put' }) }}>Put</TypeBtn>
              <span style={{ marginLeft: 4, color: S.borderInner, fontSize: 10 }}>|</span>
              <TypeBtn disabled title="Coming soon">C Sprd</TypeBtn>
              <TypeBtn disabled title="Coming soon">P Sprd</TypeBtn>
              <TypeBtn disabled title="Coming soon">Strad</TypeBtn>
            </div>
          </div>

          {/* BidAsk — reuses exact same component as PricePanel */}
          <BidAskDisplay
            sellPrice={sellPrice} buyPrice={buyPrice} spread={spread}
            baseCurrency={`${optionType === 'call' ? 'Call' : 'Put'} ${base}`}
            qtyEntered={qtyNum > 0} submitting={submitting}
            locked={locked}
            onSell={() => handleTrade('sell')} onBuy={() => handleTrade('buy')}
          />

          {/* Qty — reuses exact same component as PricePanel */}
          <OrderSizeSelector
            qty={qty} presetQtys={QTY_PRESETS}
            onChange={v => { setQty(v); onConfigChange?.(id, { quantity: parseFloat(v) || 0 }) }}
            baseCurrency={base}
            onBlur={() => onConfigChange?.(id, { quantity: parseFloat(qty) || 0 })}
          />
        </div>

        {/* Right column — exchange selector, close, lock (same as PricePanel right column) */}
        <div style={{ flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'row',
          borderLeft: `1px solid ${S.borderInner}`, borderRadius: '0 0 4px 0', overflow: 'visible', background: S.bgCardEnd,
        }}>
          <div style={{ width: 22, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <button onClick={() => onClose?.(id)} style={{ height: 22, width: 22, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 12, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; e.currentTarget.style.color = '#fff' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
            >×</button>
            <ExchangeSelector exchange={exchange} availableExchanges={['DERIBIT']}
              logoUrls={EXCHANGE_LOGOS} colors={EXCHANGE_COLORS} abbrevs={EXCHANGE_ABBREV}
              onSelect={() => {}} />
            <button onClick={() => { const next = !locked; setLocked(next); onConfigChange?.(id, { locked: next }) }} title={locked ? 'Unlock' : 'Lock'}
              style={{ height: 28, width: 22, background: 'transparent', border: 'none', color: locked ? '#e05252' : '#666', cursor: 'pointer', fontSize: 14, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'color 0.15s ease' }}>
              {locked ? '🔒' : '🔓'}
            </button>
          </div>
        </div>
      </div>

      {/* Resize handle — identical to PricePanel */}
      <div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', right: -3, top: 6, bottom: 6, width: 6, cursor: 'col-resize', zIndex: 20, borderRadius: 3, background: 'transparent', transition: 'background .15s' }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.35)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      />

      {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(to right, transparent, #2B79DD, transparent)', opacity: 0.7, borderRadius: '4px 4px 0 0' }} />}
    </div>
  )
}
