import axios from 'axios'

export const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

export const orderApi = {
  submit: (request: unknown) => api.post('/order/submit', request),
  get: (orderId: string) => api.get(`/order/${orderId}`),
}

export const algoApi = {
  start: (strategyType: string, params: Record<string, unknown>) =>
    api.post('/algo/start', { strategyType, params }),
  stop: (strategyId: string) => api.post(`/algo/stop/${strategyId}`),
  pause: (strategyId: string) => api.post(`/algo/pause/${strategyId}`),
  resume: (strategyId: string) => api.post(`/algo/resume/${strategyId}`),
  accelerate: (strategyId: string, quantity: number) =>
    api.post(`/algo/accelerate/${strategyId}`, { quantity }),
  status: () => api.get('/algo/status'),
}

export const blotterApi = {
  snapshot: (venue?: string) => api.get('/blotter', { params: { venue } }),
  positions: (venue?: string) => api.get('/blotter/positions', { params: { venue } }),
  balances: (venue?: string) => api.get('/blotter/balances', { params: { venue } }),
  orders: (exchange: string, period: string) => api.get('/blotter/orders', { params: { exchange, period } }),
  trades: (exchange: string, period: string) => api.get('/blotter/trades', { params: { exchange, period } }),
}

export const marketDataApi = {
  connect: (exchange: string) => api.post('/marketdata/connect', { exchange }),
  subscribe: (symbols: string[], exchange: string) => api.post('/marketdata/subscribe', { symbols, exchange }),
  unsubscribe: (symbols: string[], exchange: string) => api.post('/marketdata/unsubscribe', { symbols, exchange }),
  instruments: (exchange: string) => api.get(`/marketdata/instruments/${exchange}`),
}

export const layoutsApi = {
  getAll: () => api.get('/layouts'),
  save: (layout: any) => api.post('/layouts', layout),
  saveAll: (layouts: any[]) => api.put('/layouts/bulk', layouts),
  delete: (id: string) => api.delete(`/layouts/${id}`),
  reorder: (ids: string[]) => api.put('/layouts/reorder', ids),
}

export const contractSpecsApi = {
  getAll: () => api.get('/marketdata/contract-specs'),
}

export const venuesApi = {
  list: () => api.get('/venues'),
}

export const riskApi = {
  check: (request: unknown) => api.post('/risk/check', request),
  headroom: (symbol: string, exchange: string) =>
    api.get('/risk/headroom', { params: { symbol, exchange } }),
}
