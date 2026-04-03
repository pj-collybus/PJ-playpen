export function StatusPill({ status }: { status: string }) {
  const s = status?.toLowerCase() ?? ''
  const config = s === 'open' ? { bg: 'rgba(43,121,221,0.15)', color: '#2B79DD', border: 'rgba(43,121,221,0.3)' }
    : s === 'filled' ? { bg: 'rgba(0,199,88,0.12)', color: '#00C758', border: 'rgba(0,199,88,0.25)' }
    : s.includes('cancel') ? { bg: 'rgba(99,110,130,0.12)', color: '#636e82', border: 'rgba(99,110,130,0.2)' }
    : s.includes('partial') ? { bg: 'rgba(247,166,0,0.12)', color: '#f7a600', border: 'rgba(247,166,0,0.25)' }
    : { bg: 'rgba(99,110,130,0.12)', color: '#636e82', border: 'rgba(99,110,130,0.2)' }
  return (
    <span style={{
      background: config.bg, color: config.color,
      border: `1px solid ${config.border}`,
      borderRadius: 3, padding: '1px 6px', fontSize: 9, fontWeight: 700,
      whiteSpace: 'nowrap' as const, textTransform: 'uppercase' as const,
    }}>{status}</span>
  )
}
