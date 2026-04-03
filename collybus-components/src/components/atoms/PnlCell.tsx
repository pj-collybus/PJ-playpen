export function PnlCell({ value, decimals = 4 }: { value: number; decimals?: number }) {
  const color = value > 0 ? '#00C758' : value < 0 ? '#FB2C36' : '#636e82'
  const prefix = value > 0 ? '+' : ''
  return (
    <span style={{ color, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
      {prefix}{value.toFixed(decimals)}
    </span>
  )
}
