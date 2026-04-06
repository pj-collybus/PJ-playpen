// @ts-nocheck
import { useState, useRef, useEffect, useCallback, useMemo, Component } from 'react'
import { ExchangePill } from '../shared/ExchangePill'

// Error boundary to prevent OptionsMatrix crashes from blanking the whole app
class OptionsMatrixErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('[OptionsMatrix] crash:', error, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ position: 'fixed', left: 100, top: 100, zIndex: 600, padding: 20, background: '#18171C', border: '1px solid #4a1a1a', borderRadius: 8, color: '#e05252', fontSize: 12, maxWidth: 400 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Options Matrix Error</div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>{String(this.state.error)}</div>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 8, background: '#2a2a38', border: '1px solid #363C4E', borderRadius: 4, color: '#aaa', padding: '4px 12px', cursor: 'pointer', fontSize: 10 }}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}

const S = {
  bg: '#18171C', panel: '#141418', border: '#2a2a38', bgInput: '#0e0e14',
  positive: '#00C758', negative: '#FB2C36', blue: '#2B79DD', amber: '#F59E0B',
  text: 'rgba(255,255,255,0.85)', muted: '#636e82', dim: 'rgba(255,255,255,0.4)',
}

const EXCH_COLORS: Record<string, string> = {
  DERIBIT: '#e03040', BITMEX: '#4a90d9', BINANCE: '#f0b90b',
}

const savePos = (key: string, p: { x: number; y: number }) => {
  try { localStorage.setItem(`collybus.pos.${key}`, JSON.stringify(p)) } catch {}
}
const loadPos = (key: string, fb: { x: number; y: number }) => {
  try { const s = localStorage.getItem(`collybus.pos.${key}`); return s ? JSON.parse(s) : fb } catch { return fb }
}
const saveSize = (key: string, sz: { w: number; h: number }) => {
  try { localStorage.setItem(`collybus.size.${key}`, JSON.stringify(sz)) } catch {}
}
const loadSize = (key: string, fb: { w: number; h: number }) => {
  try { const s = localStorage.getItem(`collybus.size.${key}`); return s ? JSON.parse(s) : fb } catch { return fb }
}

interface MatrixCell {
  instrument: string; optionType: string; strike: number; expiry: string; dte: number
  bid: number; ask: number; mark: number; markIv: number; bidIv: number; askIv: number
  volume: number; openInterest: number
}
interface MatrixResponse {
  strikes: number[]; expiries: string[]; cells: Record<string, Record<string, MatrixCell>>
  indexPrice: number; atmStrike: number; instrument: string; type: string; timestamp: number
}
interface ExpiriesResponse {
  expiries: string[]; indexPrice: number; instrument: string; type: string
}

type ViewMode = 'bidask' | 'iv'
type OptionType = 'calls' | 'puts' | 'both'
type SideMode = 'buy' | 'sell'
type InstrumentId = 'BTC' | 'BTC_USDC' | 'ETH' | 'ETH_USDC' | 'SOL_USDC' | 'XRP_USDC'

const INSTRUMENTS: InstrumentId[] = ['BTC', 'BTC_USDC', 'ETH', 'ETH_USDC', 'SOL_USDC', 'XRP_USDC']
const INSTRUMENT_LABELS: Record<InstrumentId, string> = {
  BTC: 'BTC', BTC_USDC: 'BTC USDC', ETH: 'ETH', ETH_USDC: 'ETH USDC', SOL_USDC: 'SOL USDC', XRP_USDC: 'XRP USDC',
}
const INVERSE_BASES = new Set(['BTC', 'ETH'])

export interface OptionsMatrixProps {
  apiBase?: string; initialInstrument?: string
  onOrderClick?: (cell: MatrixCell) => void; onClose?: () => void
  layoutWidth?: number; layoutHeight?: number  // when controlled by parent layout
}

const fmtStrike = (v: number) => v >= 1 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${v.toFixed(4)}`
const parseStrike = (val: string): number => {
  const s = val.toLowerCase().trim()
  if (s.endsWith('k')) return parseFloat(s) * 1000
  if (s.endsWith('m')) return parseFloat(s) * 1000000
  return parseFloat(s.replace(/,/g, ''))
}
const fmtIndex = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// ── Exchange pill — exact same style as price panel headers ──
function ExchPill({ ex }: { ex: string }) {
  const c = EXCH_COLORS[ex] ?? '#555'
  return <span style={{ background: `${c}22`, color: c, border: `1px solid ${c}44`, borderRadius: 3, padding: '1px 5px', fontSize: 9, fontWeight: 700 }}>{ex}</span>
}

// ── 3D Pill button ──
function Pill({ active, onClick, children, color, disabled, style: extra }: {
  active: boolean; onClick: () => void; children: React.ReactNode; color?: string; disabled?: boolean; style?: React.CSSProperties
}) {
  const c = color ?? S.blue
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: active
        ? `linear-gradient(to bottom, ${c}33 0%, ${c}18 100%)`
        : 'linear-gradient(to bottom, #3C3B42, #323138, #2B2A2F)',
      border: `1px solid ${active ? c + '88' : S.border}`,
      borderRadius: 4, padding: '3px 9px', fontSize: 10, fontWeight: 600,
      color: active ? c : 'rgba(255,255,255,0.35)',
      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
      boxShadow: active
        ? `inset 0px 1px 0px rgba(255,255,255,0.12), inset 0px -1px 0px rgba(0,0,0,0.3), 0 0 6px ${c}22`
        : 'inset 0px 1px 0px rgba(255,255,255,0.06), inset 0px -1px 0px rgba(0,0,0,0.3)',
      opacity: disabled ? 0.3 : 1, transition: 'all 0.15s', ...extra,
    }}>{children}</button>
  )
}

// ── Price cell button — EXACT BuySellButton style from atoms/BuySellButton.tsx ──
const GRAD_ACTION = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'
const GRAD_ACTION_HOVER = 'linear-gradient(to right, #2656b7 0%, #3A8FE4 100%)'
const SHADOW_ACTION = 'inset 0px 3px 1px rgba(255,255,255,0.25), inset 0px -3px 1px rgba(0,0,0,0.25), inset 0px 4px 4px rgba(0,0,0,0.25)'
const GRAD_SELL = 'linear-gradient(to right, #941A1A 0%, #DD2B2B 100%)'
const GRAD_SELL_HOVER = 'linear-gradient(to right, #b72626 0%, #E43A3A 100%)'

function PriceBtn({ value, sub, side, onClick }: { value: string; sub?: string; side: SideMode; onClick?: () => void }) {
  if (value === '—') return <span style={{ color: S.dim, fontSize: 10 }}>—</span>
  const isBuy = side === 'buy'
  const grad = isBuy ? GRAD_ACTION : GRAD_SELL
  const gradH = isBuy ? GRAD_ACTION_HOVER : GRAD_SELL_HOVER
  return (
    <button onClick={onClick}
      onMouseEnter={e => e.currentTarget.style.background = gradH}
      onMouseLeave={e => e.currentTarget.style.background = grad}
      style={{
        background: grad, border: 'none', borderRadius: 4,
        padding: '5px 6px', cursor: 'pointer',
        width: 90, minWidth: 90, maxWidth: 90,
        textAlign: 'center', fontFamily: 'inherit',
        boxShadow: SHADOW_ACTION,
      }}>
      <div style={{ fontSize: 12, fontWeight: 400, color: '#fff', lineHeight: 1.3 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, fontWeight: 400, color: '#CFD1D4', lineHeight: 1.2, marginTop: 1 }}>{sub}</div>}
    </button>
  )
}

// Dark dropdown style
const selectStyle: React.CSSProperties = {
  height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3,
  color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', fontFamily: 'inherit', cursor: 'pointer',
}

// Format expiry header: 5APR26
const fmtExpiry = (exp: string) => {
  try {
    const d = new Date(exp)
    if (!isNaN(d.getTime())) {
      const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
      return `${d.getUTCDate()}${months[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`
    }
  } catch {}
  return exp
}

function OptionsMatrixInner({ apiBase = '', initialInstrument, onOrderClick, onClose, layoutWidth, layoutHeight }: OptionsMatrixProps) {
  const isLayoutControlled = layoutWidth != null && layoutHeight != null
  // ── All useState declarations first ──
  const posKey = 'optionsMatrix'
  const [pos, setPos] = useState(() => loadPos(posKey, { x: 80, y: 60 }))
  const [size, setSize] = useState(() => loadSize(posKey, { w: 920, h: 580 }))
  // Min width: strike col (80) + 3 expiry cols (98 each) + scrollbar (16) = 390
  const [toolbarMinW, setToolbarMinW] = useState(80 + 98 * 3 + 16)
  const [instrument, setInstrument] = useState<InstrumentId>((initialInstrument as InstrumentId) || 'BTC')
  const [optionType, setOptionType] = useState<OptionType>('calls')
  const [sideMode, setSideMode] = useState<SideMode>('buy')
  const [viewMode, setViewMode] = useState<ViewMode>('bidask')
  const [atmMode, setAtmMode] = useState(true)
  const [strikeMin, setStrikeMin] = useState('')
  const [strikeMax, setStrikeMax] = useState('')
  const [availableExpiries, setAvailableExpiries] = useState<string[]>([])
  const [indexPrice, setIndexPrice] = useState(0)
  const [expiryFrom, setExpiryFrom] = useState('')
  const [expiryTo, setExpiryTo] = useState('')
  const [data, setData] = useState<MatrixResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchTs, setLastFetchTs] = useState(0)
  const [now, setNow] = useState(Date.now())

  // ── All useRef declarations ──
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const resizeRef = useRef<any>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const autoSelectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── useEffect — position/size persistence ──
  useEffect(() => { savePos(posKey, pos) }, [pos])
  useEffect(() => { saveSize(posKey, size) }, [size])
  // Measure toolbar natural width on mount to set min panel width
  useEffect(() => {
    const el = toolbarRef.current
    if (!el) return
    requestAnimationFrame(() => {
      const w = el.scrollWidth + 20
      if (w > 300) setToolbarMinW(w)
    })
  }, [instrument, optionType, atmMode])

  // Stage 1: Fetch expiries + subscribe to websocket on instrument change
  const fetchExpiries = useCallback(async () => {
    try {
      const params = new URLSearchParams({ instrument, type: optionType === 'both' ? 'calls' : optionType })
      const resp = await fetch(`${apiBase}/api/options/expiries?${params}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json: ExpiriesResponse = await resp.json()
      setAvailableExpiries(json.expiries ?? [])
      setIndexPrice(json.indexPrice ?? 0)
      setExpiryFrom('')
      setExpiryTo('')
      setData(null)
      if (autoSelectTimer.current) clearTimeout(autoSelectTimer.current)
      autoSelectTimer.current = setTimeout(() => {
        if (json.expiries?.length > 0) setExpiryTo(json.expiries[0])
      }, 2000)
      // Subscribe to websocket summary feed
      fetch(`${apiBase}/api/options/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument }),
      }).catch(() => {})
    } catch (e: any) { setError(e.message ?? 'Failed to load expiries') }
  }, [apiBase, instrument, optionType])

  useEffect(() => { fetchExpiries() }, [fetchExpiries])
  // Unsubscribe on unmount
  useEffect(() => {
    return () => {
      fetch(`${apiBase}/api/options/unsubscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument }),
      }).catch(() => {})
    }
  }, [apiBase, instrument])

  // Stage 2: Initial matrix load when expiryTo selected (one-time REST fetch for structure)
  const fetchMatrix = useCallback(async () => {
    if (!expiryTo) return
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('exchange', 'Deribit')
      params.set('instrument', instrument)
      params.set('type', optionType === 'both' ? 'both' : optionType)
      if (atmMode) params.set('atmOnly', 'true')
      if (expiryFrom) params.set('fromExpiry', expiryFrom)
      if (expiryTo) params.set('toExpiry', expiryTo)
      const resp = await fetch(`${apiBase}/api/options/matrix?${params}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      setError(null)
      setData(json)
      setIndexPrice(json.indexPrice ?? 0)
      setLastFetchTs(Date.now())
    } catch (e: any) { setError(e.message ?? 'Fetch failed') }
    finally { setLoading(false) }
  }, [apiBase, instrument, optionType, atmMode, expiryFrom, expiryTo])

  // Fetch initial matrix data once when expiryTo changes
  useEffect(() => { if (expiryTo) fetchMatrix() }, [expiryTo, instrument, optionType, atmMode])

  // Live websocket updates — merge incoming summaries into existing cells
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.summaries) return
      setLastFetchTs(Date.now())
      const sums = detail.summaries as any[]
      // Build lookup by instrument name
      const sumMap: Record<string, any> = {}
      for (const s of sums) if (s.instrument) sumMap[s.instrument] = s
      // Update index price from underlying
      const anySum = sums[0]
      if (anySum?.underlyingPrice > 0) setIndexPrice(anySum.underlyingPrice)
      // Merge into existing data
      setData(prev => {
        if (!prev) return prev
        const merged = { ...prev, timestamp: Date.now() }
        const mc = { ...prev.cells }
        for (const sk of Object.keys(mc)) {
          mc[sk] = { ...mc[sk] }
          for (const exp of Object.keys(mc[sk])) {
            const cell = mc[sk][exp] as any
            if (!cell?.instrument) continue
            const update = sumMap[cell.instrument]
            if (update && (update.bidPrice || update.askPrice)) {
              mc[sk][exp] = {
                ...cell,
                bid: update.bidPrice ?? cell.bid,
                ask: update.askPrice ?? cell.ask,
                mark: update.markPrice ?? cell.mark,
                markIv: update.markIv ?? cell.markIv,
                bidIv: update.bidIv ?? cell.bidIv,
                askIv: update.askIv ?? cell.askIv,
                volume: update.volume ?? cell.volume,
                openInterest: update.openInterest ?? cell.openInterest,
              }
            }
          }
        }
        merged.cells = mc
        return merged
      })
    }
    window.addEventListener('options-update', handler)
    return () => window.removeEventListener('options-update', handler)
  }, [])

  // Freshness indicator — live if last update within 10s
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const isLive = lastFetchTs > 0 && (now - lastFetchTs) < 10000

  // ATM filter: 4 above + ATM + 4 below = 9 strikes
  const filteredStrikes = useMemo(() => {
    if (!data) return []
    let strikes = data.strikes
    if (atmMode && data.atmStrike > 0) {
      const atmIdx = strikes.indexOf(data.atmStrike)
      if (atmIdx >= 0) {
        strikes = strikes.slice(Math.max(0, atmIdx - 4), Math.min(strikes.length, atmIdx + 5))
      }
    } else if (!atmMode && (strikeMin || strikeMax)) {
      const mn = strikeMin ? parseStrike(strikeMin) : 0
      const mx = strikeMax ? parseStrike(strikeMax) : Infinity
      strikes = strikes.filter(s => s >= mn && s <= mx)
    }
    return strikes
  }, [data, atmMode, strikeMin, strikeMax])

  // Filter expiries by from/to dropdowns — index-based on sorted API list
  const filteredExpiries = useMemo(() => {
    if (!data?.expiries?.length) return []
    const all = data.expiries
    const fromIdx = expiryFrom ? all.indexOf(expiryFrom) : 0
    const toIdx = expiryTo ? all.indexOf(expiryTo) : all.length - 1
    const lo = fromIdx >= 0 ? fromIdx : 0
    const hi = toIdx >= 0 ? toIdx : all.length - 1
    return all.filter((_, i) => i >= lo && i <= hi)
  }, [data, expiryFrom, expiryTo])

  // Format cell
  const fmtCell = (cell: MatrixCell | undefined) => {
    if (!cell) return { val: '—', sub: '' }
    const base = instrument.split('_')[0]
    const isInverse = INVERSE_BASES.has(base)
    if (viewMode === 'iv') return { val: cell.markIv > 0 ? `${cell.markIv.toFixed(1)}%` : '—', sub: '' }
    const price = sideMode === 'buy' ? cell.ask : cell.bid
    if (price <= 0) return { val: '—', sub: '' }
    const usd = isInverse && indexPrice ? price * indexPrice : price
    const main = usd >= 1 ? `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${usd.toFixed(4)}`
    const sub = isInverse ? `${price.toFixed(6)} ${base}` : ''
    return { val: main, sub }
  }

  // Drag/resize
  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,label')) return
    e.preventDefault()
    dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }
    const mv = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }
    const up = () => { dragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { sx: e.clientX, sy: e.clientY, sw: size.w, sh: size.h }
    const mv = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      setSize({ w: Math.max(toolbarMinW, resizeRef.current.sw + ev.clientX - resizeRef.current.sx), h: Math.max(300, resizeRef.current.sh + ev.clientY - resizeRef.current.sy) })
    }
    const up = () => { resizeRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }

  return (
    <div style={{
      position: isLayoutControlled ? 'relative' : 'fixed',
      left: isLayoutControlled ? 0 : pos.x, top: isLayoutControlled ? 0 : pos.y,
      zIndex: isLayoutControlled ? undefined : 600,
      width: isLayoutControlled ? '100%' : size.w,
      minWidth: isLayoutControlled ? undefined : toolbarMinW,
      height: isLayoutControlled ? '100%' : size.h,
      background: S.bg, border: `1px solid ${S.border}`, borderRadius: 8,
      boxShadow: '0 20px 80px rgba(0,0,0,0.95), 0 0 0 1px rgba(100,100,150,0.2)',
      display: 'flex', flexDirection: 'column', userSelect: 'none', fontFamily: 'inherit',
    }}>
      {/* ── Header ── */}
      <div onMouseDown={isLayoutControlled ? undefined : onHeaderMouseDown} style={{ padding: '8px 10px 6px', cursor: isLayoutControlled ? 'default' : 'grab', borderBottom: `1px solid ${S.border}` }}>
        {/* Row 1 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: S.text }}>OPTIONS MATRIX</span>
            <ExchangePill exchange="DERIBIT" />
            {loading && <span style={{ fontSize: 9, color: S.amber }}>loading...</span>}
            {error && <span style={{ fontSize: 9, color: S.negative }}>{error}</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {indexPrice > 0 && (
              <span style={{ fontSize: 11, fontWeight: 600, color: S.text }}>
                <span style={{ color: S.muted, fontSize: 9, marginRight: 4 }}>INDEX</span>
                {fmtIndex(indexPrice)}
              </span>
            )}
            {isLive && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 8, background: 'rgba(0,199,88,0.15)', color: S.positive, border: '1px solid rgba(0,199,88,0.4)', animation: 'pulse 2s ease-in-out infinite' }}>LIVE</span>
            )}
            {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 3px' }}>×</button>}
          </div>
        </div>

        {/* Row 2: Instruments */}
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 5 }}>
          {INSTRUMENTS.map(i => (
            <Pill key={i} active={instrument === i} onClick={() => setInstrument(i)}>{INSTRUMENT_LABELS[i]}</Pill>
          ))}
        </div>

        {/* Row 3: Type | Side | View | ATM | Strike */}
        <div ref={toolbarRef} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['calls', 'puts', 'both'] as OptionType[]).map(t => (
            <Pill key={t} active={optionType === t} onClick={() => setOptionType(t)}
              color={t === 'calls' ? S.positive : t === 'puts' ? S.negative : S.blue}
            >{t === 'calls' ? 'Calls' : t === 'puts' ? 'Puts' : 'Both'}</Pill>
          ))}
          <span style={{ width: 1, height: 16, background: S.border }} />
          <Pill active={sideMode === 'buy'} onClick={() => setSideMode('buy')} color={S.positive}>Buy</Pill>
          <Pill active={sideMode === 'sell'} onClick={() => setSideMode('sell')} color={S.negative}>Sell</Pill>
          <span style={{ width: 1, height: 16, background: S.border }} />
          <Pill active={viewMode === 'bidask'} onClick={() => setViewMode('bidask')}>Bid/Ask</Pill>
          <Pill active={viewMode === 'iv'} onClick={() => setViewMode('iv')}>IV%</Pill>
          <span style={{ width: 1, height: 16, background: S.border }} />
          <Pill active={atmMode} onClick={() => { setAtmMode(v => !v); if (!atmMode) { setStrikeMin(''); setStrikeMax('') } }} color={S.blue}>ATM</Pill>
          {!atmMode && (
            <>
              <span style={{ fontSize: 9, color: S.muted }}>Min</span>
              <input value={strikeMin} onChange={e => setStrikeMin(e.target.value)} placeholder="0"
                style={{ width: 60, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 6px', outline: 'none', fontFamily: 'inherit' }} />
              <span style={{ fontSize: 9, color: S.muted }}>–</span>
              <input value={strikeMax} onChange={e => setStrikeMax(e.target.value)} placeholder="∞"
                style={{ width: 60, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 6px', outline: 'none', fontFamily: 'inherit' }} />
            </>
          )}
        </div>

        {/* Row 4: Expiry From/To — dedicated row */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 5, paddingTop: 5, borderTop: '1px solid #1e1e28' }}>
          <span style={{ fontSize: 9, color: S.muted, fontWeight: 600 }}>Exp</span>
          <span style={{ fontSize: 9, color: S.dim }}>From:</span>
          <select value={expiryFrom} onChange={e => setExpiryFrom(e.target.value)} style={{ ...selectStyle, width: 90 }}>
            <option value="">Today</option>
            {availableExpiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
          </select>
          <span style={{ fontSize: 9, color: S.dim }}>→</span>
          <span style={{ fontSize: 9, color: S.dim }}>To:</span>
          <select value={expiryTo} onChange={e => setExpiryTo(e.target.value)} style={{ ...selectStyle, width: 90 }}>
            <option value="">Select</option>
            {availableExpiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
          </select>
          {availableExpiries.length === 0 && !loading && (
            <span style={{ fontSize: 9, color: S.amber }}>No expiries available for {INSTRUMENT_LABELS[instrument]}</span>
          )}
        </div>
      </div>

      {/* ── Grid ── */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {data && filteredStrikes.length > 0 && filteredExpiries.length > 0 ? (
          <table style={{ borderCollapse: 'collapse', fontSize: 10, fontFamily: 'inherit' }}>
            <thead>
              <tr>
                <th style={{
                  position: 'sticky', top: 0, left: 0, zIndex: 3,
                  background: S.panel, padding: '6px 10px', textAlign: 'left',
                  color: S.muted, fontWeight: 700, fontSize: 9, letterSpacing: '0.05em',
                  borderBottom: `1px solid ${S.border}`, borderRight: `1px solid ${S.border}`,
                  textTransform: 'uppercase', width: 80, minWidth: 80, maxWidth: 80,
                }}>Strike</th>
                {filteredExpiries.map(exp => (
                  <th key={exp} style={{
                    position: 'sticky', top: 0, zIndex: 2,
                    background: S.panel, padding: '6px 4px', textAlign: 'center',
                    borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap', fontSize: 10,
                    width: 98, minWidth: 98,
                  }}>
                    <span style={{ color: S.text, fontWeight: 600 }}>{fmtExpiry(exp)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredStrikes.map(strike => {
                const isAtm = data.atmStrike === strike
                const sk = strike.toFixed(0)
                return (
                  <tr key={strike} style={{ background: isAtm ? 'rgba(204,170,68,0.06)' : 'transparent' }}>
                    <td style={{
                      position: 'sticky', left: 0, zIndex: 1,
                      background: isAtm ? '#1e1c14' : S.panel,
                      padding: '5px 10px', textAlign: 'left',
                      color: isAtm ? '#ccaa44' : S.text, fontWeight: isAtm ? 700 : 500,
                      borderRight: `1px solid ${S.border}`,
                      borderLeft: isAtm ? '3px solid #ccaa44' : '3px solid transparent',
                      borderBottom: `1px solid ${S.border}10`,
                      whiteSpace: 'nowrap', fontSize: 11,
                      width: 80, minWidth: 80, maxWidth: 80,
                    }}>
                      {fmtStrike(strike)}
                      {isAtm && <span style={{ fontSize: 8, color: '#ccaa44', marginLeft: 5, fontWeight: 700 }}>ATM</span>}
                    </td>
                    {filteredExpiries.map(exp => {
                      const cell = data.cells[sk]?.[exp] as MatrixCell | undefined
                      const { val, sub } = fmtCell(cell)
                      return (
                        <td key={exp} style={{
                          padding: '3px 4px', textAlign: 'center',
                          borderBottom: `1px solid ${S.border}10`,
                          width: 98, minWidth: 98,
                        }}>
                          {cell && val !== '—' ? (
                            <PriceBtn value={val} sub={sub} side={sideMode} onClick={() => onOrderClick?.(cell)} />
                          ) : (
                            <span style={{ color: S.dim, fontSize: 10 }}>—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : !expiryTo ? (
          <div style={{ padding: 40, textAlign: 'center', color: S.muted, fontSize: 12 }}>
            Select an expiry date to load options data
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: S.muted, fontSize: 12 }}>
            {loading ? 'Loading options data...' : error ? `Error: ${error}` : 'No data available.'}
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div style={{ padding: '4px 10px', borderTop: `1px solid ${S.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: S.muted }}>
          {data ? `${filteredStrikes.length} strikes × ${filteredExpiries.length} expiries` : `${availableExpiries.length} expiry dates available`}
        </span>
        <span style={{ fontSize: 9, color: S.dim }}>
          {data ? new Date(data.timestamp).toLocaleTimeString() : ''}
        </span>
      </div>

      {/* ── Resize handle (only when self-managed) ── */}
      {!isLayoutControlled && (
        <div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize', opacity: 0.4 }}>
          <svg width="14" height="14" viewBox="0 0 14 14">
            <line x1="10" y1="4" x2="4" y2="10" stroke={S.muted} strokeWidth="1" />
            <line x1="12" y1="6" x2="6" y2="12" stroke={S.muted} strokeWidth="1" />
            <line x1="14" y1="8" x2="8" y2="14" stroke={S.muted} strokeWidth="1" />
          </svg>
        </div>
      )}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
    </div>
  )
}

export function OptionsMatrix(props: OptionsMatrixProps) {
  return (
    <OptionsMatrixErrorBoundary>
      <OptionsMatrixInner {...props} />
    </OptionsMatrixErrorBoundary>
  )
}
