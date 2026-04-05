// @ts-nocheck
import { useState, useRef, useEffect } from 'react'
import { MetricsGrid } from './algo/MetricsGrid'
import { StrategyMetrics } from './algo/StrategyMetrics'
import { ChildOrdersTable } from './algo/ChildOrdersTable'
import { ExecutionChart } from './algo/ExecutionChart'
import type { AlgoStatusReport } from './algo/types'
import { STATUS_COLORS, S } from './algo/types'

export type { AlgoStatusReport } from './algo/types'
export type { FillEntry as AlgoFillReport } from './algo/types'

export interface AlgoMonitorProps {
  status: AlgoStatusReport
  onStop: (sid: string) => void
  onPause: (sid: string) => void
  onResume: (sid: string) => void
  onAccelerate: (sid: string, qty: number) => void
  onClose: (sid: string) => void
}

const monitorPositions: Record<string, { x: number; y: number }> = {}
let posOffset = 0

export function AlgoMonitor({ status, onStop, onPause, onResume, onAccelerate, onClose }: AlgoMonitorProps) {
  const [pos, setPos] = useState(() => {
    if (monitorPositions[status.strategyId]) return monitorPositions[status.strategyId]
    const off = (posOffset++ % 5) * 30
    return { x: Math.max(0, window.innerWidth - 420 - off), y: 80 + off }
  })
  const [accQty, setAccQty] = useState('')
  const [accQtyEdited, setAccQtyEdited] = useState(false)
  const [showChart, setShowChart] = useState(false)
  const [chartDetached, setChartDetached] = useState(false)
  const [chartPos, setChartPos] = useState({ x: 0, y: 0 })
  const [showOrders, setShowOrders] = useState(false)
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const chartDragRef = useRef<{ ox: number; oy: number } | null>(null)
  const monitorRef = useRef<HTMLDivElement>(null)
  const [panelHeight, setPanelHeight] = useState(0)

  useEffect(() => { monitorPositions[status.strategyId] = pos }, [pos, status.strategyId])
  useEffect(() => { if (showChart && !chartDetached) setChartPos({ x: pos.x + 360, y: pos.y }) }, [pos, showChart, chartDetached])

  const [lockedHeight, setLockedHeight] = useState(0)

  // Capture panel height once after first render — lock it forever
  useEffect(() => {
    const el = monitorRef.current
    if (!el) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const h = el.getBoundingClientRect().height
      setLockedHeight(h)
      setPanelHeight(h)
    }))
  }, [])

  const pct = status.totalSize > 0 ? Math.min(100, (status.filledSize / status.totalSize) * 100) : 0
  const statusColor = STATUS_COLORS[status.status] ?? S.muted
  const sideColor = status.side === 'BUY' ? S.positive : S.negative
  const isActive = ['Running', 'Waiting', 'Active'].includes(status.status)
  const isPaused = status.status === 'Paused'
  const isDone = ['Completed', 'Stopped', 'Error', 'Expired'].includes(status.status)

  // Urgency context
  const urgencyStr = status.activeOrderPrice && status.activeOrderPrice > 0
    ? `resting @ ${status.activeOrderPrice.toFixed(4)}`
    : status.urgency === 'aggressive' ? 'crossing now' : status.urgency ?? ''

  return (
    <>
      {/* Main monitor panel */}
      <div ref={monitorRef} style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 550,
        width: 350, background: S.bg, border: `1px solid ${S.border}`,
        borderLeft: `3px solid ${statusColor}`, borderRadius: 8,
        boxShadow: '0 12px 40px rgba(0,0,0,0.8)', userSelect: 'none',
        height: lockedHeight > 0 ? lockedHeight : undefined,
        maxHeight: '85vh', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header — draggable */}
        <div
          onMouseDown={e => {
            if ((e.target as HTMLElement).closest('button,input')) return
            e.preventDefault()
            dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }
            const mv = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }
            const up = () => { dragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
          }}
          style={{ padding: '8px 10px 6px', cursor: 'grab' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9, background: '#1D2432', border: '1px solid #363C4E', borderRadius: 3, padding: '1px 5px', color: S.muted }}>{status.exchange}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: S.text }}>{status.strategyType}</span>
              <span style={{ fontSize: 10, color: S.muted }}>{status.symbol}</span>
              <span style={{ fontSize: 10, color: sideColor, fontWeight: 700 }}>{status.side}</span>
            </div>
            <div style={{ display: 'flex', gap: 3 }}>
              <button onClick={() => setShowChart(v => !v)} title="Chart" style={{
                background: showChart ? 'rgba(43,121,221,0.2)' : 'none', border: showChart ? '1px solid rgba(43,121,221,0.4)' : '1px solid #363C4E',
                borderRadius: 4, color: showChart ? S.blue : S.muted, cursor: 'pointer', fontSize: 9, fontWeight: 700, padding: '2px 6px', fontFamily: 'inherit',
              }}>CHART</button>
              <button onClick={() => setShowOrders(v => !v)} title="Orders" style={{
                background: showOrders ? 'rgba(43,121,221,0.2)' : 'none', border: showOrders ? '1px solid rgba(43,121,221,0.4)' : '1px solid #363C4E',
                borderRadius: 4, color: showOrders ? S.blue : S.muted, cursor: 'pointer', fontSize: 9, fontWeight: 700, padding: '2px 6px', fontFamily: 'inherit',
              }}>FILLS</button>
              <button onClick={() => onClose(status.strategyId)} style={{
                background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px',
              }}>×</button>
            </div>
          </div>

          {/* Status + elapsed */}
          <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: `${statusColor}22`, color: statusColor, border: `1px solid ${statusColor}44` }}>{status.status.toUpperCase()}</span>
            <span style={{ fontSize: 9, color: S.muted }}>{pct.toFixed(1)}%</span>
            {urgencyStr && <span style={{ fontSize: 9, color: S.dim }}>{urgencyStr}</span>}
            {status.pauseReason && <span style={{ fontSize: 8, color: S.amber }}>{status.pauseReason}</span>}
          </div>
        </div>

        {/* Summary line */}
        {status.summaryLine && <div style={{ padding: '0 10px 4px', fontSize: 9, color: S.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status.summaryLine}</div>}

        {/* Progress bar */}
        <div style={{ margin: '0 10px 6px', height: 4, background: '#2a2a38', borderRadius: 2 }}>
          <div style={{ height: '100%', borderRadius: 2, width: `${pct}%`, background: isDone ? statusColor : sideColor, transition: 'width 0.5s' }} />
        </div>

        {/* Metrics or Fills view — toggle between them, scrollable within fixed panel */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {showOrders ? (
            <ChildOrdersTable orders={status.childOrders} />
          ) : (
            <>
              <MetricsGrid s={status} />
              <StrategyMetrics s={status} />
            </>
          )}
        </div>

        {/* Error */}
        {status.errorMessage && <div style={{ margin: '4px 10px', padding: '4px 8px', background: 'rgba(251,44,54,0.1)', border: '1px solid rgba(251,44,54,0.3)', borderRadius: 4, fontSize: 9, color: S.negative }}>{status.errorMessage}</div>}

        {/* Controls */}
        <div style={{ padding: '6px 10px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Accelerate — defaults to remaining size */}
          {(isActive || isPaused) && (
            <div style={{ display: 'flex', gap: 3 }}>
              <input
                value={accQtyEdited ? accQty : (status.remainingSize > 0 ? status.remainingSize.toFixed(2) : '')}
                onChange={e => { setAccQty(e.target.value); setAccQtyEdited(true) }}
                placeholder={`Remaining: ${status.remainingSize?.toFixed(2) ?? '?'}`}
                style={{ flex: 1, height: 24, background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 4, color: S.text, fontSize: 10, padding: '0 6px', outline: 'none', fontFamily: 'inherit' }} />
              <button onClick={() => {
                const q = accQtyEdited ? parseFloat(accQty) : status.remainingSize
                if (q > 0) { onAccelerate(status.strategyId, Math.min(q, status.remainingSize)); setAccQty(''); setAccQtyEdited(false) }
              }}
                style={{ padding: '0 8px', height: 24, border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, background: 'rgba(245,158,11,0.15)', color: S.amber, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>⚡ Accel</button>
            </div>
          )}
          {/* Pause/Resume/Stop */}
          {!isDone && (
            <div style={{ display: 'flex', gap: 3 }}>
              {isActive && <button onClick={() => onPause(status.strategyId)} style={{ flex: 1, padding: '5px 0', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, background: 'rgba(245,158,11,0.1)', color: S.amber, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>⏸ Pause</button>}
              {isPaused && <button onClick={() => onResume(status.strategyId)} style={{ flex: 1, padding: '5px 0', border: '1px solid rgba(43,121,221,0.4)', borderRadius: 4, background: 'rgba(43,121,221,0.1)', color: S.blue, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>▶ Resume</button>}
              <button onClick={() => onStop(status.strategyId)} style={{ flex: 1, padding: '5px 0', border: '1px solid rgba(251,44,54,0.4)', borderRadius: 4, background: 'rgba(251,44,54,0.1)', color: S.negative, fontSize: 9, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>■ Stop</button>
            </div>
          )}
          {/* Completion summary */}
          {isDone && (
            <div style={{ textAlign: 'center', fontSize: 10, color: statusColor, fontWeight: 600 }}>
              {status.status === 'Completed' ? `✓ Completed — avg ${status.avgFillPrice.toFixed(4)} slip ${status.slippageBps.toFixed(1)}bps` : status.status}
            </div>
          )}
        </div>
      </div>

      {/* Execution chart panel */}
      {showChart && (
        <div
          onMouseDown={chartDetached ? (e => {
            if ((e.target as HTMLElement).closest('button')) return
            e.preventDefault()
            chartDragRef.current = { ox: e.clientX - chartPos.x, oy: e.clientY - chartPos.y }
            const mv = (ev: MouseEvent) => { if (!chartDragRef.current) return; setChartPos({ x: ev.clientX - chartDragRef.current.ox, y: ev.clientY - chartDragRef.current.oy }) }
            const up = () => { chartDragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }
            document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up)
          }) : undefined}
          style={{
            position: 'fixed', left: chartPos.x, top: chartPos.y, zIndex: 549,
            height: panelHeight > 0 ? panelHeight : undefined,
            background: S.bg, border: `1px solid ${S.border}`, borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
            padding: 8, cursor: chartDetached ? 'grab' : 'default',
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 9, color: S.muted, fontWeight: 700 }}>EXECUTION CHART</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => setChartDetached(v => !v)} title={chartDetached ? 'Attach' : 'Detach'}
                style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 10 }}>
                {chartDetached ? '📌' : '↗'}
              </button>
              <button onClick={() => setShowChart(false)}
                style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 12 }}>×</button>
            </div>
          </div>
          <ExecutionChart status={status} width={380} height={Math.max(150, (panelHeight || 200) - 40)} />
        </div>
      )}
    </>
  )
}
