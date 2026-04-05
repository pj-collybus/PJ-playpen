// @ts-nocheck
import type { AlgoStatusReport, LevelState } from './types'
import { S, LEVEL_COLORS } from './types'

const fmtN = (n: number, dp = 4) => !n || !isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: dp, useGrouping: true })

function LevelBar({ level, index, totalSize }: { level: LevelState; index: number; totalSize: number }) {
  const pct = level.allocatedSize > 0 ? Math.min(100, (level.filledSize / level.allocatedSize) * 100) : 0
  const color = LEVEL_COLORS[index % LEVEL_COLORS.length]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <span style={{ fontSize: 9, color, fontWeight: 700, minWidth: 18 }}>L{index + 1}</span>
      <span style={{ fontSize: 9, color: S.muted, minWidth: 50, fontFamily: 'monospace' }}>${level.price?.toFixed(4)}</span>
      <div style={{ flex: 1, height: 6, background: '#1a1a22', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 9, color: S.text, fontFamily: 'monospace', minWidth: 70, textAlign: 'right' }}>
        {fmtN(level.filledSize, 2)}/{fmtN(level.allocatedSize, 2)}
      </span>
      <span style={{ fontSize: 8, color: level.status === 'COMPLETED' ? S.positive : level.status === 'FIRING' ? color : S.muted, minWidth: 50 }}>
        {level.status}
      </span>
    </div>
  )
}

function SniperMetrics({ s }: { s: AlgoStatusReport }) {
  const isPostSnipe = s.executionMode === 'post_snipe'
  const isBuy = s.side === 'BUY'

  // Build combined rows: POST + snipe levels, sorted by price
  type Row = { label: string; price: number; filled: number; allocated: number; status: string; color: string }
  const rows: Row[] = []

  // Add POST row if post+snipe
  if (isPostSnipe && s.targetPrice && s.targetPrice > 0) {
    const postAlloc = s.totalSize - (s.levels?.reduce((sum, l) => sum + l.allocatedSize, 0) ?? 0)
    rows.push({
      label: 'POST', price: s.targetPrice, color: '#ccaa44',
      filled: s.passiveFillSize ?? 0, allocated: postAlloc,
      status: (s.passiveFillSize ?? 0) >= postAlloc ? 'Filled' : s.postSnipePhase === 'ACTIVE' ? 'Resting' : 'Waiting',
    })
  }

  // Add snipe level rows
  s.levels?.forEach((lv, i) => {
    rows.push({
      label: `L${i + 1}`, price: lv.price, color: LEVEL_COLORS[i % LEVEL_COLORS.length],
      filled: lv.filledSize, allocated: lv.allocatedSize, status: lv.status,
    })
  })

  // Sort: BUY = descending (highest first), SELL = ascending (lowest first)
  rows.sort((a, b) => isBuy ? b.price - a.price : a.price - b.price)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {rows.map((r, i) => {
        const pct = r.allocated > 0 ? Math.min(100, (r.filled / r.allocated) * 100) : 0
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
            <span style={{ fontSize: 9, color: r.color, fontWeight: 700, minWidth: 28 }}>{r.label}</span>
            <span style={{ fontSize: 9, color: S.muted, minWidth: 50, fontFamily: 'monospace' }}>${r.price.toFixed(4)}</span>
            <div style={{ flex: 1, height: 6, background: '#1a1a22', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: r.color, borderRadius: 3, transition: 'width 0.3s' }} />
            </div>
            <span style={{ fontSize: 9, color: S.text, fontFamily: 'monospace', minWidth: 70, textAlign: 'right' }}>
              {fmtN(r.filled, 2)}/{fmtN(r.allocated, 2)}
            </span>
            <span style={{ fontSize: 8, color: r.status === 'Completed' || r.status === 'Filled' ? S.positive : r.status === 'Firing' || r.status === 'FIRING' ? r.color : S.muted, minWidth: 50 }}>
              {r.status}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function TwapVwapMetrics({ s }: { s: AlgoStatusReport }) {
  const nextIn = s.nextSliceAt ? Math.max(0, Math.floor((s.nextSliceAt - Date.now()) / 1000)) : null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10 }}>
      <div style={{ color: S.muted }}>
        Slice {s.currentSlice}/{s.totalSlices}
        {nextIn != null && <span> · next in <span style={{ color: S.text }}>{nextIn}s</span></span>}
      </div>
      {s.strategyType === 'VWAP' && s.rollingVwap && s.rollingVwap > 0 && (
        <div style={{ color: S.muted }}>
          VWAP: <span style={{ color: S.text }}>{fmtN(s.rollingVwap)}</span>
          {s.deviationFromVwap != null && <span> · dev: <span style={{ color: Math.abs(s.deviationFromVwap) > 5 ? S.negative : S.text }}>{s.deviationFromVwap?.toFixed(1)}bps</span></span>}
          {s.inParticipationBand != null && <span> · {s.inParticipationBand ? '✓ in band' : '✗ out of band'}</span>}
        </div>
      )}
      {s.urgency && <div style={{ color: S.muted }}>Urgency: <span style={{ color: s.urgency === 'aggressive' ? S.negative : s.urgency === 'passive' ? S.positive : S.text }}>{s.urgency}</span></div>}
    </div>
  )
}

function ISMetrics({ s }: { s: AlgoStatusReport }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, color: S.muted }}>
      {s.isCostBps != null && <div>IS Cost: <span style={{ color: S.text }}>{s.isCostBps.toFixed(1)}bps</span> (timing: {s.timingCostBps?.toFixed(1)} + impact: {s.impactCostBps?.toFixed(1)})</div>}
      {s.optimalRate != null && <div>Optimal rate: {(s.optimalRate * 100).toFixed(1)}% · Urgency: {s.currentUrgency}</div>}
      {s.estimatedVolatility != null && <div>Vol: {(s.estimatedVolatility * 100).toFixed(2)}%</div>}
    </div>
  )
}

function POVMetrics({ s }: { s: AlgoStatusReport }) {
  const actual = s.participationRate ?? 0
  const target = s.targetParticipation ?? 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, color: S.muted }}>
      <div>Participation: <span style={{ color: actual >= target * 0.8 ? S.positive : S.negative }}>{(actual * 100).toFixed(1)}%</span> / {(target * 100).toFixed(1)}% target</div>
      {s.windowVolume != null && <div>Window vol: {fmtN(s.windowVolume, 2)}</div>}
      {s.deficit != null && s.deficit > 0 && <div>Deficit: <span style={{ color: S.negative }}>{fmtN(s.deficit, 2)}</span></div>}
    </div>
  )
}

function IcebergMetrics({ s }: { s: AlgoStatusReport }) {
  const score = s.detectionRiskScore ?? 0
  const scoreColor = score > 70 ? S.negative : score > 40 ? S.amber : S.positive
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, color: S.muted }}>
      <div>Slices fired: {s.currentSlice ?? 0} · Visible: {fmtN(s.visibleSize ?? 0, 2)}</div>
      <div>Detection: <span style={{ color: scoreColor, fontWeight: 700 }}>{score}</span>/100
        {s.activeOrderPrice && <span> · {s.activeOrderPrice > 0 ? 'Chasing' : 'Resting'}</span>}
      </div>
    </div>
  )
}

export function StrategyMetrics({ s }: { s: AlgoStatusReport }) {
  return (
    <div style={{ padding: '4px 12px 8px', background: S.panel, margin: '0 8px', borderRadius: 4, border: `1px solid ${S.border}` }}>
      {s.strategyType === 'SNIPER' && <SniperMetrics s={s} />}
      {(s.strategyType === 'TWAP' || s.strategyType === 'VWAP') && <TwapVwapMetrics s={s} />}
      {s.strategyType === 'IS' && <ISMetrics s={s} />}
      {s.strategyType === 'POV' && <POVMetrics s={s} />}
      {s.strategyType === 'ICEBERG' && <IcebergMetrics s={s} />}
    </div>
  )
}
