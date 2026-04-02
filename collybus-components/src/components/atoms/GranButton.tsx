const gradAction = 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)'
const gradSecondary = 'linear-gradient(to bottom, #3C3B42 0%, #323138 50%, #2B2A2F 100%)'

interface GranButtonProps {
  label: string
  active: boolean
  onClick: () => void
}

export function GranButton({ label, active, onClick }: GranButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 28, padding: '4px 0', fontSize: 9,
        background: active ? gradAction : gradSecondary,
        border: 'none', borderRadius: 4,
        color: active ? '#fff' : 'rgba(255,255,255,0.3)',
        cursor: 'pointer', textAlign: 'center' as const, lineHeight: 1.2,
      }}
    >{label}</button>
  )
}
