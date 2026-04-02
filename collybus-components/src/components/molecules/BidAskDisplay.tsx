import { BuySellButton } from '../atoms/BuySellButton'
import { SpreadBadge } from '../atoms/SpreadBadge'

interface BidAskDisplayProps {
  sellPrice: string
  buyPrice: string
  spread: string
  baseCurrency: string
  qtyEntered: boolean
  submitting: 'buy' | 'sell' | null
  onSell: () => void
  onBuy: () => void
}

export function BidAskDisplay({ sellPrice, buyPrice, spread, baseCurrency, qtyEntered, submitting, onSell, onBuy }: BidAskDisplayProps) {
  return (
    <div style={{ position: 'relative', display: 'flex', gap: 2, width: '100%' }}>
      <BuySellButton side="sell" price={sellPrice} baseCurrency={baseCurrency}
        disabled={!qtyEntered || submitting !== null} dimmed={submitting === 'buy'}
        onClick={onSell} />
      <SpreadBadge value={spread} />
      <BuySellButton side="buy" price={buyPrice} baseCurrency={baseCurrency}
        disabled={!qtyEntered || submitting !== null} dimmed={submitting === 'sell'}
        onClick={onBuy} />
    </div>
  )
}
