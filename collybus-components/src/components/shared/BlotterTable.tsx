import { useState, useRef, useMemo, useCallback, useEffect } from 'react'

// ── Public types ──

export interface BlotterColumn {
  key: string
  label: string
  width: number
  minWidth: number
  sortable: boolean
  visible: boolean
  defaultVisible: boolean
  align: 'left' | 'right' | 'center'
  format?: 'number' | 'price' | 'qty' | 'time' | 'date' | 'pnl' | 'side' | 'status' | 'string'
  render?: (value: any, row: Record<string, any>) => React.ReactNode
}

interface BlotterTableProps {
  columns: BlotterColumn[]
  rows: Record<string, any>[]
  rowKey: (row: Record<string, any>) => string
  storageKey: string
  emptyMessage?: string
  statusField?: string
  onRowDoubleClick?: (row: Record<string, any>) => void
}

// ── Column state persistence ──

interface ColumnState {
  order: string[]
  widths: Record<string, number>
  visible: Record<string, boolean>
}

function loadColumnState(storageKey: string): ColumnState | null {
  try {
    const raw = localStorage.getItem(`collybus.blotter.${storageKey}.columns`)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveColumnState(storageKey: string, state: ColumnState) {
  try { localStorage.setItem(`collybus.blotter.${storageKey}.columns`, JSON.stringify(state)) } catch {}
}

// ── Formatters ──

function formatCell(col: BlotterColumn, row: Record<string, any>): React.ReactNode {
  if (col.render) return col.render(row[col.key], row)
  const v = row[col.key]
  if (v == null || v === '') return <span style={{ color: '#363C4E' }}>—</span>
  switch (col.format) {
    case 'time':
      return new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    case 'date':
      return new Date(v).toLocaleDateString('en-GB')
    case 'price':
      return Number(v).toFixed(4).replace(/\.?0+$/, '')
    case 'qty':
      return Number(v).toFixed(4).replace(/\.?0+$/, '')
    case 'pnl': {
      const n = Number(v)
      const c = n > 0 ? '#00C758' : n < 0 ? '#FB2C36' : '#636e82'
      return <span style={{ color: c }}>{(n >= 0 ? '+' : '') + n.toFixed(2)}</span>
    }
    case 'side': {
      const s = String(v).toUpperCase()
      const c = s === 'BUY' || s === 'LONG' ? '#00C758' : '#FB2C36'
      return <span style={{ color: c, fontWeight: 600 }}>{s}</span>
    }
    case 'status': {
      const st = String(v).toUpperCase()
      let bg = 'rgba(99,110,130,0.15)', fg = '#636e82'
      if (st === 'OPEN' || st === 'PARTIALLY_FILLED') { bg = 'rgba(43,121,221,0.15)'; fg = '#4488ff' }
      else if (st === 'FILLED' || st === 'COMPLETED') { bg = 'rgba(0,199,88,0.15)'; fg = '#00C758' }
      else if (st === 'CANCELLED' || st === 'STOPPED') { bg = 'rgba(99,110,130,0.15)'; fg = '#636e82' }
      else if (st === 'REJECTED' || st === 'ERROR') { bg = 'rgba(251,44,54,0.15)'; fg = '#FB2C36' }
      else if (st === 'RUNNING') { bg = 'rgba(43,121,221,0.15)'; fg = '#4488ff' }
      else if (st === 'PAUSED' || st === 'WAITING') { bg = 'rgba(245,158,11,0.15)'; fg = '#F59E0B' }
      return <span style={{ background: bg, color: fg, borderRadius: 3, padding: '1px 6px', fontSize: 9, fontWeight: 700 }}>{st}</span>
    }
    case 'number':
      return Number(v).toLocaleString()
    default:
      return String(v)
  }
}

function getRowBg(row: Record<string, any>, idx: number, statusField?: string): string {
  if (statusField) {
    const st = String(row[statusField] ?? '').toUpperCase()
    if (st === 'FILLED' || st === 'COMPLETED') return 'rgba(0,199,88,0.04)'
    if (st === 'CANCELLED' || st === 'STOPPED') return 'rgba(99,110,130,0.04)'
    if (st === 'REJECTED' || st === 'ERROR') return 'rgba(251,44,54,0.04)'
  }
  return idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)'
}

// ── Constants ──

const ROW_H = 28
const OVERSCAN = 8
const HOVER_BG = 'rgba(43,121,221,0.06)'

// ── Component ──

export function BlotterTable({ columns, rows, rowKey, storageKey, emptyMessage, statusField, onRowDoubleClick }: BlotterTableProps) {
  // Column state
  const saved = useRef(loadColumnState(storageKey))
  const [colOrder, setColOrder] = useState<string[]>(() =>
    saved.current?.order ?? columns.map(c => c.key)
  )
  const [colWidths, setColWidths] = useState<Record<string, number>>(() =>
    saved.current?.widths ?? Object.fromEntries(columns.map(c => [c.key, c.width]))
  )
  const [colVisible, setColVisible] = useState<Record<string, boolean>>(() =>
    saved.current?.visible ?? Object.fromEntries(columns.map(c => [c.key, c.defaultVisible]))
  )

  // Sort state (3-click cycle: desc → asc → none)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Settings dropdown
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)

  // Column drag reorder
  const [dragCol, setDragCol] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  // Settings drag reorder
  const [settingsDragCol, setSettingsDragCol] = useState<string | null>(null)
  const [settingsDropTarget, setSettingsDropTarget] = useState<string | null>(null)

  // Virtual scroll state
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerH, setContainerH] = useState(300)

  // Sync new columns not in saved state
  useEffect(() => {
    const allKeys = columns.map(c => c.key)
    setColOrder(prev => {
      const existing = prev.filter(k => allKeys.includes(k))
      const newKeys = allKeys.filter(k => !prev.includes(k))
      return [...existing, ...newKeys]
    })
    setColWidths(prev => {
      const next = { ...prev }
      columns.forEach(c => { if (!(c.key in next)) next[c.key] = c.width })
      return next
    })
    setColVisible(prev => {
      const next = { ...prev }
      columns.forEach(c => { if (!(c.key in next)) next[c.key] = c.defaultVisible })
      return next
    })
  }, [columns.length])

  // Persist on change
  useEffect(() => {
    saveColumnState(storageKey, { order: colOrder, widths: colWidths, visible: colVisible })
  }, [colOrder, colWidths, colVisible, storageKey])

  // Container resize observer
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height
      if (h && h > 0) setContainerH(h)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Close settings on outside click
  useEffect(() => {
    if (!settingsOpen) return
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [settingsOpen])

  // Visible columns in order
  const colMap = useMemo(() => new Map(columns.map(c => [c.key, c])), [columns])
  const visibleCols = useMemo(
    () => colOrder.filter(k => colVisible[k] && colMap.has(k)).map(k => colMap.get(k)!),
    [colOrder, colVisible, colMap]
  )
  const totalWidth = useMemo(
    () => visibleCols.reduce((s, c) => s + (colWidths[c.key] ?? c.width), 0),
    [visibleCols, colWidths]
  )

  // Sorted rows
  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = colMap.get(sortKey)
    if (!col?.sortable) return rows
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortKey, sortDir, colMap])

  // Virtual scroll computation
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const endIdx = Math.min(sorted.length, Math.ceil((scrollTop + containerH) / ROW_H) + OVERSCAN)
  const visibleRows = sorted.slice(startIdx, endIdx)

  // Sort handler (3-click)
  const handleSort = useCallback((key: string) => {
    const col = colMap.get(key)
    if (!col?.sortable) return
    if (sortKey !== key) { setSortKey(key); setSortDir('desc') }
    else if (sortDir === 'desc') { setSortDir('asc') }
    else { setSortKey(null); setSortDir('desc') }
  }, [sortKey, sortDir, colMap])

  // Column resize
  const handleResizeStart = useCallback((colKey: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX
    const startW = colWidths[colKey] ?? 100
    const minW = colMap.get(colKey)?.minWidth ?? 50
    const onMove = (ev: MouseEvent) => {
      setColWidths(prev => ({ ...prev, [colKey]: Math.max(minW, startW + ev.clientX - startX) }))
    }
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [colWidths, colMap])

  // Auto-fit column on double-click resize handle
  const handleAutoFit = useCallback((colKey: string) => {
    const col = colMap.get(colKey)
    if (!col) return
    let maxW = col.minWidth
    for (const row of sorted.slice(0, 100)) {
      const val = row[colKey]
      const text = val != null ? String(val) : ''
      maxW = Math.max(maxW, text.length * 7.5 + 20)
    }
    maxW = Math.max(maxW, col.label.length * 8 + 30)
    setColWidths(prev => ({ ...prev, [colKey]: Math.min(400, maxW) }))
  }, [colMap, sorted])

  // Column drag reorder (header)
  const handleHeaderDragStart = useCallback((key: string) => setDragCol(key), [])
  const handleHeaderDragOver = useCallback((key: string, e: React.DragEvent) => {
    e.preventDefault()
    if (dragCol && dragCol !== key) setDropTarget(key)
  }, [dragCol])
  const handleHeaderDrop = useCallback((targetKey: string) => {
    if (!dragCol || dragCol === targetKey) return
    setColOrder(prev => {
      const order = [...prev]
      const fromIdx = order.indexOf(dragCol)
      const toIdx = order.indexOf(targetKey)
      if (fromIdx === -1 || toIdx === -1) return prev
      order.splice(fromIdx, 1)
      order.splice(toIdx, 0, dragCol)
      return order
    })
    setDragCol(null)
    setDropTarget(null)
  }, [dragCol])
  const handleHeaderDragEnd = useCallback(() => { setDragCol(null); setDropTarget(null) }, [])

  // Settings column reorder
  const handleSettingsDragOver = useCallback((key: string, e: React.DragEvent) => {
    e.preventDefault()
    if (settingsDragCol && settingsDragCol !== key) setSettingsDropTarget(key)
  }, [settingsDragCol])
  const handleSettingsDrop = useCallback((targetKey: string) => {
    if (!settingsDragCol || settingsDragCol === targetKey) return
    setColOrder(prev => {
      const order = [...prev]
      const fromIdx = order.indexOf(settingsDragCol)
      const toIdx = order.indexOf(targetKey)
      if (fromIdx === -1 || toIdx === -1) return prev
      order.splice(fromIdx, 1)
      order.splice(toIdx, 0, settingsDragCol)
      return order
    })
    setSettingsDragCol(null)
    setSettingsDropTarget(null)
  }, [settingsDragCol])

  // Reset columns to defaults
  const handleReset = useCallback(() => {
    setColOrder(columns.map(c => c.key))
    setColWidths(Object.fromEntries(columns.map(c => [c.key, c.width])))
    setColVisible(Object.fromEntries(columns.map(c => [c.key, c.defaultVisible])))
  }, [columns])

  // Toggle column visibility
  const toggleCol = useCallback((key: string) => {
    setColVisible(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // Sync header + body horizontal scroll
  const headerRef = useRef<HTMLDivElement>(null)
  const handleBodyScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
    if (headerRef.current) headerRef.current.scrollLeft = e.currentTarget.scrollLeft
  }, [])
  const handleHeaderScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (bodyRef.current) bodyRef.current.scrollLeft = e.currentTarget.scrollLeft
  }, [])

  // ── Render ──
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      {/* Header */}
      <div ref={headerRef} onScroll={handleHeaderScroll}
        style={{ overflowX: 'auto', overflowY: 'hidden', flexShrink: 0, scrollbarWidth: 'none' }}>
        <div style={{ display: 'flex', width: totalWidth, background: '#18171C' }}>
          {visibleCols.map(col => {
            const isDropTarget = dropTarget === col.key
            return (
              <div
                key={col.key}
                draggable
                onDragStart={() => handleHeaderDragStart(col.key)}
                onDragOver={e => handleHeaderDragOver(col.key, e)}
                onDrop={() => handleHeaderDrop(col.key)}
                onDragEnd={handleHeaderDragEnd}
                style={{
                  position: 'relative',
                  width: colWidths[col.key] ?? col.width,
                  minWidth: col.minWidth,
                  padding: '5px 10px', fontSize: 9, fontWeight: 700,
                  color: '#636e82', letterSpacing: '0.07em',
                  textTransform: 'uppercase', textAlign: col.align,
                  whiteSpace: 'nowrap', userSelect: 'none',
                  boxShadow: '0 1px 0 #1e1e2a', cursor: col.sortable ? 'pointer' : 'default',
                  boxSizing: 'border-box',
                  borderLeft: isDropTarget ? '2px solid #2B79DD' : '2px solid transparent',
                  opacity: dragCol === col.key ? 0.4 : 1,
                }}
                onClick={() => handleSort(col.key)}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {col.label}
                  {sortKey === col.key && (
                    <span style={{ marginLeft: 3, opacity: 0.7 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </span>
                {/* Resize handle */}
                <div
                  style={{
                    position: 'absolute', right: 0, top: '20%', bottom: '20%',
                    width: 4, cursor: 'col-resize', zIndex: 2,
                    background: 'rgba(54,60,78,0.8)', borderRadius: 2,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.7)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(54,60,78,0.8)'}
                  onMouseDown={e => handleResizeStart(col.key, e)}
                  onDoubleClick={e => { e.stopPropagation(); handleAutoFit(col.key) }}
                  onClick={e => e.stopPropagation()}
                />
              </div>
            )
          })}
        </div>
      </div>

      {/* Body (virtualized scroll) */}
      <div ref={bodyRef} onScroll={handleBodyScroll}
        style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {sorted.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: '#363C4E', fontSize: 12 }}>
            {emptyMessage ?? 'No data'}
          </div>
        ) : (
          <div style={{ height: sorted.length * ROW_H, position: 'relative', width: totalWidth }}>
            {visibleRows.map((row, vi) => {
              const idx = startIdx + vi
              const bg = getRowBg(row, idx, statusField)
              return (
                <div
                  key={rowKey(row)}
                  style={{
                    position: 'absolute', top: idx * ROW_H, height: ROW_H,
                    width: totalWidth, display: 'flex',
                    cursor: onRowDoubleClick ? 'pointer' : 'default',
                  }}
                  onDoubleClick={() => onRowDoubleClick?.(row)}
                  onMouseEnter={e => e.currentTarget.style.background = HOVER_BG}
                  onMouseLeave={e => e.currentTarget.style.background = bg}
                >
                  {visibleCols.map(col => (
                    <div key={col.key} style={{
                      width: colWidths[col.key] ?? col.width, minWidth: col.minWidth,
                      padding: '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.025)',
                      color: 'rgba(255,255,255,0.8)', textAlign: col.align,
                      fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      background: bg, boxSizing: 'border-box', lineHeight: `${ROW_H - 8}px`,
                    }}>
                      {formatCell(col, row)}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Settings gear */}
      <div ref={settingsRef} style={{ position: 'absolute', top: 0, right: 0, zIndex: 10 }}>
        <button
          onClick={() => setSettingsOpen(p => !p)}
          style={{
            background: settingsOpen ? 'rgba(43,121,221,0.2)' : 'rgba(24,23,28,0.9)',
            border: 'none', color: settingsOpen ? '#2B79DD' : '#636e82',
            cursor: 'pointer', fontSize: 12, padding: '4px 7px',
            borderRadius: '0 0 0 4px',
          }}
          onMouseEnter={e => { if (!settingsOpen) e.currentTarget.style.color = '#fff' }}
          onMouseLeave={e => { if (!settingsOpen) e.currentTarget.style.color = '#636e82' }}
          title="Column settings"
        >⚙</button>
        {settingsOpen && (
          <div style={{
            position: 'absolute', top: 26, right: 0,
            background: '#1F1E23', border: '1px solid #363C4E', borderRadius: 6,
            padding: '6px 0', minWidth: 200, maxHeight: 380, overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          }}>
            {colOrder.filter(k => colMap.has(k)).map(key => {
              const c = colMap.get(key)!
              const isTarget = settingsDropTarget === key
              return (
                <div
                  key={key}
                  draggable
                  onDragStart={() => setSettingsDragCol(key)}
                  onDragOver={e => handleSettingsDragOver(key, e)}
                  onDrop={() => handleSettingsDrop(key)}
                  onDragEnd={() => { setSettingsDragCol(null); setSettingsDropTarget(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 12px', cursor: 'grab', fontSize: 11,
                    color: colVisible[key] ? 'rgba(255,255,255,0.8)' : '#636e82',
                    borderTop: isTarget ? '2px solid #2B79DD' : '2px solid transparent',
                    opacity: settingsDragCol === key ? 0.4 : 1,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ color: '#363C4E', fontSize: 10, cursor: 'grab' }}>⠿</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1 }}>
                    <input
                      type="checkbox"
                      checked={colVisible[key] ?? c.defaultVisible}
                      onChange={() => toggleCol(key)}
                      style={{ accentColor: '#2B79DD' }}
                    />
                    {c.label}
                  </label>
                </div>
              )
            })}
            <div style={{ borderTop: '1px solid #363C4E', padding: '6px 12px', marginTop: 4 }}>
              <button
                onClick={handleReset}
                style={{
                  background: 'rgba(43,121,221,0.12)', border: '1px solid rgba(43,121,221,0.3)',
                  borderRadius: 4, color: '#2B79DD', fontSize: 10, fontWeight: 600,
                  padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit', width: '100%',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.25)'}
                onMouseLeave={e => e.currentTarget.style.background = 'rgba(43,121,221,0.12)'}
              >Reset to Defaults</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Column definition helper ──

export function col(
  key: string, label: string,
  opts: Partial<Omit<BlotterColumn, 'key' | 'label'>> = {}
): BlotterColumn {
  return {
    key, label,
    width: opts.width ?? 100,
    minWidth: opts.minWidth ?? 50,
    sortable: opts.sortable ?? true,
    visible: opts.visible ?? opts.defaultVisible ?? true,
    defaultVisible: opts.defaultVisible ?? true,
    align: opts.align ?? 'left',
    format: opts.format,
    render: opts.render,
  }
}
