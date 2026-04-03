import { OrderTypeButton } from '../atoms/OrderTypeButton'

const ORDER_TYPES = [
  { label: 'LMT', modalTab: 'LMT' },
  { label: 'S/L', modalTab: 'S/L' },
  { label: 'I/D', modalTab: 'ID' },
  { label: 'OCO', modalTab: 'OCO' },
  { label: 'RFQ', modalTab: null },
  { label: 'ALGO', modalTab: null },
]

interface OrderTypeTabsProps {
  onSelect: (label: string, modalTab: string | null) => void
}

export function OrderTypeTabs({ onSelect }: OrderTypeTabsProps) {
  return (
    <>
      {ORDER_TYPES.map(({ label, modalTab }) => (
        <OrderTypeButton key={label} label={label} onClick={() => onSelect(label, modalTab)} />
      ))}
    </>
  )
}
