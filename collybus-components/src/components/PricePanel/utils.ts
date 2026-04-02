import type { OrderBookLevel } from './types'

export function formatPrice(price: number, tickSize: number): string {
  if (!price) return '—'
  const decimals = tickSize < 1
    ? Math.max(0, -Math.floor(Math.log10(tickSize)))
    : 0
  return price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export function formatSize(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}M`
  if (size >= 1_000) return `${(size / 1_000).toFixed(1)}k`
  return size.toFixed(0)
}

export function formatChange(change: number): string {
  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
}

export function formatFunding(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`
}

export function aggregateLevels(
  levels: OrderBookLevel[],
  tickSize: number,
  granularity: number
): OrderBookLevel[] {
  if (granularity <= 1) return levels
  const bucketSize = tickSize * granularity
  const buckets = new Map<number, number>()
  for (const level of levels) {
    const bucket = Math.floor(level.price / bucketSize) * bucketSize
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + level.size)
  }
  return Array.from(buckets.entries())
    .map(([price, size]) => ({ price, size }))
}

export function tickDecimals(tickSize: number): number {
  if (tickSize >= 1) return 0
  return Math.max(0, -Math.floor(Math.log10(tickSize)))
}

export function calculateVwap(
  levels: OrderBookLevel[],
  quantity: number
): number {
  if (!quantity || levels.length === 0) return 0
  let remaining = quantity
  let totalCost = 0
  for (const level of levels) {
    if (remaining <= 0) break
    const filled = Math.min(remaining, level.size)
    totalCost += filled * level.price
    remaining -= filled
  }
  const filled = quantity - remaining
  return filled > 0 ? totalCost / filled : 0
}
