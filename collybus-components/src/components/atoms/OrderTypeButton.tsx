const gradSecondary = 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)'
const gradAction = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'

interface OrderTypeButtonProps {
  label: string
  onClick: () => void
}

export function OrderTypeButton({ label, onClick }: OrderTypeButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 28, padding: '4px 0', fontSize: 9,
        background: gradSecondary, border: 'none', borderRadius: 4,
        color: 'rgba(255,255,255,0.3)',
        cursor: 'pointer', textAlign: 'center' as const, lineHeight: 1.2,
        fontFamily: 'inherit', transition: 'color 0.1s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = gradAction; e.currentTarget.style.color = 'white' }}
      onMouseLeave={e => { e.currentTarget.style.background = gradSecondary; e.currentTarget.style.color = 'rgba(255,255,255,0.3)' }}
    >{label}</button>
  )
}
