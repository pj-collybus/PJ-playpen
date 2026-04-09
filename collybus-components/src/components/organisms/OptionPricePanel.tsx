// @ts-nocheck
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { DepthChart } from '../shared/DepthChart'
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

export interface TickerOverrides {
  bid: number
  ask: number
  high: number
  low: number
  change: number | null
}

export interface OrderBookLevel {
  price: number
  size: number
}

export interface OrderBookOverrides {
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  timestamp: number
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
  tickerOverrides?: TickerOverrides
  orderBook?: OrderBookOverrides
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

// Same instrument list as OptionsMatrix
const CURRENCIES = ['BTC', 'BTC_USDC', 'ETH', 'ETH_USDC', 'SOL_USDC', 'XRP_USDC']
const CURRENCY_LABELS: Record<string, string> = {
  BTC: 'BTC', BTC_USDC: 'BTC/USDC', ETH: 'ETH', ETH_USDC: 'ETH/USDC', SOL_USDC: 'SOL/USDC', XRP_USDC: 'XRP/USDC',
}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const QTY_PRESETS = [1, 5, 10, 25, 100]

// ── Helpers ────────────────────────────────────────────────────────────────────

const toDeribitExpiry = (exp: string) => {
  try { const d = new Date(exp); if (!isNaN(d.getTime())) return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}` } catch {}
  return exp
}

// Extract base for instrument name: BTC_USDC → BTC, ETH_USDC → ETH, BTC → BTC
function toInstrumentBase(currency: string): string {
  return currency.split('_')[0]
}

// Deribit option instrument: BTC-13APR26-71500-C (always uses base, never _USDC)
const getInstrumentName = (currency: string, expiry: string, strike: number, type: 'call' | 'put') =>
  `${toInstrumentBase(currency)}-${toDeribitExpiry(expiry)}-${strike}-${type === 'call' ? 'C' : 'P'}`

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
  id, x, y, width: initialWidth, apiBase, config, onConfigChange, onSubmitOrder, onClose, onMove, onResize, tickerOverrides, orderBook,
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
  const [indexPrice, setIndexPrice] = useState(0)

  const elRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null)
  const posRef = useRef({ x, y })
  const subscribed = useRef<string | null>(null)

  // ── Data fetching ──────────────────────────────────────────────────────────

  // Fetch expiries + subscribe on currency change (matches OptionsMatrix exactly)
  useEffect(() => {
    if (!currency) return
    let cancelled = false
    setLoading(true)
    setExpiries([])

    const loadExpiries = async () => {
      try {
        const type = optionType === 'call' ? 'calls' : 'puts'
        const resp = await fetch(`${apiBase}/api/options/expiries?instrument=${currency}&type=${type}`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const json = await resp.json()
        if (cancelled) return
        const dates: string[] = json.expiries ?? []
        if (json.indexPrice) setIndexPrice(json.indexPrice)
        setExpiries(dates)
        if (dates.length > 0) {
          const sel = dates.includes(expiry) ? expiry : dates[0]
          setExpiry(sel)
          onConfigChange?.(id, { expiry: sel })
        }
        // Subscribe to websocket summary feed (same as OptionsMatrix)
        fetch(`${apiBase}/api/options/subscribe`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instrument: currency }),
        }).catch(() => {})
        subscribed.current = currency
      } catch {} finally { if (!cancelled) setLoading(false) }
    }
    loadExpiries()
    return () => {
      cancelled = true
      // Unsubscribe on cleanup (same as OptionsMatrix)
      fetch(`${apiBase}/api/options/unsubscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument: currency }),
      }).catch(() => {})
      subscribed.current = null
    }
  }, [apiBase, currency, optionType])

  // Fetch strikes via matrix endpoint when expiry changes (matches OptionsMatrix)
  useEffect(() => {
    if (!currency || !expiry) return
    let cancelled = false
    setStrikes([])

    const fetchStrikes = async () => {
      try {
        const params = new URLSearchParams({
          instrument: currency,
          type: optionType === 'call' ? 'calls' : 'puts',
          toExpiry: expiry,
          atmOnly: 'false',
        })
        const resp = await fetch(`${apiBase}/api/options/matrix?${params}`)
        if (!resp.ok) return
        const json = await resp.json()
        if (cancelled) return
        const stks: number[] = json.strikes ?? []
        if (json.indexPrice) setIndexPrice(json.indexPrice)
        setStrikes(stks)
        if (stks.length > 0) {
          const atm = json.atmStrike ?? stks[Math.floor(stks.length / 2)]
          const sel = stks.includes(strike) ? strike : atm
          setStrike(sel)
          onConfigChange?.(id, { strike: sel })
        }
      } catch {}
    }
    fetchStrikes()
    return () => { cancelled = true }
  }, [apiBase, currency, expiry, optionType])

  // ── Apply ticker overrides from wrapper (SignalR-sourced live data) ─────
  useEffect(() => {
    if (!tickerOverrides) return
    if (tickerOverrides.bid) setBid(tickerOverrides.bid)
    if (tickerOverrides.ask) setAsk(tickerOverrides.ask)
    if (tickerOverrides.high) setHigh(tickerOverrides.high)
    if (tickerOverrides.low) setLow(tickerOverrides.low)
    if (tickerOverrides.change != null) setChange(tickerOverrides.change)
  }, [tickerOverrides])

  // ── SignalR live updates (fallback — options:update CustomEvent) ───────

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

  // Order book depth (same as PricePanel)
  const bids = orderBook?.bids ?? []
  const asks = orderBook?.asks ?? []
  const sortedBids = useMemo(() => bids.length ? [...bids].sort((a, b) => b.price - a.price) : [], [orderBook])
  const sortedAsks = useMemo(() => asks.length ? [...asks].sort((a, b) => a.price - b.price) : [], [orderBook])
  const [bidVisibleTotal, setBidVisibleTotal] = useState(0)
  const [askVisibleTotal, setAskVisibleTotal] = useState(0)
  const sharedCumMax = Math.max(bidVisibleTotal, askVisibleTotal)
  const showDepth = width >= 320 && (sortedBids.length > 0 || sortedAsks.length > 0)

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
        borderRadius: 4, height: 171, cursor: locked ? 'default' : 'grab',
      }}>
        {/* Bid depth chart */}
        {showDepth && (
          <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
            <DepthChart levels={sortedBids} side="bid" tickSize={0.01} granularity={1}
              highlightQty={qtyNum} globalCumMax={sharedCumMax > 0 ? sharedCumMax : undefined}
              onVisibleTotalChange={setBidVisibleTotal} />
          </div>
        )}

        {/* Centre column — same structure as PricePanel centre column */}
        <div style={{ width: showDepth ? 200 : undefined, flex: showDepth ? undefined : 1, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column',
          padding: '4px 4px', gap: 3, overflow: 'hidden',
          borderLeft: showDepth ? `1px solid ${S.borderInner}` : 'none', borderRight: `1px solid ${S.borderInner}`, justifyContent: 'center',
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
                options={CURRENCIES.map(c => ({ label: CURRENCY_LABELS[c] ?? c, value: c }))}
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

          {/* USD value derived from index price */}
          {indexPrice > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px' }}>
              <span style={{ fontSize: 10, color: '#aaa' }}>{bid > 0 ? `$${(bid * indexPrice).toFixed(2)}` : '—'}</span>
              <span style={{ fontSize: 10, color: '#aaa' }}>{ask > 0 ? `$${(ask * indexPrice).toFixed(2)}` : '—'}</span>
            </div>
          )}

          {/* Qty — reuses exact same component as PricePanel */}
          <OrderSizeSelector
            qty={qty} presetQtys={QTY_PRESETS}
            onChange={v => { setQty(v); onConfigChange?.(id, { quantity: parseFloat(v) || 0 }) }}
            baseCurrency={base}
            onBlur={() => onConfigChange?.(id, { quantity: parseFloat(qty) || 0 })}
          />
        </div>

        {/* Ask depth chart */}
        {showDepth && (
          <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
            <DepthChart levels={sortedAsks} side="ask" tickSize={0.01} granularity={1}
              highlightQty={qtyNum} globalCumMax={sharedCumMax > 0 ? sharedCumMax : undefined}
              onVisibleTotalChange={setAskVisibleTotal} />
          </div>
        )}

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
