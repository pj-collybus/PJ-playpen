import { useEffect, useRef, useState } from 'react'
import type { OrderBookLevel } from '../PricePanel/types'

interface DepthChartProps {
  levels: OrderBookLevel[]
  side: 'bid' | 'ask'
  tickSize: number
  granularity: number
  highlightQty: number
  sizeUnit?: 'base' | 'quote' | 'contracts'
  lotSize?: number
  midPrice?: number
  globalCumMax?: number
  onVisibleTotalChange?: (total: number) => void
  onPriceClick?: (price: number) => void
}

export function DepthChart({ levels, side, tickSize, granularity, highlightQty, sizeUnit, lotSize, midPrice, globalCumMax, onVisibleTotalChange, onPriceClick }: DepthChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const metaRef = useRef<{ pMin: number; pMax: number; PL: number; PR: number; cW: number } | null>(null)
  const [redrawTick, setRedrawTick] = useState(0)

  // Force initial draw after mount (layout may not be ready immediately)
  useEffect(() => {
    const timer = setTimeout(() => setRedrawTick(t => t + 1), 150)
    return () => clearTimeout(timer)
  }, [])

  // ResizeObserver
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 4 && height > 4) setRedrawTick(t => t + 1)
      }
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w < 4 || h < 4) return
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    if (!levels || levels.length === 0) return

    const isBid = side === 'bid'
    const PB = 18, PT = 4
    const PL = isBid ? 32 : 4
    const PR = isBid ? 4 : 32
    const cW = w - PL - PR
    const cH = h - PB - PT
    if (cW < 4 || cH < 4) return

    const normalizeSize = (rawSize: number): number => {
      switch (sizeUnit) {
        case 'quote': return midPrice && midPrice > 0 ? rawSize / midPrice : rawSize
        case 'contracts': return lotSize && lotSize > 0 ? rawSize * lotSize : rawSize
        default: return rawSize
      }
    }

    // ── Bucket aggregation ──
    const bucketSize = tickSize * granularity
    const bestPrice = isBid
      ? Math.max(...levels.map(l => l.price))
      : Math.min(...levels.map(l => l.price))
    if (!isFinite(bestPrice)) return

    const bestBucket = isBid
      ? Math.floor(bestPrice / bucketSize) * bucketSize
      : Math.ceil(bestPrice / bucketSize) * bucketSize

    const BAR_W = 42
    const maxBars = Math.max(1, Math.floor(cW / BAR_W))

    const buckets: { price: number; size: number }[] = []
    for (let i = 0; i < maxBars; i++) {
      const bucketPrice = isBid
        ? bestBucket - i * bucketSize
        : bestBucket + i * bucketSize
      const bucketMax = bucketPrice + bucketSize
      const size = levels
        .filter(l => l.price >= bucketPrice && l.price < bucketMax)
        .reduce((sum, l) => sum + normalizeSize(l.size), 0)
      buckets.push({ price: bucketPrice, size })
    }
    if (buckets.every(b => b.size === 0)) return

    let run = 0
    const cumBuckets = buckets.map(b => { run += b.size; return { ...b, cumulative: run } })
    const lastNonEmptyIdx = cumBuckets.reduce((last, b, i) => b.size > 0 ? i : last, 0)
    const totalCum = cumBuckets[lastNonEmptyIdx]?.cumulative ?? 0
    const cMax = (globalCumMax && globalCumMax > 0) ? globalCumMax : totalCum
    if (cMax === 0) return

    const barX = (i: number): number => isBid
      ? PL + cW - (i + 1) * BAR_W
      : PL + i * BAR_W
    const yC = (c: number) => PT + (1 - c / cMax) * cH

    const color = isBid ? '#00C758' : '#FB2C36'
    const fillHi = isBid ? 'rgba(0,199,88,0.35)' : 'rgba(251,44,54,0.35)'
    const fillMid = isBid ? 'rgba(0,199,88,0.15)' : 'rgba(251,44,54,0.15)'
    const fillLo = isBid ? 'rgba(0,199,88,0.02)' : 'rgba(251,44,54,0.02)'
    const barColorTop = 'rgba(115,120,140,0.80)'
    const barColorBot = 'rgba(90,95,115,0.65)'
    const visibleTotal = cumBuckets.reduce((s, b) => s + b.size, 0)
    onVisibleTotalChange?.(visibleTotal)

    // ── Build cumulative curve points (shared by fill + line) ──
    // Points plateau through empty buckets and extend to the full chart edge
    const cumPoints: { x: number; y: number }[] = []
    let lastCum = 0
    if (isBid) {
      cumPoints.push({ x: PL + cW, y: PT + cH })
      for (let i = 0; i < cumBuckets.length; i++) {
        if (cumBuckets[i].cumulative > 0) lastCum = cumBuckets[i].cumulative
        cumPoints.push({ x: barX(i) + BAR_W / 2, y: yC(lastCum) })
      }
      // Extend to left edge of chart
      const edgeX = PL
      if (cumPoints[cumPoints.length - 1].x > edgeX)
        cumPoints.push({ x: edgeX, y: yC(lastCum) })
    } else {
      cumPoints.push({ x: PL, y: PT + cH })
      for (let i = 0; i < cumBuckets.length; i++) {
        if (cumBuckets[i].cumulative > 0) lastCum = cumBuckets[i].cumulative
        cumPoints.push({ x: barX(i) + BAR_W / 2, y: yC(lastCum) })
      }
      // Extend to right edge of chart
      const edgeX = PL + cW
      if (cumPoints[cumPoints.length - 1].x < edgeX)
        cumPoints.push({ x: edgeX, y: yC(lastCum) })
    }

    // ── 1. Cumulative fill (smooth bezier, deepest layer) ──
    if (cumPoints.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(cumPoints[0].x, cumPoints[0].y)
      for (let i = 0; i < cumPoints.length - 1; i++) {
        const p0 = cumPoints[i], p1 = cumPoints[i + 1]
        const cpx = (p0.x + p1.x) / 2
        ctx.bezierCurveTo(cpx, p0.y, cpx, p1.y, p1.x, p1.y)
      }
      const last = cumPoints[cumPoints.length - 1]
      ctx.lineTo(last.x, PT + cH)
      ctx.lineTo(cumPoints[0].x, PT + cH)
      ctx.closePath()
      const g = ctx.createLinearGradient(0, PT, 0, PT + cH)
      g.addColorStop(0, fillHi); g.addColorStop(0.4, fillMid); g.addColorStop(1, fillLo)
      ctx.fillStyle = g; ctx.fill()
    }

    // ── 2. Histogram bars (same Y-axis as cumulative) ──
    for (let i = 0; i < cumBuckets.length; i++) {
      const { size } = cumBuckets[i]
      if (size === 0) continue
      const bx = barX(i)
      const barTop = yC(size)
      const barH = PT + cH - barTop
      const barGrad = ctx.createLinearGradient(0, barTop, 0, PT + cH)
      barGrad.addColorStop(0, barColorTop); barGrad.addColorStop(1, barColorBot)
      ctx.fillStyle = barGrad
      ctx.fillRect(bx, barTop, BAR_W - 1, barH)
      if (size > 0) {
        const label = size >= 1_000_000 ? `${(size / 1_000_000).toFixed(1)}M`
                    : size >= 1_000 ? `${(size / 1_000).toFixed(1)}k`
                    : size.toFixed(1)
        ctx.font = 'bold 8px -apple-system, monospace'
        ctx.fillStyle = 'rgba(220,222,235,0.95)'
        ctx.textAlign = 'center'
        const labelX = bx + (BAR_W - 1) / 2
        if (barH >= 18) ctx.fillText(label, labelX, barTop + Math.min(barH * 0.45, 12))
        else ctx.fillText(label, labelX, barTop - 3)
      }
    }

    // ── 3. Cumulative smooth line (on top) ──
    if (cumPoints.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(cumPoints[0].x, cumPoints[0].y)
      for (let i = 0; i < cumPoints.length - 1; i++) {
        const p0 = cumPoints[i], p1 = cumPoints[i + 1]
        const cpx = (p0.x + p1.x) / 2
        ctx.bezierCurveTo(cpx, p0.y, cpx, p1.y, p1.x, p1.y)
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke()
    }

    // ── 4. Total label ──
    const totalLabel = visibleTotal >= 1_000_000 ? `${(visibleTotal / 1_000_000).toFixed(1)}M`
                     : visibleTotal >= 1_000 ? `${(visibleTotal / 1_000).toFixed(1)}k`
                     : visibleTotal.toFixed(0)
    ctx.font = 'bold 10px -apple-system, monospace'
    ctx.fillStyle = color
    if (isBid) { ctx.textAlign = 'right'; ctx.fillText(totalLabel, PL - 2, PT + 10) }
    else { ctx.textAlign = 'left'; ctx.fillText(totalLabel, w - PR + 2, PT + 10) }

    // ── 5. Price labels ──
    const d = tickSize < 1 ? Math.max(0, -Math.floor(Math.log10(tickSize))) : 0
    ctx.font = '9px -apple-system, monospace'
    ctx.fillStyle = 'rgba(140,145,170,0.95)'
    ctx.textAlign = 'center'
    for (let i = 0; i < cumBuckets.length; i++) {
      const cx = barX(i) + (BAR_W - 1) / 2
      if (cx < PL + 2 || cx > PL + cW - 2) continue
      ctx.fillStyle = 'rgba(140,145,170,0.95)'
      ctx.fillText(cumBuckets[i].price.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }), cx, h - 4)
      ctx.strokeStyle = 'rgba(80,85,110,0.9)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(cx, PT + cH); ctx.lineTo(cx, PT + cH + 3); ctx.stroke()
    }

    // ── 6. Y-axis labels ──
    ctx.fillStyle = 'rgba(140,145,170,0.95)'
    ctx.font = '9px -apple-system, monospace'
    ctx.textAlign = isBid ? 'right' : 'left'
    ;[0.25, 0.5, 0.75, 1].forEach(t => {
      const val = cMax * t
      const y = yC(val)
      if (y > PT + 4 && y < PT + cH - 4) {
        const label = val >= 1_000_000 ? `${(val / 1_000_000).toFixed(1)}M`
                    : val >= 1_000 ? `${(val / 1_000).toFixed(1)}k`
                    : val.toFixed(0)
        ctx.fillText(label, isBid ? PL - 3 : w - PR + 3, y + 3)
      }
    })

    metaRef.current = {
      pMin: isBid ? bestBucket - (maxBars - 1) * bucketSize : bestBucket,
      pMax: isBid ? bestBucket + bucketSize : bestBucket + maxBars * bucketSize,
      PL, PR, cW,
    }
  }, [levels, side, tickSize, granularity, highlightQty, sizeUnit, lotSize, midPrice, globalCumMax, redrawTick])

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onPriceClick || !metaRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const { pMin, pMax, PL, cW } = metaRef.current
    const price = pMin + ((clickX - PL) / cW) * (pMax - pMin)
    if (price >= pMin && price <= pMax) onPriceClick(price)
  }

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      style={{ display: 'block', width: '100%', height: '100%', cursor: 'crosshair' }}
    />
  )
}
