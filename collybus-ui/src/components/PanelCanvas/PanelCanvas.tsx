import { useRef, useEffect, useCallback, useState } from 'react'
import { useLayoutStore } from '../../stores/layoutStore'
import { PricePanel } from '../PricePanel/PricePanel'
import { OptionsMatrix, OptionsLadder } from '@collybus/components'
import { snapToGrid, findFreePosition, resolveOverlaps, type PanelRect } from '../../utils/layoutEngine'

// Wrapper that positions OptionsMatrix in the panel layout grid (same as PricePanel)
function OptionsMatrixWrapper({ id, x, y, width, height, initialInstrument, panelConfig, onMove, onResize, onClose, onConfigChange }: {
  id: string; x: number; y: number; width: number; height: number; initialInstrument: string
  panelConfig: Record<string, unknown>
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onClose: () => void
  onConfigChange: (config: Record<string, unknown>) => void
}) {
  const resizeRef = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null)

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { sx: e.clientX, sy: e.clientY, sw: width, sh: height }
    const mv = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      onResize(id, resizeRef.current.sw + ev.clientX - resizeRef.current.sx, resizeRef.current.sh + ev.clientY - resizeRef.current.sy)
    }
    const up = () => { resizeRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }

  // Drag handler passed to OptionsMatrix — attached to header background, not overlay
  const onDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const ox = e.clientX - x, oy = e.clientY - y
    const mv = (ev: MouseEvent) => onMove(id, ev.clientX - ox, ev.clientY - oy)
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }, [id, x, y, onMove])

  return (
    <div style={{ position: 'absolute', left: x, top: y, width, height }}>
      <OptionsMatrix
        apiBase=""
        initialInstrument={initialInstrument}
        initialConfig={{
          instrument: (panelConfig.instrument as string) || undefined,
          optionType: (panelConfig.optionType as string) || undefined,
          sideMode: (panelConfig.sideMode as string) || undefined,
          viewMode: (panelConfig.viewMode as string) || undefined,
          atmMode: panelConfig.atmMode != null ? panelConfig.atmMode as boolean : undefined,
          strikeMin: (panelConfig.strikeMin as string) || undefined,
          strikeMax: (panelConfig.strikeMax as string) || undefined,
          expiryFrom: (panelConfig.expiryFrom as string) || undefined,
          expiryTo: (panelConfig.expiryTo as string) || undefined,
        }}
        onOrderClick={(cell: any) => console.log('[OptionsMatrix] order click:', cell)}
        onClose={onClose}
        onConfigChange={onConfigChange}
        onDrag={onDrag}
        layoutWidth={width}
        layoutHeight={height}
      />
      {/* Resize handle */}
      <div onMouseDown={onResizeMouseDown} style={{
        position: 'absolute', right: 0, bottom: 0, width: 16, height: 16,
        cursor: 'nwse-resize', zIndex: 2,
      }} />
    </div>
  )
}

function OptionsLadderWrapper({ id, x, y, width, height, panelConfig, onMove, onResize, onClose, onConfigChange }: {
  id: string; x: number; y: number; width: number; height: number
  panelConfig: Record<string, unknown>
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onClose: () => void; onConfigChange: (config: Record<string, unknown>) => void
}) {
  const resizeRef = useRef<any>(null)
  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { sx: e.clientX, sy: e.clientY, sw: width, sh: height }
    const mv = (ev: MouseEvent) => { if (!resizeRef.current) return; onResize(id, resizeRef.current.sw + ev.clientX - resizeRef.current.sx, resizeRef.current.sh + ev.clientY - resizeRef.current.sy) }
    const up = () => { resizeRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }
  const onDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const ox = e.clientX - x, oy = e.clientY - y
    const mv = (ev: MouseEvent) => onMove(id, ev.clientX - ox, ev.clientY - oy)
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }, [id, x, y, onMove])
  return (
    <div style={{ position: 'absolute', left: x, top: y, width, height }}>
      <OptionsLadder apiBase="" initialConfig={{
        instrument: (panelConfig.instrument as string) || undefined,
        expiry: (panelConfig.expiry as string) || undefined,
        atmN: (panelConfig.atmN as number) || undefined,
        atmOnly: panelConfig.atmOnly != null ? panelConfig.atmOnly as boolean : undefined,
        strikeMin: (panelConfig.strikeMin as string) || undefined,
        strikeMax: (panelConfig.strikeMax as string) || undefined,
        visibleCols: panelConfig.visibleCols as string[] || undefined,
      }} onClose={onClose} onConfigChange={onConfigChange} onDrag={onDrag} layoutWidth={width} layoutHeight={height} />
      <div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'nwse-resize', zIndex: 2 }} />
    </div>
  )
}

interface PanelCanvasProps {
  availableExchanges: string[]
}

export function PanelCanvas({ availableExchanges }: PanelCanvasProps) {
  const { layouts, activeLayoutId, updatePanel, removePanel } = useLayoutStore()
  const activeLayout = layouts.find(l => l.id === activeLayoutId)
  const panels = activeLayout?.panels ?? []
  const canvasRef = useRef<HTMLDivElement>(null)

  const getPanelRects = useCallback((): PanelRect[] =>
    panels.map(p => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height ?? 180 })),
    [panels]
  )

  // Auto-place panels with sentinel position (x=-1)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const canvasW = canvas.clientWidth || 1200
    const canvasH = canvas.clientHeight || 2000

    panels.forEach(panel => {
      if (panel.x === -1 || panel.y === -1) {
        const rects = getPanelRects().filter(r => r.id !== panel.id && r.x >= 0)
        const pos = findFreePosition(rects, panel.width, panel.height ?? 180, canvasW, canvasH)
        updatePanel(panel.id, { x: pos.x, y: pos.y })
      }
    })
  }, [panels.length])

  if (panels.length === 0) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#2a3a4a', fontSize: 13 }}>No panels — click Add Panel to get started</span>
      </div>
    )
  }

  // Calculate content extent for scrolling
  const contentHeight = panels.reduce((max, p) => {
    if (p.x < 0) return max
    return Math.max(max, p.y + (p.height ?? 180) + 20)
  }, 0)
  const contentWidth = panels.reduce((max, p) => {
    if (p.x < 0) return max
    return Math.max(max, p.x + p.width + 20)
  }, 0)

  return (
    <div ref={canvasRef} style={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
      <div style={{ position: 'relative', minHeight: contentHeight, minWidth: contentWidth }}>
      {panels.map(panel => {
        if (panel.type === 'price' && panel.x >= 0) {
          return (
            <PricePanel
              key={panel.id}
              id={panel.id}
              x={panel.x}
              y={panel.y}
              width={panel.width}
              exchange={(panel.config.exchange as string) || 'DERIBIT'}
              symbol={(panel.config.symbol as string) || ''}
              availableExchanges={availableExchanges}
              granularityPresets={(panel.config.granularityPresets as any[]) ?? undefined}
              panelConfig={panel.config}
              onMove={(id, x, y) => {
                const snappedX = snapToGrid(x)
                const snappedY = snapToGrid(Math.max(0, y))
                const rects = getPanelRects()
                const updated = rects.map(r => r.id === id ? { ...r, x: snappedX, y: snappedY } : r)
                const resolved = resolveOverlaps(updated, id)
                resolved.forEach(r => {
                  const orig = rects.find(p => p.id === r.id)
                  if (orig && (orig.x !== r.x || orig.y !== r.y)) {
                    updatePanel(r.id, { x: r.x, y: r.y })
                  }
                })
              }}
              onClose={(id) => removePanel(id)}
              onResize={(id, width) => {
                const snappedW = Math.max(120, snapToGrid(width))
                updatePanel(id, { width: snappedW })
                const rects = getPanelRects().map(r => r.id === id ? { ...r, width: snappedW } : r)
                const resolved = resolveOverlaps(rects, id)
                resolved.forEach(r => {
                  if (r.id !== id) {
                    const orig = rects.find(p => p.id === r.id)
                    if (orig && (orig.x !== r.x || orig.y !== r.y)) {
                      updatePanel(r.id, { x: r.x, y: r.y })
                    }
                  }
                })
              }}
              onConfigChange={(id, changes) => {
                const configUpdates: Record<string, unknown> = { ...changes }
                if (changes.symbol) {
                  const storedSymbol = panel.config.symbol as string
                  if (storedSymbol && changes.symbol === storedSymbol) {
                    delete configUpdates.symbol
                  }
                }
                if (Object.keys(configUpdates).length > 0) {
                  updatePanel(id, { config: { ...panel.config, ...configUpdates } })
                }
              }}
            />
          )
        }
        if (panel.type === 'options-matrix' && panel.x >= 0) {
          return (
            <OptionsMatrixWrapper
              key={panel.id}
              id={panel.id}
              x={panel.x}
              y={panel.y}
              width={panel.width}
              height={panel.height ?? 500}
              initialInstrument={(panel.config.instrument as string) || 'BTC_USDC'}
              panelConfig={panel.config}
              onConfigChange={(config) => {
                updatePanel(panel.id, { config: { ...panel.config, ...config } })
              }}
              onMove={(id, x, y) => {
                const snappedX = snapToGrid(x)
                const snappedY = snapToGrid(Math.max(0, y))
                const rects = getPanelRects()
                const updated = rects.map(r => r.id === id ? { ...r, x: snappedX, y: snappedY } : r)
                const resolved = resolveOverlaps(updated, id)
                resolved.forEach(r => {
                  const orig = rects.find(p => p.id === r.id)
                  if (orig && (orig.x !== r.x || orig.y !== r.y)) {
                    updatePanel(r.id, { x: r.x, y: r.y })
                  }
                })
              }}
              onResize={(id, w, h) => {
                const snappedW = Math.max(390, snapToGrid(w))
                const snappedH = Math.max(300, snapToGrid(h))
                updatePanel(id, { width: snappedW, height: snappedH })
                const rects = getPanelRects().map(r => r.id === id ? { ...r, width: snappedW, height: snappedH } : r)
                const resolved = resolveOverlaps(rects, id)
                resolved.forEach(r => {
                  if (r.id !== id) {
                    const orig = rects.find(p => p.id === r.id)
                    if (orig && (orig.x !== r.x || orig.y !== r.y)) {
                      updatePanel(r.id, { x: r.x, y: r.y })
                    }
                  }
                })
              }}
              onClose={() => removePanel(panel.id)}
            />
          )
        }
        if (panel.type === 'options-ladder' && panel.x >= 0) {
          return (
            <OptionsLadderWrapper
              key={panel.id} id={panel.id} x={panel.x} y={panel.y} width={panel.width} height={panel.height ?? 500}
              panelConfig={panel.config}
              onConfigChange={(config) => updatePanel(panel.id, { config: { ...panel.config, ...config } })}
              onMove={(id, x, y) => {
                const snappedX = snapToGrid(x); const snappedY = snapToGrid(Math.max(0, y))
                const rects = getPanelRects(); const updated = rects.map(r => r.id === id ? { ...r, x: snappedX, y: snappedY } : r)
                resolveOverlaps(updated, id).forEach(r => { const orig = rects.find(p => p.id === r.id); if (orig && (orig.x !== r.x || orig.y !== r.y)) updatePanel(r.id, { x: r.x, y: r.y }) })
              }}
              onResize={(id, w, h) => {
                const snappedW = Math.max(300, snapToGrid(w)); const snappedH = Math.max(200, snapToGrid(h))
                updatePanel(id, { width: snappedW, height: snappedH })
                const rects = getPanelRects().map(r => r.id === id ? { ...r, width: snappedW, height: snappedH } : r)
                resolveOverlaps(rects, id).forEach(r => { if (r.id !== id) { const orig = rects.find(p => p.id === r.id); if (orig && (orig.x !== r.x || orig.y !== r.y)) updatePanel(r.id, { x: r.x, y: r.y }) } })
              }}
              onClose={() => removePanel(panel.id)}
            />
          )
        }
        return null
      })}
      </div>
    </div>
  )
}
