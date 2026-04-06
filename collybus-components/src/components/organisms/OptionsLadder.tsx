// @ts-nocheck
import React, { useState, useRef, useEffect, useCallback, useMemo, Component } from 'react'

const S = {
  bg: '#18171C', panel: '#141418', border: '#2a2a38', bgInput: '#0e0e14',
  positive: '#00C758', negative: '#FB2C36', blue: '#2B79DD', amber: '#F59E0B',
  text: 'rgba(255,255,255,0.85)', muted: '#636e82', dim: 'rgba(255,255,255,0.4)',
}

type InstrumentId = 'BTC' | 'BTC_USDC' | 'ETH' | 'ETH_USDC' | 'SOL_USDC' | 'XRP_USDC'
type CpFilter = 'calls' | 'puts' | 'both'

// All instrument pills in order
const PILL_INSTRUMENTS: { label: string; id: InstrumentId }[] = [
  { label: 'BTC', id: 'BTC' }, { label: 'BTC USDC', id: 'BTC_USDC' },
  { label: 'ETH', id: 'ETH' }, { label: 'ETH USDC', id: 'ETH_USDC' },
  { label: 'SOL USDC', id: 'SOL_USDC' }, { label: 'XRP USDC', id: 'XRP_USDC' },
]
const PILL_IDS = new Set(PILL_INSTRUMENTS.map(p => p.id))
const LABELS: Record<InstrumentId, string> = { BTC: 'BTC', BTC_USDC: 'BTC USDC', ETH: 'ETH', ETH_USDC: 'ETH USDC', SOL_USDC: 'SOL USDC', XRP_USDC: 'XRP USDC' }
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

const fmtStrike = (v: number) => v >= 1 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${v.toFixed(4)}`
const fmtIndex = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const fmtExpiry = (exp: string) => {
  try { const d = new Date(exp); if (!isNaN(d.getTime())) return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}` } catch {}
  return exp
}
// Convert yyyy-MM-dd to Deribit instrument name format: 7APR26
const toDeribitExpiry = (exp: string) => {
  try { const d = new Date(exp); if (!isNaN(d.getTime())) return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}` } catch {}
  return exp
}

// Column definitions — fixed order matching reference screenshot
interface ColDef { key: string; label: string; width: number; defaultVisible: boolean; style: 'bid' | 'ask' | 'mark' | 'iv' | 'greek' | 'vol' | 'size' }

// Calls: left-to-right = ΔDelta, Last, Size, IV Bid, Bid, Mark, Ask, IV Ask, Size
const CALL_COLUMNS: ColDef[] = [
  { key: 'delta', label: 'ΔDelta', width: 46, defaultVisible: false, style: 'greek' },
  { key: 'last', label: 'Last', width: 50, defaultVisible: false, style: 'mark' },
  { key: 'openInterest', label: 'Size', width: 44, defaultVisible: true, style: 'vol' },
  { key: 'markIv', label: 'IV Bid', width: 46, defaultVisible: true, style: 'iv' },
  { key: 'bid', label: 'Bid', width: 58, defaultVisible: true, style: 'bid' },
  { key: 'mark', label: 'Mark', width: 54, defaultVisible: true, style: 'mark' },
  { key: 'ask', label: 'Ask', width: 58, defaultVisible: true, style: 'ask' },
  { key: 'askIv', label: 'IV Ask', width: 46, defaultVisible: false, style: 'iv' },
  { key: 'volume', label: 'Size', width: 44, defaultVisible: true, style: 'size' },
]

// Puts: left-to-right = Size, IV Bid, Bid, Mark, Ask, IV Ask, Size, Last, ΔDelta
const PUT_COLUMNS: ColDef[] = [
  { key: 'volume', label: 'Size', width: 44, defaultVisible: true, style: 'size' },
  { key: 'markIv', label: 'IV Bid', width: 46, defaultVisible: true, style: 'iv' },
  { key: 'bid', label: 'Bid', width: 58, defaultVisible: true, style: 'bid' },
  { key: 'mark', label: 'Mark', width: 54, defaultVisible: true, style: 'mark' },
  { key: 'ask', label: 'Ask', width: 58, defaultVisible: true, style: 'ask' },
  { key: 'askIv', label: 'IV Ask', width: 46, defaultVisible: false, style: 'iv' },
  { key: 'openInterest', label: 'Size', width: 44, defaultVisible: true, style: 'vol' },
  { key: 'last', label: 'Last', width: 50, defaultVisible: false, style: 'mark' },
  { key: 'delta', label: 'ΔDelta', width: 46, defaultVisible: false, style: 'greek' },
]

// All unique column keys for settings modal
const ALL_COLUMNS: ColDef[] = [
  { key: 'bid', label: 'Bid', width: 58, defaultVisible: true, style: 'bid' },
  { key: 'ask', label: 'Ask', width: 58, defaultVisible: true, style: 'ask' },
  { key: 'mark', label: 'Mark', width: 54, defaultVisible: true, style: 'mark' },
  { key: 'markIv', label: 'IV Bid', width: 46, defaultVisible: true, style: 'iv' },
  { key: 'askIv', label: 'IV Ask', width: 46, defaultVisible: false, style: 'iv' },
  { key: 'last', label: 'Last', width: 50, defaultVisible: false, style: 'mark' },
  { key: 'volume', label: 'Volume', width: 44, defaultVisible: true, style: 'size' },
  { key: 'openInterest', label: 'Open Interest', width: 44, defaultVisible: true, style: 'vol' },
  { key: 'delta', label: 'ΔDelta', width: 46, defaultVisible: false, style: 'greek' },
  { key: 'gamma', label: 'Gamma', width: 42, defaultVisible: false, style: 'greek' },
  { key: 'vega', label: 'Vega', width: 42, defaultVisible: false, style: 'greek' },
  { key: 'theta', label: 'Theta', width: 42, defaultVisible: false, style: 'greek' },
]

const GRAD_BUY = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'
const GRAD_BUY_H = 'linear-gradient(to right, #2656b7 0%, #3A8FE4 100%)'
const GRAD_SELL = 'linear-gradient(to right, #941A1A 0%, #DD2B2B 100%)'
const GRAD_SELL_H = 'linear-gradient(to right, #b72626 0%, #E43A3A 100%)'
const SHADOW_BTN = 'inset 0px 3px 1px rgba(255,255,255,0.25), inset 0px -3px 1px rgba(0,0,0,0.25), inset 0px 4px 4px rgba(0,0,0,0.25)'

function fmtCell(val: any, format: string): string {
  if (val == null || val === 0) return '—'
  switch (format) {
    case 'price': return Number(val).toFixed(4).replace(/\.?0+$/, '')
    case 'iv': return `${Number(val).toFixed(1)}%`
    case 'greek': return Number(val).toFixed(4)
    case 'vol': return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(Math.round(val))
    default: return String(val)
  }
}

// Pill button
function Pill({ active, onClick, children, color, style: extra }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string; style?: React.CSSProperties }) {
  const c = color ?? S.blue
  return <button onClick={onClick} style={{
    background: active ? `linear-gradient(to bottom, ${c}33, ${c}18)` : 'linear-gradient(to bottom, #3C3B42, #323138, #2B2A2F)',
    border: `1px solid ${active ? c + '88' : S.border}`, borderRadius: 4, padding: '3px 8px', fontSize: 10, fontWeight: 600,
    color: active ? c : 'rgba(255,255,255,0.35)', cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: active ? `inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(0,0,0,0.3), 0 0 6px ${c}22` : 'inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -1px 0 rgba(0,0,0,0.3)',
    transition: 'all 0.15s', ...extra,
  }}>{children}</button>
}

const selectStyle: React.CSSProperties = { height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', fontFamily: 'inherit', cursor: 'pointer' }

// Props
export interface OptionsLadderConfig { instrument?: string; expiry?: string; atmN?: number; atmOnly?: boolean; strikeMin?: string; strikeMax?: string; visibleCols?: string[]; cpFilter?: string }
export interface OptionsLadderProps { apiBase?: string; initialConfig?: OptionsLadderConfig; onOrderClick?: (cell: any, side: string) => void; onClose?: () => void; onConfigChange?: (config: OptionsLadderConfig) => void; onDrag?: (e: React.MouseEvent) => void; layoutWidth?: number; layoutHeight?: number }

// Row data
interface LadderRow { strike: number; call: Record<string, any> | null; put: Record<string, any> | null }

// Settings modal
function SettingsModal({ visibleCols, onSave, onCancel }: { visibleCols: Set<string>; onSave: (cols: Set<string>) => void; onCancel: () => void }) {
  const [sel, setSel] = useState(new Set(visibleCols))
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: '#18171C', border: '1px solid #2a2a3a', borderRadius: 8, width: 360, padding: '16px 20px', boxShadow: '0 20px 80px rgba(0,0,0,0.95)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: S.text, marginBottom: 2 }}>Tile Configuration</div>
        <div style={{ fontSize: 10, color: S.muted, marginBottom: 12 }}>Options Ladder</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#888', textTransform: 'uppercase', marginBottom: 6 }}>Display Columns</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 14 }}>
          {ALL_COLUMNS.map(c => <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: sel.has(c.key) ? S.text : S.muted, cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.has(c.key)} onChange={() => setSel(p => { const n = new Set(p); n.has(c.key) ? n.delete(c.key) : n.add(c.key); return n })} style={{ accentColor: '#2B79DD' }} />{c.label}
          </label>)}
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={() => setSel(new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key)))} style={{ background: 'transparent', border: '1px solid #2a2a3a', borderRadius: 4, color: S.muted, fontSize: 10, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>Reset</button>
          <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid #2a2a3a', borderRadius: 4, color: S.muted, fontSize: 10, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={() => onSave(sel)} style={{ background: GRAD_BUY, border: 'none', borderRadius: 4, color: '#fff', fontSize: 10, fontWeight: 700, padding: '5px 14px', cursor: 'pointer', fontFamily: 'inherit', boxShadow: SHADOW_BTN }}>Save</button>
        </div>
      </div>
    </div>
  )
}

// Error boundary
class LadderErrorBoundary extends Component { state = { error: null }; static getDerivedStateFromError(e) { return { error: e } }; render() { return this.state.error ? <div style={{ padding: 20, color: '#e05252' }}>Ladder Error: {String(this.state.error)}</div> : this.props.children } }

function OptionsLadderInner({ apiBase = '', initialConfig, onOrderClick, onClose, onConfigChange, onDrag, layoutWidth, layoutHeight }: OptionsLadderProps) {
  const isLayout = layoutWidth != null && layoutHeight != null
  const ic = initialConfig

  // State
  const [instrument, setInstrument] = useState<InstrumentId>((ic?.instrument ?? 'BTC') as InstrumentId)
  const [cpFilter, setCpFilter] = useState<CpFilter>((ic?.cpFilter ?? 'both') as CpFilter)
  const [expiry, setExpiry] = useState(ic?.expiry ?? '')
  const [atmN, setAtmN] = useState(ic?.atmN ?? 8)
  const [atmOnly, setAtmOnly] = useState(ic?.atmOnly ?? true)
  const [strikeMin, setStrikeMin] = useState(ic?.strikeMin ?? '')
  const [strikeMax, setStrikeMax] = useState(ic?.strikeMax ?? '')
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => ic?.visibleCols ? new Set(ic.visibleCols) : new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key)))
  const [availableExpiries, setAvailableExpiries] = useState<string[]>([])
  const [indexPrice, setIndexPrice] = useState(0)
  const [rows, setRows] = useState<LadderRow[]>([])
  const [atmStrike, setAtmStrike] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchTs, setLastFetchTs] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [othersOpen, setOthersOpen] = useState(false)

  const isFirstLoad = useRef(true)
  const savedExpiry = useRef(ic?.expiry ?? '')
  const gridRef = useRef<HTMLDivElement>(null)
  const othersRef = useRef<HTMLDivElement>(null)

  // Persist config
  useEffect(() => {
    onConfigChange?.({ instrument, expiry, atmN, atmOnly, strikeMin, strikeMax, visibleCols: [...visibleCols], cpFilter })
  }, [instrument, expiry, atmN, atmOnly, strikeMin, strikeMax, visibleCols, cpFilter])

  // Freshness
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const isLive = lastFetchTs > 0 && (now - lastFetchTs) < 10000

  // Close "Others" on outside click
  useEffect(() => { if (!othersOpen) return; const h = (e: MouseEvent) => { if (othersRef.current && !othersRef.current.contains(e.target as Node)) setOthersOpen(false) }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h) }, [othersOpen])

  // Load expiries
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const resp = await fetch(`${apiBase}/api/options/expiries?instrument=${instrument}&type=both`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const json = await resp.json()
        if (cancelled) return
        setAvailableExpiries(json.expiries ?? [])
        setIndexPrice(json.indexPrice ?? 0)
        if (isFirstLoad.current) {
          isFirstLoad.current = false
          const dates = json.expiries ?? []
          setExpiry(dates.includes(savedExpiry.current) ? savedExpiry.current : dates[0] ?? '')
        } else { setExpiry((json.expiries ?? [])[0] ?? ''); setRows([]) }
        fetch(`${apiBase}/api/options/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument }) }).catch(() => {})
      } catch (e: any) { if (!cancelled) setError(e.message) }
    }
    load()
    return () => { cancelled = true; fetch(`${apiBase}/api/options/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument }) }).catch(() => {}) }
  }, [apiBase, instrument])

  // Build rows from bulk summary data
  const buildRows = useCallback((summaries: any[], idxPrice: number) => {
    const expiryStr = toDeribitExpiry(expiry)
    const rowMap: Record<number, { call: any; put: any }> = {}
    for (const s of summaries) {
      const name = s.instrument_name ?? s.instrument ?? ''
      if (!name.includes(expiryStr)) continue
      // Parse: BTC-7APR26-69000-C
      const parts = name.split('-')
      const strike = parseFloat(parts[parts.length - 2])
      const type = parts[parts.length - 1] // C or P
      if (isNaN(strike)) continue
      if (!rowMap[strike]) rowMap[strike] = { call: null, put: null }
      const cell = {
        instrument: name, strike,
        bid: s.bid_price ?? s.bidPrice ?? 0,
        ask: s.ask_price ?? s.askPrice ?? 0,
        mark: s.mark_price ?? s.markPrice ?? 0,
        markIv: s.mark_iv ?? s.markIv ?? 0,
        last: s.last ?? 0,
        volume: s.volume ?? 0,
        openInterest: s.open_interest ?? s.openInterest ?? 0,
      }
      if (type === 'C') rowMap[strike].call = cell
      else if (type === 'P') rowMap[strike].put = cell
    }
    const strikes = Object.keys(rowMap).map(Number).sort((a, b) => a - b)
    const atm = idxPrice > 0 ? strikes.reduce((best, s) => Math.abs(s - idxPrice) < Math.abs(best - idxPrice) ? s : best, strikes[0] ?? 0) : 0
    setAtmStrike(atm)
    setRows(strikes.map(s => ({ strike: s, call: rowMap[s].call, put: rowMap[s].put })))
  }, [expiry])

  // Fetch initial data
  useEffect(() => {
    if (!expiry) return
    setLoading(true)
    const load = async () => {
      try {
        const currency = instrument.startsWith('ETH') ? 'ETH' : instrument.startsWith('SOL') ? 'SOL' : instrument.startsWith('XRP') ? 'XRP' : 'BTC'
        const resp = await fetch(`https://test.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const json = await resp.json()
        const summaries = json.result ?? []
        const idxPrice = summaries[0]?.underlying_price ?? indexPrice
        setIndexPrice(idxPrice)
        buildRows(summaries, idxPrice)
        setLastFetchTs(Date.now())
        setError(null)
      } catch (e: any) { if (rows.length === 0) setError(e.message) }
      finally { setLoading(false) }
    }
    load()
  }, [expiry, instrument])

  // Live websocket updates
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.summaries) return
      setLastFetchTs(Date.now())
      const sums = detail.summaries as any[]
      if (sums[0]?.underlyingPrice > 0) setIndexPrice(sums[0].underlyingPrice)
      // Merge into existing rows
      const expiryStr = toDeribitExpiry(expiry)
      setRows(prev => {
        if (!prev.length) return prev
        const sumMap: Record<string, any> = {}
        for (const s of sums) { const n = s.instrument ?? ''; if (n.includes(expiryStr)) sumMap[n] = s }
        return prev.map(row => {
          const updCall = row.call ? sumMap[row.call.instrument] : null
          const updPut = row.put ? sumMap[row.put.instrument] : null
          const newCall = updCall && (updCall.bidPrice || updCall.askPrice) ? { ...row.call, bid: updCall.bidPrice ?? row.call.bid, ask: updCall.askPrice ?? row.call.ask, mark: updCall.markPrice ?? row.call.mark, markIv: updCall.markIv ?? row.call.markIv, volume: updCall.volume ?? row.call.volume, openInterest: updCall.openInterest ?? row.call.openInterest } : row.call
          const newPut = updPut && (updPut.bidPrice || updPut.askPrice) ? { ...row.put, bid: updPut.bidPrice ?? row.put.bid, ask: updPut.askPrice ?? row.put.ask, mark: updPut.markPrice ?? row.put.mark, markIv: updPut.markIv ?? row.put.markIv, volume: updPut.volume ?? row.put.volume, openInterest: updPut.openInterest ?? row.put.openInterest } : row.put
          return { ...row, call: newCall, put: newPut }
        })
      })
    }
    window.addEventListener('options-update', handler)
    return () => window.removeEventListener('options-update', handler)
  }, [expiry])

  // Filter strikes
  const filteredRows = useMemo(() => {
    let r = rows
    if (atmOnly && atmStrike > 0 && atmN > 0) {
      const idx = r.findIndex(row => row.strike === atmStrike)
      if (idx >= 0) r = r.slice(Math.max(0, idx - atmN), Math.min(r.length, idx + atmN + 1))
    } else if (!atmOnly && (strikeMin || strikeMax)) {
      const mn = strikeMin ? parseFloat(strikeMin.replace(/k/i, '000').replace(/m/i, '000000').replace(/,/g, '')) : 0
      const mx = strikeMax ? parseFloat(strikeMax.replace(/k/i, '000').replace(/m/i, '000000').replace(/,/g, '')) : Infinity
      r = r.filter(row => row.strike >= mn && row.strike <= mx)
    }
    return r
  }, [rows, atmOnly, atmN, atmStrike, strikeMin, strikeMax])

  // Visible columns — fixed order per side
  const callCols = useMemo(() => CALL_COLUMNS.filter(c => visibleCols.has(c.key)), [visibleCols])
  const putCols = useMemo(() => PUT_COLUMNS.filter(c => visibleCols.has(c.key)), [visibleCols])

  // Scroll to ATM
  useEffect(() => {
    if (!gridRef.current || !filteredRows.length || !atmStrike) return
    const idx = filteredRows.findIndex(r => r.strike === atmStrike)
    if (idx >= 0) gridRef.current.scrollTop = Math.max(0, idx * 28 - gridRef.current.clientHeight / 2 + 14)
  }, [atmStrike, filteredRows.length])

  // Heatmap for size/OI columns
  const maxVolume = useMemo(() => filteredRows.reduce((mx, r) => Math.max(mx, r.call?.volume ?? 0, r.put?.volume ?? 0), 1), [filteredRows])
  const maxOI = useMemo(() => filteredRows.reduce((mx, r) => Math.max(mx, r.call?.openInterest ?? 0, r.put?.openInterest ?? 0), 1), [filteredRows])
  const heatColor = (val: number, max: number) => {
    if (!val || !max) return 'transparent'
    const t = Math.min(1, val / max)
    return `rgba(68,136,255,${(0.08 + t * 0.35).toFixed(2)})`
  }

  // Render cell — plain colored text, no buttons
  const renderCell = (cell: any, col: ColDef, isPut: boolean) => {
    const val = cell?.[col.key]
    const fmt = col.style === 'iv' ? 'iv' : col.style === 'greek' ? 'greek' : col.style === 'vol' || col.style === 'size' ? 'vol' : 'price'
    const text = fmtCell(val, fmt)
    if (text === '—') return <span style={{ color: '#2a2a3a', fontSize: 9 }}>—</span>
    if (col.style === 'bid' || col.style === 'ask') {
      return <span onClick={() => cell && onOrderClick?.(cell, isPut ? 'sell' : 'buy')}
        style={{ fontSize: 10, color: isPut ? '#e05252' : '#00c896', cursor: 'pointer' }}>{text}</span>
    }
    if (col.style === 'mark') return <span style={{ fontSize: 10, color: '#ccc' }}>{text}</span>
    return <span style={{ fontSize: 9, color: '#888' }}>{text}</span>
  }

  // Cell background for heatmap columns
  const cellBg = (col: ColDef, cell: any) => {
    if (col.style === 'vol') return heatColor(cell?.openInterest ?? 0, maxOI)
    if (col.style === 'size') return heatColor(cell?.volume ?? 0, maxVolume)
    return 'transparent'
  }

  const showCalls = cpFilter === 'calls' || cpFilter === 'both'
  const showPuts = cpFilter === 'puts' || cpFilter === 'both'

  return (
    <div style={{
      position: isLayout ? 'relative' : 'fixed', left: isLayout ? 0 : 80, top: isLayout ? 0 : 60,
      zIndex: isLayout ? undefined : 600, width: isLayout ? '100%' : 800, height: isLayout ? '100%' : 500,
      background: S.bg, border: `1px solid ${S.border}`, borderRadius: 8,
      boxShadow: isLayout ? 'none' : '0 20px 80px rgba(0,0,0,0.95)',
      display: 'flex', flexDirection: 'column', userSelect: 'none', fontFamily: 'inherit',
    }}>
      {/* Row 1: Instruments + Type + Settings + Index */}
      <div onMouseDown={e => { if ((e.target as HTMLElement).closest('button,input,select,label,[role=button]')) return; if (isLayout && onDrag) onDrag(e) }}
        style={{ padding: '6px 10px 4px', cursor: 'grab', borderBottom: `1px solid ${S.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: S.text, marginRight: 4 }}>OPTIONS LADDER</span>
            <span style={{ fontSize: 9, color: '#888', marginRight: 4 }}>DERIBIT</span>
            {PILL_INSTRUMENTS.map(p => <Pill key={p.id} active={instrument === p.id} onClick={() => setInstrument(p.id)}>{p.label}</Pill>)}
            <div ref={othersRef} style={{ position: 'relative' }}>
              <Pill active={!PILL_IDS.has(instrument)} onClick={() => setOthersOpen(v => !v)}>Others</Pill>
              {othersOpen && <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 1000, background: '#0d0d14', border: '1px solid #2a2a3a', borderRadius: 6, padding: '4px 0', marginTop: 2, minWidth: 120, boxShadow: '0 8px 32px rgba(0,0,0,0.8)' }}>
                {['DOGE', 'HYPE', 'TRX', 'AVAX', 'LINK', 'MATIC'].map(c => <button key={c} onClick={() => { setOthersOpen(false) }}
                  style={{ display: 'block', width: '100%', padding: '5px 12px', background: 'transparent', border: 'none', color: '#ccc', fontSize: 10, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#1a1a2a'} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>{c}</button>)}
              </div>}
            </div>
            <span style={{ width: 1, height: 16, background: S.border }} />
            {(['calls', 'puts', 'both'] as CpFilter[]).map(t => <Pill key={t} active={cpFilter === t} onClick={() => setCpFilter(t)} color={t === 'calls' ? S.positive : t === 'puts' ? S.negative : S.blue}>{t === 'calls' ? 'Calls' : t === 'puts' ? 'Puts' : 'Both'}</Pill>)}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {isLive && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: 'rgba(0,199,88,0.15)', color: S.positive, border: '1px solid rgba(0,199,88,0.4)', animation: 'pulse 2s ease-in-out infinite' }}>LIVE</span>}
            {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>}
          </div>
        </div>
        {/* Row 2: Expiry + Strike filter */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <select value={expiry} onChange={e => setExpiry(e.target.value)} style={{ ...selectStyle, width: 90 }}>
            <option value="">Expiry</option>
            {availableExpiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
          </select>
          <span style={{ width: 1, height: 16, background: S.border }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: S.muted, cursor: 'pointer' }}>
            <input type="checkbox" checked={atmOnly} onChange={() => setAtmOnly(v => !v)} style={{ accentColor: S.blue }} /> ATM ±
          </label>
          {atmOnly && <input value={atmN} onChange={e => setAtmN(Math.max(1, parseInt(e.target.value) || 8))} type="number" min={1} max={50} style={{ width: 36, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', textAlign: 'center', fontFamily: 'inherit' }} />}
          {!atmOnly && <>
            <input value={strikeMin} onChange={e => setStrikeMin(e.target.value)} placeholder="Min" style={{ width: 50, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', fontFamily: 'inherit' }} />
            <span style={{ fontSize: 9, color: S.dim }}>–</span>
            <input value={strikeMax} onChange={e => setStrikeMax(e.target.value)} placeholder="Max" style={{ width: 50, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', fontFamily: 'inherit' }} />
          </>}
          {loading && <span style={{ fontSize: 9, color: S.amber }}>loading...</span>}
          {error && <span style={{ fontSize: 9, color: S.negative }}>{error}</span>}
        </div>
      </div>

      {/* Content area: grid + right button bar */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* Grid */}
      <div ref={gridRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {filteredRows.length > 0 ? (
          <table style={{ borderCollapse: 'collapse', fontSize: 10, fontFamily: 'inherit', width: 'max-content' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <tr>
                {showCalls && <th colSpan={callCols.length} style={{ background: '#0d0d14', padding: '2px 0 0', textAlign: 'center', color: S.positive, fontWeight: 700, fontSize: 9, letterSpacing: '0.08em' }}>CALLS</th>}
                <th rowSpan={2} style={{ background: '#0d0d14', padding: '2px 4px', textAlign: 'center', borderLeft: `1px solid ${S.border}`, borderRight: `1px solid ${S.border}`, borderBottom: `1px solid ${S.border}`, width: 74, minWidth: 74, verticalAlign: 'bottom' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: S.text }}>{indexPrice > 0 ? fmtIndex(indexPrice) : ''}</div>
                  <div style={{ fontSize: 8, color: S.muted, marginTop: 1 }}>STRIKE</div>
                </th>
                {showPuts && <th colSpan={putCols.length} style={{ background: '#0d0d14', padding: '2px 0 0', textAlign: 'center', color: S.negative, fontWeight: 700, fontSize: 9, letterSpacing: '0.08em' }}>PUTS</th>}
              </tr>
              <tr>
                {showCalls && callCols.map(c => <th key={`ch-${c.key}`} style={{ background: '#0d0d14', padding: '1px 1px 2px', textAlign: 'center', color: S.muted, fontWeight: 600, fontSize: 7, textTransform: 'uppercase', borderBottom: `1px solid ${S.border}`, width: c.width, minWidth: c.width }}>{c.label}</th>)}
                {showPuts && putCols.map(c => <th key={`ph-${c.key}`} style={{ background: '#0d0d14', padding: '1px 1px 2px', textAlign: 'center', color: S.muted, fontWeight: 600, fontSize: 7, textTransform: 'uppercase', borderBottom: `1px solid ${S.border}`, width: c.width, minWidth: c.width }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, ri) => {
                const pctFromAtm = atmStrike > 0 ? ((row.strike - atmStrike) / atmStrike * 100) : 0
                const pctColor = pctFromAtm > 0 ? S.positive : pctFromAtm < 0 ? S.negative : S.muted
                const totalCols = (showCalls ? callCols.length : 0) + 1 + (showPuts ? putCols.length : 0)
                // ATM divider line — insert between row where strike crosses index
                const prevRow = ri > 0 ? filteredRows[ri - 1] : null
                const showAtmLine = prevRow && indexPrice > 0 && prevRow.strike < indexPrice && row.strike >= indexPrice
                return (
                  <React.Fragment key={row.strike}>
                    {showAtmLine && (
                      <tr><td colSpan={totalCols} style={{ padding: 0, border: 'none' }}>
                        <div style={{ height: 2, background: 'linear-gradient(to right, transparent, #ccaa44, #ccaa44, transparent)', margin: '0 8px', boxShadow: '0 0 6px rgba(204,170,68,0.6)' }} />
                      </td></tr>
                    )}
                    <tr style={{ background: ri % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      {showCalls && callCols.map(c => <td key={`c-${c.key}`} style={{ padding: '1px 1px', textAlign: 'center', borderBottom: `1px solid ${S.border}10`, width: c.width, background: cellBg(c, row.call) }}>{renderCell(row.call, c, false)}</td>)}
                      <td style={{ padding: '1px 2px', textAlign: 'center', borderLeft: `1px solid ${S.border}`, borderRight: `1px solid ${S.border}`, borderBottom: `1px solid ${S.border}10`, background: S.panel, whiteSpace: 'nowrap' }}>
                        <button style={{ background: GRAD_BUY, border: 'none', borderRadius: 3, padding: '2px 4px', width: '100%', cursor: 'default', fontFamily: 'inherit', boxShadow: SHADOW_BTN }}>
                          <div style={{ fontSize: 10, fontWeight: 400, color: '#fff' }}>{fmtStrike(row.strike)}</div>
                          {pctFromAtm !== 0 && <div style={{ fontSize: 8, color: pctColor, marginTop: -1 }}>{pctFromAtm > 0 ? '+' : ''}{pctFromAtm.toFixed(2)}%</div>}
                        </button>
                      </td>
                      {showPuts && putCols.map(c => <td key={`p-${c.key}`} style={{ padding: '1px 1px', textAlign: 'center', borderBottom: `1px solid ${S.border}10`, width: c.width, background: cellBg(c, row.put) }}>{renderCell(row.put, c, true)}</td>)}
                    </tr>
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: S.muted, fontSize: 12 }}>
            {loading ? 'Loading...' : !expiry ? 'Select an expiry' : error ? `Error: ${error}` : 'No data'}
          </div>
        )}
      </div>

      {/* Right button bar */}
      <div style={{ width: 28, flexShrink: 0, background: '#111015', borderLeft: `1px solid ${S.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '4px 0', gap: 2 }}>
        {[
          { icon: 'D', title: 'Exchange', onClick: undefined },
          { icon: '⚙', title: 'Settings', onClick: () => setSettingsOpen(true) },
          { icon: '🔔', title: 'Alert', onClick: undefined },
          { icon: '🔒', title: 'Lock', onClick: undefined },
        ].map((btn, i) => (
          <button key={i} onClick={btn.onClick ?? undefined} title={btn.title}
            disabled={!btn.onClick}
            onMouseEnter={e => { if (btn.onClick) e.currentTarget.style.background = '#2a2a38' }}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            style={{
              width: 24, height: 24, background: 'transparent', border: 'none',
              borderRadius: 3, color: btn.onClick ? S.muted : '#2a2a38',
              cursor: btn.onClick ? 'pointer' : 'default', fontSize: 12, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{btn.icon}</button>
        ))}
      </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '3px 10px', borderTop: `1px solid ${S.border}`, display: 'flex', justifyContent: 'space-between', fontSize: 9, color: S.muted, flexShrink: 0 }}>
        <span>{filteredRows.length > 0 ? `${filteredRows.length} strikes • ${fmtExpiry(expiry)}` : ''}</span>
        <span>{lastFetchTs > 0 ? new Date(lastFetchTs).toLocaleTimeString() : ''}</span>
      </div>

      {settingsOpen && <SettingsModal visibleCols={visibleCols} onSave={cols => { setVisibleCols(cols); setSettingsOpen(false) }} onCancel={() => setSettingsOpen(false)} />}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
    </div>
  )
}

export function OptionsLadder(props: OptionsLadderProps) {
  return <LadderErrorBoundary><OptionsLadderInner {...props} /></LadderErrorBoundary>
}
