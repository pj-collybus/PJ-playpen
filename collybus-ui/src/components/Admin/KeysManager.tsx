import { useEffect, useState } from 'react'
import { api } from '../../services/apiClient'

interface KeyEntrySafe {
  id: string
  exchange: string
  label: string
  testnet: boolean
  permissions: string
  status: string
  lastTested: string | null
  fields: Record<string, string | null>
}

const FIELD_DEFS: Record<string, { label: string; fields: string[]; testnetOption: boolean }> = {
  DERIBIT: { label: 'Deribit', fields: ['clientId', 'clientSecret'], testnetOption: true },
  BITMEX: { label: 'BitMEX', fields: ['apiKey', 'apiSecret'], testnetOption: true },
  BINANCE: { label: 'Binance', fields: ['apiKey', 'secretKey'], testnetOption: false },
  BYBIT: { label: 'Bybit', fields: ['apiKey', 'secretKey'], testnetOption: true },
  OKX: { label: 'OKX', fields: ['apiKey', 'secretKey', 'passphrase'], testnetOption: true },
  KRAKEN: { label: 'Kraken', fields: ['apiKey', 'privateKey'], testnetOption: false },
}

const inputStyle: React.CSSProperties = {
  background: '#141414', border: '1px solid #363C4E', borderRadius: 4,
  color: 'rgba(255,255,255,0.85)', fontSize: 12, padding: '6px 10px',
  outline: 'none', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
}

export function KeysManager() {
  const [keys, setKeys] = useState<KeyEntrySafe[]>([])
  const [adding, setAdding] = useState(false)
  const [newExchange, setNewExchange] = useState('DERIBIT')
  const [newLabel, setNewLabel] = useState('')
  const [newFields, setNewFields] = useState<Record<string, string>>({})
  const [newTestnet, setNewTestnet] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [saving, setSaving] = useState(false)

  const load = () => api.get('/keys').then(r => setKeys(r.data.keys ?? [])).catch(() => {})
  useEffect(() => { load() }, [])

  const fieldDef = FIELD_DEFS[newExchange]

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.post('/keys', {
        exchange: newExchange,
        label: newLabel || newExchange,
        fields: newFields,
        testnet: newTestnet,
      })
      setAdding(false)
      setNewFields({})
      setNewLabel('')
      load()
    } catch (e) {
      console.error(e)
    } finally { setSaving(false) }
  }

  const handleTest = async (id: string) => {
    setTesting(id)
    try {
      const r = await api.post(`/keys/${id}/test`, {})
      setTestResult(prev => ({ ...prev, [id]: { ok: r.data.ok, message: r.data.message ?? 'Connected' } }))
      load()
    } catch {
      setTestResult(prev => ({ ...prev, [id]: { ok: false, message: 'Connection failed' } }))
    } finally { setTesting(null) }
  }

  const handleDelete = async (id: string) => {
    await api.delete(`/keys/${id}`)
    load()
  }

  const handleSubscribePrivate = async (exchange: string) => {
    try {
      await api.post('/keys/subscribe-private', { exchanges: [exchange] })
    } catch (e) { console.error(e) }
  }

  return (
    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', flex: 1 }}>

      {/* Existing keys */}
      {keys.map(key => (
        <div key={key.id} style={{
          background: '#1F1E23', border: '1px solid #363C4E', borderRadius: 8,
          padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: 'white' }}>{key.label}</span>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                background: 'rgba(43,121,221,0.15)', color: '#2B79DD', border: '1px solid rgba(43,121,221,0.3)',
              }}>{key.exchange}</span>
              {key.testnet && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                  background: 'rgba(247,166,0,0.15)', color: '#f7a600', border: '1px solid rgba(247,166,0,0.3)',
                }}>TESTNET</span>
              )}
              {key.status === 'ok' && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                  background: 'rgba(0,199,88,0.15)', color: '#00C758', border: '1px solid rgba(0,199,88,0.3)',
                }}>VERIFIED</span>
              )}
              {key.status === 'error' && (
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                  background: 'rgba(251,44,54,0.15)', color: '#FB2C36', border: '1px solid rgba(251,44,54,0.3)',
                }}>ERROR</span>
              )}
            </div>
            <div style={{ fontSize: 10, color: '#636e82' }}>
              {Object.entries(key.fields).map(([k, v]) => (
                <span key={k} style={{ marginRight: 12 }}>{k}: {v ?? '••••••••'}</span>
              ))}
            </div>
            {testResult[key.id] && (
              <div style={{ fontSize: 10, marginTop: 4, color: testResult[key.id].ok ? '#00C758' : '#FB2C36' }}>
                {testResult[key.id].message}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => handleTest(key.id)} disabled={testing === key.id} style={{
              background: 'transparent', border: '1px solid #363C4E', borderRadius: 4,
              color: '#636e82', fontSize: 11, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
            }}>
              {testing === key.id ? 'Testing...' : 'Test'}
            </button>
            <button onClick={() => handleSubscribePrivate(key.exchange)} style={{
              background: 'linear-gradient(to right, #1A3A94, #2B79DD)',
              border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 600,
              padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
            }}>Connect</button>
            <button onClick={() => handleDelete(key.id)} style={{
              background: 'rgba(251,44,54,0.1)', border: '1px solid rgba(251,44,54,0.25)',
              borderRadius: 4, color: '#FB2C36', fontSize: 11,
              padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
            }}>Delete</button>
          </div>
        </div>
      ))}

      {/* Add new key form */}
      {adding ? (
        <div style={{
          background: '#1F1E23', border: '1px solid #363C4E', borderRadius: 8,
          padding: '16px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'white', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Add API Key
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ fontSize: 9, color: '#636e82', fontWeight: 700, display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Exchange</label>
              <select value={newExchange} onChange={e => { setNewExchange(e.target.value); setNewFields({}) }}
                style={{ ...inputStyle, cursor: 'pointer' }}>
                {Object.keys(FIELD_DEFS).map(ex => <option key={ex} value={ex}>{FIELD_DEFS[ex].label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 9, color: '#636e82', fontWeight: 700, display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>Label</label>
              <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
                placeholder={newExchange} style={inputStyle} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            {fieldDef.fields.map(field => (
              <div key={field}>
                <label style={{ fontSize: 9, color: '#636e82', fontWeight: 700, display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>{field}</label>
                <input
                  type={field.toLowerCase().includes('secret') || field.toLowerCase().includes('private') ? 'password' : 'text'}
                  value={newFields[field] ?? ''}
                  onChange={e => setNewFields(prev => ({ ...prev, [field]: e.target.value }))}
                  style={inputStyle}
                />
              </div>
            ))}
          </div>
          {fieldDef.testnetOption && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#636e82', marginBottom: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={newTestnet} onChange={e => setNewTestnet(e.target.checked)} />
              Testnet
            </label>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setAdding(false)} style={{
              background: 'transparent', border: '1px solid #363C4E', borderRadius: 4,
              color: '#636e82', fontSize: 11, padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit',
            }}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={{
              background: 'linear-gradient(to right, #1A3A94, #2B79DD)',
              border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 600,
              padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit',
            }}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{
          background: 'transparent', border: '1px dashed #363C4E', borderRadius: 8,
          color: '#636e82', fontSize: 12, padding: '12px', cursor: 'pointer',
          fontFamily: 'inherit', width: '100%',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#2B79DD'; e.currentTarget.style.color = 'white' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#363C4E'; e.currentTarget.style.color = '#636e82' }}
        >+ Add API Key</button>
      )}
    </div>
  )
}
