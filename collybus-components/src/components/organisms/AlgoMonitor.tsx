import { useState, useRef, useEffect } from 'react'

export interface AlgoMonitorProps {
  status: AlgoStatusReport
  onStop: (sid: string) => void
  onPause: (sid: string) => void
  onResume: (sid: string) => void
  onAccelerate: (sid: string, qty: number) => void
  onClose: (sid: string) => void
}

export interface AlgoStatusReport {
  strategyId: string; strategyType: string; exchange: string; symbol: string; side: string
  status: string; totalSize: number; filledSize: number; remainingSize: number
  avgFillPrice: number; arrivalMid: number; slippageBps: number; vwapShortfallBps: number
  currentSlice: number; totalSlices: number; nextSliceAt: number | null
  pauseReason?: string | null; errorMessage: string | null; summaryLine?: string | null
  startedAt: number; updatedAt: number
  fills?: AlgoFillReport[]
}

export interface AlgoFillReport {
  fillPrice: number; fillSize: number; timestamp: number
}

const STATUS_COLORS: Record<string, string> = {
  Running: '#2B79DD', Waiting: '#636e82', Paused: '#F59E0B',
  Completing: '#00C758', Completed: '#00C758', Stopped: '#636e82', Error: '#FB2C36',
}
const S = { bg: '#18171C', border: '#2a2a38', positive: '#00C758', negative: '#FB2C36', blue: '#2B79DD', text: 'rgba(255,255,255,0.85)', muted: '#636e82' }

const monitorPositions: Record<string, { x: number; y: number }> = {}
let posOffset = 0
function getPos(sid: string) {
  if (monitorPositions[sid]) return monitorPositions[sid]
  const off = (posOffset++ % 5) * 30
  return { x: Math.max(0, window.innerWidth - 380 - off), y: 80 + off }
}

export function AlgoMonitor({ status, onStop, onPause, onResume, onAccelerate, onClose }: AlgoMonitorProps) {
  const [pos, setPos] = useState(() => getPos(status.strategyId))
  const [accQty, setAccQty] = useState('')
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  useEffect(() => { monitorPositions[status.strategyId] = pos }, [pos, status.strategyId])

  const pct = status.totalSize > 0 ? Math.min(100, (status.filledSize / status.totalSize) * 100) : 0
  const statusColor = STATUS_COLORS[status.status] ?? S.muted
  const sideColor = status.side === 'BUY' ? S.positive : S.negative
  const isActive = ['Running', 'Waiting'].includes(status.status)
  const isPaused = status.status === 'Paused'
  const isDone = ['Completed', 'Stopped', 'Error'].includes(status.status)
  const elapsed = Math.floor((Date.now() - status.startedAt) / 1000)
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  const nextIn = status.nextSliceAt ? Math.max(0, Math.floor((status.nextSliceAt - Date.now()) / 1000)) : null

  return (
    <div style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 550, width: 340, background: S.bg, border: `1px solid ${S.border}`, borderLeft: `3px solid ${statusColor}`, borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.8)', userSelect: 'none' }}>
      {/* Header */}
      <div onMouseDown={e => { if ((e.target as HTMLElement).closest('button,input')) return; e.preventDefault(); dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }; const mv = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }; const up = () => { dragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up) }} style={{ padding: '10px 12px 8px', cursor: 'grab' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, background: '#1D2432', border: '1px solid #363C4E', borderRadius: 3, padding: '1px 6px', color: S.muted }}>{status.exchange}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: S.text }}>{status.strategyType}</span>
            <span style={{ fontSize: 10, color: S.muted }}>{status.symbol}</span>
            <span style={{ fontSize: 10, color: sideColor, fontWeight: 700 }}>{status.side}</span>
            <span style={{ fontSize: 10, color: S.muted }}>{pct.toFixed(1)}%</span>
          </div>
          <button onClick={() => onClose(status.strategyId)} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: `${statusColor}22`, color: statusColor, border: `1px solid ${statusColor}44` }}>{status.status.toUpperCase()}</span>
          <span style={{ fontSize: 9, color: S.muted }}>{elapsedStr}</span>
          {status.currentSlice > 0 && <span style={{ fontSize: 9, color: S.muted }}>slice {status.currentSlice}/{status.totalSlices}{nextIn != null && ` · next ${nextIn}s`}</span>}
          {status.pauseReason && <span style={{ fontSize: 8, color: '#F59E0B' }}>{status.pauseReason}</span>}
        </div>
      </div>

      {/* Progress */}
      <div style={{ margin: '0 12px 8px', height: 4, background: '#2a2a38', borderRadius: 2 }}>
        <div style={{ height: '100%', borderRadius: 2, width: `${pct}%`, background: isDone ? `linear-gradient(to right, ${statusColor}88, ${statusColor})` : `linear-gradient(to right, ${sideColor}88, ${sideColor})`, transition: 'width 0.5s' }} />
      </div>

      {/* Stats */}
      <div style={{ padding: '0 12px 8px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        {[
          { l: 'Filled', v: status.filledSize.toLocaleString('en-US', { maximumFractionDigits: 4 }) },
          { l: 'Remaining', v: status.remainingSize.toLocaleString('en-US', { maximumFractionDigits: 4 }) },
          { l: 'Avg Fill', v: status.avgFillPrice > 0 ? status.avgFillPrice.toFixed(4) : '—' },
          { l: 'Arrival', v: status.arrivalMid > 0 ? status.arrivalMid.toFixed(4) : '—' },
          { l: 'Slippage', v: `${status.slippageBps.toFixed(1)}bps`, c: status.slippageBps > 5 ? S.negative : status.slippageBps < -2 ? S.positive : S.muted },
          { l: 'VWAP Δ', v: `${status.vwapShortfallBps.toFixed(1)}bps`, c: status.vwapShortfallBps > 5 ? S.negative : S.muted },
        ].map(({ l, v, c }) => <div key={l} style={{ textAlign: 'center' }}><div style={{ fontSize: 8, color: S.muted, marginBottom: 1 }}>{l}</div><div style={{ fontSize: 11, fontWeight: 600, color: c ?? S.text }}>{v}</div></div>)}
      </div>

      {/* Error */}
      {status.errorMessage && <div style={{ margin: '0 12px 8px', padding: '6px 8px', background: 'rgba(251,44,54,0.1)', border: '1px solid rgba(251,44,54,0.3)', borderRadius: 4, fontSize: 10, color: S.negative }}>{status.errorMessage}</div>}

      {/* Controls */}
      <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {isActive && <div style={{ display: 'flex', gap: 4 }}>
          <input value={accQty} onChange={e => setAccQty(e.target.value)} placeholder="Accelerate qty" style={{ flex: 1, height: 28, background: '#0e0e14', border: `1px solid ${S.border}`, borderRadius: 4, color: S.text, fontSize: 11, padding: '0 8px', outline: 'none', fontFamily: 'inherit' }} />
          <button onClick={() => { const q = parseFloat(accQty); if (q > 0) onAccelerate(status.strategyId, q) }} style={{ padding: '0 12px', height: 28, border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, background: 'rgba(245,158,11,0.2)', color: '#F59E0B', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>⚡ Accel</button>
        </div>}
        <div style={{ display: 'flex', gap: 4 }}>
          {isActive && <button onClick={() => onPause(status.strategyId)} style={{ flex: 1, padding: '6px 0', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, background: 'rgba(245,158,11,0.12)', color: '#F59E0B', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>⏸ Pause</button>}
          {isPaused && <button onClick={() => onResume(status.strategyId)} style={{ flex: 1, padding: '6px 0', border: '1px solid rgba(43,121,221,0.4)', borderRadius: 4, background: 'rgba(43,121,221,0.12)', color: S.blue, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>▶ Resume</button>}
          {!isDone && <button onClick={() => onStop(status.strategyId)} style={{ flex: 1, padding: '6px 0', border: '1px solid rgba(251,44,54,0.4)', borderRadius: 4, background: 'rgba(251,44,54,0.12)', color: S.negative, fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>■ Stop</button>}
        </div>
      </div>
    </div>
  )
}
