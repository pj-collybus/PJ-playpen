import { useState, useEffect } from 'react'

interface QuantityInputProps {
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
}

function formatDisplay(val: string): string {
  const n = parseFloat(val)
  if (!val || isNaN(n)) return val
  return n.toLocaleString('en-US', { maximumFractionDigits: 8, useGrouping: true })
}

function parseShorthand(val: string): string {
  const v = val.trim().toLowerCase()
  const num = parseFloat(v)
  if (isNaN(num)) return val
  if (v.endsWith('b')) return String(num * 1_000_000_000)
  if (v.endsWith('m')) return String(num * 1_000_000)
  if (v.endsWith('k')) return String(num * 1_000)
  return val
}

export function QuantityInput({ value, onChange, onBlur: onBlurProp }: QuantityInputProps) {
  const [display, setDisplay] = useState(formatDisplay(value))

  useEffect(() => {
    setDisplay(formatDisplay(value))
  }, [value])

  const handleCommit = (raw: string) => {
    const parsed = parseShorthand(raw)
    const n = parseFloat(parsed)
    onChange(parsed)
    setDisplay(isNaN(n) ? raw : formatDisplay(parsed))
  }

  return (
    <input
      type="text"
      value={display}
      onChange={e => setDisplay(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { handleCommit(display); e.currentTarget.blur() }
      }}
      onBlur={e => {
        handleCommit(display)
        e.target.style.borderBottomColor = '#363C4E'
        onBlurProp?.()
      }}
      onFocus={e => {
        setDisplay(value)
        e.target.style.borderBottomColor = '#4598EF'
      }}
      placeholder="Qty…"
      style={{
        background: 'transparent', border: 'none',
        borderBottom: '1px solid #363C4E', borderRadius: 0,
        color: '#fff', fontSize: 12, padding: '4px',
        outline: 'none', fontFamily: 'inherit', textAlign: 'center' as const,
        width: '100%',
      }}
    />
  )
}
