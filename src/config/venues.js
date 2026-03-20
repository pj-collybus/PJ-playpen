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
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_PERP', 'CRYPTO_FUTURE', 'CRYPTO_SPOT'],
  },

  BINANCE: {
    id:         'BINANCE',
    wsUrl:      'wss://stream.binance.com:9443/ws',
    restBase:   'https://api.binance.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT'],
  },

  BYBIT: {
    id:         'BYBIT',
    wsUrl:      'wss://stream.bybit.com/v5/public/spot',
    restBase:   'https://api.bybit.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
  },

  OKX: {
    id:         'OKX',
    wsUrl:      'wss://ws.okx.com:8443/ws/v5/public',
    restBase:   'https://www.okx.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT', 'CRYPTO_PERP', 'CRYPTO_FUTURE'],
  },

  KRAKEN: {
    id:         'KRAKEN',
    wsUrl:      'wss://ws.kraken.com',
    restBase:   'https://api.kraken.com',
    testnet:    false,
    feedType:   'WEBSOCKET',
    assetClass: ['CRYPTO_SPOT', 'CRYPTO_PERP'],
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
  },
};
