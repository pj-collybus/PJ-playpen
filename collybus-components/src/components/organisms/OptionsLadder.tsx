// @ts-nocheck
import { useState, useRef, useEffect, useCallback, useMemo, Component } from 'react'

const S = {
  bg: '#18171C', panel: '#141418', border: '#2a2a38', bgInput: '#0e0e14',
  positive: '#00C758', negative: '#FB2C36', blue: '#2B79DD', amber: '#F59E0B',
  text: 'rgba(255,255,255,0.85)', muted: '#636e82', dim: 'rgba(255,255,255,0.4)',
}

// ── Types ──
interface LadderCell {
  instrument: string; optionType: string; strike: number; expiry: string; dte: number
  bid: number; ask: number; mark: number; markIv: number; bidIv: number; askIv: number
  volume: number; openInterest: number; last?: number; bidSize?: number; askSize?: number
  delta?: number; nDelta?: number; gamma?: number; vega?: number; theta?: number; rho?: number
  extValue?: number
}
interface LadderData {
  strikes: number[]; expiry: string; cells: Record<string, { call?: LadderCell; put?: LadderCell }>
  indexPrice: number; atmStrike: number; instrument: string; timestamp: number
}
interface ExpiriesResponse { expiries: string[]; indexPrice: number; instrument: string; type: string }
type InstrumentId = 'BTC' | 'BTC_USDC' | 'ETH' | 'ETH_USDC' | 'SOL_USDC' | 'XRP_USDC'

const INSTRUMENTS: InstrumentId[] = ['BTC', 'BTC_USDC', 'ETH', 'ETH_USDC', 'SOL_USDC', 'XRP_USDC']
const INSTRUMENT_LABELS: Record<InstrumentId, string> = {
  BTC: 'BTC', BTC_USDC: 'BTC USDC', ETH: 'ETH', ETH_USDC: 'ETH USDC', SOL_USDC: 'SOL USDC', XRP_USDC: 'XRP USDC',
}

const fmtStrike = (v: number) => v >= 1 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${v.toFixed(4)}`
const fmtIndex = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
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

// ── Column definitions ──
interface ColDef { key: string; label: string; width: number; defaultVisible: boolean; format: 'price' | 'iv' | 'greek' | 'vol' | 'size' }
const ALL_COLUMNS: ColDef[] = [
  { key: 'bid', label: 'Bid', width: 64, defaultVisible: true, format: 'price' },
  { key: 'ask', label: 'Ask', width: 64, defaultVisible: true, format: 'price' },
  { key: 'mark', label: 'Mark', width: 64, defaultVisible: true, format: 'price' },
  { key: 'bidIv', label: 'IV Bid', width: 56, defaultVisible: true, format: 'iv' },
  { key: 'askIv', label: 'IV Ask', width: 56, defaultVisible: false, format: 'iv' },
  { key: 'last', label: 'Last', width: 56, defaultVisible: false, format: 'price' },
  { key: 'bidSize', label: 'Bid Size', width: 56, defaultVisible: false, format: 'size' },
  { key: 'askSize', label: 'Ask Size', width: 56, defaultVisible: false, format: 'size' },
  { key: 'delta', label: 'ΔDelta', width: 56, defaultVisible: false, format: 'greek' },
  { key: 'nDelta', label: 'NDelta', width: 56, defaultVisible: false, format: 'greek' },
  { key: 'gamma', label: 'Gamma', width: 56, defaultVisible: false, format: 'greek' },
  { key: 'vega', label: 'Vega', width: 56, defaultVisible: false, format: 'greek' },
  { key: 'theta', label: 'Theta', width: 56, defaultVisible: false, format: 'greek' },
  { key: 'rho', label: 'Rho', width: 56, defaultVisible: false, format: 'greek' },
  { key: 'extValue', label: 'Ext Value', width: 64, defaultVisible: false, format: 'price' },
  { key: 'openInterest', label: 'Open', width: 56, defaultVisible: true, format: 'vol' },
  { key: 'volume', label: 'Volume', width: 56, defaultVisible: true, format: 'vol' },
]

const GRAD_BUY = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'
const GRAD_BUY_H = 'linear-gradient(to right, #2656b7 0%, #3A8FE4 100%)'
const GRAD_SELL = 'linear-gradient(to right, #941A1A 0%, #DD2B2B 100%)'
const GRAD_SELL_H = 'linear-gradient(to right, #b72626 0%, #E43A3A 100%)'
const SHADOW_BTN = 'inset 0px 3px 1px rgba(255,255,255,0.25), inset 0px -3px 1px rgba(0,0,0,0.25), inset 0px 4px 4px rgba(0,0,0,0.25)'

// ── Cell formatter ──
function fmtCell(val: any, format: string): string {
  if (val == null || val === 0) return '—'
  switch (format) {
    case 'price': return Number(val).toFixed(4).replace(/\.?0+$/, '')
    case 'iv': return `${Number(val).toFixed(1)}%`
    case 'greek': return Number(val).toFixed(4)
    case 'vol': return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(Math.round(val))
    case 'size': return String(Math.round(val))
    default: return String(val)
  }
}

// ── Props ──
export interface OptionsLadderConfig {
  instrument?: string; expiry?: string; atmN?: number; atmOnly?: boolean
  strikeMin?: string; strikeMax?: string; visibleCols?: string[]
}
export interface OptionsLadderProps {
  apiBase?: string; initialConfig?: OptionsLadderConfig
  onOrderClick?: (cell: LadderCell, side: 'buy' | 'sell') => void; onClose?: () => void
  onConfigChange?: (config: OptionsLadderConfig) => void
  onDrag?: (e: React.MouseEvent) => void
  layoutWidth?: number; layoutHeight?: number
}

// ── Settings modal ──
function SettingsModal({ visibleCols, onSave, onCancel }: {
  visibleCols: Set<string>; onSave: (cols: Set<string>) => void; onCancel: () => void
}) {
  const [selected, setSelected] = useState(new Set(visibleCols))
  const toggle = (key: string) => setSelected(prev => {
    const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next
  })
  const resetDefaults = () => setSelected(new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key)))
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div style={{ background: '#18171C', border: '1px solid #2a2a3a', borderRadius: 8, width: 380, maxHeight: '80vh', overflow: 'auto',
        boxShadow: '0 20px 80px rgba(0,0,0,0.95)', padding: '16px 20px' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: S.text, marginBottom: 4 }}>Tile Configuration</div>
        <div style={{ fontSize: 10, color: S.muted, marginBottom: 12 }}>Options Ladder</div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#888', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>Display Columns</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 16 }}>
          {ALL_COLUMNS.map(c => (
            <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: selected.has(c.key) ? S.text : S.muted, cursor: 'pointer', padding: '3px 0' }}>
              <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} style={{ accentColor: '#2B79DD' }} />
              {c.label}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={resetDefaults} style={{ background: 'transparent', border: '1px solid #2a2a3a', borderRadius: 4, color: S.muted, fontSize: 10, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>Reset to defaults</button>
          <button onClick={onCancel} style={{ background: 'transparent', border: '1px solid #2a2a3a', borderRadius: 4, color: S.muted, fontSize: 10, padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={() => onSave(selected)} style={{ background: GRAD_BUY, border: 'none', borderRadius: 4, color: '#fff', fontSize: 10, fontWeight: 700, padding: '5px 14px', cursor: 'pointer', fontFamily: 'inherit', boxShadow: SHADOW_BTN }}>Save Configuration</button>
        </div>
      </div>
    </div>
  )
}

// ── Error boundary ──
class LadderErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return <div style={{ padding: 20, color: '#e05252', fontSize: 12 }}>Options Ladder Error: {String(this.state.error)}</div>
    return this.props.children
  }
}

// ── Select style ──
const selectStyle: React.CSSProperties = {
  height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3,
  color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', fontFamily: 'inherit', cursor: 'pointer',
}

// ── Inner component ──
function OptionsLadderInner({ apiBase = '', initialConfig, onOrderClick, onClose, onConfigChange, onDrag, layoutWidth, layoutHeight }: OptionsLadderProps) {
  const isLayoutControlled = layoutWidth != null && layoutHeight != null
  const ic = initialConfig

  // ── State ──
  const [instrument, setInstrument] = useState<InstrumentId>((ic?.instrument ?? 'BTC') as InstrumentId)
  const [expiry, setExpiry] = useState(ic?.expiry ?? '')
  const [atmN, setAtmN] = useState(ic?.atmN ?? 8)
  const [atmOnly, setAtmOnly] = useState(ic?.atmOnly ?? true)
  const [strikeMin, setStrikeMin] = useState(ic?.strikeMin ?? '')
  const [strikeMax, setStrikeMax] = useState(ic?.strikeMax ?? '')
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => {
    if (ic?.visibleCols) return new Set(ic.visibleCols)
    return new Set(ALL_COLUMNS.filter(c => c.defaultVisible).map(c => c.key))
  })
  const [availableExpiries, setAvailableExpiries] = useState<string[]>([])
  const [indexPrice, setIndexPrice] = useState(0)
  const [data, setData] = useState<LadderData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchTs, setLastFetchTs] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [settingsOpen, setSettingsOpen] = useState(false)

  const isFirstLoad = useRef(true)
  const savedExpiry = useRef(ic?.expiry ?? '')
  const gridRef = useRef<HTMLDivElement>(null)

  // ── Persist config ──
  useEffect(() => {
    onConfigChange?.({ instrument, expiry, atmN, atmOnly, strikeMin, strikeMax, visibleCols: [...visibleCols] })
  }, [instrument, expiry, atmN, atmOnly, strikeMin, strikeMax, visibleCols])

  // ── Freshness ──
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const isLive = lastFetchTs > 0 && (now - lastFetchTs) < 10000

  // ── Load expiries ──
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const resp = await fetch(`${apiBase}/api/options/expiries?instrument=${instrument}&type=both`)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const json: ExpiriesResponse = await resp.json()
        if (cancelled) return
        setAvailableExpiries(json.expiries ?? [])
        setIndexPrice(json.indexPrice ?? 0)
        if (isFirstLoad.current) {
          isFirstLoad.current = false
          const dates = json.expiries ?? []
          setExpiry(dates.includes(savedExpiry.current) ? savedExpiry.current : dates[0] ?? '')
        } else {
          setExpiry((json.expiries ?? [])[0] ?? '')
          setData(null)
        }
        fetch(`${apiBase}/api/options/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument }) }).catch(() => {})
      } catch (e: any) { if (!cancelled) setError(e.message) }
    }
    load()
    return () => { cancelled = true; fetch(`${apiBase}/api/options/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument }) }).catch(() => {}) }
  }, [apiBase, instrument])

  // ── Fetch ladder data ──
  const fetchLadder = useCallback(async () => {
    if (!expiry) return
    setLoading(true)
    try {
      const params = new URLSearchParams({ exchange: 'Deribit', instrument, type: 'both', fromExpiry: expiry, toExpiry: expiry })
      if (atmOnly && atmN > 0) params.set('atmOnly', 'true')
      const resp = await fetch(`${apiBase}/api/options/matrix?${params}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      // Restructure: group calls and puts per strike for this single expiry
      const cells: Record<string, { call?: any; put?: any }> = {}
      for (const sk of Object.keys(json.cells ?? {})) {
        const expCells = json.cells[sk] ?? {}
        for (const cell of Object.values(expCells) as any[]) {
          if (!cells[sk]) cells[sk] = {}
          if (cell.optionType === 'call') cells[sk].call = cell
          else if (cell.optionType === 'put') cells[sk].put = cell
        }
      }
      setData({ strikes: json.strikes ?? [], expiry, cells, indexPrice: json.indexPrice ?? 0, atmStrike: json.atmStrike ?? 0, instrument, timestamp: Date.now() })
      setIndexPrice(json.indexPrice ?? 0)
      setLastFetchTs(Date.now())
      setError(null)
    } catch (e: any) { if (!data) setError(e.message) }
    finally { setLoading(false) }
  }, [apiBase, instrument, expiry, atmOnly, atmN])

  useEffect(() => { if (expiry) fetchLadder() }, [expiry, instrument, atmOnly, atmN])

  // ── Live websocket updates ──
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.summaries) return
      setLastFetchTs(Date.now())
      const sumMap: Record<string, any> = {}
      for (const s of detail.summaries as any[]) if (s.instrument) sumMap[s.instrument] = s
      if (detail.summaries[0]?.underlyingPrice > 0) setIndexPrice(detail.summaries[0].underlyingPrice)
      setData(prev => {
        if (!prev) return prev
        const mc = { ...prev.cells }
        for (const sk of Object.keys(mc)) {
          const row = { ...mc[sk] }
          for (const side of ['call', 'put'] as const) {
            const cell = row[side]
            if (!cell?.instrument) continue
            const u = sumMap[cell.instrument]
            if (u && (u.bidPrice || u.askPrice)) {
              row[side] = { ...cell, bid: u.bidPrice ?? cell.bid, ask: u.askPrice ?? cell.ask, mark: u.markPrice ?? cell.mark, markIv: u.markIv ?? cell.markIv, bidIv: u.bidIv ?? cell.bidIv, askIv: u.askIv ?? cell.askIv, volume: u.volume ?? cell.volume, openInterest: u.openInterest ?? cell.openInterest }
            }
          }
          mc[sk] = row
        }
        return { ...prev, cells: mc, timestamp: Date.now() }
      })
    }
    window.addEventListener('options-update', handler)
    return () => window.removeEventListener('options-update', handler)
  }, [])

  // ── Filter strikes ──
  const filteredStrikes = useMemo(() => {
    if (!data) return []
    let strikes = data.strikes
    if (atmOnly && data.atmStrike > 0 && atmN > 0) {
      const idx = strikes.indexOf(data.atmStrike)
      if (idx >= 0) strikes = strikes.slice(Math.max(0, idx - atmN), Math.min(strikes.length, idx + atmN + 1))
    } else if (!atmOnly && (strikeMin || strikeMax)) {
      const mn = strikeMin ? parseFloat(strikeMin.replace(/k/i, '000').replace(/m/i, '000000').replace(/,/g, '')) : 0
      const mx = strikeMax ? parseFloat(strikeMax.replace(/k/i, '000').replace(/m/i, '000000').replace(/,/g, '')) : Infinity
      strikes = strikes.filter(s => s >= mn && s <= mx)
    }
    return strikes
  }, [data, atmOnly, atmN, strikeMin, strikeMax])

  // ── Visible column defs ──
  const visCols = useMemo(() => ALL_COLUMNS.filter(c => visibleCols.has(c.key)), [visibleCols])
  const callCols = useMemo(() => [...visCols].reverse(), [visCols]) // calls: right-to-left from strike
  const putCols = visCols // puts: left-to-right from strike

  // ── Scroll to ATM on first data ──
  useEffect(() => {
    if (!data || !gridRef.current) return
    const atmIdx = filteredStrikes.indexOf(data.atmStrike)
    if (atmIdx >= 0) {
      const rowH = 28
      gridRef.current.scrollTop = Math.max(0, atmIdx * rowH - gridRef.current.clientHeight / 2 + rowH)
    }
  }, [data?.atmStrike])

  // ── Render cell ──
  const renderCell = (cell: any, col: ColDef, isSell: boolean) => {
    const val = cell?.[col.key]
    const text = fmtCell(val, col.format)
    if (text === '—') return <span style={{ color: S.dim, fontSize: 10 }}>—</span>
    if (col.key === 'bid' || col.key === 'ask') {
      const grad = isSell ? GRAD_SELL : GRAD_BUY
      const gradH = isSell ? GRAD_SELL_H : GRAD_BUY_H
      return (
        <button onClick={() => cell && onOrderClick?.(cell, isSell ? 'sell' : 'buy')}
          onMouseEnter={e => e.currentTarget.style.background = gradH}
          onMouseLeave={e => e.currentTarget.style.background = grad}
          style={{ background: grad, border: 'none', borderRadius: 3, padding: '2px 4px', cursor: 'pointer', width: '100%', textAlign: 'center', fontFamily: 'inherit', boxShadow: SHADOW_BTN }}>
          <span style={{ fontSize: 10, fontWeight: 400, color: '#fff' }}>{text}</span>
        </button>
      )
    }
    return <span style={{ fontSize: 10, color: col.format === 'greek' ? '#888' : S.text }}>{text}</span>
  }

  return (
    <div style={{
      position: isLayoutControlled ? 'relative' : 'fixed', left: isLayoutControlled ? 0 : 80, top: isLayoutControlled ? 0 : 60,
      zIndex: isLayoutControlled ? undefined : 600,
      width: isLayoutControlled ? '100%' : 800, height: isLayoutControlled ? '100%' : 500,
      background: S.bg, border: `1px solid ${S.border}`, borderRadius: 8,
      boxShadow: isLayoutControlled ? 'none' : '0 20px 80px rgba(0,0,0,0.95)',
      display: 'flex', flexDirection: 'column', userSelect: 'none', fontFamily: 'inherit',
    }}>
      {/* Header */}
      <div onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button,input,select,label,[role=button]')) return
        if (isLayoutControlled && onDrag) onDrag(e)
      }} style={{ padding: '8px 10px 6px', cursor: 'grab', borderBottom: `1px solid ${S.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: S.text }}>OPTIONS LADDER</span>
            <span style={{ fontSize: 9, color: '#888', flexShrink: 0 }}>DERIBIT</span>
            {loading && <span style={{ fontSize: 9, color: S.amber }}>loading...</span>}
            {error && <span style={{ fontSize: 9, color: S.negative }}>{error}</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {indexPrice > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: S.text }}><span style={{ color: S.muted, fontSize: 9, marginRight: 4 }}>INDEX</span>{fmtIndex(indexPrice)}</span>}
            {isLive && <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 8, background: 'rgba(0,199,88,0.15)', color: S.positive, border: '1px solid rgba(0,199,88,0.4)', animation: 'pulse 2s ease-in-out infinite' }}>LIVE</span>}
            <button onClick={() => setSettingsOpen(true)} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 14 }}>⚙</button>
            {onClose && <button onClick={onClose} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>}
          </div>
        </div>
        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={instrument} onChange={e => setInstrument(e.target.value as InstrumentId)} style={{ ...selectStyle, width: 80 }}>
            {INSTRUMENTS.map(i => <option key={i} value={i}>{INSTRUMENT_LABELS[i]}</option>)}
          </select>
          <select value={expiry} onChange={e => setExpiry(e.target.value)} style={{ ...selectStyle, width: 90 }}>
            <option value="">Expiry</option>
            {availableExpiries.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
          </select>
          <span style={{ width: 1, height: 16, background: S.border }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: S.muted, cursor: 'pointer' }}>
            <input type="checkbox" checked={atmOnly} onChange={() => setAtmOnly(v => !v)} style={{ accentColor: S.blue }} />
            ATM ±
          </label>
          {atmOnly && <input value={atmN} onChange={e => setAtmN(Math.max(1, parseInt(e.target.value) || 8))} type="number" min={1} max={50}
            style={{ width: 36, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', textAlign: 'center', fontFamily: 'inherit' }} />}
          {!atmOnly && <>
            <input value={strikeMin} onChange={e => setStrikeMin(e.target.value)} placeholder="Min" style={{ width: 50, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', fontFamily: 'inherit' }} />
            <span style={{ fontSize: 9, color: S.dim }}>–</span>
            <input value={strikeMax} onChange={e => setStrikeMax(e.target.value)} placeholder="Max" style={{ width: 50, height: 22, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 3, color: S.text, fontSize: 10, padding: '0 4px', outline: 'none', fontFamily: 'inherit' }} />
          </>}
        </div>
      </div>

      {/* Grid */}
      <div ref={gridRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {data && filteredStrikes.length > 0 ? (
          <table style={{ borderCollapse: 'collapse', fontSize: 10, fontFamily: 'inherit' }}>
            <thead>
              <tr>
                {/* Calls headers — reversed order */}
                {callCols.map(c => <th key={`c-${c.key}`} style={{ position: 'sticky', top: 0, zIndex: 2, background: S.panel, padding: '4px 3px', textAlign: 'center', color: S.positive, fontWeight: 600, fontSize: 8, letterSpacing: '0.04em', textTransform: 'uppercase', borderBottom: `1px solid ${S.border}`, width: c.width, minWidth: c.width }}>{c.label}</th>)}
                {/* Strike header */}
                <th style={{ position: 'sticky', top: 0, zIndex: 3, background: S.panel, padding: '4px 6px', textAlign: 'center', color: S.muted, fontWeight: 700, fontSize: 9, borderBottom: `1px solid ${S.border}`, borderLeft: `1px solid ${S.border}`, borderRight: `1px solid ${S.border}`, width: 70, minWidth: 70 }}>STRIKE</th>
                {/* Puts headers */}
                {putCols.map(c => <th key={`p-${c.key}`} style={{ position: 'sticky', top: 0, zIndex: 2, background: S.panel, padding: '4px 3px', textAlign: 'center', color: S.negative, fontWeight: 600, fontSize: 8, letterSpacing: '0.04em', textTransform: 'uppercase', borderBottom: `1px solid ${S.border}`, width: c.width, minWidth: c.width }}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {filteredStrikes.map(strike => {
                const isAtm = data.atmStrike === strike
                const sk = strike.toFixed(0)
                const row = data.cells[sk]
                return (
                  <tr key={strike} style={{ background: isAtm ? 'rgba(204,170,68,0.06)' : 'transparent' }}>
                    {/* Calls — reversed column order */}
                    {callCols.map(c => (
                      <td key={`c-${c.key}`} style={{ padding: '2px 3px', textAlign: 'center', borderBottom: `1px solid ${S.border}10`, borderLeft: isAtm && c === callCols[0] ? '3px solid #ccaa44' : undefined, width: c.width }}>
                        {renderCell(row?.call, c, false)}
                      </td>
                    ))}
                    {/* Strike */}
                    <td style={{ padding: '3px 6px', textAlign: 'center', fontWeight: isAtm ? 700 : 500, color: isAtm ? '#ccaa44' : S.text, fontSize: 11, borderLeft: `1px solid ${S.border}`, borderRight: `1px solid ${S.border}`, borderBottom: `1px solid ${S.border}10`, background: isAtm ? '#1e1c14' : S.panel, whiteSpace: 'nowrap' }}>
                      {fmtStrike(strike)}{isAtm && <span style={{ fontSize: 7, color: '#ccaa44', marginLeft: 3 }}>ATM</span>}
                    </td>
                    {/* Puts */}
                    {putCols.map(c => (
                      <td key={`p-${c.key}`} style={{ padding: '2px 3px', textAlign: 'center', borderBottom: `1px solid ${S.border}10`, borderRight: isAtm && c === putCols[putCols.length - 1] ? '3px solid #ccaa44' : undefined, width: c.width }}>
                        {renderCell(row?.put, c, true)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: S.muted, fontSize: 12 }}>
            {loading ? 'Loading...' : !expiry ? 'Select an expiry date' : error ? `Error: ${error}` : 'No data'}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '3px 10px', borderTop: `1px solid ${S.border}`, display: 'flex', justifyContent: 'space-between', fontSize: 9, color: S.muted, flexShrink: 0 }}>
        <span>{data ? `${filteredStrikes.length} strikes • ${fmtExpiry(expiry)}` : ''}</span>
        <span>{data ? new Date(data.timestamp).toLocaleTimeString() : ''}</span>
      </div>

      {/* Settings modal */}
      {settingsOpen && <SettingsModal visibleCols={visibleCols} onSave={cols => { setVisibleCols(cols); setSettingsOpen(false) }} onCancel={() => setSettingsOpen(false)} />}
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
    </div>
  )
}

export function OptionsLadder(props: OptionsLadderProps) {
  return <LadderErrorBoundary><OptionsLadderInner {...props} /></LadderErrorBoundary>
}
