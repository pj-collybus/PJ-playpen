// @ts-nocheck
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'

/* ---------- Styles (matches AlgoMonitor / dark theme) ---------- */
const S = {
  bg: '#18171C', panel: '#141418', border: '#2a2a38', bgInput: '#0e0e14',
  positive: '#00C758', negative: '#FB2C36', blue: '#2B79DD', amber: '#F59E0B',
  text: 'rgba(255,255,255,0.85)', muted: '#636e82', dim: 'rgba(255,255,255,0.4)',
}

/* ---------- Persistence helpers ---------- */
const savePos = (key: string, p: { x: number; y: number }) => {
  try { localStorage.setItem(`collybus.pos.${key}`, JSON.stringify(p)) } catch {}
}
const loadPos = (key: string, fallback: { x: number; y: number }) => {
  try { const s = localStorage.getItem(`collybus.pos.${key}`); return s ? JSON.parse(s) : fallback } catch { return fallback }
}
const saveSize = (key: string, sz: { w: number; h: number }) => {
  try { localStorage.setItem(`collybus.size.${key}`, JSON.stringify(sz)) } catch {}
}
const loadSize = (key: string, fallback: { w: number; h: number }) => {
  try { const s = localStorage.getItem(`collybus.size.${key}`); return s ? JSON.parse(s) : fallback } catch { return fallback }
}

/* ---------- Types ---------- */
interface MatrixCell {
  instrument: string
  optionType: string
  strike: number
  expiry: string
  dte: number
  bid: number
  ask: number
  mark: number
  markIv: number
  bidIv: number
  askIv: number
  volume: number
  openInterest: number
}

interface MatrixResponse {
  strikes: number[]
  expiries: string[]
  cells: Record<string, Record<string, MatrixCell>>
  indexPrice: number
  atmStrike: number
  instrument: string
  type: string
  timestamp: number
}

type ViewMode = 'iv' | 'price' | 'greeks'
type OptionType = 'calls' | 'puts' | 'both'
type InstrumentId = 'BTC' | 'BTC_USDC' | 'ETH' | 'ETH_USDC' | 'SOL_USDC' | 'XRP_USDC'

const EXCHANGES = [
  { id: 'Deribit', label: 'Deribit', active: true },
  { id: 'Binance', label: 'Binance', active: false },
  { id: 'OKX', label: 'OKX', active: false },
]
const INSTRUMENTS: InstrumentId[] = ['BTC', 'BTC_USDC', 'ETH', 'ETH_USDC', 'SOL_USDC', 'XRP_USDC']
const EXPIRY_PRESETS = [
  { label: '1W', value: '1w' },
  { label: '2W', value: '2w' },
  { label: '1M', value: '1m' },
  { label: '3M', value: '3m' },
  { label: '6M', value: '6m' },
  { label: '1Y', value: '1y' },
  { label: 'ALL', value: '' },
]

/* ---------- Props ---------- */
export interface OptionsMatrixProps {
  apiBase?: string
  onOrderClick?: (cell: MatrixCell) => void
  onClose?: () => void
}

/* ---------- Component ---------- */
export function OptionsMatrix({ apiBase = '', onOrderClick, onClose }: OptionsMatrixProps) {
  /* Position & size */
  const posKey = 'optionsMatrix'
  const [pos, setPos] = useState(() => loadPos(posKey, { x: 80, y: 60 }))
  const [size, setSize] = useState(() => loadSize(posKey, { w: 900, h: 560 }))
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null)

  useEffect(() => { savePos(posKey, pos) }, [pos])
  useEffect(() => { saveSize(posKey, size) }, [size])

  /* Filters */
  const [exchange, setExchange] = useState('Deribit')
  const [instrument, setInstrument] = useState<InstrumentId>('BTC')
  const [optionType, setOptionType] = useState<OptionType>('calls')
  const [viewMode, setViewMode] = useState<ViewMode>('iv')
  const [atmOnly, setAtmOnly] = useState(false)
  const [heatmap, setHeatmap] = useState(false)
  const [expiryPreset, setExpiryPreset] = useState('3m')
  const [polling, setPolling] = useState(true)

  /* Data */
  const [data, setData] = useState<MatrixResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /* Fetch matrix */
  const fetchMatrix = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set('exchange', exchange)
      params.set('instrument', instrument)
      params.set('type', optionType === 'both' ? 'both' : optionType)
      if (atmOnly) params.set('atmOnly', 'true')
      if (expiryPreset) params.set('toExpiry', expiryPreset)
      const url = `${apiBase}/api/options/matrix?${params}`
      console.log('[OptionsMatrix] fetching:', url)
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      setData(json)
    } catch (e: any) {
      setError(e.message ?? 'Fetch failed')
    } finally {
      setLoading(false)
    }
  }, [apiBase, exchange, instrument, optionType, atmOnly, expiryPreset])

  /* Poll */
  useEffect(() => {
    fetchMatrix()
    if (!polling) return
    const id = setInterval(fetchMatrix, 5000)
    return () => clearInterval(id)
  }, [fetchMatrix, polling])

  /* Heatmap color */
  const ivRange = useMemo(() => {
    if (!data) return { min: 0, max: 100 }
    let min = Infinity, max = -Infinity
    for (const strikeMap of Object.values(data.cells)) {
      for (const cell of Object.values(strikeMap) as MatrixCell[]) {
        if (cell.markIv > 0) { min = Math.min(min, cell.markIv); max = Math.max(max, cell.markIv) }
      }
    }
    return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 100 : max }
  }, [data])

  const heatColor = (iv: number) => {
    if (!heatmap || iv <= 0) return 'transparent'
    const t = Math.min(1, Math.max(0, (iv - ivRange.min) / (ivRange.max - ivRange.min + 0.001)))
    const r = Math.round(30 + t * 200)
    const g = Math.round(80 - t * 60)
    const b = Math.round(180 - t * 120)
    return `rgba(${r},${g},${b},0.18)`
  }

  /* Format cell value */
  const fmtCell = (cell: MatrixCell | undefined) => {
    if (!cell) return { top: '-', bot: '' }
    if (viewMode === 'iv') {
      return {
        top: cell.markIv > 0 ? `${cell.markIv.toFixed(1)}%` : '-',
        bot: cell.bidIv > 0 && cell.askIv > 0 ? `${cell.bidIv.toFixed(1)}/${cell.askIv.toFixed(1)}` : '',
      }
    }
    if (viewMode === 'price') {
      return {
        top: cell.mark > 0 ? cell.mark.toFixed(4) : '-',
        bot: `${cell.bid.toFixed(4)} / ${cell.ask.toFixed(4)}`,
      }
    }
    // greeks placeholder
    return { top: cell.markIv > 0 ? `IV ${cell.markIv.toFixed(1)}` : '-', bot: `OI ${cell.openInterest}` }
  }

  /* Pill button helper */
  const Pill = ({ active, onClick, children, color, style: extraStyle }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string; style?: React.CSSProperties }) => (
    <button onClick={onClick} style={{
      background: active ? `${color ?? S.blue}22` : 'transparent',
      border: `1px solid ${active ? (color ?? S.blue) + '66' : S.border}`,
      borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 600,
      color: active ? (color ?? S.blue) : S.muted, cursor: 'pointer', fontFamily: 'inherit',
      transition: 'all 0.15s',
      ...extraStyle,
    }}>{children}</button>
  )

  /* Drag handlers */
  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select')) return
    e.preventDefault()
    dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }
    const mv = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }
    const up = () => { dragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: size.w, startH: size.h }
    const mv = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      setSize({
        w: Math.max(500, resizeRef.current.startW + ev.clientX - resizeRef.current.startX),
        h: Math.max(300, resizeRef.current.startH + ev.clientY - resizeRef.current.startY),
      })
    }
    const up = () => { resizeRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }

  return (
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 600,
      width: size.w, height: size.h,
      background: S.bg, border: `1px solid ${S.border}`, borderRadius: 8,
      boxShadow: '0 20px 80px rgba(0,0,0,0.95), 0 0 0 1px rgba(100,100,150,0.2)',
      display: 'flex', flexDirection: 'column', userSelect: 'none', fontFamily: 'inherit',
    }}>
      {/* -------- Header / Toolbar -------- */}
      <div onMouseDown={onHeaderMouseDown} style={{ padding: '8px 10px 6px', cursor: 'grab', borderBottom: `1px solid ${S.border}` }}>
        {/* Row 1: Title + close */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: S.text }}>OPTIONS MATRIX</span>
            {data && <span style={{ fontSize: 10, color: S.muted }}>IDX {data.indexPrice.toFixed(2)}</span>}
            {loading && <span style={{ fontSize: 9, color: S.amber }}>loading...</span>}
            {error && <span style={{ fontSize: 9, color: S.negative }}>{error}</span>}
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <Pill active={polling} onClick={() => setPolling(v => !v)} color={S.positive}>LIVE</Pill>
            {onClose && (
              <button onClick={onClose} style={{
                background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 3px',
              }}>{'\u00D7'}</button>
            )}
          </div>
        </div>

        {/* Row 2: Exchange + Instrument pills */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 5, alignItems: 'center' }}>
          {EXCHANGES.map(ex => (
            <Pill key={ex.id} active={exchange === ex.id}
              onClick={() => { if (ex.active) { setExchange(ex.id); setData(null) } }}
              style={!ex.active ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}>
              {ex.label}
            </Pill>
          ))}
          <span style={{ color: S.muted, fontSize: 9, margin: '0 2px' }}>|</span>
          {INSTRUMENTS.map(i => (
            <Pill key={i} active={instrument === i} onClick={() => setInstrument(i)}>{i}</Pill>
          ))}
        </div>

        {/* Row 3: Type / View / Toggles / Expiry */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Option type */}
          {(['calls', 'puts', 'both'] as OptionType[]).map(t => (
            <Pill key={t} active={optionType === t} onClick={() => setOptionType(t)}
              color={t === 'calls' ? S.positive : t === 'puts' ? S.negative : S.blue}
            >{t.toUpperCase()}</Pill>
          ))}

          <span style={{ width: 1, height: 16, background: S.border, margin: '0 2px' }} />

          {/* View mode */}
          {(['iv', 'price', 'greeks'] as ViewMode[]).map(v => (
            <Pill key={v} active={viewMode === v} onClick={() => setViewMode(v)}>{v.toUpperCase()}</Pill>
          ))}

          <span style={{ width: 1, height: 16, background: S.border, margin: '0 2px' }} />

          <Pill active={atmOnly} onClick={() => setAtmOnly(v => !v)} color={S.amber}>ATM</Pill>
          <Pill active={heatmap} onClick={() => setHeatmap(v => !v)} color={S.amber}>HEAT</Pill>

          <span style={{ width: 1, height: 16, background: S.border, margin: '0 2px' }} />

          {/* Expiry presets */}
          {EXPIRY_PRESETS.map(ep => (
            <Pill key={ep.label} active={expiryPreset === ep.value} onClick={() => setExpiryPreset(ep.value)}>{ep.label}</Pill>
          ))}
        </div>
      </div>

      {/* -------- Grid -------- */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {data && data.strikes.length > 0 && data.expiries.length > 0 ? (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 10, fontFamily: 'monospace' }}>
            <thead>
              <tr>
                <th style={{
                  position: 'sticky', top: 0, left: 0, zIndex: 3,
                  background: S.panel, padding: '5px 8px', textAlign: 'right',
                  color: S.muted, fontWeight: 600, borderBottom: `1px solid ${S.border}`, borderRight: `1px solid ${S.border}`,
                }}>Strike</th>
                {data.expiries.map(exp => (
                  <th key={exp} style={{
                    position: 'sticky', top: 0, zIndex: 2,
                    background: S.panel, padding: '5px 6px', textAlign: 'center',
                    color: S.text, fontWeight: 600, borderBottom: `1px solid ${S.border}`,
                    whiteSpace: 'nowrap', fontSize: 9,
                  }}>{exp}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.strikes.map(strike => {
                const isAtm = data.atmStrike === strike
                const strikeKey = strike.toFixed(0)
                return (
                  <tr key={strike} style={{
                    background: isAtm ? 'rgba(43,121,221,0.08)' : 'transparent',
                  }}>
                    <td style={{
                      position: 'sticky', left: 0, zIndex: 1,
                      background: isAtm ? '#1a2540' : S.panel,
                      padding: '4px 8px', textAlign: 'right',
                      color: isAtm ? S.blue : S.text, fontWeight: isAtm ? 700 : 500,
                      borderRight: `1px solid ${S.border}`, borderBottom: `1px solid ${S.border}20`,
                      whiteSpace: 'nowrap',
                    }}>
                      {strike.toLocaleString()}
                      {isAtm && <span style={{ fontSize: 8, color: S.blue, marginLeft: 4 }}>ATM</span>}
                    </td>
                    {data.expiries.map(exp => {
                      const cell = data.cells[strikeKey]?.[exp] as MatrixCell | undefined
                      const fmt = fmtCell(cell)
                      return (
                        <td key={exp}
                          onClick={() => { if (cell && onOrderClick) onOrderClick(cell) }}
                          style={{
                            padding: '3px 6px', textAlign: 'center',
                            borderBottom: `1px solid ${S.border}20`,
                            cursor: cell ? 'pointer' : 'default',
                            background: cell ? heatColor(cell.markIv) : 'transparent',
                            transition: 'background 0.2s',
                          }}
                          onMouseEnter={e => { if (cell) (e.currentTarget as HTMLElement).style.background = 'rgba(43,121,221,0.12)' }}
                          onMouseLeave={e => { if (cell) (e.currentTarget as HTMLElement).style.background = heatColor(cell?.markIv ?? 0) }}
                        >
                          <div style={{ color: cell ? S.text : S.dim, fontWeight: 500, lineHeight: 1.3 }}>{fmt.top}</div>
                          {fmt.bot && <div style={{ color: S.muted, fontSize: 9, lineHeight: 1.2 }}>{fmt.bot}</div>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: S.muted, fontSize: 12 }}>
            {loading ? 'Loading options data...' : error ? `Error: ${error}` : 'No data available. Check filters or API connection.'}
          </div>
        )}
      </div>

      {/* -------- Footer -------- */}
      <div style={{
        padding: '4px 10px', borderTop: `1px solid ${S.border}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 9, color: S.muted }}>
          {data ? `${data.strikes.length} strikes x ${data.expiries.length} expiries` : ''}
        </span>
        <span style={{ fontSize: 9, color: S.dim }}>
          {data ? new Date(data.timestamp).toLocaleTimeString() : ''}
        </span>
      </div>

      {/* -------- Resize handle -------- */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 14, height: 14,
          cursor: 'nwse-resize', opacity: 0.4,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14">
          <line x1="10" y1="4" x2="4" y2="10" stroke={S.muted} strokeWidth="1" />
          <line x1="12" y1="6" x2="6" y2="12" stroke={S.muted} strokeWidth="1" />
          <line x1="14" y1="8" x2="8" y2="14" stroke={S.muted} strokeWidth="1" />
        </svg>
      </div>
    </div>
  )
}
