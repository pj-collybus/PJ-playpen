import { PriceInput } from '../atoms/PriceInput'
import { TifSelector } from '../atoms/TifSelector'
import { tickDecimals } from '../PricePanel/utils'

interface LimitOrderFormProps {
  price: string
  qty: string
  tif: string
  tickSize: number
  lotSize: number
  postOnly: boolean
  reduceOnly: boolean
  onPriceChange: (v: string) => void
  onQtyChange: (v: string) => void
  onTifChange: (v: string) => void
  onPostOnlyChange: (v: boolean) => void
  onReduceOnlyChange: (v: boolean) => void
}

const checkStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 11, color: 'rgba(255,255,255,0.6)',
  cursor: 'pointer', userSelect: 'none',
}

export function LimitOrderForm({
  price, qty, tif, tickSize, lotSize,
  postOnly, reduceOnly,
  onPriceChange, onQtyChange, onTifChange, onPostOnlyChange, onReduceOnlyChange,
}: LimitOrderFormProps) {
  const d = tickDecimals(tickSize)
  const qd = tickDecimals(lotSize)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PriceInput label="Limit Price" value={price} onChange={onPriceChange}
        step={tickSize} decimals={d} placeholder="Price" />
      <PriceInput label="Quantity" value={qty} onChange={onQtyChange}
        step={lotSize} decimals={qd} placeholder="Qty" />
      <TifSelector value={tif} onChange={onTifChange} />
      <div style={{ display: 'flex', gap: 16 }}>
        <label style={checkStyle}>
          <input type="checkbox" checked={postOnly} onChange={e => onPostOnlyChange(e.target.checked)} />
          Post Only
        </label>
        <label style={checkStyle}>
          <input type="checkbox" checked={reduceOnly} onChange={e => onReduceOnlyChange(e.target.checked)} />
          Reduce Only
        </label>
      </div>
    </div>
  )
}
