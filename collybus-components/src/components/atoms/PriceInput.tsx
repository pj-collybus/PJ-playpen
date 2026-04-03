interface PriceInputProps {
  label: string
  value: string
  onChange: (v: string) => void
  step: number
  decimals: number
  placeholder?: string
}

const S = {
  border: '#363C4E',
  bg: '#141418',
  text: 'rgba(255,255,255,0.85)',
  muted: '#636e82',
  blue: '#2B79DD',
  gradSecondary: 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)',
}

export function PriceInput({ label, value, onChange, step, decimals, placeholder }: PriceInputProps) {
  const round = (n: number) => parseFloat(n.toFixed(decimals))

  const increment = () => {
    const current = parseFloat(value) || 0
    onChange(round(current + step).toString())
  }
  const decrement = () => {
    const current = parseFloat(value) || 0
    onChange(round(Math.max(0, current - step)).toString())
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 9, color: S.muted, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
        {label}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <button onClick={decrement} style={{
          width: 28, height: 28, background: S.gradSecondary, border: 'none',
          color: 'rgba(255,255,255,0.6)', fontSize: 16, cursor: 'pointer',
          borderRadius: '4px 0 0 4px', fontFamily: 'inherit', lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
          onMouseEnter={e => e.currentTarget.style.color = '#fff'}
          onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.6)'}
        >−</button>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={e => {
            const n = parseFloat(e.target.value)
            if (!isNaN(n)) onChange(round(n).toString())
            e.target.style.borderColor = S.border
          }}
          onFocus={e => e.target.style.borderColor = S.blue}
          placeholder={placeholder ?? '0'}
          style={{
            flex: 1, height: 28, background: S.bg, border: `1px solid ${S.border}`,
            borderLeft: 'none', borderRight: 'none',
            color: S.text, fontSize: 12, padding: '0 6px',
            outline: 'none', fontFamily: 'inherit', textAlign: 'center' as const,
          }}
        />
        <button onClick={increment} style={{
          width: 28, height: 28, background: S.gradSecondary, border: 'none',
          color: 'rgba(255,255,255,0.6)', fontSize: 16, cursor: 'pointer',
          borderRadius: '0 4px 4px 0', fontFamily: 'inherit', lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
          onMouseEnter={e => e.currentTarget.style.color = '#fff'}
          onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.6)'}
        >+</button>
      </div>
    </div>
  )
}
