import { PriceInput } from '../atoms/PriceInput'
import { TifSelector } from '../atoms/TifSelector'
import { tickDecimals } from '../PricePanel/utils'

interface StopOrderFormProps {
  triggerPrice: string
  limitPrice: string
  qty: string
  orderType: 'market' | 'limit'
  tif: string
  reduceOnly: boolean
  tickSize: number
  lotSize: number
  onTriggerChange: (v: string) => void
  onLimitChange: (v: string) => void
  onQtyChange: (v: string) => void
  onOrderTypeChange: (v: 'market' | 'limit') => void
  onTifChange: (v: string) => void
  onReduceOnlyChange: (v: boolean) => void
}

export function StopOrderForm({
  triggerPrice, limitPrice, qty, orderType, tif, reduceOnly,
  tickSize, lotSize,
  onTriggerChange, onLimitChange, onQtyChange,
  onOrderTypeChange, onTifChange, onReduceOnlyChange,
}: StopOrderFormProps) {
  const d = tickDecimals(tickSize)
  const qd = tickDecimals(lotSize)
  const gradSecondary = 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)'
  const gradAction = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PriceInput label="Trigger Price" value={triggerPrice} onChange={onTriggerChange}
        step={tickSize} decimals={d} placeholder="Trigger" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: 9, color: '#636e82', fontWeight: 700,
          letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
          Order Type
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['market', 'limit'] as const).map(t => (
            <button key={t} onClick={() => onOrderTypeChange(t)} style={{
              flex: 1, padding: '5px 0', border: 'none', borderRadius: 4,
              background: orderType === t ? gradAction : gradSecondary,
              color: orderType === t ? '#fff' : 'rgba(255,255,255,0.3)',
              fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              textTransform: 'capitalize' as const,
            }}>{t}</button>
          ))}
        </div>
      </div>
      {orderType === 'limit' && (
        <PriceInput label="Limit Price" value={limitPrice} onChange={onLimitChange}
          step={tickSize} decimals={d} placeholder="Limit Price" />
      )}
      <PriceInput label="Quantity" value={qty} onChange={onQtyChange}
        step={lotSize} decimals={qd} placeholder="Qty" />
      <TifSelector value={tif} onChange={onTifChange} options={['GTC', 'Day', 'IOC']} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11, color: 'rgba(255,255,255,0.6)', cursor: 'pointer' }}>
        <input type="checkbox" checked={reduceOnly} onChange={e => onReduceOnlyChange(e.target.checked)} />
        Reduce Only
      </label>
    </div>
  )
}
