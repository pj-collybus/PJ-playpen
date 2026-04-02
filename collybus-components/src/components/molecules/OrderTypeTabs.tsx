import { OrderTypeButton } from '../atoms/OrderTypeButton'

const ORDER_TYPES = ['LMT', 'S/L', 'ID', 'OCO', 'RFQ', 'ALGO']

interface OrderTypeTabsProps {
  onSelect: (type: string) => void
}

export function OrderTypeTabs({ onSelect }: OrderTypeTabsProps) {
  return (
    <>
      {ORDER_TYPES.map(label => (
        <OrderTypeButton key={label} label={label} onClick={() => onSelect(label)} />
      ))}
    </>
  )
}
