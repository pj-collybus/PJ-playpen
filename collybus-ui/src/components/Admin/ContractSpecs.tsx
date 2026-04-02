import { useEffect, useState, useMemo } from 'react'
import { contractSpecsApi } from '../../services/apiClient'

interface ContractSpec {
  symbol: string
  exchange: string
  contractType: string
  baseCurrency: string
  quoteCurrency: string
  settleCurrency: string
  tickSize: number
  lotSize: number
  minOrderSize: number
  isPerp: boolean
  isInverse: boolean
}

const EXCHANGE_COLORS: Record<string, string> = {
  DERIBIT: '#e03040', BITMEX: '#4a90d9', BINANCE: '#f0b90b',
  BYBIT: '#f7a600', OKX: '#aaaaaa', KRAKEN: '#8d5ff0',
}

const TYPE_COLORS: Record<string, string> = {
  LINEAR: '#2B79DD', INVERSE: '#f7a600', SPOT: '#00C758', OPTION: '#8d5ff0',
}

export function ContractSpecs() {
  const [specs, setSpecs] = useState<ContractSpec[]>([])
  const [loading, setLoading] = useState(true)
  const [filterAsset, setFilterAsset] = useState('All assets')
  const [filterExchange, setFilterExchange] = useState('All exchanges')
  const [filterType, setFilterType] = useState('All types')
  const [search, setSearch] = useState('')

  useEffect(() => {
    contractSpecsApi.getAll().then(r => { setSpecs(r.data); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  const assets = useMemo(() => ['All assets', ...Array.from(new Set(specs.map(s => s.baseCurrency).filter(Boolean))).sort()], [specs])
  const exchanges = useMemo(() => ['All exchanges', ...Array.from(new Set(specs.map(s => s.exchange).filter(Boolean))).sort()], [specs])
  const types = useMemo(() => ['All types', ...Array.from(new Set(specs.map(s => s.contractType).filter(Boolean))).sort()], [specs])

  const filtered = useMemo(() => specs.filter(s => {
    if (filterAsset !== 'All assets' && s.baseCurrency !== filterAsset) return false
    if (filterExchange !== 'All exchanges' && s.exchange !== filterExchange) return false
    if (filterType !== 'All types' && s.contractType !== filterType) return false
    if (search && !s.symbol.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [specs, filterAsset, filterExchange, filterType, search])

  const inputStyle: React.CSSProperties = {
    background: '#141414', border: '1px solid #363C4E', borderRadius: 4,
    color: 'rgba(255,255,255,0.85)', fontSize: 11, padding: '5px 10px',
    outline: 'none', fontFamily: 'inherit', cursor: 'pointer',
  }
  const thStyle: React.CSSProperties = {
    padding: '8px 12px', fontSize: 9, fontWeight: 700, color: '#636e82',
    letterSpacing: '0.07em', textTransform: 'uppercase', textAlign: 'left',
    borderBottom: '1px solid #363C4E', whiteSpace: 'nowrap',
  }
  const tdStyle: React.CSSProperties = {
    padding: '7px 12px', fontSize: 11, color: 'rgba(255,255,255,0.85)',
    borderBottom: '1px solid #1a1a24', whiteSpace: 'nowrap',
  }

  return (
    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', height: '100%' }}>
      <div style={{ background: 'linear-gradient(to bottom, #1F1E23, #1E1D22, #1B1A1F)', border: '1.25px solid #363C4E', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #363C4E', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.85)', letterSpacing: '0.07em', textTransform: 'uppercase', marginRight: 8 }}>
            Contract Specifications
          </span>
          <span style={{ fontSize: 10, color: '#636e82' }}>
            {loading ? 'Loading...' : `${filtered.length.toLocaleString()} of ${specs.length.toLocaleString()} instruments`}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, color: '#636e82', fontWeight: 700, textTransform: 'uppercase' }}>Filter:</span>
            <select value={filterAsset} onChange={e => setFilterAsset(e.target.value)} style={inputStyle}>
              {assets.map(a => <option key={a}>{a}</option>)}
            </select>
            <select value={filterExchange} onChange={e => setFilterExchange(e.target.value)} style={inputStyle}>
              {exchanges.map(e => <option key={e}>{e}</option>)}
            </select>
            <select value={filterType} onChange={e => setFilterType(e.target.value)} style={inputStyle}>
              {types.map(t => <option key={t}>{t}</option>)}
            </select>
            <input placeholder="search..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ ...inputStyle, width: 140, cursor: 'text' }} />
          </div>
        </div>

        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead style={{ position: 'sticky', top: 0, background: '#1D1D1D', zIndex: 1 }}>
              <tr>
                {['Instrument', 'Exchange', 'Type', 'Contract Size', 'Tick Size', 'Min Order', 'Base', 'Quote', 'Settle'].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: '#636e82', padding: '40px' }}>Loading contract specifications from all exchanges...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} style={{ ...tdStyle, textAlign: 'center', color: '#636e82', padding: '40px' }}>No instruments match the current filters</td></tr>
              ) : filtered.slice(0, 500).map((s, i) => (
                <tr key={`${s.exchange}-${s.symbol}-${i}`}
                  style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(43,121,221,0.08)')}
                  onMouseLeave={e => (e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)')}
                >
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{s.symbol}</td>
                  <td style={tdStyle}>
                    <span style={{ background: `${EXCHANGE_COLORS[s.exchange] ?? '#555'}22`, color: EXCHANGE_COLORS[s.exchange] ?? '#888',
                      border: `1px solid ${EXCHANGE_COLORS[s.exchange] ?? '#555'}44`, borderRadius: 3, padding: '1px 6px', fontSize: 9, fontWeight: 700 }}>{s.exchange}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ background: `${TYPE_COLORS[s.contractType] ?? '#555'}22`, color: TYPE_COLORS[s.contractType] ?? '#888',
                      border: `1px solid ${TYPE_COLORS[s.contractType] ?? '#555'}44`, borderRadius: 3, padding: '1px 5px', fontSize: 9, fontWeight: 700 }}>{s.contractType}</span>
                  </td>
                  <td style={tdStyle}>{s.lotSize > 0 ? `${s.lotSize} ${s.baseCurrency}` : '—'}</td>
                  <td style={tdStyle}>{s.tickSize > 0 ? s.tickSize.toLocaleString('en-US', { maximumSignificantDigits: 4 }) : '—'}</td>
                  <td style={tdStyle}>{s.minOrderSize > 0 ? `${s.minOrderSize} ${s.baseCurrency}` : '—'}</td>
                  <td style={{ ...tdStyle, color: '#636e82' }}>{s.baseCurrency || '—'}</td>
                  <td style={{ ...tdStyle, color: '#636e82' }}>{s.quoteCurrency || '—'}</td>
                  <td style={{ ...tdStyle, color: '#636e82' }}>{s.settleCurrency || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 500 && (
            <div style={{ padding: '12px 16px', fontSize: 10, color: '#636e82', textAlign: 'center', borderTop: '1px solid #363C4E' }}>
              Showing 500 of {filtered.length.toLocaleString()} results — use filters to narrow down
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
