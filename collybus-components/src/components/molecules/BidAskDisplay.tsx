import { BuySellButton } from '../atoms/BuySellButton'
import { SpreadBadge } from '../atoms/SpreadBadge'

interface BidAskDisplayProps {
  sellPrice: string
  buyPrice: string
  spread: string
  baseCurrency: string
  qtyEntered: boolean
  submitting: 'buy' | 'sell' | null
  locked?: boolean
  onSell: () => void
  onBuy: () => void
}

export function BidAskDisplay({ sellPrice, buyPrice, spread, baseCurrency, qtyEntered, submitting, locked, onSell, onBuy }: BidAskDisplayProps) {
  const btnDisabled = locked || !qtyEntered || submitting !== null
  return (
    <div style={{ position: 'relative', display: 'flex', gap: 2, width: '100%' }}>
      <BuySellButton side="sell" price={sellPrice} baseCurrency={baseCurrency}
        disabled={btnDisabled} dimmed={submitting === 'buy'}
        onClick={onSell} />
      <SpreadBadge value={spread} />
      <BuySellButton side="buy" price={buyPrice} baseCurrency={baseCurrency}
        disabled={btnDisabled} dimmed={submitting === 'sell'}
        onClick={onBuy} />
    </div>
  )
}
