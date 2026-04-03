import { useState, useRef, useEffect } from 'react'

export interface AlgoModalProps {
  exchange: string; symbol: string; baseCurrency: string; quoteCurrency: string
  tickSize: number; lotSize: number; bid: number; ask: number; mid: number
  initialSide?: 'BUY' | 'SELL'; initialQty?: number
  onSubmit: (params: AlgoLaunchParams) => Promise<string>
  onClose: () => void
}

export interface AlgoLaunchParams {
  strategyType: string; exchange: string; symbol: string; side: string
  totalSize: number; tickSize: number; lotSize: number
  arrivalMid: number; arrivalBid: number; arrivalAsk: number
  durationMinutes?: number; urgency?: string; numSlices?: number
  limitPrice?: number; limitMode?: string; startMode?: string
  triggerPrice?: number; triggerDirection?: string; maxSpreadBps?: number
  vwapMode?: string; participationBandBps?: number; maxDeviationBps?: number
  sniperMode?: string; levelMode?: string; retriggerMode?: string
  levels?: { index: number; price: number; allocationPct: number; enabled: boolean }[]
  icebergSnipe?: boolean; sniperSlicePct?: number
  postPrice?: number; snipeCeiling?: number; snipeCap?: number
  visibleSize?: number; visibleVariancePct?: number
  participationPct?: number; volumeWindowSeconds?: number
}

type StrategyType = 'TWAP' | 'VWAP' | 'SNIPER' | 'ICEBERG' | 'POV'
type Urgency = 'passive' | 'balanced' | 'aggressive'
type StartMode = 'immediate' | 'scheduled' | 'trigger'

const S = {
  bg: '#18171C', panel: '#1F1E23', border: '#2a2a38',
  gradAction: 'linear-gradient(to right, #1A3A94 0%, #2B79DD 100%)',
  gradSec: 'linear-gradient(to bottom, #3C3B42 0%, #2B2A2F 100%)',
  positive: '#00C758', negative: '#FB2C36',
  text: 'rgba(255,255,255,0.85)', muted: '#636e82', blue: '#2B79DD',
}

const STRATS: { type: StrategyType; label: string }[] = [
  { type: 'TWAP', label: 'TWAP' }, { type: 'VWAP', label: 'VWAP' },
  { type: 'SNIPER', label: 'Sniper' }, { type: 'ICEBERG', label: 'Iceberg' },
  { type: 'POV', label: 'POV' },
]
const DUR_PRESETS = [1, 5, 10, 15, 30]
const URG_OPTS: Urgency[] = ['passive', 'balanced', 'aggressive']

const lbl = (t: string) => <span style={{ fontSize: 9, color: S.muted, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, display: 'block', marginBottom: 4 }}>{t}</span>
const inp: React.CSSProperties = { background: '#0e0e14', border: `1px solid ${S.border}`, borderRadius: 4, color: S.text, fontSize: 11, padding: '5px 8px', outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }
const sel: React.CSSProperties = { ...inp, cursor: 'pointer' }

let savedPos: { x: number; y: number } | null = null

export function AlgoModal({ exchange, symbol, baseCurrency, tickSize, lotSize, bid, ask, mid, initialSide = 'BUY', initialQty, onSubmit, onClose }: AlgoModalProps) {
  const [strat, setStrat] = useState<StrategyType>('TWAP')
  const [side, setSide] = useState<'BUY' | 'SELL'>(initialSide)
  const [qty, setQty] = useState(initialQty?.toString() ?? '')
  const [dur, setDur] = useState(5)
  const [urg, setUrg] = useState<Urgency>('balanced')
  const [startMode, setStartMode] = useState<StartMode>('immediate')
  const [trigPx, setTrigPx] = useState('')
  const [trigDir, setTrigDir] = useState<'above' | 'below'>('below')
  const [limMode, setLimMode] = useState('none')
  const [limPx, setLimPx] = useState('')
  const [vwapMode, setVwapMode] = useState('realtime')
  const [bandBps, setBandBps] = useState('20')
  const [maxDevBps, setMaxDevBps] = useState('50')
  const [sniperMode, setSniperMode] = useState('snipe')
  const [levelMode, setLevelMode] = useState('sequential')
  const [levels, setLevels] = useState([{ index: 0, price: String(bid), allocationPct: '100', enabled: true }])
  const [retrigger, setRetrigger] = useState('same')
  const [snipeCap, setSnipeCap] = useState('50')
  const [postPx, setPostPx] = useState(String(bid))
  const [snipeCeil, setSnipeCeil] = useState(String(ask))
  const [visSz, setVisSz] = useState('')
  const [visVar, setVisVar] = useState('20')
  const [povPct, setPovPct] = useState('10')
  const [volWin, setVolWin] = useState('60')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [pos, setPos] = useState(savedPos ?? { x: Math.max(0, (window.innerWidth - 500) / 2), y: Math.max(0, (window.innerHeight - 600) / 2) })
  const dragRef = useRef<{ ox: number; oy: number } | null>(null)
  useEffect(() => { savedPos = pos }, [pos])

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const q = parseFloat(qty); if (!q || q <= 0) throw new Error('Invalid quantity')
      const p: AlgoLaunchParams = {
        strategyType: strat, exchange, symbol, side, totalSize: q, tickSize, lotSize,
        arrivalMid: mid, arrivalBid: bid, arrivalAsk: ask,
        durationMinutes: ['TWAP','VWAP','ICEBERG','POV'].includes(strat) ? dur : undefined,
        urgency: ['TWAP','VWAP'].includes(strat) ? urg : undefined,
        startMode, triggerPrice: startMode === 'trigger' ? parseFloat(trigPx) : undefined,
        triggerDirection: startMode === 'trigger' ? trigDir : undefined,
        limitMode: limMode !== 'none' ? limMode : undefined,
        limitPrice: limMode !== 'none' && limPx ? parseFloat(limPx) : undefined,
        vwapMode: strat === 'VWAP' ? vwapMode : undefined,
        participationBandBps: strat === 'VWAP' ? parseFloat(bandBps) : undefined,
        maxDeviationBps: strat === 'VWAP' ? parseFloat(maxDevBps) : undefined,
        sniperMode: strat === 'SNIPER' ? sniperMode : undefined,
        levelMode: strat === 'SNIPER' ? levelMode : undefined,
        levels: strat === 'SNIPER' ? levels.map((l, i) => ({ index: i, price: parseFloat(l.price), allocationPct: parseFloat(l.allocationPct), enabled: l.enabled })) : undefined,
        retriggerMode: strat === 'SNIPER' ? retrigger : undefined,
        snipeCap: sniperMode === 'post_snipe' ? parseFloat(snipeCap) : undefined,
        postPrice: sniperMode === 'post_snipe' ? parseFloat(postPx) : undefined,
        snipeCeiling: sniperMode === 'post_snipe' ? parseFloat(snipeCeil) : undefined,
        visibleSize: strat === 'ICEBERG' && visSz ? parseFloat(visSz) : undefined,
        visibleVariancePct: strat === 'ICEBERG' ? parseFloat(visVar) : undefined,
        participationPct: strat === 'POV' ? parseFloat(povPct) : undefined,
        volumeWindowSeconds: strat === 'POV' ? parseInt(volWin) : undefined,
      }
      await onSubmit(p); setError(''); onClose()
    } catch (e: any) { setError(e.message ?? 'Failed') } finally { setSubmitting(false) }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 600, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: pos.x, top: pos.y, width: 480, maxHeight: '90vh', overflowY: 'auto', background: S.bg, border: `1px solid ${S.border}`, borderRadius: 10, boxShadow: '0 20px 60px rgba(0,0,0,0.9)', pointerEvents: 'all' }}>
        {/* Header */}
        <div onMouseDown={e => { if ((e.target as HTMLElement).closest('button,input,select')) return; e.preventDefault(); dragRef.current = { ox: e.clientX - pos.x, oy: e.clientY - pos.y }; const mv = (ev: MouseEvent) => { if (!dragRef.current) return; setPos({ x: ev.clientX - dragRef.current.ox, y: ev.clientY - dragRef.current.oy }) }; const up = () => { dragRef.current = null; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up) }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up) }} style={{ padding: '14px 16px 0', cursor: 'grab' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: S.text }}>Algo Order <span style={{ fontWeight: 400, color: S.muted }}>on</span> {exchange}</div>
              <div style={{ fontSize: 11, color: S.muted, marginTop: 2 }}>{symbol}</div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 18, lineHeight: 1, fontFamily: 'inherit' }}>×</button>
          </div>
          <div style={{ display: 'flex', borderBottom: `1px solid ${S.border}` }}>
            {STRATS.map(s => <button key={s.type} onClick={() => setStrat(s.type)} style={{ padding: '7px 14px', border: 'none', background: 'none', borderBottom: s.type === strat ? `2px solid ${S.blue}` : '2px solid transparent', color: s.type === strat ? S.blue : S.muted, fontSize: 11, fontWeight: s.type === strat ? 600 : 400, cursor: 'pointer', fontFamily: 'inherit' }}>{s.label}</button>)}
          </div>
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Side + Qty */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              {lbl('Side')}
              <div style={{ display: 'flex', height: 32 }}>
                {(['SELL','BUY'] as const).map(s => <button key={s} onClick={() => setSide(s)} style={{ flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, borderRadius: s === 'SELL' ? '4px 0 0 4px' : '0 4px 4px 0', background: side === s ? (s === 'BUY' ? 'rgba(0,199,88,0.25)' : 'rgba(251,44,54,0.25)') : '#1a1a22', color: side === s ? (s === 'BUY' ? S.positive : S.negative) : S.muted, border: `1px solid ${side === s ? (s === 'BUY' ? 'rgba(0,199,88,0.4)' : 'rgba(251,44,54,0.4)') : S.border}` }}>{s}</button>)}
              </div>
            </div>
            <div>{lbl(`Total Size (${baseCurrency})`)}<input value={qty} onChange={e => setQty(e.target.value)} placeholder="0" style={inp} /></div>
          </div>

          <div style={{ display: 'flex', gap: 16, fontSize: 10, color: S.muted }}>
            <span>Bid: <span style={{ color: S.positive }}>{bid}</span></span>
            <span>Ask: <span style={{ color: S.negative }}>{ask}</span></span>
            <span>Mid: <span style={{ color: S.text }}>{mid}</span></span>
          </div>

          {['TWAP','VWAP','ICEBERG','POV'].includes(strat) && <div>{lbl('Duration')}<div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {DUR_PRESETS.map(d => <button key={d} onClick={() => setDur(d)} style={{ padding: '4px 10px', border: 'none', borderRadius: 4, background: dur === d ? S.gradAction : S.gradSec, color: dur === d ? '#fff' : S.muted, fontSize: 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{d}m</button>)}
            <input type="number" value={dur} onChange={e => setDur(parseInt(e.target.value) || 5)} style={{ ...inp, width: 60, textAlign: 'center' }} />
          </div></div>}

          {['TWAP','VWAP'].includes(strat) && <div>{lbl('Urgency')}<div style={{ display: 'flex', gap: 4 }}>
            {URG_OPTS.map(u => <button key={u} onClick={() => setUrg(u)} style={{ flex: 1, padding: '5px 0', border: 'none', borderRadius: 4, background: urg === u ? S.gradAction : S.gradSec, color: urg === u ? '#fff' : S.muted, fontSize: 10, fontWeight: urg === u ? 700 : 400, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' }}>{u}</button>)}
          </div></div>}

          {strat === 'VWAP' && <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>{lbl('VWAP Mode')}<select value={vwapMode} onChange={e => setVwapMode(e.target.value)} style={sel}><option value="realtime">Realtime</option><option value="benchmark">Benchmark</option><option value="historical">Historical</option></select></div>
            {vwapMode === 'realtime' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}><div>{lbl('Band (bps)')}<input value={bandBps} onChange={e => setBandBps(e.target.value)} style={inp} /></div><div>{lbl('Max Dev (bps)')}<input value={maxDevBps} onChange={e => setMaxDevBps(e.target.value)} style={inp} /></div></div>}
          </div>}

          {strat === 'SNIPER' && <div style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>{lbl('Mode')}<select value={sniperMode} onChange={e => setSniperMode(e.target.value)} style={sel}><option value="snipe">Snipe</option><option value="post_snipe">Post+Snipe</option></select></div>
              <div>{lbl('Level Mode')}<select value={levelMode} onChange={e => setLevelMode(e.target.value)} style={sel}><option value="sequential">Sequential</option><option value="simultaneous">Simultaneous</option></select></div>
            </div>
            {sniperMode === 'snipe' && <>{lbl('Levels')}{levels.map((lv, i) => <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={lv.enabled} onChange={e => setLevels(p => p.map((l, j) => j === i ? { ...l, enabled: e.target.checked } : l))} />
              <input value={lv.price} placeholder="Price" onChange={e => setLevels(p => p.map((l, j) => j === i ? { ...l, price: e.target.value } : l))} style={{ ...inp, width: 100 }} />
              <input value={lv.allocationPct} placeholder="%" onChange={e => setLevels(p => p.map((l, j) => j === i ? { ...l, allocationPct: e.target.value } : l))} style={{ ...inp, width: 50 }} />
              <span style={{ fontSize: 10, color: S.muted }}>%</span>
              {levels.length > 1 && <button onClick={() => setLevels(p => p.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: S.negative, cursor: 'pointer', fontSize: 14 }}>×</button>}
            </div>)}
            <button onClick={() => setLevels(p => [...p, { index: p.length, price: '', allocationPct: '', enabled: true }])} style={{ background: S.gradSec, border: `1px solid ${S.border}`, borderRadius: 4, color: S.muted, fontSize: 10, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit' }}>+ Level</button>
            <div>{lbl('Retrigger')}<select value={retrigger} onChange={e => setRetrigger(e.target.value)} style={sel}><option value="same">Same price</option><option value="better">Better price</option><option value="vwap">VWAP chase</option></select></div></>}
            {sniperMode === 'post_snipe' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div>{lbl('Post Price')}<input value={postPx} onChange={e => setPostPx(e.target.value)} style={inp} /></div>
              <div>{lbl('Snipe Ceiling')}<input value={snipeCeil} onChange={e => setSnipeCeil(e.target.value)} style={inp} /></div>
              <div>{lbl('Snipe Cap %')}<input value={snipeCap} onChange={e => setSnipeCap(e.target.value)} style={inp} /></div>
            </div>}
          </div>}

          {strat === 'ICEBERG' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: 10 }}>
            <div>{lbl('Visible Size')}<input value={visSz} onChange={e => setVisSz(e.target.value)} placeholder="Auto" style={inp} /></div>
            <div>{lbl('Variance %')}<input value={visVar} onChange={e => setVisVar(e.target.value)} style={inp} /></div>
          </div>}

          {strat === 'POV' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, background: S.panel, border: `1px solid ${S.border}`, borderRadius: 6, padding: 10 }}>
            <div>{lbl('Participation %')}<input value={povPct} onChange={e => setPovPct(e.target.value)} style={inp} /></div>
            <div>{lbl('Volume Window (s)')}<input value={volWin} onChange={e => setVolWin(e.target.value)} style={inp} /></div>
          </div>}

          <div>{lbl('Limit')}<div style={{ display: 'flex', gap: 4 }}>
            {['none','market_limit','average_rate'].map(m => <button key={m} onClick={() => setLimMode(m)} style={{ flex: 1, padding: '5px 0', border: 'none', borderRadius: 4, background: limMode === m ? S.gradAction : S.gradSec, color: limMode === m ? '#fff' : S.muted, fontSize: 9, cursor: 'pointer', fontFamily: 'inherit' }}>{m === 'none' ? 'None' : m === 'market_limit' ? 'Mkt Limit' : 'Avg Rate'}</button>)}
          </div>{limMode !== 'none' && <input value={limPx} onChange={e => setLimPx(e.target.value)} placeholder="Limit price" style={{ ...inp, marginTop: 6 }} />}</div>

          <div>{lbl('Start')}<div style={{ display: 'flex', gap: 4 }}>
            {(['immediate','scheduled','trigger'] as StartMode[]).map(m => <button key={m} onClick={() => setStartMode(m)} style={{ flex: 1, padding: '5px 0', border: 'none', borderRadius: 4, background: startMode === m ? S.gradAction : S.gradSec, color: startMode === m ? '#fff' : S.muted, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' }}>{m}</button>)}
          </div>
          {startMode === 'trigger' && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <select value={trigDir} onChange={e => setTrigDir(e.target.value as 'above' | 'below')} style={{ ...sel, width: 90 }}><option value="above">Above</option><option value="below">Below</option></select>
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
