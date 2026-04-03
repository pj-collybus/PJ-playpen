import { QuantityInput } from '../atoms/QuantityInput'

const gradAction = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'
const gradSecondary = 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)'
const shadowAction = 'inset 0px 3px 1px rgba(255,255,255,0.25), inset 0px -3px 1px rgba(0,0,0,0.25), inset 0px 4px 4px rgba(0,0,0,0.25)'
const shadowQty = 'inset 0px 1px 1px rgba(255,255,255,0.25), inset 0px -1px 1px rgba(0,0,0,0.25)'

interface OrderSizeSelectorProps {
  qty: string
  presetQtys: number[]
  onChange: (v: string) => void
  baseCurrency?: string
  onBlur?: () => void
}

export function OrderSizeSelector({ qty, presetQtys, onChange, baseCurrency, onBlur }: OrderSizeSelectorProps) {
  const qtyNum = parseFloat(qty)
  return (
    <div style={{ marginTop: 'auto', paddingBottom: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <QuantityInput value={qty} onChange={onChange} onBlur={onBlur} />
        {baseCurrency && (
          <span style={{ fontSize: 10, color: '#636e82', fontWeight: 600, flexShrink: 0, minWidth: 30 }}>{baseCurrency}</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 3, justifyContent: 'center' }}>
        {presetQtys.map(q => {
          const active = qtyNum === q
          const label = q >= 1_000_000_000 ? `${q / 1_000_000_000}b`
            : q >= 1_000_000 ? `${q / 1_000_000}m`
            : q >= 1_000 ? `${q / 1_000}k`
            : String(q)
          return (
            <button key={q} onClick={() => onChange(String(q))} style={{
              background: active ? gradAction : gradSecondary,
              boxShadow: active ? shadowAction : shadowQty,
              border: 'none', color: active ? '#fff' : 'rgba(255,255,255,0.5)',
              fontSize: 9, fontWeight: 700, borderRadius: 4,
              width: 32, height: 24, padding: 0,
              cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{label}</button>
          )
        })}
      </div>
    </div>
  )
}
