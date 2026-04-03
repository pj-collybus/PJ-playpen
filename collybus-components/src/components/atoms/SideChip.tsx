export function SideChip({ side }: { side: string }) {
  const s = side?.toUpperCase() ?? ''
  const isBuy = s === 'BUY' || s === 'LONG'
  const isSell = s === 'SELL' || s === 'SHORT'
  const color = isBuy ? '#00C758' : isSell ? '#FB2C36' : '#636e82'
  return <span style={{ color, fontWeight: 700, fontSize: 11 }}>{s}</span>
}
