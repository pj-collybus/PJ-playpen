/**
 * Venue configuration — WebSocket URLs, REST base URLs, testnet flags.
 */

'use strict';

const TESTNET = process.env.USE_TESTNET !== 'false'; // default: testnet on

module.exports = {
  DERIBIT: {
    id:         'DERIBIT',
    wsUrl:      TESTNET ? 'wss://test.deribit.com/ws/api/v2' : 'wss://www.deribit.com/ws/api/v2',
    restBase:   TESTNET ? 'https://test.deribit.com' : 'https://www.deribit.com',
    testnet:    TESTNET,
    simulateFills: TESTNET, // simulate fills on testnet where matching engine is unreliable
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_PERP', 'CRYPTO_FUTURE', 'CRYPTO_SPOT'],
    exchangeColor: '#e03040',  // orange-red
    exchangeBg:    '#2a080e',
    exchangeText:  'D',
    logoUrl:       'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiNlMzEyMzciLz48dGV4dCB4PSI5IiB5PSIyMiIgZm9udC1zaXplPSIyMCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IndoaXRlIj5EPC90ZXh0Pjwvc3ZnPg==',
  },

  BINANCE: {
    id:         'BINANCE',
    wsUrl:      'wss://stream.binance.com:9443/ws',
    restBase:   'https://api.binance.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT'],
    exchangeColor: '#f0b90b',  // yellow-green
    exchangeBg:    '#2a2008',
    exchangeText:  'B',
    logoUrl:       'https://bin.bnbstatic.com/static/images/common/favicon.ico',
  },

  BYBIT: {
    id:         'BYBIT',
    wsUrl:      'wss://stream.bybit.com/v5/public/spot',
    restBase:   'https://api.bybit.com',
    testnet:    false,
    simulateFills: TESTNET,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
    exchangeColor: '#f7a600',  // yellow
    exchangeBg:    '#2a1e08',
    exchangeText:  'By',
    logoUrl:       'https://www.bybit.com/favicon.ico',
  },

  OKX: {
    id:         'OKX',
    wsUrl:      'wss://ws.okx.com:8443/ws/v5/public',
    restBase:   'https://www.okx.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT', 'CRYPTO_PERP', 'CRYPTO_FUTURE'],
    exchangeColor: '#aaaaaa',  // white/grey
    exchangeBg:    '#1a1a1a',
    exchangeText:  'OX',
    logoUrl:       'https://www.okx.com/favicon.ico',
  },

  KRAKEN: {
    id:         'KRAKEN',
    wsUrl:      'wss://ws.kraken.com',
    restBase:   'https://api.kraken.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
    exchangeColor: '#8d5ff0',  // purple
    exchangeBg:    '#100820',
    exchangeText:  'Kr',
    logoUrl:       'https://www.kraken.com/favicon.ico',
  },

  BITMEX: {
    id:         'BITMEX',
    wsUrl:      'wss://ws.bitmex.com/realtime',
    restBase:   'https://www.bitmex.com',
    testnet:    false,
    simulateFills: TESTNET,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_PERP', 'CRYPTO_FUTURE'],
    exchangeColor: '#4a90d9',  // dark blue
    exchangeBg:    '#081420',
    exchangeText:  'BX',
    logoUrl:       'https://www.bitmex.com/favicon.ico',
  },

  'GATE.IO': {
    id:         'GATE.IO',
    restBase:   'https://api.gateio.ws',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT'],
    exchangeColor: '#2196f3',  // blue
    exchangeBg:    '#081c2e',
    exchangeText:  'G',
    logoUrl:       'https://www.gate.io/favicon.ico',
  },

  KUCOIN: {
    id:         'KUCOIN',
    restBase:   'https://api.kucoin.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
    exchangeColor: '#24ae8f',  // green
    exchangeBg:    '#081e18',
    exchangeText:  'K',
    logoUrl:       'https://www.kucoin.com/favicon.ico',
  },

  // FIX venues — stubs only (real integration requires FIX 4.4 engine)
  LMAX: {
    id:         'LMAX',
    fixHost:    process.env.LMAX_FIX_HOST   || '127.0.0.1',
    fixPort:    parseInt(process.env.LMAX_FIX_PORT || '2101', 10),
    senderCompId: process.env.LMAX_SENDER_COMP_ID || 'COLLYBUS',
    targetCompId: process.env.LMAX_TARGET_COMP_ID || 'LMXBD',
    testnet:    true,
    feedType:   'FIX',
    assetClass: ['FX_SPOT'],
    exchangeColor: '#cc8844',  // amber
    exchangeBg:    '#1e1408',
    exchangeText:  'LX',
  },

  EBS: {
    id:         'EBS',
    fixHost:    process.env.EBS_FIX_HOST   || '127.0.0.1',
    fixPort:    parseInt(process.env.EBS_FIX_PORT || '2102', 10),
    senderCompId: process.env.EBS_SENDER_COMP_ID || 'COLLYBUS',
    targetCompId: process.env.EBS_TARGET_COMP_ID || 'EBS',
    testnet:    true,
    feedType:   'FIX',
    assetClass: ['FX_SPOT'],
    exchangeColor: '#5588cc',  // steel blue
    exchangeBg:    '#081420',
    exchangeText:  'EB',
  },

  '360T': {
    id:         '360T',
    fixHost:    process.env.T360_FIX_HOST  || '127.0.0.1',
    fixPort:    parseInt(process.env.T360_FIX_PORT || '2103', 10),
    senderCompId: process.env.T360_SENDER_COMP_ID || 'COLLYBUS',
    targetCompId: process.env.T360_TARGET_COMP_ID || '360T',
    testnet:    true,
    feedType:   'FIX',
    assetClass: ['FX_SPOT'],
    exchangeColor: '#66aa66',  // muted green
    exchangeBg:    '#0e1e0e',
    exchangeText:  '3T',
  },
};
