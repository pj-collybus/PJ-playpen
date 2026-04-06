import { useRef, useEffect, useCallback, useState } from 'react'
import { useLayoutStore } from '../../stores/layoutStore'
import { PricePanel } from '../PricePanel/PricePanel'
import { OptionsMatrix } from '@collybus/components'
import { snapToGrid, findFreePosition, resolveOverlaps, type PanelRect } from '../../utils/layoutEngine'

// Wrapper that positions OptionsMatrix in the panel layout grid (same as PricePanel)
function OptionsMatrixWrapper({ id, x, y, width, height, initialInstrument, onMove, onResize, onClose }: {
  id: string; x: number; y: number; width: number; height: number; initialInstrument: string
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, w: number, h: number) => void
  onClose: () => void
}) {
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(null)

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,label')) return
    e.preventDefault()
    dragRef.current = { ox: e.clientX - x, oy: e.clientY - y }
    const mv = (ev: MouseEvent) => {
      if (!dragRef.current) return
      onMove(id, ev.clientX - dragRef.current.ox, ev.clientY - dragRef.current.oy)
    }
    const up = () => { dragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
  }

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

  return (
    <div style={{ position: 'absolute', left: x, top: y, width, height }}>
      {/* Invisible drag handle over the header area */}
      <div onMouseDown={onHeaderMouseDown} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 90, cursor: 'grab', zIndex: 1 }} />
      <OptionsMatrix
        apiBase=""
        initialInstrument={initialInstrument}
        onOrderClick={(cell: any) => console.log('[OptionsMatrix] order click:', cell)}
        onClose={onClose}
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

  return (
    <div ref={canvasRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
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
        return null
      })}
    </div>
  )
}
