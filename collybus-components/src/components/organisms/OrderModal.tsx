import { useState, useRef, useEffect } from 'react'
import { formatPrice, tickDecimals } from '../PricePanel/utils'

const savePos = (key: string, p: { x: number; y: number }) => {
  try { localStorage.setItem(`collybus.pos.${key}`, JSON.stringify(p)) } catch {}
}
const loadPos = (key: string, fallback: { x: number; y: number }) => {
  try { const s = localStorage.getItem(`collybus.pos.${key}`); return s ? JSON.parse(s) : fallback } catch { return fallback }
}

export interface OrderModalProps {
  exchange: string
  symbol: string
  baseCurrency: string
  quoteCurrency: string
  tickSize: number
  lotSize: number
  initialSide?: 'BUY' | 'SELL'
  initialPrice?: number
  initialQty?: number
  initialTab?: 'LMT' | 'S/L' | 'ID' | 'OCO'
  bid?: number
  ask?: number
  existingOrderId?: string
  onSubmit: (params: OrderSubmitParams) => Promise<void>
  onCancel?: (orderId: string, exchange: string) => Promise<void>
  onLaunchAlgo?: (params: any) => Promise<string>
  onClose: () => void
}

export interface OrderSubmitParams {
  exchange: string
  symbol: string
  side: 'BUY' | 'SELL'
  orderType: string
  quantity: number
  limitPrice?: number
  triggerPrice?: number
  timeInForce: string
  postOnly?: boolean
  reduceOnly?: boolean
  hidden?: boolean
  linkedOrder?: OrderSubmitParams
}

const S = {
  bg: '#1a1a22',
  bgInput: '#0e0e14',
  border: '#2a2a38',
  gradAction: 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)',
  gradSecondary: 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)',
  positive: '#00C758',
  negative: '#FB2C36',
  text: 'rgba(255,255,255,0.85)',
  muted: '#636e82',
  blue: '#7B61FF',
}

const TABS = ['LMT', 'S/L', 'ID', 'OCO'] as const
type Tab = typeof TABS[number]
type StopType = 'limit' | 'stop'
type PriceTrigger = 'N/A' | 'Last Price' | 'Mark Price' | 'Index Price'

const colLabel: React.CSSProperties = {
  fontSize: 9, color: S.muted, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase',
}

// ── InlineInput: value + currency label + ▲▼ arrows ────────────────────────

function InlineInput({ value, onChange, currency, onUp, onDown }: {
  value: string; onChange: (v: string) => void; currency: string
  onUp: () => void; onDown: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      background: S.bgInput, border: `1px solid ${S.border}`,
      borderRadius: 4, overflow: 'hidden', height: 32,
    }}>
      <input value={value} onChange={e => onChange(e.target.value)} style={{
        flex: 1, background: 'transparent', border: 'none',
        color: S.text, fontSize: 12, padding: '0 8px',
        outline: 'none', fontFamily: 'inherit', minWidth: 0,
      }} />
      <span style={{ fontSize: 9, color: S.muted, fontWeight: 600, paddingRight: 4, flexShrink: 0 }}>{currency}</span>
      <div style={{ display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${S.border}`, flexShrink: 0 }}>
        <button onClick={onUp} style={{
          width: 18, height: 16,
          background: 'linear-gradient(to bottom, #3C3B42 0%, #2B2A2F 100%)',
          border: 'none', borderBottom: '1px solid #1a1a20',
          color: '#8a8a9a', fontSize: 8, cursor: 'pointer', lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.12), inset 0px -1px 0px rgba(0,0,0,0.2)',
          transition: 'background 0.1s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(to bottom, #4a4950, #38373d)'; e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(to bottom, #3C3B42 0%, #2B2A2F 100%)'; e.currentTarget.style.color = '#8a8a9a' }}
        >▲</button>
        <button onClick={onDown} style={{
          width: 18, height: 16,
          background: 'linear-gradient(to bottom, #2B2A2F 0%, #232228 100%)',
          border: 'none',
          color: '#8a8a9a', fontSize: 8, cursor: 'pointer', lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.06), inset 0px -1px 0px rgba(0,0,0,0.25)',
          transition: 'background 0.1s',
        }}
          onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(to bottom, #38373d, #2a2930)'; e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(to bottom, #2B2A2F 0%, #232228 100%)'; e.currentTarget.style.color = '#8a8a9a' }}
        >▼</button>
      </div>
    </div>
  )
}

// ── TypeToggle: Limit / Stop Loss ──────────────────────────────────────────

function TypeToggle({ value, onChange }: { value: StopType; onChange: (v: StopType) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
      {(['limit', 'stop'] as StopType[]).map(t => (
        <button key={t} onClick={() => onChange(t)} style={{
          padding: '3px 10px', border: 'none', borderRadius: 3,
          background: value === t ? S.gradAction : S.gradSecondary,
          color: value === t ? '#fff' : S.muted,
          fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        }}>{t === 'limit' ? 'Limit' : 'Stop Loss'}</button>
      ))}
    </div>
  )
}

// ── OrderLeg: side + amount + price in a 3-column grid ─────────────────────

function OrderLeg({
  label, side, qty, price, stopType, baseCurrency, quoteCurrency,
  tickSize, lotSize, showTypeToggle,
  onSideChange, onQtyChange, onPriceChange, onStopTypeChange,
}: {
  label?: string; side: 'BUY' | 'SELL'; qty: string; price: string
  stopType: StopType; baseCurrency: string; quoteCurrency: string
  tickSize: number; lotSize: number; showTypeToggle?: boolean
  onSideChange: (s: 'BUY' | 'SELL') => void
  onQtyChange: (v: string) => void; onPriceChange: (v: string) => void
  onStopTypeChange: (v: StopType) => void
}) {
  const round = (n: number, step: number) => {
    const d = Math.max(0, -Math.floor(Math.log10(step)))
    return parseFloat(n.toFixed(d))
  }
  const priceLabel = stopType === 'stop' ? 'STOP PRICE' : 'PRICE'

  return (
    <div style={{
      background: '#141418', border: `1px solid ${S.border}`,
      borderRadius: 6, padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {(label || showTypeToggle) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {label && <span style={{ fontSize: 11, fontWeight: 700, color: S.text, letterSpacing: '0.05em' }}>{label}</span>}
          {showTypeToggle && <TypeToggle value={stopType} onChange={onStopTypeChange} />}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8 }}>
        <span style={colLabel}>SIDE</span>
        <span style={colLabel}>AMOUNT</span>
        <span style={colLabel}>{priceLabel}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8, alignItems: 'center' }}>
        <div style={{ display: 'flex', height: 32 }}>
          {(['SELL', 'BUY'] as const).map(s => (
            <button key={s} onClick={() => onSideChange(s)} style={{
              flex: 1, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 11, fontWeight: 700,
              borderRadius: s === 'SELL' ? '4px 0 0 4px' : '0 4px 4px 0',
              background: side === s
                ? s === 'BUY' ? 'rgba(0,199,88,0.25)' : 'rgba(251,44,54,0.25)'
                : '#1a1a22',
              color: side === s
                ? s === 'BUY' ? '#00C758' : '#FB2C36'
                : '#636e82',
              border: side === s
                ? `1px solid ${s === 'BUY' ? 'rgba(0,199,88,0.4)' : 'rgba(251,44,54,0.4)'}`
                : `1px solid ${S.border}`,
              boxShadow: side === s
                ? 'inset 0px 2px 1px rgba(255,255,255,0.15), inset 0px -2px 1px rgba(0,0,0,0.25)'
                : 'none',
            }}>{s}</button>
          ))}
        </div>

        <InlineInput value={qty} onChange={onQtyChange} currency={baseCurrency}
          onUp={() => onQtyChange(String(round(parseFloat(qty || '0') + lotSize, lotSize)))}
          onDown={() => onQtyChange(String(round(Math.max(0, parseFloat(qty || '0') - lotSize), lotSize)))} />

        <InlineInput value={price} onChange={onPriceChange} currency={quoteCurrency}
          onUp={() => onPriceChange(String(round(parseFloat(price || '0') + tickSize, tickSize)))}
          onDown={() => onPriceChange(String(round(Math.max(0, parseFloat(price || '0') - tickSize), tickSize)))} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8 }}>
        <div />
        <InlineInput
          value={(parseFloat(qty || '0') * parseFloat(price || '0') || 0)
            .toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: true })}
          onChange={(v) => {
            const notional = parseFloat(v.replace(/,/g, ''))
            const p = parseFloat(price || '0')
            if (!isNaN(notional) && p > 0) onQtyChange(String(round(notional / p, lotSize)))
          }}
          currency={quoteCurrency}
          onUp={() => onQtyChange(String(round(parseFloat(qty || '0') + lotSize, lotSize)))}
          onDown={() => onQtyChange(String(round(Math.max(0, parseFloat(qty || '0') - lotSize), lotSize)))}
        />
        <div />
      </div>
    </div>
  )
}

// ── FooterRow: hidden, expiry (with GTD), price trigger ────────────────────

function FooterRow({ hidden, setHidden, expiry, setExpiry, gtdDateTime, setGtdDateTime, priceTrigger, setPriceTrigger, showPriceTrigger = true }: {
  hidden: boolean; setHidden: (v: boolean) => void
  expiry: string; setExpiry: (v: string) => void
  gtdDateTime: string; setGtdDateTime: (v: string) => void
  priceTrigger: PriceTrigger; setPriceTrigger: (v: PriceTrigger) => void
  showPriceTrigger?: boolean
}) {
  const selectStyle: React.CSSProperties = {
    background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 4,
    color: S.text, fontSize: 11, padding: '5px 8px', outline: 'none',
    fontFamily: 'inherit', cursor: 'pointer',
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: S.muted, cursor: 'pointer' }}>
        <input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} />
        Hidden / Iceberg
      </label>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <span style={{ ...colLabel, display: 'block', marginBottom: 4 }}>Expiry</span>
          <select value={expiry} onChange={e => setExpiry(e.target.value)} style={selectStyle}>
            {['GTC', 'Day', 'IOC', 'FOK', 'GTD'].map(o => <option key={o}>{o}</option>)}
          </select>
        </div>
        {expiry === 'GTD' && (
          <div>
            <span style={{ ...colLabel, display: 'block', marginBottom: 4 }}>Date & Time</span>
            <input type="datetime-local" value={gtdDateTime} onChange={e => setGtdDateTime(e.target.value)}
              style={{ ...selectStyle, colorScheme: 'dark' }} />
          </div>
        )}
        {showPriceTrigger && (
          <div>
            <span style={{ ...colLabel, display: 'block', marginBottom: 4 }}>Price Trigger</span>
            <select value={priceTrigger} onChange={e => setPriceTrigger(e.target.value as PriceTrigger)} style={selectStyle}>
              {(['N/A', 'Last Price', 'Mark Price', 'Index Price'] as PriceTrigger[]).map(o => <option key={o}>{o}</option>)}
            </select>
          </div>
        )}
      </div>
    </div>
  )
}

// ── OrderModal ─────────────────────────────────────────────────────────────

export function OrderModal({
  exchange, symbol, baseCurrency, quoteCurrency, tickSize, lotSize,
  initialSide = 'BUY', initialPrice, initialQty, initialTab = 'LMT',
  bid, ask, existingOrderId, onSubmit, onCancel, onLaunchAlgo, onClose,
}: OrderModalProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [side, setSide] = useState<'BUY' | 'SELL'>(initialSide)
  const [qty, setQty] = useState(initialQty?.toString() ?? '')
  const [price, setPrice] = useState(initialPrice?.toString() ?? (ask?.toString() ?? ''))
  const [stopType, setStopType] = useState<StopType>('limit')
  const [side2, setSide2] = useState<'BUY' | 'SELL'>(initialSide === 'BUY' ? 'SELL' : 'BUY')
  const [qty2, setQty2] = useState(initialQty?.toString() ?? '')
  const [price2, setPrice2] = useState(bid?.toString() ?? '')
  const [stopType2, setStopType2] = useState<StopType>('stop')
  const [side3, setSide3] = useState<'BUY' | 'SELL'>(initialSide)
  const [qty3, setQty3] = useState(initialQty?.toString() ?? '')
  const [price3, setPrice3] = useState(bid?.toString() ?? '')
  const [stopType3, setStopType3] = useState<StopType>('limit')
  const [hidden, setHidden] = useState(false)
  const [discretionEnabled, setDiscretionEnabled] = useState(false)
  const [discretionBps, setDiscretionBps] = useState('10')
  const [discretionPct, setDiscretionPct] = useState('50')
  const [discretionPrice, setDiscretionPrice] = useState('')

  useEffect(() => {
    if (!discretionEnabled) return
    const px = parseFloat(price), bps = parseFloat(discretionBps)
    if (!isNaN(px) && px > 0 && !isNaN(bps)) {
      const sp = side === 'BUY' ? px * (1 + bps / 10000) : px * (1 - bps / 10000)
      setDiscretionPrice(sp.toFixed(tickDecimals(tickSize)))
    }
  }, [price, discretionBps, side, discretionEnabled, tickSize])
  const [expiry, setExpiry] = useState('GTC')
  const [gtdDateTime, setGtdDateTime] = useState('')
  const [priceTrigger, setPriceTrigger] = useState<PriceTrigger>('N/A')
  const [orCondition, setOrCondition] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [pos, setPos] = useState(() =>
    loadPos('orderModal', { x: Math.max(0, (window.innerWidth - 480) / 2), y: Math.max(0, (window.innerHeight - 600) / 2) })
  )
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)

  useEffect(() => { savePos('orderModal', pos) }, [pos])

  useEffect(() => {
    if (tab === 'LMT') setPriceTrigger('N/A')
    else if (tab === 'S/L') setPriceTrigger('Last Price')
    else setPriceTrigger('Mark Price')
  }, [tab])

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const q = parseFloat(qty)
      const p = parseFloat(price)
      if (!q || q <= 0) throw new Error('Invalid quantity')

      // Discretion: Post+Snipe with 3 snipe levels (uses discretionService logic)
      if (tab === 'LMT' && discretionEnabled) {
        if (!onLaunchAlgo) throw new Error('Algo not configured')
        const bps = parseFloat(discretionBps) || 10
        const activePct = parseFloat(discretionPct) || 50
        const dir = side === 'BUY' ? 1 : -1
        const ceilingPx = p + dir * (p * bps / 10000)
        const range = ceilingPx - p
        const rnd = (px: number) => Math.round(px / tickSize) * tickSize

        // Same params format as AlgoModal Post+Snipe:
        // snipeCap = active%, levels have allocationPct summing to 100% of snipe portion
        // C# handles the lot rounding and remainder distribution
        await onLaunchAlgo({
          strategyType: 'SNIPER', exchange, symbol, side, totalSize: q,
          tickSize, lotSize, arrivalMid: ((bid ?? 0) + (ask ?? 0)) / 2,
          arrivalBid: bid ?? 0, arrivalAsk: ask ?? 0,
          sniperMode: 'post_snipe', levelMode: 'simultaneous',
          postPrice: p, snipeCap: activePct,
          levels: [
            { index: 0, price: rnd(p + range / 3), allocationPct: 33.33, enabled: true },
            { index: 1, price: rnd(p + range * 2 / 3), allocationPct: 33.33, enabled: true },
            { index: 2, price: rnd(ceilingPx), allocationPct: 33.34, enabled: true },
          ],
        })
        setError(''); onClose(); return
      }

      const isStop = tab === 'S/L' || (stopType === 'stop' && (tab === 'ID' || tab === 'OCO'))
      const params: OrderSubmitParams = {
        exchange, symbol, side,
        orderType: isStop ? 'STOP' : 'LIMIT',
        quantity: q,
        triggerPrice: isStop ? p : undefined,
        limitPrice: isStop ? undefined : p,
        timeInForce: expiry,
        hidden,
        reduceOnly: false,
      }

      if (tab === 'ID' || tab === 'OCO') {
        const q2 = parseFloat(qty2 || qty)
        params.linkedOrder = {
          exchange, symbol, side: side2,
          orderType: stopType2 === 'stop' ? 'STOP' : 'LIMIT',
          quantity: q2,
          limitPrice: stopType2 === 'limit' ? parseFloat(price2) : undefined,
          triggerPrice: stopType2 === 'stop' ? parseFloat(price2) : undefined,
          timeInForce: expiry,
        }
      }

      await onSubmit(params)
      setError('')
      onClose()
    } catch (e: any) {
      setError(e.message ?? 'Order failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 500, pointerEvents: 'none' }}>
      <div style={{
        position: 'absolute', left: pos.x, top: pos.y,
        width: 480, maxHeight: '90vh', overflowY: 'auto',
        background: S.bg, border: '1px solid #4a4a60',
        borderRadius: 10, boxShadow: '0 20px 80px rgba(0,0,0,0.95), 0 0 0 1px rgba(100,100,150,0.3)',
        display: 'flex', flexDirection: 'column',
        userSelect: 'none', pointerEvents: 'all',
      }}>
        {/* Header */}
        <div
          onMouseDown={e => {
            if ((e.target as HTMLElement).closest('button,input,select')) return
            e.preventDefault()
            dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }
            const onMove = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }
            const onUp = () => { dragRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
          }}
          style={{ padding: '12px 16px 0', cursor: 'grab' }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: S.text }}>{existingOrderId ? 'Amend Order' : 'Place Order'} <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.5)' }}>on</span> {exchange}</span>
              <div style={{ fontSize: 11, color: S.muted, marginTop: 2 }}>{symbol}</div>
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: S.muted,
              cursor: 'pointer', fontSize: 18, lineHeight: 1, fontFamily: 'inherit', marginTop: 2,
            }}
              onMouseEnter={e => e.currentTarget.style.color = '#fff'}
              onMouseLeave={e => e.currentTarget.style.color = S.muted}
            >×</button>
          </div>
          <div style={{ display: 'flex', borderBottom: `1px solid ${S.border}` }}>
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '7px 16px', border: 'none', background: 'none',
                borderBottom: t === tab ? `2px solid ${S.blue}` : '2px solid transparent',
                color: t === tab ? S.blue : S.muted,
                fontSize: 12, fontWeight: t === tab ? 600 : 400,
                cursor: 'pointer', fontFamily: 'inherit',
              }}>{t === 'S/L' ? 'Stop' : t === 'ID' ? 'If Done' : t}</button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(bid || ask) && (
            <div style={{ display: 'flex', gap: 16, fontSize: 10, color: S.muted }}>
              {bid ? <span>Bid: <span style={{ color: S.positive }}>{formatPrice(bid, tickSize)}</span></span> : null}
              {ask ? <span>Ask: <span style={{ color: S.negative }}>{formatPrice(ask, tickSize)}</span></span> : null}
            </div>
          )}

          {tab === 'LMT' && (<>
            <OrderLeg side={side} qty={qty} price={price} stopType="limit"
              baseCurrency={baseCurrency} quoteCurrency={quoteCurrency}
              tickSize={tickSize} lotSize={lotSize}
              onSideChange={setSide} onQtyChange={setQty} onPriceChange={setPrice}
              onStopTypeChange={() => {}} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={discretionEnabled} onChange={e => {
                setDiscretionEnabled(e.target.checked)
                if (e.target.checked && price) {
                  const px = parseFloat(price), bps = parseFloat(discretionBps)
                  if (!isNaN(px) && !isNaN(bps) && px > 0) {
                    const sp = side === 'BUY' ? px * (1 + bps / 10000) : px * (1 - bps / 10000)
                    setDiscretionPrice(sp.toFixed(tickDecimals(tickSize)))
                  }
                }
              }} />
              <span style={{ fontSize: 11, color: discretionEnabled ? '#2B79DD' : S.muted, fontWeight: discretionEnabled ? 700 : 400 }}>Discretion</span>
            </label>
            {discretionEnabled && (
              <div style={{ background: '#141418', border: '1px solid rgba(43,121,221,0.4)', borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <span style={{ fontSize: 9, color: S.muted, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>DISCRETION (bps)</span>
                  <span style={{ fontSize: 9, color: S.muted, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>{side === 'BUY' ? 'UP TO' : 'DOWN TO'}</span>
                  <span style={{ fontSize: 9, color: S.muted, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>AMOUNT %</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <InlineInput value={discretionBps} onChange={v => {
                    setDiscretionBps(v); const bps = parseFloat(v), px = parseFloat(price)
                    if (!isNaN(bps) && !isNaN(px) && px > 0) setDiscretionPrice((side === 'BUY' ? px * (1 + bps / 10000) : px * (1 - bps / 10000)).toFixed(tickDecimals(tickSize)))
                  }} currency="bps" onUp={() => {
                    const v = String(parseFloat(discretionBps || '0') + 1); setDiscretionBps(v)
                    const px = parseFloat(price); if (!isNaN(px) && px > 0) setDiscretionPrice((side === 'BUY' ? px * (1 + parseFloat(v) / 10000) : px * (1 - parseFloat(v) / 10000)).toFixed(tickDecimals(tickSize)))
                  }} onDown={() => {
                    const v = String(Math.max(0, parseFloat(discretionBps || '0') - 1)); setDiscretionBps(v)
                    const px = parseFloat(price); if (!isNaN(px) && px > 0) setDiscretionPrice((side === 'BUY' ? px * (1 + parseFloat(v) / 10000) : px * (1 - parseFloat(v) / 10000)).toFixed(tickDecimals(tickSize)))
                  }} />
                  <InlineInput value={discretionPrice} onChange={v => {
                    setDiscretionPrice(v); const sp = parseFloat(v), px = parseFloat(price)
                    if (!isNaN(sp) && !isNaN(px) && px > 0) setDiscretionBps(Math.max(0, side === 'BUY' ? (sp - px) / px * 10000 : (px - sp) / px * 10000).toFixed(1))
                  }} currency={quoteCurrency} onUp={() => {
                    const v = (parseFloat(discretionPrice || '0') + tickSize).toFixed(tickDecimals(tickSize)); setDiscretionPrice(v)
                    const px = parseFloat(price); if (!isNaN(px) && px > 0) setDiscretionBps(Math.max(0, side === 'BUY' ? (parseFloat(v) - px) / px * 10000 : (px - parseFloat(v)) / px * 10000).toFixed(1))
                  }} onDown={() => {
                    const v = Math.max(0, parseFloat(discretionPrice || '0') - tickSize).toFixed(tickDecimals(tickSize)); setDiscretionPrice(v)
                    const px = parseFloat(price); if (!isNaN(px) && px > 0) setDiscretionBps(Math.max(0, side === 'BUY' ? (parseFloat(v) - px) / px * 10000 : (px - parseFloat(v)) / px * 10000).toFixed(1))
                  }} />
                  <InlineInput value={discretionPct} onChange={setDiscretionPct} currency="%" onUp={() => setDiscretionPct(String(Math.min(100, parseFloat(discretionPct || '50') + 5)))} onDown={() => setDiscretionPct(String(Math.max(5, parseFloat(discretionPct || '50') - 5)))} />
                </div>
              </div>
            )}
          </>)}
          {tab === 'S/L' && (
            <OrderLeg side={side} qty={qty} price={price} stopType="stop"
              baseCurrency={baseCurrency} quoteCurrency={quoteCurrency}
              tickSize={tickSize} lotSize={lotSize}
              onSideChange={setSide} onQtyChange={setQty} onPriceChange={setPrice}
              onStopTypeChange={() => {}} />
          )}
          {tab === 'ID' && (
            <>
              <OrderLeg label="IF" showTypeToggle
                side={side} qty={qty} price={price} stopType={stopType}
                baseCurrency={baseCurrency} quoteCurrency={quoteCurrency}
                tickSize={tickSize} lotSize={lotSize}
                onSideChange={setSide} onQtyChange={setQty} onPriceChange={setPrice}
                onStopTypeChange={setStopType} />
              <OrderLeg label="THEN" showTypeToggle
                side={side2} qty={qty2 || qty} price={price2} stopType={stopType2}
                baseCurrency={baseCurrency} quoteCurrency={quoteCurrency}
                tickSize={tickSize} lotSize={lotSize}
                onSideChange={setSide2} onQtyChange={setQty2} onPriceChange={setPrice2}
                onStopTypeChange={setStopType2} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: S.muted, cursor: 'pointer' }}>
                <input type="checkbox" checked={orCondition} onChange={e => setOrCondition(e.target.checked)} />
                OR condition
              </label>
              {orCondition && (
                <OrderLeg label="OR" showTypeToggle
                  side={side3} qty={qty3 || qty} price={price3} stopType={stopType3}
                  baseCurrency={baseCurrency} quoteCurrency={quoteCurrency}
                  tickSize={tickSize} lotSize={lotSize}
                  onSideChange={setSide3} onQtyChange={setQty3} onPriceChange={setPrice3}
                  onStopTypeChange={setStopType3} />
              )}
            </>
          )}
          {tab === 'OCO' && (
            <>
              <OrderLeg label="EITHER" showTypeToggle
                side={side} qty={qty} price={price} stopType={stopType}
                baseCurrency={baseCurrency} quoteCurrency={quoteCurrency}
                tickSize={tickSize} lotSize={lotSize}
                onSideChange={setSide} onQtyChange={setQty} onPriceChange={setPrice}
                onStopTypeChange={setStopType} />
              <OrderLeg label="OR" showTypeToggle
                side={side2} qty={qty2 || qty} price={price2} stopType={stopType2}
                baseCurrency={baseCurrency} quoteCurrency={quoteCurrency}
                tickSize={tickSize} lotSize={lotSize}
                onSideChange={setSide2} onQtyChange={setQty2} onPriceChange={setPrice2}
                onStopTypeChange={setStopType2} />
            </>
          )}

          <FooterRow
            hidden={hidden} setHidden={setHidden}
            expiry={expiry} setExpiry={setExpiry}
            gtdDateTime={gtdDateTime} setGtdDateTime={setGtdDateTime}
            priceTrigger={priceTrigger} setPriceTrigger={setPriceTrigger}
            showPriceTrigger={tab !== 'LMT'} />

          {error && (
            <div style={{
              background: 'rgba(251,44,54,0.1)', border: '1px solid rgba(251,44,54,0.3)',
              borderRadius: 4, padding: '8px 12px', fontSize: 11, color: '#FB2C36', lineHeight: 1.4,
            }}>
              <span style={{ fontWeight: 700 }}>Order Rejected: </span>{error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {existingOrderId ? (
              <>
                <button onClick={async () => {
                  setSubmitting(true); setError('')
                  try { await onCancel?.(existingOrderId, exchange); onClose() }
                  catch (e: any) { setError(e.message) }
                  finally { setSubmitting(false) }
                }} style={{
                  flex: 1, padding: '9px 0', border: '1px solid rgba(251,44,54,0.4)',
                  borderRadius: 4, background: 'rgba(251,44,54,0.15)',
                  color: '#FB2C36', fontSize: 12, fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}>Cancel Order</button>
                <button onClick={handleSubmit} disabled={submitting} style={{
                  flex: 2, padding: '9px 0', border: 'none', borderRadius: 4,
                  background: S.gradAction,
                  boxShadow: 'inset 0px 3px 1px rgba(255,255,255,0.2), inset 0px -3px 1px rgba(0,0,0,0.3)',
                  color: '#fff', fontSize: 12, fontWeight: 700,
                  cursor: submitting ? 'wait' : 'pointer', fontFamily: 'inherit',
                }}>{submitting ? 'Amending...' : 'Amend Order'}</button>
              </>
            ) : (
              <>
                <button onClick={onClose} style={{
                  flex: 1, padding: '9px 0', border: `1px solid ${S.border}`,
                  borderRadius: 4, background: 'transparent',
                  color: S.muted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                }}>Cancel</button>
                <button onClick={handleSubmit} disabled={submitting} style={{
                  flex: 2, padding: '9px 0', border: 'none', borderRadius: 4,
                  background: S.gradAction,
                  boxShadow: 'inset 0px 3px 1px rgba(255,255,255,0.2), inset 0px -3px 1px rgba(0,0,0,0.3)',
                  color: '#fff', fontSize: 12, fontWeight: 700,
                  cursor: submitting ? 'wait' : 'pointer', fontFamily: 'inherit',
                }}>{submitting ? 'Placing...' : 'Submit'}</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
