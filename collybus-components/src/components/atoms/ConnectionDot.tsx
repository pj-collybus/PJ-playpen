interface ConnectionDotProps { live: boolean }

export function ConnectionDot({ live }: ConnectionDotProps) {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%',
      background: live ? '#00C758' : '#252530',
      boxShadow: live ? '0 0 5px rgba(0,199,88,0.55)' : 'none',
      flexShrink: 0, display: 'inline-block',
    }} />
  )
}
