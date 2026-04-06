import * as signalR from '@microsoft/signalr'
import { useMarketDataStore } from '../stores/marketDataStore'
import { useBlotterStore } from '../stores/blotterStore'
import { useAlgoStore } from '../stores/algoStore'

class SignalRClient {
  private connection: signalR.HubConnection | null = null
  private subscribedChannels = new Set<string>()

  async connect(): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected) return

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl('/hub')
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build()

    this.registerHandlers()

    try {
      await this.connection.start()
      console.log('[SignalR] Connected')
      // Re-subscribe to channels after reconnect
      if (this.subscribedChannels.size > 0) {
        await this.subscribe([...this.subscribedChannels])
      }
      // Request re-push of cached positions/balances, then fetch history
      fetch('/api/blotter/snapshot', { method: 'POST' }).catch(() => {})
      setTimeout(() => useBlotterStore.getState().fetchHistory('week'), 500)
    } catch (err) {
      console.error('[SignalR] Connection failed:', err)
    }
  }

  async subscribe(channels: string[]): Promise<void> {
    channels.forEach((c) => this.subscribedChannels.add(c))
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      await this.connection.invoke('Subscribe', channels)
    }
  }

  async unsubscribe(channels: string[]): Promise<void> {
    channels.forEach((c) => this.subscribedChannels.delete(c))
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      await this.connection.invoke('Unsubscribe', channels)
    }
  }

  private registerHandlers(): void {
    if (!this.connection) return
    const { setTicker, setOrderBook } = useMarketDataStore.getState()
    const { upsertOrder, upsertTrade, upsertPosition, upsertBalance } = useBlotterStore.getState()
    const { upsertStrategy } = useAlgoStore.getState()

    this.connection.on('TickerUpdate', (payload: { key: string; ticker: Parameters<typeof setTicker>[1] }) => {
      setTicker(payload.key, payload.ticker)
    })
    this.connection.on('OrderBookUpdate', (payload: { key: string; book: Parameters<typeof setOrderBook>[1] }) => {
      setOrderBook(payload.key, payload.book)
    })
    this.connection.on('OrderUpdate', (data) => {
      console.log('[blotter] order update:', data?.orderId, data?.state ?? data?.status, data?.symbol)
      if (data?.orderId) useBlotterStore.getState().upsertOrder(data)
    })
    this.connection.on('FillUpdate', (data) => {
      console.log('[blotter] fill update:', data?.fillId, data?.fillPrice, data?.fillSize, data?.symbol)
      if (data?.fillId) useBlotterStore.getState().upsertTrade(data)
    })
    this.connection.on('PositionUpdate', (data) => {
      console.log('[blotter] position update:', data?.symbol, 'size:', data?.size, 'side:', data?.side)
      if (data?.symbol) useBlotterStore.getState().upsertPosition(data)
    })
    this.connection.on('BalanceUpdate', (data) => {
      console.log('[blotter] balance update:', data?.exchange, data?.currency, 'total:', data?.total)
      if (data?.exchange) useBlotterStore.getState().upsertBalance(data)
    })
    this.connection.on('AlgoProgress', (data) => {
      if (data?.strategyId) {
        console.log('[AlgoProgress]', data.strategyId, 'bids:', data.chartBids?.length, 'fills:', data.chartFills?.length, 'fills[0]:', data.chartFills?.[0], 'chartOrder.last3:', data.chartOrder?.slice(-3), 'status:', data.status)
        upsertStrategy(data)
        window.dispatchEvent(new CustomEvent('algo-status-update', { detail: data }))
      }
    })
    this.connection.on('BlotterUpdate', (snapshot: {
      orders?: Parameters<typeof upsertOrder>[0][]
      trades?: Parameters<typeof upsertTrade>[0][]
      positions?: Parameters<typeof upsertPosition>[0][]
      balances?: Parameters<typeof upsertBalance>[0][]
    }) => {
      snapshot.orders?.forEach(upsertOrder)
      snapshot.trades?.forEach(upsertTrade)
      snapshot.positions?.forEach(upsertPosition)
      snapshot.balances?.forEach(upsertBalance)
    })
  }

  async subscribeToSymbol(exchange: string, symbol: string): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      await this.connection.invoke('SubscribeSymbol', exchange, symbol)
    }
  }

  async unsubscribeFromSymbol(exchange: string, symbol: string): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      await this.connection.invoke('UnsubscribeSymbol', exchange, symbol)
    }
  }

  disconnect(): void {
    this.connection?.stop()
  }
}

export const signalRClient = new SignalRClient()
