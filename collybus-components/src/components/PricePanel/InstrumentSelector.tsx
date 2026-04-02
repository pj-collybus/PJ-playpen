import React, { useState, useEffect, useRef } from 'react'
import { Input } from 'antd'
import { StarOutlined, StarFilled } from '@ant-design/icons'

interface Instrument {
  symbol: string
  baseCurrency: string
  contractType: string
  isPerp?: boolean
  kind?: string
}

interface InstrumentSelectorProps {
  exchange: string
  currentSymbol: string
  favourites: string[]
  onSelect: (symbol: string) => void
  onToggleFavourite: (symbol: string) => void
  onClose: () => void
  instruments: Instrument[]
}

function getTab(instrument: Instrument): string {
  if (instrument.contractType === 'OPTION') return 'Options'
  if (instrument.contractType === 'SPOT' || instrument.kind === 'spot') return 'Spot'
  if (instrument.isPerp === true) return 'Perps'
  return 'Futures'
}

export const InstrumentSelector: React.FC<InstrumentSelectorProps> = ({
  exchange, currentSymbol, favourites, onSelect, onToggleFavourite, onClose, instruments
}) => {
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('Perps')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  const filtered = instruments.filter(i => {
    const matchesSearch = !search || i.symbol.toLowerCase().includes(search.toLowerCase())
    const matchesTab = activeTab === 'Favs'
      ? favourites.includes(i.symbol)
      : getTab(i) === activeTab
    return matchesSearch && matchesTab
  })

  const grouped = filtered.reduce<Record<string, Instrument[]>>((acc, i) => {
    const key = i.baseCurrency
    if (!acc[key]) acc[key] = []
    acc[key].push(i)
    return acc
  }, {})

  const tabs = ['Favs', 'Perps', 'Futures', 'Options', 'Spot']

  return (
    <div style={{
      background: '#0d1117',
      border: '1px solid #1e2d3d',
      borderRadius: 6,
      width: 320,
      maxWidth: 320,
      maxHeight: 480,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      padding: 0, margin: 0,
    }}>
      <div style={{ padding: '8px 8px 0', borderBottom: '1px solid #1e2d3d' }}>
        <div style={{
          marginBottom: 8, fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
          color: '#555', textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>{exchange}</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#555', cursor: 'pointer',
            fontSize: 14, lineHeight: 1, padding: '0 2px', fontFamily: 'inherit',
          }}
          onMouseEnter={e => e.currentTarget.style.color = '#fff'}
          onMouseLeave={e => e.currentTarget.style.color = '#555'}
          >×</button>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: '0 0 6px' }}>
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: 1, padding: '4px 0',
                background: activeTab === tab ? '#0e1e18' : '#0f0f18',
                border: `1px solid ${activeTab === tab ? '#1a4030' : '#1e1e28'}`,
                borderRadius: 4,
                color: activeTab === tab ? '#00c896' : '#444',
                fontSize: 10, fontWeight: 700,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >{tab}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: '6px 8px' }}>
        <Input
          ref={searchRef as any}
          placeholder="Search..."
          size="small"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ background: '#090d14' }}
          autoFocus
        />
      </div>
      <div className="ip-list" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {Object.entries(grouped).map(([currency, instrs]) => (
          <div key={currency}>
            <div style={{
              padding: '2px 12px',
              fontSize: 10,
              color: '#4a5a6a',
              fontWeight: 700,
              background: '#090d14',
            }}>
              {currency}
            </div>
            {instrs.map(instr => (
              <div
                key={instr.symbol}
                onClick={() => onSelect(instr.symbol)}
                style={{
                  padding: '5px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  background: instr.symbol === currentSymbol ? '#141b26' : 'transparent',
                  fontSize: 12,
                  color: instr.symbol === currentSymbol ? '#e8edf2' : '#8899aa',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#141b26')}
                onMouseLeave={e => (e.currentTarget.style.background = instr.symbol === currentSymbol ? '#141b26' : 'transparent')}
              >
                <span style={{ flex: 1, fontFamily: 'monospace' }}>{instr.symbol}</span>
                <span
                  onClick={e => { e.stopPropagation(); onToggleFavourite(instr.symbol) }}
                  style={{ color: favourites.includes(instr.symbol) ? '#f0a020' : '#2a3a4a', cursor: 'pointer' }}
                >
                  {favourites.includes(instr.symbol) ? <StarFilled /> : <StarOutlined />}
                </span>
              </div>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: 16, color: '#4a5a6a', fontSize: 12, textAlign: 'center' }}>
            No instruments found
          </div>
        )}
      </div>
    </div>
  )
}
