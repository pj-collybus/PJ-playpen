const gradAction = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'
const gradActionHover = 'linear-gradient(to right, #2656b7 0%, #3A8FE4 100%)'
const shadowAction = 'inset 0px 3px 1px rgba(255,255,255,0.25), inset 0px -3px 1px rgba(0,0,0,0.25), inset 0px 4px 4px rgba(0,0,0,0.25)'

interface BuySellButtonProps {
  side: 'buy' | 'sell'
  price: string
  baseCurrency: string
  disabled?: boolean
  dimmed?: boolean
  onClick: () => void
}

export function BuySellButton({ side, price, baseCurrency, disabled, dimmed, onClick }: BuySellButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, borderRadius: 4, height: 56, minHeight: 56, maxHeight: 56,
        padding: '6px 4px', cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 2,
        background: gradAction, border: 'none', boxShadow: shadowAction,
        opacity: dimmed ? 0.6 : 1,
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = gradActionHover }}
      onMouseLeave={e => { e.currentTarget.style.background = gradAction }}
    >
      <span style={{ fontSize: 15, fontWeight: 400, lineHeight: 1, color: '#fff' }}>{price}</span>
      <span style={{ fontSize: 9, fontWeight: 400, lineHeight: 1, color: '#CFD1D4' }}>
        {side === 'sell' ? 'Sell' : 'Buy'} {baseCurrency}
      </span>
    </button>
  )
}
