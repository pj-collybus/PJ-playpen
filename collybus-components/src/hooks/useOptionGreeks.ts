import { useState, useEffect } from 'react'

export interface OptionGreeks {
  delta?: number | null
  gamma?: number | null
  vega?: number | null
  theta?: number | null
  rho?: number | null
  bidIv?: number | null
  askIv?: number | null
  markIv?: number | null
  openInterest?: number | null
  volume?: number | null
}

export function useOptionGreeks(instrumentNames: string[], apiBase = '', intervalMs = 5000): Record<string, OptionGreeks> {
  const [greeks, setGreeks] = useState<Record<string, OptionGreeks>>({})
  const namesKey = instrumentNames.filter(Boolean).sort().join(',')

  useEffect(() => {
    const names = instrumentNames.filter(Boolean)
    if (!names.length) return

    const fetchGreeks = async () => {
      try {
        const resp = await fetch(`${apiBase}/api/options/greeks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(names),
        })
        if (!resp.ok) return
        const data = await resp.json()
        setGreeks(prev => ({ ...prev, ...data }))
      } catch (e) {
        console.warn('[greeks] fetch failed:', e)
      }
    }

    fetchGreeks()
    const timer = setInterval(fetchGreeks, intervalMs)
    return () => clearInterval(timer)
  }, [namesKey, apiBase, intervalMs])

  return greeks
}
