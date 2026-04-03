import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PricePanel as PricePanelComponent } from '@collybus/components'
import type { PricePanelConfig, InstrumentInfo } from '@collybus/components'
import { useMarketDataStore } from '../../stores/marketDataStore'
import { api, marketDataApi } from '../../services/apiClient'
import { signalRClient } from '../../services/signalRClient'

interface PricePanelProps {
  id: string
  x: number
  y: number
  width: number
  exchange: string
  symbol: string
  onMove: (id: string, x: number, y: number) => void
  onClose: (id: string) => void
  onResize: (id: string, width: number) => void
  onConfigChange?: (id: string, changes: Record<string, unknown>) => void
  availableExchanges?: string[]
  granularityPresets?: { label: string; value: string }[]
  panelConfig?: Record<string, unknown>
}

export function PricePanel({ id, x, y, width, exchange, symbol: initialSymbol, onMove, onClose, onResize, onConfigChange: parentOnConfigChange, availableExchanges = [], granularityPresets: savedGranPresets, panelConfig }: PricePanelProps) {
  const [currentExchange, setCurrentExchange] = useState(exchange)
  const [currentSymbol, setCurrentSymbol] = useState(initialSymbol)
  const [instruments, setInstruments] = useState<InstrumentInfo[]>([])


  const key = `${currentExchange}:${currentSymbol}`
  const { ticker, orderBook } = useMarketDataStore(
    useShallow(s => ({
      ticker: s.tickers[key],
      orderBook: s.orderBooks[key],
    }))
  )

  // Fetch instruments list — use cache if available, auto-select only when symbol empty
  useEffect(() => {
    const autoSelect = (list: any[]) => {
      if (!currentSymbol) {
        const firstPerp = list.find((i: any) => i.isPerp === true)
        setCurrentSymbol(firstPerp?.symbol ?? list[0]?.symbol ?? '')
      }
    }
    const cached = useMarketDataStore.getState().instruments[currentExchange]
    if (cached?.length) {
      setInstruments(cached)
      autoSelect(cached)
      return
    }
    setInstruments([])
    marketDataApi.instruments(currentExchange).then(r => {
      const list: any[] = r.data
      useMarketDataStore.getState().setInstruments(currentExchange, list)
      setInstruments(list)
      autoSelect(list)
    }).catch(() => {})
  }, [currentExchange])

  // Subscribe to market data + SignalR group (with retry)
  useEffect(() => {
    let active = true
    let retries = 0

    const trySubscribe = async () => {
      try {
        await marketDataApi.connect(currentExchange)
        if (!active) return
        await marketDataApi.subscribe([currentSymbol], currentExchange)
        if (!active) return
        await signalRClient.subscribeToSymbol(currentExchange, currentSymbol)
      } catch (e) {
        if (active && retries < 5) {
          retries++
          setTimeout(trySubscribe, 1000 * retries)
        }
      }
    }

    if (currentSymbol) trySubscribe()

    return () => {
      active = false
      signalRClient.unsubscribeFromSymbol(currentExchange, currentSymbol).catch(() => {})
    }
  }, [currentExchange, currentSymbol])

  const config: PricePanelConfig = {
    exchange: currentExchange,
    symbol: currentSymbol,
    granularity: 1,
    presetQtys: (panelConfig?.presetQtys as number[]) ?? [1, 5, 10, 25, 100],
    defaultQty: (panelConfig?.defaultQty as string) ?? undefined,
    selectedGranularity: (panelConfig?.selectedGranularity as string) ?? undefined,
    favourites: [],
    orderType: 'LMT',
    availableExchanges,
    granularityPresets: savedGranPresets,
  }

  const tickerData = useMemo(() => ticker ? {
    bestBid: ticker.bestBid,
    bestAsk: ticker.bestAsk,
    lastPrice: ticker.lastPrice,
    markPrice: ticker.markPrice,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    change24h: ticker.change24h,
    fundingRate: ticker.fundingRate,
    volume24h: ticker.volume24h,
    timestamp: ticker.timestamp,
  } : undefined, [ticker])

  const orderBookData = useMemo(() => orderBook ? {
    bids: orderBook.bids,
    asks: orderBook.asks,
    timestamp: orderBook.timestamp,
  } : undefined, [orderBook])

  const callbacks = useMemo(() => ({
    onMove,
    onClose,
    onResize,
    onLaunchAlgo: async (params: any) => {
      console.log('[AlgoLaunch] params:', JSON.stringify(params))
      try {
        const r = await api.post('/algo/start', params)
        console.log('[AlgoLaunch] response:', r.data)
        if (!r.data.ok) throw new Error(r.data.error ?? 'Failed to launch')
        return r.data.strategyId
      } catch (e: any) {
        console.error('[AlgoLaunch] error:', e.response?.status, e.response?.data, e.message)
        throw e
      }
    },
    onConfigChange: (_panelId: string, changes: Record<string, unknown>) => {
      if (changes.symbol) {
        const sym = changes.symbol as string
        setCurrentSymbol(sym)
      }
      if (changes.exchange) {
        const newExchange = changes.exchange as string
        setCurrentExchange(newExchange)
        setCurrentSymbol('')
      }
      // Forward all changes in a single call to avoid stale-config overwrites
      parentOnConfigChange?.(id, changes)
    },
    onSubmitOrder: async (params: any) => {
      const instr = useMarketDataStore.getState().instruments[params.exchange?.toUpperCase()]
      const spec = instr?.find((i: any) => i.symbol === params.symbol)
      const r = await api.post('/order/submit', {
        exchange: params.exchange,
        symbol: params.symbol,
        side: params.side,
        quantity: params.quantity,
        limitPrice: params.limitPrice,
        triggerPrice: params.triggerPrice,
        orderType: params.orderType === 'STOP' ? 'STOP' : params.orderType ?? 'LIMIT',
        timeInForce: params.timeInForce ?? 'GTC',
        reduceOnly: params.reduceOnly,
        postOnly: params.postOnly,
        tickSize: spec?.tickSize,
        algoType: 'MANUAL',
      })
      if (!r.data.ok) throw new Error(r.data.error ?? r.data.rejectReason ?? 'Order failed')
    },
  }), [id, onMove, onClose, onResize, parentOnConfigChange])

  return (
    <PricePanelComponent
      id={id}
      x={x}
      y={y}
      width={width}
      config={config}
      ticker={tickerData}
      orderBook={orderBookData}
      instruments={instruments
        .filter((i: any) => !i.exchange || i.exchange?.toUpperCase() === currentExchange.toUpperCase())
        .map((i: any) => ({
          symbol: i.symbol ?? '',
          exchange: i.exchange ?? currentExchange,
          tickSize: i.tickSize ?? 0.5,
          lotSize: i.lotSize ?? 1,
          contractType: i.contractType ?? 'LINEAR',
          baseCurrency: i.baseCurrency ?? '',
          quoteCurrency: i.quoteCurrency ?? 'USD',
          isPerp: i.isPerp ?? i.symbol?.includes('PERPETUAL') ?? false,
          kind: i.kind ?? 'future',
          sizeUnit: i.sizeUnit,
        } as InstrumentInfo))}
      callbacks={callbacks}
    />
  )
}
