/**
 * Tick store — ClickHouse stub (in-memory ring buffer).
 *
 * Subscribes to market data topics on the event bus and stores ticks.
 * Query API matches ClickHouse shape for drop-in replacement.
 *
 * Usage:
 *   const store = require('./tickStore');
 *   await store.start();
 *   const recent = await store.queryBBO('BTC-PERP', 100);
 *   const trades = await store.queryTrades('ETH-USDT', 50);
 */

'use strict';

const { subscribe, Topics } = require('../core/eventBus');

let CHImpl;
try {
  const { useRealClickhouse } = require('../config/services');
  if (useRealClickhouse) {
    CHImpl = require('@clickhouse/client');
  } else {
    CHImpl = require('../stubs/clickhouse');
  }
} catch {
  CHImpl = require('../stubs/clickhouse');
}

const client = CHImpl.createClient({
  host:     process.env.CLICKHOUSE_HOST     || 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE || 'collybus',
});

const TABLE_BBO    = 'market_l1_bbo';
const TABLE_L2     = 'market_l2_book';
const TABLE_TRADES = 'market_trades';

let _started = false;

async function start() {
  if (_started) return;
  _started = true;

  await subscribe(Topics.L1_BBO, 'tickStore-bbo', async (event) => {
    await client.insert({ table: TABLE_BBO, values: [event] });
  });

  await subscribe(Topics.L2_BOOK, 'tickStore-l2', async (event) => {
    await client.insert({ table: TABLE_L2, values: [event] });
  });

  await subscribe(Topics.TRADES, 'tickStore-trades', async (event) => {
    await client.insert({ table: TABLE_TRADES, values: [event] });
  });
}

/**
 * Query recent BBO ticks for a symbol.
 * @param {string} symbol - Canonical symbol
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function queryBBO(symbol, limit = 100) {
  const result = await client.query({
    query: `SELECT * FROM ${TABLE_BBO} WHERE symbol = '${symbol}' ORDER BY receivedTs DESC LIMIT ${limit}`,
  });
  return result.json();
}

/**
 * Query recent L2 book updates for a symbol.
 * @param {string} symbol
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function queryL2(symbol, limit = 100) {
  const result = await client.query({
    query: `SELECT * FROM ${TABLE_L2} WHERE symbol = '${symbol}' ORDER BY receivedTs DESC LIMIT ${limit}`,
  });
  return result.json();
}

/**
 * Query recent trades for a symbol.
 * @param {string} symbol
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function queryTrades(symbol, limit = 100) {
  const result = await client.query({
    query: `SELECT * FROM ${TABLE_TRADES} WHERE symbol = '${symbol}' ORDER BY receivedTs DESC LIMIT ${limit}`,
  });
  return result.json();
}

/** Get underlying ClickHouse client for advanced queries */
function getClient() {
  return client;
}

module.exports = { start, queryBBO, queryL2, queryTrades, getClient };
