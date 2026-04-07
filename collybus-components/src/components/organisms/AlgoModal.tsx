import { useState, useRef, useEffect } from 'react'
import { tickDecimals } from '../PricePanel/utils'

export interface AlgoModalProps {
  exchange: string; symbol: string; baseCurrency: string; quoteCurrency: string
  tickSize: number; lotSize: number; bid: number; ask: number; mid: number
  initialSide?: 'BUY' | 'SELL'; initialQty?: number
  qtyPresets?: number[]
  onSubmit: (params: AlgoLaunchParams) => Promise<string>
  onClose: () => void
}

export interface AlgoLaunchParams {
  strategyType: string; exchange: string; symbol: string; side: string
  totalSize: number; tickSize: number; lotSize: number
  arrivalMid: number; arrivalBid: number; arrivalAsk: number
  durationMinutes?: number; urgency?: string; numSlices?: number
  limitPrice?: number; limitMode?: string; startMode?: string; maxSpreadBps?: number
  triggerPrice?: number; triggerDirection?: string; startScheduled?: string; scheduleVariancePct?: number
  vwapMode?: string; participationBandBps?: number; maxDeviationBps?: number
  sniperMode?: string; levelMode?: string; retriggerMode?: string
  levels?: { index: number; price: number; allocationPct: number; enabled: boolean }[]
  icebergSnipe?: boolean; sniperSlicePct?: number
  postPrice?: number; snipeCeiling?: number; snipeCap?: number
  visibleSize?: number; visibleVariancePct?: number
  sizeVariancePct?: number; timeVariancePct?: number
  expiry?: string; gtdDateTime?: string
  participationPct?: number; volumeWindowSeconds?: number; minChildSize?: number; maxChildSize?: number
}

type StrategyType = 'TWAP' | 'VWAP' | 'SNIPER' | 'ICEBERG' | 'POV'

type StartMode = 'immediate' | 'scheduled' | 'trigger'

const S = {
  bg: '#1a1a22', bgInput: '#0e0e14', panel: '#141418', border: '#2a2a38',
  gradAction: 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)',
  gradSec: 'linear-gradient(to bottom, #3C3B42 0%, #2B2A2F 100%)',
  positive: '#00C758', negative: '#FB2C36',
  text: 'rgba(255,255,255,0.85)', muted: '#636e82', blue: '#2B79DD',
}
const STRATS: { type: StrategyType; label: string }[] = [
  { type: 'TWAP', label: 'TWAP' }, { type: 'VWAP', label: 'VWAP' },
  { type: 'SNIPER', label: 'Sniper' }, { type: 'ICEBERG', label: 'Iceberg' }, { type: 'POV', label: 'POV' },
]
const DUR = [1, 5, 10, 15, 30]
const DUR_PRESETS = [1, 5, 15, 30, 60, 240]
const DUR_LABELS: Record<number, string> = { 1: '1m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 240: '4h' }
const colH: React.CSSProperties = { fontSize: 9, color: S.muted, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }
const lbl = (t: string) => <span style={{ ...colH, display: 'block', marginBottom: 4 }}>{t}</span>
const inp: React.CSSProperties = { background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 4, color: S.text, fontSize: 11, padding: '5px 8px', outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
const sel: React.CSSProperties = { ...inp, cursor: 'pointer' }

function InlineInput({ value, onChange, currency, onUp, onDown }: { value: string; onChange: (v: string) => void; currency: string; onUp: () => void; onDown: () => void }) {
  const arrowUp: React.CSSProperties = { width: 18, height: 16, background: 'linear-gradient(to bottom, #3C3B42, #2B2A2F)', border: 'none', borderBottom: '1px solid #1a1a20', color: '#8a8a9a', fontSize: 8, cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.12)' }
  const arrowDn: React.CSSProperties = { width: 18, height: 16, background: 'linear-gradient(to bottom, #2B2A2F, #232228)', border: 'none', color: '#8a8a9a', fontSize: 8, cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.06)' }
  return (
    <div style={{ display: 'flex', alignItems: 'center', background: S.bgInput, border: `1px solid ${S.border}`, borderRadius: 4, overflow: 'hidden', height: 32 }}>
      <input value={value} onChange={e => onChange(e.target.value)} style={{ flex: 1, background: 'transparent', border: 'none', color: S.text, fontSize: 12, padding: '0 8px', outline: 'none', fontFamily: 'inherit', minWidth: 0 }} />
      <span style={{ fontSize: 9, color: S.muted, fontWeight: 600, paddingRight: 4, flexShrink: 0 }}>{currency}</span>
      <div style={{ display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${S.border}`, flexShrink: 0 }}>
        <button onClick={onUp} style={arrowUp}>▲</button>
        <button onClick={onDown} style={arrowDn}>▼</button>
      </div>
    </div>
  )
}

const savePos = (key: string, p: { x: number; y: number }) => {
  try { localStorage.setItem(`collybus.pos.${key}`, JSON.stringify(p)) } catch {}
}
const loadPos = (key: string, fallback: { x: number; y: number }) => {
  try { const s = localStorage.getItem(`collybus.pos.${key}`); return s ? JSON.parse(s) : fallback } catch { return fallback }
}

export function AlgoModal({ exchange, symbol, baseCurrency, quoteCurrency, tickSize, lotSize, bid, ask, mid, initialSide = 'BUY', initialQty, qtyPresets, onSubmit, onClose }: AlgoModalProps) {
  const [strat, setStrat] = useState<StrategyType>('TWAP')
  const [side, setSide] = useState<'BUY' | 'SELL'>(initialSide)
  const [qty, setQty] = useState(initialQty?.toString() ?? '')
  const [priceRef, setPriceRef] = useState(mid.toFixed(tickDecimals(tickSize)))
  const [dur, setDur] = useState(5)
  const [urg, setUrg] = useState<'passive' | 'aggressive'>('passive')
  const [twapSizeVar, setTwapSizeVar] = useState('10')
  const [twapTimeVar, setTwapTimeVar] = useState('10')
  const [twapSliceMode, setTwapSliceMode] = useState<'auto' | 'manual'>('auto')
  const [twapSlices, setTwapSlices] = useState('10')
  const [twapMaxSpread, setTwapMaxSpread] = useState('50')
  const [startMode, setStartMode] = useState<StartMode>('immediate')
  const [trigPx, setTrigPx] = useState('')
  const [trigDir, setTrigDir] = useState<'above' | 'below'>('below')
  const [limMode, setLimMode] = useState('none')
  const [limPx, setLimPx] = useState('')
  const [vwapMode, setVwapMode] = useState('realtime')
  const [bandBps, setBandBps] = useState('20')
  const [maxDevBps, setMaxDevBps] = useState('50')
  const [sniperMode, setSniperMode] = useState<'snipe' | 'post_snipe'>('snipe')
  const [levelMode, _setLevelMode] = useState('simultaneous')
  const [levels, setLevels] = useState([{ price: String(ask), pct: '100' }])
  const [postPx, setPostPx] = useState(String(bid))
  const [postPct, setPostPct] = useState('50')

  // Sync main price ↔ Sniper L1 price (snipe mode) or Post price (post_snipe mode)
  useEffect(() => {
    if (strat !== 'SNIPER') return
    if (sniperMode === 'snipe' && levels[0]) {
      if (levels[0].price !== priceRef) setLevels(p => p.map((l, i) => i === 0 ? { ...l, price: priceRef } : l))
    } else if (sniperMode === 'post_snipe') {
      if (postPx !== priceRef) setPostPx(priceRef)
    }
  }, [priceRef, strat, sniperMode])

  useEffect(() => {
    if (strat !== 'SNIPER' || sniperMode !== 'snipe') return
    if (levels[0] && levels[0].price !== priceRef) setPriceRef(levels[0].price)
  }, [levels[0]?.price])

  useEffect(() => {
    if (strat !== 'SNIPER' || sniperMode !== 'post_snipe') return
    if (postPx !== priceRef) setPriceRef(postPx)
  }, [postPx])

  const [iceSlices, setIceSlices] = useState('10')
  const [iceSliceMode, setIceSliceMode] = useState<'auto' | 'manual'>('manual')
  const [visVar, setVisVar] = useState('20')
  const [schedTime, setSchedTime] = useState('')
  const [iceExpiry, setIceExpiry] = useState<'GTC' | 'Day' | 'GTD'>('GTC')
  const [iceGtdTime, setIceGtdTime] = useState('')
  const [povPct, setPovPct] = useState('10')
  const [povMode, setPovMode] = useState<'pure' | 'time_limited' | 'hybrid'>('pure')
  const [povMinChild, setPovMinChild] = useState(String(lotSize * 2))
  const [povMaxChild, setPovMaxChild] = useState('0')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [pos, setPos] = useState(() => loadPos('algoModal', { x: Math.max(0, (window.innerWidth - 500) / 2), y: Math.max(0, (window.innerHeight - 600) / 2) }))
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  useEffect(() => { savePos('algoModal', pos) }, [pos])

  const d = tickDecimals(tickSize)
  const round = (n: number, step: number) => { const dd = Math.max(0, -Math.floor(Math.log10(step))); return parseFloat(n.toFixed(dd)) }

  // Auto-split snipe levels equally (called only on add/remove, not on manual input)
  const splitLevelsEqually = (lvls: typeof levels, totalPct: number) => {
    const base = Math.floor(totalPct / lvls.length)
    const remainder = totalPct - base * lvls.length
    return lvls.map((l, i) => ({ ...l, pct: String(i === lvls.length - 1 ? base + remainder : base) }))
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const q = parseFloat(qty); if (!q || q <= 0) throw new Error('Invalid quantity')
      const p: AlgoLaunchParams = {
        strategyType: strat, exchange, symbol, side, totalSize: q, tickSize, lotSize,
        arrivalMid: mid, arrivalBid: bid, arrivalAsk: ask,
        durationMinutes: strat === 'TWAP' || strat === 'VWAP' || (strat === 'POV' && povMode !== 'pure') ? dur : undefined,
        urgency: ['TWAP','VWAP'].includes(strat) ? urg : undefined,
        numSlices: strat === 'TWAP' && twapSliceMode === 'manual' ? parseInt(twapSlices) || dur : undefined,
        scheduleVariancePct: strat === 'TWAP' ? parseInt(twapSizeVar) || 10 : undefined,
        sizeVariancePct: strat === 'TWAP' ? parseInt(twapSizeVar) || 10 : undefined,
        timeVariancePct: strat === 'TWAP' ? parseInt(twapTimeVar) || 10 : undefined,
        startMode,
        startScheduled: startMode === 'scheduled' && schedTime ? schedTime : undefined,
        triggerPrice: startMode === 'trigger' ? parseFloat(trigPx) : undefined,
        triggerDirection: startMode === 'trigger' ? trigDir : undefined,
        limitMode: strat === 'ICEBERG' ? 'hard_limit' : (limMode !== 'none' ? limMode : undefined),
        limitPrice: strat === 'ICEBERG' ? parseFloat(priceRef) : (limMode !== 'none' && limPx ? parseFloat(limPx) : undefined),
        vwapMode: strat === 'VWAP' ? vwapMode : undefined,
        participationBandBps: strat === 'VWAP' ? parseFloat(bandBps) : undefined,
        maxDeviationBps: strat === 'VWAP' ? parseFloat(maxDevBps) : undefined,
        sniperMode: strat === 'SNIPER' ? sniperMode : undefined,
        levelMode: strat === 'SNIPER' ? levelMode : undefined,
        levels: strat === 'SNIPER' ? levels.map((l, i) => ({ index: i, price: parseFloat(l.price), allocationPct: parseFloat(l.pct), enabled: true })) : undefined,
        postPrice: strat === 'SNIPER' && sniperMode === 'post_snipe' ? parseFloat(postPx) : undefined,
        snipeCap: strat === 'SNIPER' && sniperMode === 'post_snipe' ? (100 - (parseFloat(postPct) || 50)) : undefined,
        visibleSize: strat === 'ICEBERG'
          ? q / Math.max(1, parseInt(iceSlices) || 10)
          : undefined,
        visibleVariancePct: strat === 'ICEBERG' ? parseFloat(visVar) : undefined,
        expiry: strat === 'ICEBERG' ? iceExpiry : undefined,
        gtdDateTime: strat === 'ICEBERG' && iceExpiry === 'GTD' && iceGtdTime ? iceGtdTime : undefined,
        participationPct: strat === 'POV' ? parseFloat(povPct) : undefined,
        minChildSize: strat === 'POV' ? parseFloat(povMinChild) || lotSize * 2 : undefined,
        maxChildSize: strat === 'POV' && parseFloat(povMaxChild) > 0 ? parseFloat(povMaxChild) : undefined,
        maxSpreadBps: ['TWAP','POV'].includes(strat) ? parseInt(twapMaxSpread) || 50 : undefined,
      }
      await onSubmit(p); setError(''); onClose()
    } catch (e: any) { setError(e.message ?? 'Failed') } finally { setSubmitting(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 600, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: 480, maxHeight: '90vh', overflowY: 'auto', background: S.bg, border: '1px solid #4a4a60', borderRadius: 10, boxShadow: '0 20px 80px rgba(0,0,0,0.95), 0 0 0 1px rgba(100,100,150,0.3)', pointerEvents: 'all' }}>
        {/* Header */}
        <div onMouseDown={e => { if ((e.target as HTMLElement).closest('button,input,select')) return; e.preventDefault(); dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }; const mv = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }; const up = () => { dragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up) }} style={{ padding: '14px 16px 0', cursor: 'grab' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: S.text }}>Algo Order <span style={{ fontWeight: 400, color: S.muted }}>on</span> {exchange}</div>
              <div style={{ fontSize: 11, color: S.muted, marginTop: 2 }}>{symbol}</div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 18, lineHeight: 1, fontFamily: 'inherit', marginTop: 2 }}>×</button>
          </div>
          <div style={{ display: 'flex', borderBottom: `1px solid ${S.border}` }}>
            {STRATS.map(s => <button key={s.type} onClick={() => setStrat(s.type)} style={{ padding: '7px 14px', border: 'none', background: 'none', borderBottom: s.type === strat ? `2px solid ${S.blue}` : '2px solid transparent', color: s.type === strat ? S.blue : S.muted, fontSize: 11, fontWeight: s.type === strat ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit' }}>{s.label}</button>)}
          </div>
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Bid/Ask/Mid */}
          <div style={{ display: 'flex', gap: 16, fontSize: 10, color: S.muted }}>
            <span>Bid: <span style={{ color: S.positive }}>{bid.toFixed(d)}</span></span>
            <span>Ask: <span style={{ color: S.negative }}>{ask.toFixed(d)}</span></span>
            <span>Mid: <span style={{ color: S.text }}>{mid.toFixed(d)}</span></span>
          </div>

          {/* Main input — OrderModal style */}
          <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8 }}>
              <span style={colH}>SIDE</span><span style={colH}>AMOUNT</span>
              <span style={colH}>{strat === 'SNIPER' ? 'TRIGGER' : strat === 'ICEBERG' ? 'LIMIT PRICE' : 'REF PRICE'}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8, alignItems: 'center' }}>
              <div style={{ display: 'flex', height: 32 }}>
                {(['SELL','BUY'] as const).map(s => <button key={s} onClick={() => setSide(s)} style={{
                  flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                  borderRadius: s === 'SELL' ? '4px 0 0 4px' : '0 4px 4px 0',
                  background: side === s ? (s === 'BUY' ? 'rgba(0,199,88,0.25)' : 'rgba(251,44,54,0.25)') : '#1a1a22',
                  color: side === s ? (s === 'BUY' ? S.positive : S.negative) : S.muted,
                  border: `1px solid ${side === s ? (s === 'BUY' ? 'rgba(0,199,88,0.4)' : 'rgba(251,44,54,0.4)') : S.border}`,
                  boxShadow: side === s ? 'inset 0px 2px 1px rgba(255,255,255,0.15), inset 0px -2px 1px rgba(0,0,0,0.25)' : 'none',
                }}>{s}</button>)}
              </div>
              <InlineInput value={qty} onChange={setQty} currency={baseCurrency}
                onUp={() => setQty(String(round(parseFloat(qty||'0') + lotSize, lotSize)))}
                onDown={() => setQty(String(round(Math.max(0, parseFloat(qty||'0') - lotSize), lotSize)))} />
              <InlineInput value={priceRef} onChange={setPriceRef} currency={quoteCurrency}
                onUp={() => setPriceRef(round(parseFloat(priceRef||'0') + tickSize, tickSize).toFixed(d))}
                onDown={() => setPriceRef(round(Math.max(0, parseFloat(priceRef||'0') - tickSize), tickSize).toFixed(d))} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8 }}>
              <div />
              <InlineInput
                value={(parseFloat(qty||'0') * parseFloat(priceRef||'0') || 0).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: true })}
                onChange={v => { const n = parseFloat(v.replace(/,/g,'')); const p = parseFloat(priceRef||'0'); if (!isNaN(n) && p > 0) setQty(String(round(n/p, lotSize))) }}
                currency={quoteCurrency}
                onUp={() => setQty(String(round(parseFloat(qty||'0') + lotSize, lotSize)))}
                onDown={() => setQty(String(round(Math.max(0, parseFloat(qty||'0') - lotSize), lotSize)))} />
              <div />
            </div>
          </div>

          {/* TWAP params */}
          {strat === 'TWAP' && <div style={{ background: '#1F1E23', border: `1px solid ${S.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Mode toggle */}
            <div style={{ display: 'flex', height: 32 }}>
              {(['passive', 'aggressive'] as const).map(m => <button key={m} onClick={() => setUrg(m)} style={{
                flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                borderRadius: m === 'passive' ? '4px 0 0 4px' : '0 4px 4px 0',
                background: urg === m ? S.gradAction : '#1a1a22',
                color: urg === m ? '#fff' : S.muted,
                border: urg === m ? 'none' : `1px solid ${S.border}`,
                boxShadow: urg === m ? 'inset 0px 2px 1px rgba(255,255,255,0.15), inset 0px -2px 1px rgba(0,0,0,0.25)' : 'none',
              }}>{m === 'passive' ? 'PASSIVE' : 'AGGRESSIVE'}</button>)}
            </div>
            {/* Duration presets */}
            {lbl('Duration')}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              {DUR_PRESETS.map(dd => <button key={dd} onClick={() => setDur(dd)} style={{ padding: '4px 10px', border: 'none', borderRadius: 4, background: dur === dd ? S.gradAction : S.gradSec, color: dur === dd ? '#fff' : S.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{DUR_LABELS[dd]}</button>)}
              <div style={{ width: 80 }}>
                <InlineInput value={String(dur)} onChange={v => setDur(parseInt(v) || 5)} currency="min"
                  onUp={() => setDur(d => d + 1)} onDown={() => setDur(d => Math.max(1, d - 1))} />
              </div>
            </div>
            {/* Slices */}
            {lbl('Slices')}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {(['auto','manual'] as const).map(m => <button key={m} onClick={() => setTwapSliceMode(m)} style={{
                padding: '0 12px', height: 32, border: 'none', borderRadius: 4,
                background: twapSliceMode === m ? S.gradAction : S.gradSec,
                color: twapSliceMode === m ? '#fff' : S.muted,
                fontSize: 9, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize',
              }}>{m}</button>)}
              <div style={{ width: 100, opacity: twapSliceMode === 'auto' ? 0.4 : 1 }}>
                <InlineInput value={twapSliceMode === 'auto' ? String(dur) : (twapSlices || String(dur))}
                  onChange={v => { if (twapSliceMode === 'manual') setTwapSlices(v) }} currency="#"
                  onUp={() => { if (twapSliceMode === 'manual') setTwapSlices(String(Math.max(2, (parseInt(twapSlices||String(dur))||dur) + 1))) }}
                  onDown={() => { if (twapSliceMode === 'manual') setTwapSlices(String(Math.max(2, (parseInt(twapSlices||String(dur))||dur) - 1))) }} />
              </div>
            </div>
            <div style={{ fontSize: 10, color: S.muted }}>
              Each slice {'\u2248'} <span style={{ color: S.text, fontWeight: 600 }}>{((parseFloat(qty||'0') / Math.max(1, twapSliceMode === 'auto' ? dur : (parseInt(twapSlices)||dur))) || 0).toFixed(2)}</span> {baseCurrency}
            </div>
            {/* Variance row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <span style={{ ...colH, display: 'block', marginBottom: 2 }}>SIZE VARIANCE %</span>
                <span style={{ fontSize: 8, color: S.muted, display: 'block', marginBottom: 4 }}>Randomises slice size</span>
                <div style={{ maxWidth: 120 }}>
                  <InlineInput value={twapSizeVar} onChange={setTwapSizeVar} currency="%"
                    onUp={() => setTwapSizeVar(String(Math.min(50, (parseInt(twapSizeVar)||10) + 5)))}
                    onDown={() => setTwapSizeVar(String(Math.max(0, (parseInt(twapSizeVar)||10) - 5)))} />
                </div>
              </div>
              <div>
                <span style={{ ...colH, display: 'block', marginBottom: 2 }}>TIME VARIANCE %</span>
                <span style={{ fontSize: 8, color: S.muted, display: 'block', marginBottom: 4 }}>Randomises interval</span>
                <div style={{ maxWidth: 120 }}>
                  <InlineInput value={twapTimeVar} onChange={setTwapTimeVar} currency="%"
                    onUp={() => setTwapTimeVar(String(Math.min(50, (parseInt(twapTimeVar)||10) + 5)))}
                    onDown={() => setTwapTimeVar(String(Math.max(0, (parseInt(twapTimeVar)||10) - 5)))} />
                </div>
              </div>
            </div>
            {/* Max Spread */}
            <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
              <div>
                <span style={{ ...colH, display: 'block', marginBottom: 2 }}>MAX SPREAD BPS</span>
                <div style={{ maxWidth: 120 }}>
                  <InlineInput value={twapMaxSpread} onChange={setTwapMaxSpread} currency="bps"
                    onUp={() => setTwapMaxSpread(String((parseInt(twapMaxSpread)||50) + 10))}
                    onDown={() => setTwapMaxSpread(String(Math.max(0, (parseInt(twapMaxSpread)||50) - 10)))} />
                </div>
              </div>
            </div>
          </div>}

          {/* Duration (VWAP, POV only) */}
          {strat === 'VWAP' && <div>{lbl('Duration')}<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {DUR.map(dd => <button key={dd} onClick={() => setDur(dd)} style={{ padding: '4px 10px', border: 'none', borderRadius: 4, background: dur === dd ? S.gradAction : S.gradSec, color: dur === dd ? '#fff' : S.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{dd}m</button>)}
            <input type="number" value={dur} onChange={e => setDur(parseInt(e.target.value) || 5)} style={{ ...inp, width: 60, textAlign: 'center' }} />
          </div></div>}

          {/* Urgency (VWAP only) */}
          {strat === 'VWAP' && <div>{lbl('Urgency')}<div style={{ display: 'flex', gap: 4 }}>
            {(['passive','aggressive'] as const).map(u => <button key={u} onClick={() => setUrg(u)} style={{ flex: 1, padding: '5px 0', border: 'none', borderRadius: 4, background: urg === u ? S.gradAction : S.gradSec, color: urg === u ? '#fff' : S.muted, fontSize: 10, fontWeight: urg === u ? 700 : 400, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' }}>{u}</button>)}
          </div></div>}

          {/* VWAP */}
          {strat === 'VWAP' && <div style={{ background: '#1F1E23', border: `1px solid ${S.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>{lbl('VWAP Mode')}<select value={vwapMode} onChange={e => setVwapMode(e.target.value)} style={sel}><option value="realtime">Realtime</option><option value="benchmark">Benchmark</option><option value="historical">Historical</option></select></div>
            {vwapMode === 'realtime' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}><div>{lbl('Band (bps)')}<input value={bandBps} onChange={e => setBandBps(e.target.value)} style={inp} /></div><div>{lbl('Max Dev (bps)')}<input value={maxDevBps} onChange={e => setMaxDevBps(e.target.value)} style={inp} /></div></div>}
          </div>}

          {/* Sniper */}
          {strat === 'SNIPER' && (() => {
            const q = parseFloat(qty || '0')
            const lvlTotal = levels.reduce((s, l) => s + (parseFloat(l.pct) || 0), 0)
            const allTotal = sniperMode === 'post_snipe' ? (parseFloat(postPct) || 0) + lvlTotal : lvlTotal
            const totalOk = Math.abs(allTotal - 100) < 0.1
            return <div style={{ background: '#1F1E23', border: `1px solid ${S.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Mode toggle — same style as BUY/SELL buttons */}
              <div style={{ display: 'flex', height: 32 }}>
                {(['snipe', 'post_snipe'] as const).map(m => <button key={m} onClick={() => setSniperMode(m)} style={{
                  flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                  borderRadius: m === 'snipe' ? '4px 0 0 4px' : '0 4px 4px 0',
                  background: sniperMode === m ? S.gradAction : '#1a1a22',
                  color: sniperMode === m ? '#fff' : S.muted,
                  border: sniperMode === m ? 'none' : `1px solid ${S.border}`,
                  boxShadow: sniperMode === m ? 'inset 0px 2px 1px rgba(255,255,255,0.15), inset 0px -2px 1px rgba(0,0,0,0.25)' : 'none',
                }}>{m === 'snipe' ? 'SNIPE' : 'POST + SNIPE'}</button>)}
              </div>

              {/* Post section (post_snipe only) */}
              {sniperMode === 'post_snipe' && <div style={{ background: '#181820', border: `1px solid ${S.border}`, borderRadius: 4, padding: 8 }}>
                <div style={{ fontSize: 9, color: S.muted, fontWeight: 700, marginBottom: 6 }}>PASSIVE POST</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, alignItems: 'end' }}>
                  <div>
                    <span style={{ fontSize: 8, color: S.muted }}>Limit Price</span>
                    <InlineInput value={postPx} onChange={setPostPx} currency={quoteCurrency}
                      onUp={() => setPostPx(round(parseFloat(postPx||'0') + tickSize, tickSize).toFixed(d))}
                      onDown={() => setPostPx(round(Math.max(0, parseFloat(postPx||'0') - tickSize), tickSize).toFixed(d))} />
                  </div>
                  <div>
                    <span style={{ fontSize: 8, color: S.muted }}>Post %</span>
                    <InlineInput value={postPct} onChange={v => setPostPct(v)} currency="%"
                      onUp={() => setPostPct(String(Math.min(99, (parseFloat(postPct)||50) + 1)))}
                      onDown={() => setPostPct(String(Math.max(1, (parseFloat(postPct)||50) - 1)))} />
                  </div>
                </div>
                {q > 0 && <div style={{ fontSize: 9, color: S.muted, marginTop: 4 }}>Post size: <span style={{ color: S.text }}>{(q * (parseFloat(postPct)||0) / 100).toFixed(2)}</span> {baseCurrency}</div>}
              </div>}

              {/* Snipe levels */}
              <div>
                <div style={{ fontSize: 9, color: S.muted, fontWeight: 700, marginBottom: 6 }}>
                  {sniperMode === 'snipe' ? 'SNIPE LEVELS' : 'SNIPE LEVELS'}
                </div>
                {levels.map((lv, i) => <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'end' }}>
                  <span style={{ fontSize: 9, color: S.blue, fontWeight: 700, minWidth: 20, paddingBottom: 8 }}>L{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 8, color: S.muted }}>{i === 0 && sniperMode === 'snipe' ? 'Trigger / L1 Price' : 'Price'}</span>
                    <InlineInput value={lv.price}
                      onChange={v => setLevels(p => p.map((l, j) => j === i ? { ...l, price: v } : l))}
                      currency={quoteCurrency}
                      onUp={() => setLevels(p => p.map((l, j) => j === i ? { ...l, price: round(parseFloat(l.price||'0') + tickSize, tickSize).toFixed(d) } : l))}
                      onDown={() => setLevels(p => p.map((l, j) => j === i ? { ...l, price: round(Math.max(0, parseFloat(l.price||'0') - tickSize), tickSize).toFixed(d) } : l))} />
                  </div>
                  <div style={{ width: 70 }}>
                    <span style={{ fontSize: 8, color: S.muted }}>Alloc %</span>
                    <InlineInput value={lv.pct}
                      onChange={v => setLevels(p => p.map((l, j) => j === i ? { ...l, pct: v } : l))}
                      currency="%"
                      onUp={() => setLevels(p => p.map((l, j) => j === i ? { ...l, pct: String(Math.min(100, (parseFloat(l.pct)||0) + 1)) } : l))}
                      onDown={() => setLevels(p => p.map((l, j) => j === i ? { ...l, pct: String(Math.max(1, (parseFloat(l.pct)||0) - 1)) } : l))} />
                  </div>
                  {q > 0 && <span style={{ fontSize: 8, color: S.muted, minWidth: 50, paddingBottom: 8, textAlign: 'right' }}>{(q * (parseFloat(lv.pct)||0) / 100).toFixed(1)}</span>}
                  {levels.length > 1 && <button onClick={() => {
                    const snipePct = sniperMode === 'post_snipe' ? 100 - (parseFloat(postPct) || 50) : 100
                    setLevels(p => splitLevelsEqually(p.filter((_, j) => j !== i), snipePct))
                  }} style={{ background: 'none', border: 'none', color: S.negative, cursor: 'pointer', fontSize: 14, paddingBottom: 6 }}>×</button>}
                </div>)}
                <button onClick={() => {
                  const snipePct = sniperMode === 'post_snipe' ? 100 - (parseFloat(postPct) || 50) : 100
                  setLevels(p => splitLevelsEqually([...p, { price: String(ask), pct: '0' }], snipePct))
                }} style={{ background: S.gradSec, border: `1px solid ${S.border}`, borderRadius: 4, color: S.muted, fontSize: 10, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>+ Add Level</button>
              </div>

              {/* Allocation total */}
              <div style={{ fontSize: 10, color: totalOk ? S.positive : S.negative, fontWeight: 600 }}>
                {sniperMode === 'post_snipe' && `Post: ${postPct}% + `}
                {levels.map((l, i) => `L${i+1}: ${l.pct}%`).join(' + ')}
                {` = ${allTotal.toFixed(0)}% `}
                {totalOk ? '✓' : '✗'}
              </div>
            </div>
          })()}

          {/* Iceberg */}
          {strat === 'ICEBERG' && <div style={{ background: '#1F1E23', border: `1px solid ${S.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Qty presets */}
            {qtyPresets && qtyPresets.length > 0 && <div style={{ display: 'flex', gap: 4 }}>
              {qtyPresets.map(p => <button key={p} onClick={() => setQty(String(p))} style={{ padding: '3px 10px', border: 'none', borderRadius: 4, background: qty === String(p) ? S.gradAction : S.gradSec, color: qty === String(p) ? '#fff' : S.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{p}</button>)}
            </div>}
            {/* Slices + mode — single row, buttons aligned with input */}
            {lbl('Slices')}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {(['auto','manual'] as const).map(m => <button key={m} onClick={() => setIceSliceMode(m)} style={{
                padding: '0 12px', height: 32, border: 'none', borderRadius: 4,
                background: iceSliceMode === m ? S.gradAction : S.gradSec,
                color: iceSliceMode === m ? '#fff' : S.muted,
                fontSize: 9, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize',
              }}>{m}</button>)}
              <div style={{ width: 120, opacity: iceSliceMode === 'auto' ? 0.4 : 1 }}>
                <InlineInput value={iceSlices}
                  onChange={v => { if (iceSliceMode === 'manual') setIceSlices(v) }}
                  currency="#"
                  onUp={() => { if (iceSliceMode === 'manual') setIceSlices(String(Math.max(1, (parseInt(iceSlices)||10) + 1))) }}
                  onDown={() => { if (iceSliceMode === 'manual') setIceSlices(String(Math.max(1, (parseInt(iceSlices)||10) - 1))) }} />
              </div>
            </div>
            <div style={{ fontSize: 10, color: S.muted }}>
              Each slice {'\u2248'} <span style={{ color: S.text, fontWeight: 600 }}>{((parseFloat(qty||'0') / Math.max(1, parseInt(iceSlices)||10)) || 0).toFixed(2)}</span> {baseCurrency}
            </div>
            {/* Size variance */}
            <div>
              <span style={{ ...colH, display: 'block', marginBottom: 2 }}>SIZE VARIANCE %</span>
              <span style={{ fontSize: 8, color: S.muted, display: 'block', marginBottom: 4 }}>Randomises slice size ± this %</span>
              <div style={{ maxWidth: 140 }}>
                <InlineInput value={visVar} onChange={setVisVar} currency="%"
                  onUp={() => setVisVar(String(Math.min(50, (parseInt(visVar)||20) + 5)))}
                  onDown={() => setVisVar(String(Math.max(0, (parseInt(visVar)||20) - 5)))} />
              </div>
            </div>
            {/* Expiry */}
            <div>
              {lbl('Expiry')}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {(['GTC','Day','GTD'] as const).map(e => <button key={e} onClick={() => setIceExpiry(e)} style={{
                  padding: '5px 12px', border: 'none', borderRadius: 4,
                  background: iceExpiry === e ? S.gradAction : S.gradSec,
                  color: iceExpiry === e ? '#fff' : S.muted,
                  fontSize: 10, fontWeight: iceExpiry === e ? 700 : 400, cursor: 'pointer', fontFamily: 'inherit',
                }}>{e === 'Day' ? 'End of Day' : e}</button>)}
              </div>
              {iceExpiry === 'GTD' && <input type="datetime-local" value={iceGtdTime} onChange={e => setIceGtdTime(e.target.value)}
                style={{ ...inp, marginTop: 6, colorScheme: 'dark', maxWidth: 220 }} />}
            </div>
          </div>}

          {/* POV */}
          {strat === 'POV' && <div style={{ background: '#1F1E23', border: `1px solid ${S.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Mode toggle */}
            <div style={{ display: 'flex', height: 32 }}>
              {(['pure', 'time_limited', 'hybrid'] as const).map((m, i) => <button key={m} onClick={() => setPovMode(m)} style={{
                flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 700,
                borderRadius: i === 0 ? '4px 0 0 4px' : i === 2 ? '0 4px 4px 0' : '0',
                background: povMode === m ? S.gradAction : '#1a1a22',
                color: povMode === m ? '#fff' : S.muted,
                border: povMode === m ? 'none' : `1px solid ${S.border}`,
                boxShadow: povMode === m ? 'inset 0px 2px 1px rgba(255,255,255,0.15), inset 0px -2px 1px rgba(0,0,0,0.25)' : 'none',
              }}>{m === 'pure' ? 'PURE' : m === 'time_limited' ? 'TIME LIMITED' : 'HYBRID'}</button>)}
            </div>
            {/* Duration — only for TIME LIMITED / HYBRID */}
            {povMode !== 'pure' && <div>
              {lbl('Duration')}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                {DUR_PRESETS.map(dd => <button key={dd} onClick={() => setDur(dd)} style={{ padding: '4px 10px', border: 'none', borderRadius: 4, background: dur === dd ? S.gradAction : S.gradSec, color: dur === dd ? '#fff' : S.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{DUR_LABELS[dd]}</button>)}
                <div style={{ width: 80 }}>
                  <InlineInput value={String(dur)} onChange={v => setDur(parseInt(v) || 5)} currency="min"
                    onUp={() => setDur(d => d + 1)} onDown={() => setDur(d => Math.max(1, d - 1))} />
                </div>
              </div>
            </div>}
            {/* Urgency toggle */}
            <div style={{ display: 'flex', height: 32 }}>
              {(['passive', 'aggressive'] as const).map(m => <button key={m} onClick={() => setUrg(m)} style={{
                flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                borderRadius: m === 'passive' ? '4px 0 0 4px' : '0 4px 4px 0',
                background: urg === m ? S.gradAction : '#1a1a22',
                color: urg === m ? '#fff' : S.muted,
                border: urg === m ? 'none' : `1px solid ${S.border}`,
                boxShadow: urg === m ? 'inset 0px 2px 1px rgba(255,255,255,0.15), inset 0px -2px 1px rgba(0,0,0,0.25)' : 'none',
              }}>{m === 'passive' ? 'PASSIVE' : 'AGGRESSIVE'}</button>)}
            </div>
            {/* Participation + Spread */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                {lbl('Target Participation %')}
                <InlineInput value={povPct} onChange={setPovPct} currency="%"
                  onUp={() => setPovPct(String(Math.min(50, (parseInt(povPct)||10) + 1)))}
                  onDown={() => setPovPct(String(Math.max(1, (parseInt(povPct)||10) - 1)))} />
              </div>
              <div>
                {lbl('Max Spread bps')}
                <InlineInput value={twapMaxSpread} onChange={setTwapMaxSpread} currency="bps"
                  onUp={() => setTwapMaxSpread(String((parseInt(twapMaxSpread)||50) + 10))}
                  onDown={() => setTwapMaxSpread(String(Math.max(0, (parseInt(twapMaxSpread)||50) - 10)))} />
              </div>
            </div>
            {/* Min/Max Child Size */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                {lbl('Min Child Size')}
                <InlineInput value={povMinChild} onChange={setPovMinChild} currency={baseCurrency}
                  onUp={() => setPovMinChild(String((parseFloat(povMinChild)||lotSize*2) + lotSize))}
                  onDown={() => setPovMinChild(String(Math.max(lotSize, (parseFloat(povMinChild)||lotSize*2) - lotSize)))} />
              </div>
              <div>
                {lbl('Max Child Size')}
                <InlineInput value={povMaxChild} onChange={setPovMaxChild} currency={baseCurrency}
                  onUp={() => setPovMaxChild(String((parseFloat(povMaxChild)||0) + lotSize))}
                  onDown={() => setPovMaxChild(String(Math.max(0, (parseFloat(povMaxChild)||0) - lotSize)))} />
                <span style={{ fontSize: 8, color: S.muted }}>0 = no cap</span>
              </div>
            </div>
          </div>}

          {/* Limit — not shown for Iceberg or Sniper */}
          {strat !== 'ICEBERG' && strat !== 'SNIPER' && <div>{lbl('Limit')}<div style={{ display: 'flex', gap: 4 }}>
            {['none','market_limit','average_rate'].map(m => <button key={m} onClick={() => setLimMode(m)} style={{ flex: 1, padding: '5px 0', border: 'none', borderRadius: 4, background: limMode === m ? S.gradAction : S.gradSec, color: limMode === m ? '#fff' : S.muted, fontSize: 9, cursor: 'pointer', fontFamily: 'inherit' }}>{m === 'none' ? 'None' : m === 'market_limit' ? 'Mkt Limit' : 'Avg Rate'}</button>)}
          </div>{limMode !== 'none' && <input value={limPx} onChange={e => setLimPx(e.target.value)} placeholder="Limit price" style={{ ...inp, marginTop: 6 }} />}</div>}

          {/* Start */}
          <div>{lbl('Start')}<div style={{ display: 'flex', gap: 4 }}>
            {(['immediate','scheduled','trigger'] as StartMode[]).map(m => <button key={m} onClick={() => setStartMode(m)} style={{ flex: 1, padding: '5px 0', border: 'none', borderRadius: 4, background: startMode === m ? S.gradAction : S.gradSec, color: startMode === m ? '#fff' : S.muted, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' }}>{m}</button>)}
          </div>
          {startMode === 'scheduled' && <div style={{ marginTop: 8 }}>
            <input type="datetime-local" value={schedTime} onChange={e => setSchedTime(e.target.value)}
              style={{ ...inp, colorScheme: 'dark' }} />
          </div>}
          {startMode === 'trigger' && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <select value={trigDir} onChange={e => setTrigDir(e.target.value as 'above' | 'below')} style={{ ...sel, width: 120 }}>
              <option value="above">Price Above</option>
              <option value="below">Price Below</option>
            </select>
            <input value={trigPx} onChange={e => setTrigPx(e.target.value)} placeholder="Trigger price" style={inp} />
          </div>}
          </div>

          {error && <div style={{ background: 'rgba(251,44,54,0.1)', border: '1px solid rgba(251,44,54,0.3)', borderRadius: 4, padding: '8px 12px', fontSize: 11, color: S.negative }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '9px 0', border: `1px solid ${S.border}`, borderRadius: 4, background: 'transparent', color: S.muted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
            <button onClick={handleSubmit} disabled={submitting} style={{ flex: 2, padding: '9px 0', border: 'none', borderRadius: 4, background: S.gradAction, color: '#fff', fontSize: 12, fontWeight: 700, cursor: submitting ? 'wait' : 'pointer', fontFamily: 'inherit', boxShadow: 'inset 0px 3px 1px rgba(255,255,255,0.2), inset 0px -3px 1px rgba(0,0,0,0.3)' }}>
              {submitting ? 'Launching...' : `Launch ${strat} ${side}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
