// @ts-nocheck
import { useRef, useEffect } from 'react'
import type { AlgoStatusReport } from './types'
import { S, LEVEL_COLORS } from './types'

const FILL_COLORS: Record<string, string> = {
  'snipe-L1': '#00BFFF', 'snipe-L2': '#FFD700', 'snipe-L3': '#FF00FF',
  'snipe': '#FF00FF', 'passive': '#00c896', 'post': '#00c896',
  'accelerate': '#F59E0B', 'sweep': '#FB2C36',
}

export function ExecutionChart({ status, width = 400, height = 200 }: {
  status: AlgoStatusReport; width?: number; height?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = width; canvas.height = height
    ctx.clearRect(0, 0, width, height)

    const times = status.chartTimes ?? []
    const bids = status.chartBids ?? []
    const asks = status.chartAsks ?? []
    const orders = status.chartOrder ?? []
    const fills = status.chartFills ?? []
    const vwaps = status.chartVwap ?? []
    if (times.length < 2) return

    const minT = times[0], maxT = times[times.length - 1]
    const tRange = maxT - minT || 1

    // Collect all prices for Y range
    const allPrices = [...bids, ...asks, ...orders.filter(v => v != null) as number[],
      ...fills.map(f => f.price), ...(vwaps.length ? vwaps : [])]
      .filter(v => v > 0)
    if (allPrices.length === 0) return

    const minP = Math.min(...allPrices)
    const maxP = Math.max(...allPrices)
    const padding = (maxP - minP) * 0.1 || maxP * 0.001
    const pMin = minP - padding, pMax = maxP + padding
    const pRange = pMax - pMin || 1

    const PAD = { t: 8, b: 16, l: 50, r: 8 }
    const cW = width - PAD.l - PAD.r
    const cH = height - PAD.t - PAD.b
    const xOf = (ts: number) => PAD.l + ((ts - minT) / tRange) * cW
    const yOf = (p: number) => PAD.t + (1 - (p - pMin) / pRange) * cH

    // Background grid
    ctx.strokeStyle = '#1e1e2a'; ctx.lineWidth = 0.5
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i / 4) * cH
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke()
      const price = pMax - (i / 4) * pRange
      ctx.font = '8px monospace'; ctx.fillStyle = S.muted; ctx.textAlign = 'right'
      ctx.fillText(price.toFixed(4), PAD.l - 4, y + 3)
    }

    // Bid line (green, thin)
    if (bids.length > 1) {
      ctx.beginPath(); ctx.strokeStyle = 'rgba(0,199,88,0.5)'; ctx.lineWidth = 1
      bids.forEach((b, i) => { if (b > 0) { const x = xOf(times[i]); i === 0 ? ctx.moveTo(x, yOf(b)) : ctx.lineTo(x, yOf(b)) } })
      ctx.stroke()
    }

    // Ask line (red, thin)
    if (asks.length > 1) {
      ctx.beginPath(); ctx.strokeStyle = 'rgba(251,44,54,0.5)'; ctx.lineWidth = 1
      asks.forEach((a, i) => { if (a > 0) { const x = xOf(times[i]); i === 0 ? ctx.moveTo(x, yOf(a)) : ctx.lineTo(x, yOf(a)) } })
      ctx.stroke()
    }

    // Order/resting price line (dashed white)
    const orderPts = orders.map((o, i) => o != null && o > 0 ? { x: xOf(times[i]), y: yOf(o) } : null).filter(Boolean)
    if (orderPts.length > 1) {
      ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      orderPts.forEach((p, i) => i === 0 ? ctx.moveTo(p!.x, p!.y) : ctx.lineTo(p!.x, p!.y))
      ctx.stroke(); ctx.setLineDash([])
    }

    // VWAP line (purple dashed)
    if (vwaps.length > 1) {
      ctx.beginPath(); ctx.strokeStyle = 'rgba(123,97,255,0.7)'; ctx.lineWidth = 1.5
      ctx.setLineDash([6, 3])
      vwaps.forEach((v, i) => { if (v > 0) { const x = xOf(times[i]); i === 0 ? ctx.moveTo(x, yOf(v)) : ctx.lineTo(x, yOf(v)) } })
      ctx.stroke(); ctx.setLineDash([])
    }

    // Target price line (amber dashed)
    if (status.chartTargetPrice && status.chartTargetPrice > 0) {
      const y = yOf(status.chartTargetPrice)
      ctx.beginPath(); ctx.strokeStyle = 'rgba(245,158,11,0.6)'; ctx.lineWidth = 1
      ctx.setLineDash([4, 4]); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke(); ctx.setLineDash([])
      ctx.font = '8px monospace'; ctx.fillStyle = S.amber; ctx.textAlign = 'left'
      ctx.fillText('LMT', PAD.l + 2, y - 3)
    }

    // Snipe ceiling line (purple dashed)
    if (status.chartSnipeLevel && status.chartSnipeLevel > 0) {
      const y = yOf(status.chartSnipeLevel)
      ctx.beginPath(); ctx.strokeStyle = 'rgba(123,97,255,0.6)'; ctx.lineWidth = 1
      ctx.setLineDash([3, 3]); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke(); ctx.setLineDash([])
    }

    // Level price lines
    status.chartLevelPrices?.forEach((lv, i) => {
      if (!lv.price || lv.price <= 0) return
      const y = yOf(lv.price); const color = LEVEL_COLORS[i % LEVEL_COLORS.length]
      ctx.beginPath(); ctx.strokeStyle = color + '88'; ctx.lineWidth = 1
      ctx.setLineDash([2, 3]); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + cW, y); ctx.stroke(); ctx.setLineDash([])
      ctx.font = '8px monospace'; ctx.fillStyle = color; ctx.textAlign = 'left'
      ctx.fillText(`L${i + 1}`, PAD.l + 2, y - 3)
    })

    // Fill triangles
    const isDone = ['Completed', 'Stopped', 'Error'].includes(status.status)
    fills.forEach((f, fi) => {
      const x = xOf(f.time), y = yOf(f.price)
      const color = FILL_COLORS[f.fillType ?? ''] ?? (status.side === 'BUY' ? S.positive : S.negative)
      const isLast = fi === fills.length - 1 && isDone
      const sz = 5

      if (isLast) {
        // Square marker for last fill on completion
        ctx.fillStyle = color
        ctx.fillRect(x - sz, y - sz, sz * 2, sz * 2)
      } else {
        // Triangle: BUY=up, SELL=down
        ctx.beginPath()
        if (status.side === 'BUY') {
          ctx.moveTo(x, y - sz); ctx.lineTo(x + sz * 0.7, y + sz * 0.5); ctx.lineTo(x - sz * 0.7, y + sz * 0.5)
        } else {
          ctx.moveTo(x, y + sz); ctx.lineTo(x + sz * 0.7, y - sz * 0.5); ctx.lineTo(x - sz * 0.7, y - sz * 0.5)
        }
        ctx.closePath(); ctx.fillStyle = color; ctx.fill()
      }
    })

    // Time axis
    ctx.font = '8px monospace'; ctx.fillStyle = S.muted; ctx.textAlign = 'center'
    ;[0, 0.25, 0.5, 0.75, 1].forEach(t => {
      const ts = minT + t * tRange
      const d = new Date(ts)
      ctx.fillText(`${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`, PAD.l + t * cW, height - 2)
    })

  }, [status, width, height])

  return <canvas ref={canvasRef} style={{ width, height, display: 'block', background: S.bgInput, borderRadius: 4 }} />
}
