import { useState, useRef, useEffect } from 'react'

interface GranPreset {
  label: string
  value: string
}

interface SettingsPanelProps {
  granularityPresets: GranPreset[]
  onSave: (presets: GranPreset[]) => void
  onClose: () => void
  anchorEl: HTMLElement | null
}

const border = '#363C4E'
const blue = '#2B79DD'
const blueDeep = '#1A3A94'
const muted = '#636e82'

export function SettingsPanel({ granularityPresets, onSave, onClose, anchorEl }: SettingsPanelProps) {
  const [values, setValues] = useState(granularityPresets.map(p => p.value))
  const panelRef = useRef<HTMLDivElement>(null)

  const rect = anchorEl?.getBoundingClientRect()
  const top = (rect?.bottom ?? 0) + 4
  const left = (rect?.left ?? 0) - 200 + (rect?.width ?? 0)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node))
        onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const handleSave = () => {
    onSave(values.map(v => ({ label: v, value: v })))
    onClose()
  }

  return (
    <div ref={panelRef} style={{
      position: 'fixed', zIndex: 300, top, left, width: 200,
      background: '#1F1E23', border: `1px solid ${border}`,
      borderRadius: 8, boxShadow: '0 12px 40px rgba(0,0,0,0.88)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', borderBottom: `1px solid ${border}`, background: '#1B1A1F',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.85)', letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
          Depth Buckets
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, fontFamily: 'inherit' }}
          onMouseEnter={e => e.currentTarget.style.color = '#fff'}
          onMouseLeave={e => e.currentTarget.style.color = muted}
        >×</button>
      </div>

      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 9, color: muted, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' as const, marginBottom: 2 }}>
          Bucket Size
        </span>
        {values.map((val, i) => (
          <input
            key={i}
            value={val}
            onChange={e => setValues(prev => prev.map((v, idx) => idx === i ? e.target.value : v))}
            style={{
              background: '#141414', border: `1px solid ${border}`, borderRadius: 4,
              color: 'rgba(255,255,255,0.85)', fontSize: 11, padding: '4px 8px',
              outline: 'none', fontFamily: 'inherit', width: '100%',
            }}
            onFocus={e => e.target.style.borderColor = blue}
            onBlur={e => e.target.style.borderColor = border}
          />
        ))}
      </div>

      <div style={{ padding: '6px 12px 10px', display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button onClick={onClose} style={{
          background: 'transparent', border: `1px solid ${border}`, borderRadius: 4,
          color: muted, fontSize: 11, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
        }}>Cancel</button>
        <button onClick={handleSave} style={{
          background: `linear-gradient(to right, ${blueDeep}, ${blue})`,
          border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 600,
          padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
        }}>Save</button>
      </div>
    </div>
  )
}
