interface TifSelectorProps {
  value: string
  onChange: (v: string) => void
  options?: string[]
}

export function TifSelector({ value, onChange, options = ['GTC', 'IOC', 'FOK', 'Day'] }: TifSelectorProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 9, color: '#636e82', fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
        Time in Force
      </label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        background: '#141418', border: '1px solid #363C4E', borderRadius: 4,
        color: 'rgba(255,255,255,0.85)', fontSize: 11, padding: '5px 8px',
        outline: 'none', fontFamily: 'inherit', cursor: 'pointer',
      }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}
