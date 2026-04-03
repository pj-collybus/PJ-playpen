import { useEffect, useState } from 'react'
import { App as AntApp } from 'antd'
import { ThemeProvider, BlotterPanel } from '@collybus/components'
import type { BlotterData } from '@collybus/components'
import { signalRClient } from './services/signalRClient'
import { venuesApi, marketDataApi } from './services/apiClient'
import { useMarketDataStore } from './stores/marketDataStore'
import { useBlotterStore } from './stores/blotterStore'
import { ExchangeManager } from './components/ExchangeManager/ExchangeManager'
import { AdminPanel } from './components/Admin/AdminPanel'
import { PanelCanvas } from './components/PanelCanvas/PanelCanvas'
import { useLayoutStore } from './stores/layoutStore'
import './App.css'

export default function App() {
  const [connected, setConnected] = useState(false)
  const [exchangeManagerOpen, setExchangeManagerOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const [availableExchanges, setAvailableExchanges] = useState<string[]>([])
  const [blotterHeight, setBlotterHeight] = useState(200)
  const storeOrders = useBlotterStore(s => s.orders)
  const storeTrades = useBlotterStore(s => s.trades)
  const storePositions = useBlotterStore(s => s.positions)
  const storeBalances = useBlotterStore(s => s.balances)

  const blotterData: BlotterData = {
    orders: Object.values(storeOrders).map(o => ({
      id: o.orderId,
      exchange: o.exchange,
      timestamp: o.createdAt,
      instrument: o.symbol,
      type: (o.orderType ?? 'LIMIT').toUpperCase(),
      side: String(o.side).toUpperCase(),
      amount: o.quantity,
      filled: o.filledQuantity,
      price: o.limitPrice ?? 0,
      status: (o.state ?? '').toLowerCase(),
    })),
    trades: Object.values(storeTrades).map(t => ({
      id: t.fillId,
      exchange: t.exchange,
      timestamp: t.fillTs,
      instrument: t.symbol,
      side: String(t.side).toUpperCase(),
      amount: t.fillSize,
      price: t.fillPrice,
      fee: t.commission,
      orderId: t.orderId,
    })),
    positions: Object.values(storePositions).map(p => ({
      id: `${p.exchange}:${p.symbol}`,
      exchange: p.exchange,
      instrument: p.symbol,
      side: p.side,
      size: p.size,
      sizeUnit: p.sizeUnit ?? '',
      entryPrice: p.avgEntryPrice,
      markPrice: p.markPrice,
      uPnl: p.unrealisedPnl,
      rPnl: p.realisedPnl,
      liqPrice: 0,
      margin: 0,
      updatedAt: p.timestamp,
    })),
    balances: Object.values(storeBalances).map(b => ({
      exchange: b.exchange,
      currency: b.currency,
      available: b.available,
      total: b.total,
      reservedMargin: 0,
      unrealisedPnl: b.unrealisedPnl,
      equity: b.total + (b.unrealisedPnl ?? 0),
    })),
  }

  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const { layouts, activeLayoutId, addLayout, switchLayout, addPanel, deleteLayout, renameLayout, reorderLayouts, hasUnsavedChanges, saveLayout, loadLayouts } = useLayoutStore()

  useEffect(() => {
    signalRClient.connect().then(() => setConnected(true))
    loadLayouts().then(() => {
      const s = useLayoutStore.getState()
      console.log('[App] layouts loaded:', s.savedLayouts.length)
      console.log('[App] active:', s.activeLayoutId)
      console.log('[App] panels in active:', s.layouts.find(l => l.id === s.activeLayoutId)?.panels?.length)
    })
    useBlotterStore.getState().fetchHistory('week')
    return () => signalRClient.disconnect()
  }, [])

  useEffect(() => {
    venuesApi.list().then(r => {
      const exchanges = r.data.map((v: any) => v.id as string)
      setAvailableExchanges(exchanges)
      // Pre-fetch instruments for all exchanges in background
      exchanges.forEach((exchange: string) => {
        marketDataApi.instruments(exchange).then(inst => {
          useMarketDataStore.getState().setInstruments(exchange, inst.data)
        }).catch(() => {})
      })
    }).catch(() => {})
  }, [])

  const handleSwitchLayout = (id: string) => {
    if (hasUnsavedChanges) {
      if (!window.confirm('You have unsaved changes. Discard and switch layout?')) return
      switchLayout(id, true)
    } else {
      switchLayout(id)
    }
  }

  const panelMenuItems = [
    { label: 'Price Panel', onClick: () => addPanel('price', { exchange: availableExchanges[0] ?? 'DERIBIT', symbol: '' }) },
    { label: 'Blotter', onClick: () => addPanel('blotter', {}) },
    { label: 'Options Matrix', onClick: () => addPanel('options-matrix', {}) },
  ]

  return (
    <ThemeProvider>
      <AntApp>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: '#18171C' }}>

          {/* Header */}
          <header style={{
            background: 'linear-gradient(to bottom, #1F1E23 0%, #1E1D22 50%, #1B1A1F 100%)',
            borderBottom: '1.25px solid #363C4E',
            flexShrink: 0,
            zIndex: 50,
          }}>
            {/* Top row */}
            <div style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
              <img src="/logo.png" alt="Collybus" style={{ height: 40, objectFit: 'contain' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={() => setExchangeManagerOpen(true)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    background: 'transparent', border: 'none',
                    color: 'white', fontSize: 14, fontWeight: 400,
                    cursor: 'pointer', padding: '4px 8px', borderRadius: 6,
                    fontFamily: 'inherit',
                  }}
                >
                  Exchanges
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: connected ? '#22C55E' : '#636e82',
                    display: 'inline-block',
                    boxShadow: connected ? '0 0 6px rgba(34,197,94,0.6)' : 'none',
                  }} />
                </button>
                <button onClick={() => setAdminOpen(true)} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: 'transparent', border: 'none', color: 'white',
                  fontSize: 14, fontWeight: 400, cursor: 'pointer',
                  padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit',
                }}>Admin</button>
              </div>
            </div>

            {/* Tab row */}
            <div style={{
              height: 42, display: 'flex', alignItems: 'center',
              justifyContent: 'space-between',
              background: '#1B1A1F', padding: '0 8px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, overflowX: 'auto' }}>
                {layouts.map((l, index) => (
                  <div
                    key={l.id}
                    draggable
                    onDragStart={() => setDragFrom(index)}
                    onDragOver={e => { e.preventDefault(); setDragOver(index) }}
                    onDragEnd={() => {
                      if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver)
                        reorderLayouts(dragFrom, dragOver)
                      setDragFrom(null)
                      setDragOver(null)
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 2,
                      background: l.id === activeLayoutId ? '#1A3A94' : '#1D2432',
                      borderRadius: 4, flexShrink: 0, cursor: 'grab',
                      border: dragOver === index && dragFrom !== index
                        ? '1px solid #2B79DD'
                        : l.id === activeLayoutId ? '1px solid #2B79DD' : '1px solid transparent',
                      opacity: dragFrom === index ? 0.5 : 1,
                      transition: 'opacity 0.15s, border-color 0.15s',
                    }}
                  >
                    {editingId === l.id ? (
                      <input
                        autoFocus
                        defaultValue={l.name}
                        onBlur={e => {
                          const newName = e.target.value.trim()
                          if (newName && newName !== l.name) renameLayout(l.id, newName)
                          setEditingId(null)
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        style={{
                          background: 'transparent', border: 'none',
                          borderBottom: '1px solid #2B79DD',
                          color: 'white', fontSize: 14, fontWeight: 500,
                          outline: 'none', fontFamily: 'inherit',
                          width: Math.max(40, l.name.length * 9),
                          padding: '4px 8px',
                        }}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <span
                        onClick={() => handleSwitchLayout(l.id)}
                        onDoubleClick={e => { e.stopPropagation(); setEditingId(l.id) }}
                        style={{
                          padding: '4px 8px', color: 'white', fontSize: 14, fontWeight: 500,
                          cursor: 'pointer', outline: 'none', minWidth: 40,
                          borderRadius: 4, userSelect: 'none',
                        }}
                      >{l.name}</span>
                    )}
                    {hasUnsavedChanges && l.id === activeLayoutId && (
                      <button
                        onClick={e => { e.stopPropagation(); saveLayout() }}
                        title="Save layout"
                        style={{
                          background: 'transparent', border: 'none',
                          color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
                          fontSize: 11, padding: '0 2px', lineHeight: 1,
                          display: 'flex', alignItems: 'center',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#2B79DD'}
                        onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.6)'}
                      >💾</button>
                    )}
                    {layouts.length > 1 && (
                      <button
                        onClick={e => { e.stopPropagation(); deleteLayout(l.id) }}
                        style={{
                          background: 'transparent', border: 'none',
                          color: 'rgba(255,255,255,0.4)', cursor: 'pointer',
                          fontSize: 12, padding: '0 4px 0 0', lineHeight: 1,
                          display: 'flex', alignItems: 'center',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = '#FB2C36'}
                        onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
                      >×</button>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => addLayout(`Layout ${layouts.length + 1}`)}
                  style={{
                    background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)',
                    fontSize: 18, cursor: 'pointer', padding: '0 4px',
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = 'white'}
                  onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.5)'}
                >+</button>
              </div>

              {/* Add Panel dropdown */}
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <select
                  onChange={e => {
                    const item = panelMenuItems[parseInt(e.target.value)]
                    if (item) { item.onClick(); e.target.value = '' }
                  }}
                  defaultValue=""
                  style={{
                    background: '#1A3A94', border: 'none', color: 'white',
                    fontSize: 14, fontWeight: 500, padding: '4px 12px',
                    borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                    outline: 'none',
                  }}
                >
                  <option value="" disabled>+ Add Panel</option>
                  {panelMenuItems.map((item, i) => (
                    <option key={i} value={i}>{item.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </header>

          {/* Main canvas */}
          <main style={{
            flex: 1, overflow: 'auto', background: '#18171C',
            position: 'relative',
          }}>
            <PanelCanvas availableExchanges={availableExchanges} />
          </main>

          {/* Blotter */}
          <BlotterPanel
            data={blotterData}
            height={blotterHeight}
            onHeightChange={setBlotterHeight}
            callbacks={{ onCancelOrder: (id, ex) => console.log('cancel', id, ex) }}
          />
        </div>

        <ExchangeManager
          open={exchangeManagerOpen}
          onClose={() => setExchangeManagerOpen(false)}
        />
        <AdminPanel open={adminOpen} onClose={() => setAdminOpen(false)} />
      </AntApp>
    </ThemeProvider>
  )
}
