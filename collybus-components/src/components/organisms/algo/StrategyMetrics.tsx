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
  const isDiscretion = s.levelMode === 'simultaneous' && s.executionMode === 'post_snipe'
  const isPostSnipe = s.executionMode === 'post_snipe'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Level bars */}
      {s.levels?.map((lv, i) => <LevelBar key={i} level={lv} index={i} totalSize={s.totalSize} />)}

      {/* Passive vs Sniped */}
      {isPostSnipe && (
        <div style={{ display: 'flex', gap: 12, fontSize: 9, color: S.muted, marginTop: 2 }}>
          <span>Passive: <span style={{ color: '#00c896' }}>{fmtN(s.passiveFillSize ?? 0, 2)}</span></span>
          <span>Sniped: <span style={{ color: '#FF00FF' }}>{fmtN(s.snipedSize ?? 0, 2)}</span></span>
          {s.snipeCapRemaining != null && <span>Cap left: {fmtN(s.snipeCapRemaining, 2)}</span>}
        </div>
      )}

      {/* Post+Snipe sequential state */}
      {isPostSnipe && !isDiscretion && (
        <div style={{ fontSize: 9, color: S.muted }}>
          Round {s.roundNumber ?? 0} · {s.postSnipePhase ?? 'ACTIVE'} ·
          Resting {fmtN(s.currentPostSize ?? 0, 2)} @ {fmtN(s.targetPrice ?? 0)} ·
          Snipe {fmtN(s.currentSnipeSize ?? 0, 2)} ceiling {fmtN(s.snipeLevel ?? 0)}
        </div>
      )}
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
