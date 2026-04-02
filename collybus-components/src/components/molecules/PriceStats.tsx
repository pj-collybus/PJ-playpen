interface PriceStatsProps {
  high24h: number
  low24h: number
  change24h: number
  fundingRate?: number
  isPerp: boolean
  formatPrice: (p: number, tick: number) => string
  tickSize: number
}

export function PriceStats({ high24h, low24h, change24h, fundingRate, isPerp, formatPrice, tickSize }: PriceStatsProps) {
  const pos = 'rgba(34,197,94,0.8)'
  const neg = 'rgba(251,44,54,0.8)'
  const label = 'rgba(99,110,130,0.9)'
  const val = 'rgba(255,255,255,0.8)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' as const }}>
      <span style={{ fontSize: 9, color: label, whiteSpace: 'nowrap' as const }}>
        H <span style={{ color: val }}>{formatPrice(high24h, tickSize)}</span>
        {' / '}
        <span style={{ color: val }}>{formatPrice(low24h, tickSize)}</span>
      </span>
      <span style={{ fontSize: 9, fontWeight: 600, color: change24h >= 0 ? pos : neg }}>
        {change24h >= 0 ? '+' : ''}{change24h.toFixed(2)}%
      </span>
      {isPerp && fundingRate !== undefined && (
        <span style={{ fontSize: 9, fontWeight: 500, color: fundingRate > 0 ? pos : fundingRate < 0 ? neg : label }}>
          {(fundingRate * 100).toFixed(4)}%
        </span>
      )}
    </div>
  )
}
