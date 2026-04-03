interface OrderSideToggleProps {
  side: 'BUY' | 'SELL'
  onChange: (side: 'BUY' | 'SELL') => void
}

export function OrderSideToggle({ side, onChange }: OrderSideToggleProps) {
  return (
    <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #363C4E' }}>
      {(['BUY', 'SELL'] as const).map(s => (
        <button key={s} onClick={() => onChange(s)} style={{
          flex: 1, padding: '6px 0', border: 'none', cursor: 'pointer',
          fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
          background: side === s
            ? s === 'BUY' ? 'rgba(0,199,88,0.2)' : 'rgba(251,44,54,0.2)'
            : 'linear-gradient(to bottom, #3C3B42, #2B2A2F)',
          color: side === s
            ? s === 'BUY' ? '#00C758' : '#FB2C36'
            : 'rgba(255,255,255,0.3)',
          borderRight: s === 'BUY' ? '1px solid #363C4E' : 'none',
        }}>{s}</button>
      ))}
    </div>
  )
}
