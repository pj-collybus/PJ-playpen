import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { GranButton, SettingsPanel } from '../atoms'
import { BidAskDisplay, PriceStats, OrderSizeSelector, OrderTypeTabs, ExchangeSelector } from '../molecules'
import { OrderModal } from '../organisms/OrderModal'
import { DepthChart } from '../shared/DepthChart'
import { InstrumentSelector } from '../shared/InstrumentSelector'
import { formatPrice, tickDecimals } from './utils'
import type { OrderBookData, TickerData, InstrumentInfo, PricePanelConfig, PricePanelCallbacks, OrderTypeMode } from './types'

const GRAN_OPTS = [
  { val: 'none', label: 'Raw' },
  { val: '0.5', label: '.5' },
  { val: '1', label: '1' },
  { val: '5', label: '5' },
  { val: '10', label: '10' },
  { val: '50', label: '50' },
  { val: '100', label: '100' },
]

export interface PricePanelProps {
  id: string
  x: number
  y: number
  width: number
  config: PricePanelConfig
  ticker?: TickerData
  orderBook?: OrderBookData
  instruments?: InstrumentInfo[]
  callbacks: PricePanelCallbacks
}

function baseCurrency(symbol: string): string {
  return symbol.split('-')[0].split('_')[0]
}

const S = {
  gradCard: 'linear-gradient(to bottom, #1F1E23 0%, #1E1D22 50%, #1B1A1F 100%)',
  border: '#363C4E',
  borderInner: '#303030',
  bgCardEnd: '#1B1A1F',
} as const

const EXCHANGE_LOGOS: Record<string, string> = {
  DERIBIT: 'https://www.deribit.com/favicon.ico',
  BITMEX: 'https://www.bitmex.com/favicon.ico',
  BINANCE: 'https://bin.bnbstatic.com/static/images/common/favicon.ico',
  BYBIT: 'https://www.bybit.com/favicon.ico',
  OKX: 'https://static.okx.com/cdn/assets/imgs/221/E74C5D512FA4211E.png',
  KRAKEN: 'https://www.kraken.com/favicon.ico',
}
const EXCHANGE_COLORS: Record<string, string> = {
  DERIBIT: '#e03040', BITMEX: '#4a90d9', BINANCE: '#f0b90b',
  BYBIT: '#f7a600', OKX: '#aaaaaa', KRAKEN: '#8d5ff0',
}
const EXCHANGE_ABBREV: Record<string, string> = {
  DERIBIT: 'D', BITMEX: 'BX', BINANCE: 'BN', BYBIT: 'BB', OKX: 'OX', KRAKEN: 'KR',
}

export function PricePanel({
  id, x, y, width: initialWidth, config, ticker, orderBook, instruments = [], callbacks
}: PricePanelProps) {
  const [width, setWidth] = useState(initialWidth)
  const widthRef = useRef(initialWidth)
  useEffect(() => { widthRef.current = width }, [width])
  const [gran, setGranRaw] = useState(config.selectedGranularity ?? 'none')
  const handleGranChange = (val: string) => { setGranRaw(val); callbacks.onConfigChange?.(id, { selectedGranularity: val }) }
  const [orderType] = useState<OrderTypeMode>('LMT')
  const [, _setActiveOrderBtn] = useState('LMT')
  const [locked, setLocked] = useState(false)
  const [instrOpen, setInstrOpen] = useState(false)
  const [symbol, setSymbol] = useState(config.symbol)
  const [exchange, setExchange] = useState(config.exchange)
  const [favourites, setFavourites] = useState<string[]>(config.favourites ?? [])
  const [qty, setQty] = useState(config.defaultQty ?? '')
  const [submitting, setSubmitting] = useState<'buy' | 'sell' | null>(null)
  const [instrPos, setInstrPos] = useState({ x: 0, y: 60 })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [orderModal, setOrderModal] = useState<{ tab: 'LMT' | 'S/L' | 'ID' | 'OCO'; side: 'BUY' | 'SELL'; price?: number; qty?: number } | null>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const [granPresets, setGranPresets] = useState(
    config.granularityPresets ?? GRAN_OPTS.map(g => ({ label: g.label, value: g.val }))
  )
  const [qtyPresets, setQtyPresets] = useState<number[]>(config.presetQtys ?? [1, 5, 10, 25, 100])

  useEffect(() => { setExchange(config.exchange) }, [config.exchange])
  useEffect(() => { setSymbol(config.symbol) }, [config.symbol])
  useEffect(() => { if (config.presetQtys) setQtyPresets(config.presetQtys) }, [config.presetQtys])

  const elRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null)
  const posRef = useRef({ x, y })
  const instrDragRef = useRef<{ ox: number; oy: number } | null>(null)

  const spec = useMemo(() => instruments.find(i => i.symbol === symbol), [instruments, symbol])
  const tickSize = spec?.tickSize ?? 0.5
  const sizeUnit = spec?.sizeUnit ?? 'base'
  const isPerp = symbol.includes('PERPETUAL')
  const base = baseCurrency(symbol)
  const bid = ticker?.bestBid ?? 0
  const ask = ticker?.bestAsk ?? 0
  const qtyNum = parseFloat(qty) || 0
  const granNum = gran === 'none' ? 1 : parseFloat(gran)
  const bids = orderBook?.bids ?? []
  const asks = orderBook?.asks ?? []

  function calcVwapSide(levels: {price:number;size:number}[], targetQty: number): number | null {
    if (!targetQty || targetQty <= 0 || !levels.length) return null
    let filled = 0, notional = 0
    for (const { price, size } of levels) {
      let availBase: number
      switch (sizeUnit) {
        case 'quote': availBase = price > 0 ? size / price : 0; break
        case 'contracts': availBase = size * (spec?.lotSize || 1); break
        default: availBase = size
      }
      const take = Math.min(availBase, targetQty - filled)
      notional += take * price
      filled += take
      if (filled >= targetQty - 1e-9) break
    }
    return filled < targetQty - 1e-9 ? null : notional / filled
  }

  const sortedBids = useMemo(() => bids.length ? [...bids].sort((a, b) => b.price - a.price) : [], [orderBook])
  const sortedAsks = useMemo(() => asks.length ? [...asks].sort((a, b) => a.price - b.price) : [], [orderBook])
  const [bidVisibleTotal, setBidVisibleTotal] = useState(0)
  const [askVisibleTotal, setAskVisibleTotal] = useState(0)
  const sharedCumMax = Math.max(bidVisibleTotal, askVisibleTotal)

  let sellPrice: string, buyPrice: string
  const d = tickDecimals(tickSize)
  if (qtyNum > 0) {
    const sv = calcVwapSide(sortedBids, qtyNum)
    const bv = calcVwapSide(sortedAsks, qtyNum)
    const sellP = sv != null && bv != null ? Math.min(sv, bv) : sv
    const buyP  = sv != null && bv != null ? Math.max(sv, bv) : bv
    sellPrice = sellP != null ? formatPrice(sellP, tickSize) : 'No liq.'
    buyPrice  = buyP  != null ? formatPrice(buyP, tickSize)  : 'No liq.'
  } else {
    sellPrice = bid > 0 ? formatPrice(bid, tickSize) : '—'
    buyPrice  = ask > 0 ? formatPrice(ask, tickSize) : '—'
  }

  let spreadVal: number | null = null
  if (qtyNum > 0 && sellPrice !== '—' && buyPrice !== '—' && sellPrice !== 'No liq.' && buyPrice !== 'No liq.') {
    const sn = parseFloat(sellPrice.replace(/,/g, '')), bn = parseFloat(buyPrice.replace(/,/g, ''))
    if (!isNaN(sn) && !isNaN(bn)) spreadVal = bn - sn
  } else if (bid > 0 && ask > 0) { spreadVal = ask - bid }
  const spread = spreadVal !== null ? spreadVal.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'

  // ── Drag ──
  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (locked) return
    if ((e.target as HTMLElement).closest('button, input, select, .instr-picker')) return
    e.preventDefault()
    const el = elRef.current; if (!el) return
    dragRef.current = { ox: e.clientX - el.offsetLeft, oy: e.clientY - el.offsetTop }
    el.style.zIndex = '10'
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current || !el) return
      const nx = Math.max(0, ev.clientX - dragRef.current.ox)
      const ny = Math.max(0, ev.clientY - dragRef.current.oy)
      el.style.left = nx + 'px'; el.style.top = ny + 'px'
      posRef.current = { x: nx, y: ny }
    }
    const onUp = () => {
      dragRef.current = null; el.style.zIndex = ''
      callbacks.onMove?.(id, posRef.current.x, posRef.current.y)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [id, locked, callbacks])

  // ── Resize ──
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startW: width }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      setWidth(Math.max(300, resizeRef.current.startW + (ev.clientX - resizeRef.current.startX)))
    }
    const onUp = () => {
      resizeRef.current = null
      callbacks.onResize?.(id, widthRef.current)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [id, width, callbacks])

  const handleTrade = async (side: 'buy' | 'sell') => {
    if (!qtyNum || submitting) return
    const price = side === 'sell' ? parseFloat(sellPrice.replace('$','')) || bid : parseFloat(buyPrice.replace('$','')) || ask
    setSubmitting(side)
    try { await callbacks.onSubmitOrder({ exchange, symbol, side: side.toUpperCase() as 'BUY'|'SELL', quantity: qtyNum, limitPrice: price, orderType, timeInForce: 'FOK' }) }
    finally { setSubmitting(null) }
  }

  const handleSelectSymbol = (sym: string) => { setSymbol(sym); setInstrOpen(false); callbacks.onConfigChange?.(id, { symbol: sym }) }
  const toggleFav = (sym: string) => {
    const next = favourites.includes(sym) ? favourites.filter(f => f !== sym) : [...favourites, sym]
    setFavourites(next); callbacks.onConfigChange?.(id, { favourites: next })
  }
  const handleExchangeSelect = (ex: string) => { setExchange(ex); callbacks.onConfigChange?.(id, { exchange: ex }) }

  const showDepth = width >= 320

  // ── Render ──
  return (
    <div ref={elRef} style={{
      position: 'absolute', left: x, top: y, width, minWidth: 300,
      border: `1.25px solid ${S.border}`, borderRadius: 4, overflow: 'visible',
      display: 'flex', flexDirection: 'column', background: S.gradCard,
      boxShadow: locked ? '0 0 0 1px rgba(240,160,32,0.35), 0 4px 20px rgba(0,0,0,0.6)' : '0 4px 20px rgba(0,0,0,0.5)',
      userSelect: 'none',
    }}>
      {/* Panel body */}
      <div onMouseDown={onHeaderMouseDown} style={{
        display: 'flex', flexDirection: 'row', overflow: 'hidden',
        borderRadius: 4, height: 171, cursor: locked ? 'default' : 'grab',
      }}>
        {/* Gran column */}
        <div style={{ width: 32, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column',
          alignItems: 'center', padding: '4px 2px', gap: 2, paddingTop: 4,
          borderRight: `1px solid ${S.borderInner}`, background: S.bgCardEnd, justifyContent: 'flex-start',
        }}>
          {granPresets.map(g => (
            <GranButton key={g.value} label={g.label} active={gran === g.value} onClick={() => handleGranChange(g.value)} />
          ))}
        </div>

        {/* Bid depth */}
        {showDepth && (
          <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
            <DepthChart levels={sortedBids} side="bid" tickSize={tickSize} granularity={granNum}
              highlightQty={qtyNum} sizeUnit={spec?.sizeUnit} lotSize={spec?.lotSize} midPrice={bid > 0 && ask > 0 ? (bid + ask) / 2 : undefined}
              globalCumMax={sharedCumMax > 0 ? sharedCumMax : undefined}
              onVisibleTotalChange={setBidVisibleTotal}
              onPriceClick={p => callbacks.onSubmitOrder?.({ exchange, symbol, side: 'SELL', quantity: qtyNum || 0, limitPrice: p, orderType })} />
          </div>
        )}

        {/* Centre */}
        <div style={{ width: 200, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column',
          padding: '4px 4px', gap: 3, overflow: 'hidden',
          borderLeft: `1px solid ${S.borderInner}`, borderRight: `1px solid ${S.borderInner}`, justifyContent: 'center',
        }}>
          {/* Instrument header */}
          <div style={{ height: 30, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button onClick={() => setInstrOpen(o => !o)} style={{ height: 26, width: 35, background: 'transparent', border: 'none', color: 'white', borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >🔍</button>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', overflow: 'hidden', padding: '0 4px', position: 'relative' }}>
              <button onClick={() => setInstrOpen(o => !o)} style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180, textAlign: 'left' as const }}>{symbol}</button>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#CFD1D4', flexShrink: 0, marginLeft: 6 }}>{exchange}</span>
              {instrOpen && (
                <div className="instr-picker" style={{ position: 'fixed', zIndex: 150,
                  left: (elRef.current?.getBoundingClientRect().left ?? 0) + instrPos.x,
                  top: (elRef.current?.getBoundingClientRect().top ?? 0) + instrPos.y,
                }}>
                  <div onMouseDown={e => {
                    e.stopPropagation()
                    instrDragRef.current = { ox: e.clientX - instrPos.x, oy: e.clientY - instrPos.y }
                    const onMove = (ev: MouseEvent) => { if (!instrDragRef.current) return; setInstrPos({ x: ev.clientX - instrDragRef.current.ox, y: ev.clientY - instrDragRef.current.oy }) }
                    const onUp = () => { instrDragRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
                    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
                  }} style={{ cursor: 'grab', background: '#1F1E23', borderRadius: 8, userSelect: 'none',
                    border: `1px solid ${S.border}`, width: 320, maxHeight: 440, display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    boxShadow: '0 12px 40px rgba(0,0,0,0.88)',
                  }}>
                    <InstrumentSelector exchange={exchange} currentSymbol={symbol} favourites={favourites}
                      instruments={instruments.map(i => ({ symbol: i.symbol, baseCurrency: i.baseCurrency, contractType: i.contractType, isPerp: i.isPerp === true || i.symbol.includes('PERPETUAL'), kind: i.kind }))}
                      onSelect={handleSelectSymbol} onToggleFavourite={toggleFav} onClose={() => setInstrOpen(false)} />
                  </div>
                </div>
              )}
            </div>
            <div style={{ width: 35 }} />
          </div>

          {/* Stats */}
          {ticker ? (
            <PriceStats high24h={ticker.high24h} low24h={ticker.low24h} change24h={ticker.change24h}
              fundingRate={ticker.fundingRate} isPerp={isPerp} formatPrice={formatPrice} tickSize={tickSize} />
          ) : (
            <span style={{ fontSize: 9, color: 'rgba(99,110,130,0.9)', textAlign: 'center' }}>H — / L —</span>
          )}

          {/* Buy/Sell */}
          <BidAskDisplay sellPrice={sellPrice} buyPrice={buyPrice} spread={spread}
            baseCurrency={base} qtyEntered={qtyNum > 0} submitting={submitting}
            onSell={() => handleTrade('sell')} onBuy={() => handleTrade('buy')} />

          {/* Qty */}
          <OrderSizeSelector qty={qty} presetQtys={qtyPresets}
            onChange={(v) => { setQty(v); callbacks.onConfigChange?.(id, { defaultQty: v }) }}
            baseCurrency={spec?.baseCurrency}
            onBlur={() => callbacks.onConfigChange?.(id, { defaultQty: qty })} />
        </div>

        {/* Ask depth */}
        {showDepth && (
          <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
            <DepthChart levels={sortedAsks} side="ask" tickSize={tickSize} granularity={granNum}
              highlightQty={qtyNum} sizeUnit={spec?.sizeUnit} lotSize={spec?.lotSize} midPrice={bid > 0 && ask > 0 ? (bid + ask) / 2 : undefined}
              globalCumMax={sharedCumMax > 0 ? sharedCumMax : undefined}
              onVisibleTotalChange={setAskVisibleTotal}
              onPriceClick={p => callbacks.onSubmitOrder?.({ exchange, symbol, side: 'BUY', quantity: qtyNum || 0, limitPrice: p, orderType })} />
          </div>
        )}

        {/* Order column */}
        <div style={{ flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'row',
          borderLeft: `1px solid ${S.borderInner}`, borderRadius: '0 0 4px 0', overflow: 'visible', background: S.bgCardEnd,
        }}>
          <div style={{ width: 32, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '4px 2px', gap: 2, paddingTop: 4, borderRight: `1px solid ${S.borderInner}`, justifyContent: 'flex-start',
          }}>
            <OrderTypeTabs onSelect={(_label, modalTab) => {
              if (modalTab === 'LMT' || modalTab === 'S/L' || modalTab === 'ID' || modalTab === 'OCO') {
                setOrderModal({
                  tab: modalTab as 'LMT' | 'S/L' | 'ID' | 'OCO',
                  side: modalTab === 'S/L' ? 'SELL' : 'BUY',
                  price: modalTab === 'S/L'
                    ? (bid > 0 ? bid : ask > 0 ? ask : undefined)
                    : (ask > 0 ? ask : bid > 0 ? bid : undefined),
                  qty: qtyNum > 0 ? qtyNum : undefined,
                })
              }
            }} />
          </div>

          <div style={{ width: 22, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <button onClick={() => callbacks.onClose?.(id)} style={{ height: 22, width: 22, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 12, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.2)'; e.currentTarget.style.color = '#fff' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
            >×</button>
            <ExchangeSelector exchange={exchange} availableExchanges={config.availableExchanges ?? ['DERIBIT', 'BITMEX']}
              logoUrls={EXCHANGE_LOGOS} colors={EXCHANGE_COLORS} abbrevs={EXCHANGE_ABBREV}
              onSelect={handleExchangeSelect} />
            <button ref={settingsBtnRef} title="Settings" onClick={() => setSettingsOpen(o => !o)}
              style={{ height: 28, width: 22, background: 'transparent', border: 'none', color: settingsOpen ? '#2B79DD' : '#fff', cursor: 'pointer', fontSize: 14, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>⚙</button>
            <button title="Alerts" style={{ height: 28, width: 22, background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🔔</button>
            <button onClick={() => setLocked(l => !l)} title={locked ? 'Unlock' : 'Lock'} style={{ height: 28, width: 22, background: 'transparent', border: 'none', color: locked ? '#F97316' : '#fff', cursor: 'pointer', fontSize: 14, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{locked ? '🔒' : '🔓'}</button>
          </div>
        </div>
      </div>

      {/* Resize handle */}
      <div onMouseDown={onResizeMouseDown} style={{ position: 'absolute', right: -3, top: 6, bottom: 6, width: 6, cursor: 'col-resize', zIndex: 20, borderRadius: 3, background: 'transparent', transition: 'background .15s' }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.35)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      />

      {settingsOpen && (
        <SettingsPanel
          granularityPresets={granPresets}
          qtyPresets={qtyPresets}
          anchorEl={settingsBtnRef.current}
          onSave={(presets, newQtyPresets) => {
            setGranPresets(presets)
            setQtyPresets(newQtyPresets)
            callbacks.onConfigChange?.(id, { granularityPresets: presets, presetQtys: newQtyPresets })
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {orderModal && (
        <OrderModal
          exchange={exchange}
          symbol={symbol}
          baseCurrency={spec?.baseCurrency ?? ''}
          quoteCurrency={spec?.quoteCurrency ?? 'USD'}
          tickSize={tickSize}
          lotSize={spec?.lotSize ?? 1}
          initialSide={orderModal.side}
          initialPrice={orderModal.price}
          initialQty={orderModal.qty}
          initialTab={orderModal.tab}
          bid={bid > 0 ? bid : undefined}
          ask={ask > 0 ? ask : undefined}
          onSubmit={async (params) => {
            await callbacks.onSubmitOrder({
              exchange: params.exchange,
              symbol: params.symbol,
              side: params.side,
              quantity: params.quantity,
              limitPrice: params.limitPrice ?? 0,
              triggerPrice: params.triggerPrice,
              orderType: params.orderType,
              timeInForce: params.timeInForce,
            })
          }}
          onClose={() => setOrderModal(null)}
        />
      )}
    </div>
  )
}
