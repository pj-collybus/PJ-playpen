interface ExchangeBadgeProps { exchange: string }

export function ExchangeBadge({ exchange }: ExchangeBadgeProps) {
  return (
    <span style={{
      background: '#1D2432', color: '#CFD1D4', fontSize: 9,
      borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' as const,
      flexShrink: 0, marginLeft: 8,
    }}>{exchange}</span>
  )
}
