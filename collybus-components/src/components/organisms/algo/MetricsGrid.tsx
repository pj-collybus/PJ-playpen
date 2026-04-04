// @ts-nocheck
import type { AlgoStatusReport } from './types'
import { S } from './types'

const fmtN = (n: number, dp = 4) => !n || !isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: dp, useGrouping: true })
const fmtBps = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}bps`

export function MetricsGrid({ s }: { s: AlgoStatusReport }) {
  const elapsed = Math.floor((Date.now() - s.startedAt) / 1000)
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  const nextIn = s.nextSliceAt ? Math.max(0, Math.floor((s.nextSliceAt - Date.now()) / 1000)) : null
  const timeLeft = s.nextSliceAt && s.totalSlices > 0 ? `${nextIn}s` : '—'
  const slipColor = (v: number) => v > 5 ? S.negative : v < -2 ? S.positive : S.muted

  const cells = [
    { l: 'Filled', v: fmtN(s.filledSize) },
    { l: 'Remaining', v: fmtN(s.remainingSize) },
    { l: 'Avg Fill', v: fmtN(s.avgFillPrice) },
    { l: 'Arrival', v: fmtN(s.arrivalMid) },
    { l: 'Elapsed', v: elapsedStr },
    { l: 'Time Left', v: timeLeft },
    { l: 'Slip vs Arrival', v: fmtBps(s.slippageBps), c: slipColor(s.slippageBps) },
    { l: 'Slip vs VWAP', v: fmtBps(s.vwapShortfallBps), c: slipColor(s.vwapShortfallBps) },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', padding: '0 12px 8px' }}>
      {cells.map(({ l, v, c }) => (
        <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
          <span style={{ fontSize: 10, color: S.muted }}>{l}</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: c ?? S.text, fontFamily: 'monospace' }}>{v}</span>
        </div>
      ))}
    </div>
  )
}
