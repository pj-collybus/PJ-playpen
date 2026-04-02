import { useRef, useState } from 'react'

interface ExchangeSelectorProps {
  exchange: string
  availableExchanges: string[]
  logoUrls: Record<string, string>
  colors: Record<string, string>
  abbrevs: Record<string, string>
  onSelect: (exchange: string) => void
}

export function ExchangeSelector({ exchange, availableExchanges, logoUrls, colors, abbrevs, onSelect }: ExchangeSelectorProps) {
  const [open, setOpen] = useState(false)
  const [logoError, setLogoError] = useState<Record<string, boolean>>({})
  const btnRef = useRef<HTMLButtonElement>(null)

  return (
    <div style={{ position: 'relative' }}>
      <button ref={btnRef} onClick={() => setOpen(o => !o)} style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, borderRadius: 4,
      }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        {logoError[exchange]
          ? <span style={{ color: colors[exchange] ?? '#888', fontSize: 9, fontWeight: 900 }}>{abbrevs[exchange] ?? exchange[0]}</span>
          : <img src={logoUrls[exchange] ?? ''} alt={exchange}
              style={{ width: 16, height: 16, borderRadius: 2, objectFit: 'contain' as const }}
              onError={() => setLogoError(p => ({ ...p, [exchange]: true }))}
            />
        }
      </button>
      {open && (
        <div style={{
          position: 'fixed', zIndex: 200, background: '#1F1E23',
          border: '1px solid #363C4E', borderRadius: 6, width: 140,
          boxShadow: '0 8px 24px rgba(0,0,0,0.9)', overflow: 'hidden',
          top: (btnRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
          left: (btnRef.current?.getBoundingClientRect().left ?? 0) - 120,
        }}>
          {availableExchanges.map(ex => (
            <button key={ex} onClick={() => { onSelect(ex); setOpen(false) }} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 12px', cursor: 'pointer',
              fontSize: 11, fontWeight: 700,
              color: ex === exchange ? '#fff' : '#636e82',
              background: ex === exchange ? 'linear-gradient(to right, #1A3A94, #2B79DD)' : 'transparent',
              border: 'none', width: '100%', textAlign: 'left' as const, fontFamily: 'inherit',
            }}>
              {logoError[ex]
                ? <span style={{ color: colors[ex] ?? '#888', fontSize: 8, fontWeight: 900, width: 14, textAlign: 'center' as const }}>{abbrevs[ex] ?? ex[0]}</span>
                : <img src={logoUrls[ex]} alt={ex} style={{ width: 14, height: 14, borderRadius: 2, objectFit: 'contain' as const }}
                    onError={() => setLogoError(p => ({ ...p, [ex]: true }))}
                  />
              }
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
