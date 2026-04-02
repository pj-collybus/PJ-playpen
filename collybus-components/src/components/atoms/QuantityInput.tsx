interface QuantityInputProps {
  value: string
  onChange: (v: string) => void
}

export function QuantityInput({ value, onChange }: QuantityInputProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="Qty…"
      style={{
        background: 'transparent', border: 'none',
        borderBottom: '1px solid #363C4E', borderRadius: 0,
        color: '#fff', fontSize: 12, padding: '4px',
        outline: 'none', fontFamily: 'inherit', textAlign: 'center' as const,
        width: '100%',
      }}
      onFocus={e => e.target.style.borderBottomColor = '#4598EF'}
      onBlur={e => e.target.style.borderBottomColor = '#363C4E'}
    />
  )
}
