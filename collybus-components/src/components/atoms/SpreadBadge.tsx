interface SpreadBadgeProps { value: string }

export function SpreadBadge({ value }: SpreadBadgeProps) {
  return (
    <div style={{
      position: 'absolute', left: '50%', bottom: -8,
      transform: 'translateX(-50%)',
      background: '#1D2432', border: '1px solid #363C4E',
      borderRadius: 8, padding: '1px 5px',
      fontSize: 8, color: '#CFD1D4', whiteSpace: 'nowrap' as const,
      zIndex: 2, fontWeight: 500,
    }}>{value}</div>
  )
}
