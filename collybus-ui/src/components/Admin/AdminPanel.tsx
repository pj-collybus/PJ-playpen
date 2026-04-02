import { useState } from 'react'
import { ContractSpecs } from './ContractSpecs'

interface AdminPanelProps {
  open: boolean
  onClose: () => void
}

export function AdminPanel({ open, onClose }: AdminPanelProps) {
  const [tab, setTab] = useState('Contract Specs')
  const tabs = ['Contract Specs', 'API Keys']

  if (!open) return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        width: 'min(1100px, 95vw)', height: 'min(800px, 90vh)',
        background: 'linear-gradient(to bottom, #1F1E23, #1E1D22, #1B1A1F)',
        border: '1.25px solid #363C4E', borderRadius: 8,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 20px', background: '#1B1A1F', borderBottom: '1px solid #363C4E', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', gap: 0 }}>
            {tabs.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                background: 'none', border: 'none',
                borderBottom: t === tab ? '2px solid #793ef6' : '2px solid transparent',
                color: t === tab ? '#8761f5' : '#636e82',
                fontSize: 14, fontWeight: 500, padding: '12px 16px',
                cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}>{t}</button>
            ))}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#636e82',
            cursor: 'pointer', fontSize: 18, lineHeight: 1, fontFamily: 'inherit',
          }}
            onMouseEnter={e => e.currentTarget.style.color = '#fff'}
            onMouseLeave={e => e.currentTarget.style.color = '#636e82'}
          >×</button>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {tab === 'Contract Specs' && <ContractSpecs />}
          {tab === 'API Keys' && <div style={{ padding: 20, color: '#636e82', fontSize: 13 }}>API Keys management — coming soon</div>}
        </div>
      </div>
    </div>
  )
}
