/**
 * TCA (Transaction Cost Analysis) service.
 *
 * Subscribes to fills and computes slippage, market impact, and venue performance.
 * All reads go through the ClickHouse stub via src/config/services.js.
 *
 * Methods:
 *   getClientSlippageReport(clientId, fromDate, toDate)
 *   getVenueScorecard(symbol, days)
 *   getOrderLatency(venue, days)
 *   getMarketImpact(orderId)
 *   getLiveVwap(venue, symbol, windowMs)
 */

'use strict';

const { EventEmitter }  = require('events');
const { subscribe, Topics } = require('../core/eventBus');
const slippage          = require('../tca/slippage');
const venueScorer       = require('../tca/venueScorer');
const marketImpactModel = require('../tca/marketImpact');
const fees              = require('../config/fees');

// ── ClickHouse client (stub or real) ─────────────────────────────────────────

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

const db = CHImpl.createClient({
  host:     process.env.CLICKHOUSE_HOST     || 'http://localhost:8123',
  database: process.env.CLICKHOUSE_DATABASE || 'collybus',
});

// Table names
const T_FILLS  = 'order_fills';
const T_ORDERS = 'order_state';
const T_BBO    = 'market_l1_bbo';
const T_TRADES = 'market_trades';

class TCAService extends EventEmitter {
  constructor() {
    super();
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    // Subscribe to fills — store in ClickHouse and update venue scorer
    await subscribe(Topics.FILLS, 'tcaService-fills', async (fill) => {
      console.log('[tcaService] Received fill via bus:', fill.fillId, 'orderId=', fill.orderId, 'symbol=', fill.symbol);
      await db.insert({ table: T_FILLS, values: [fill], format: 'JSONEachRow' });
      console.log('[tcaService] Inserted fill into', T_FILLS, '— total rows:', db.count(T_FILLS));
      const bps = fill.slippageBps || slippage.fillSlippage(fill);
      venueScorer.recordFill(fill.venue, fill.symbol, {
        slippageBps: bps,
        latencyMs:   fill.receivedTs - fill.fillTs,
      });
      this.emit('fill', fill);
    });

    // Subscribe to orders — store in ClickHouse
    await subscribe(Topics.ORDERS, 'tcaService-orders', async (order) => {
      console.log('[tcaService] Received order via bus:', order.orderId, 'symbol=', order.symbol, 'side=', order.side, 'arrivalMid=', order.arrivalMid);
      await db.insert({ table: T_ORDERS, values: [order], format: 'JSONEachRow' });
      console.log('[tcaService] Inserted order into', T_ORDERS, '— total rows:', db.count(T_ORDERS));
    });

    // Subscribe to L1 BBO — store in ClickHouse
    await subscribe(Topics.L1_BBO, 'tcaService-bbo', async (bbo) => {
      await db.insert({ table: T_BBO, values: [bbo], format: 'JSONEachRow' });
    });

    // Subscribe to trades — store in ClickHouse
    await subscribe(Topics.TRADES, 'tcaService-trades', async (trade) => {
      await db.insert({ table: T_TRADES, values: [trade], format: 'JSONEachRow' });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Client slippage report — returns orders with slippage_bps for a client over a date range.
   *
   * @param {string} clientId   - clientOrderId prefix or full ID
   * @param {Date|number} fromDate - Start of range (Date or Unix ms)
   * @param {Date|number} toDate   - End of range (Date or Unix ms)
   * @returns {Promise<object[]>} Array of { orderId, symbol, venue, side, avgFillPrice, arrivalMid, slippage_bps, allInCost_bps }
   */
  async getClientSlippageReport(clientId, fromDate, toDate) {
    const from = typeof fromDate === 'number' ? fromDate : fromDate.getTime();
    const to   = typeof toDate   === 'number' ? toDate   : toDate.getTime();

    console.log('[tcaService.getClientSlippageReport] clientId=%s from=%s to=%s', clientId, new Date(from).toISOString(), new Date(to).toISOString());
    console.log('[tcaService.getClientSlippageReport] Store totals: orders=%d fills=%d', db.count(T_ORDERS), db.count(T_FILLS));

    // Get orders for this client in the date range
    const orderResult = await db.query({
      query: `SELECT * FROM ${T_ORDERS} WHERE clientOrderId = '${clientId}' AND createdTs >= ${from} AND createdTs <= ${to}`,
      format: 'JSONEachRow',
    });
    let orders = await orderResult.json();
    console.log('[tcaService.getClientSlippageReport] Exact clientOrderId match: %d orders', orders.length);

    // If no exact match, try prefix match via scan
    if (orders.length === 0) {
      const allOrders = await db.query({
        query: `SELECT * FROM ${T_ORDERS} WHERE createdTs >= ${from} AND createdTs <= ${to}`,
        format: 'JSONEachRow',
      });
      const all = await allOrders.json();
      console.log('[tcaService.getClientSlippageReport] Date-range scan: %d orders total', all.length);
      orders = all.filter(o =>
        (o.clientOrderId && o.clientOrderId.startsWith(clientId)) ||
        (o.metadata && o.metadata.clientId === clientId)
      );
      console.log('[tcaService.getClientSlippageReport] After prefix/metadata filter: %d orders', orders.length);
    }

    const report = [];

    for (const order of orders) {
      // Get fills for this order — join on orderId (Deribit's order_id)
      const fillResult = await db.query({
        query: `SELECT * FROM ${T_FILLS} WHERE orderId = '${order.orderId}'`,
        format: 'JSONEachRow',
      });
      const fills = await fillResult.json();
      console.log('[tcaService.getClientSlippageReport] Order %s: found %d fills (looking for orderId=%s)', order.orderId, fills.length, order.orderId);
      if (fills.length === 0) continue;

      const orderWithFills = {
        side:       order.side,
        arrivalMid: order.arrivalMid,
        fills:      fills.map(f => ({ fillPrice: f.fillPrice, fillSize: f.fillSize })),
      };

      const slippageBps = slippage.arrivalSlippage(orderWithFills);
      const venueFees   = fees[order.venue] || { taker: 5 };
      const spreadBps   = order.arrivalSpreadBps || 0;
      const allIn       = slippage.allInCost(slippageBps, venueFees.taker, spreadBps);

      let totalNotional = 0, totalSize = 0;
      for (const f of fills) {
        totalNotional += f.fillPrice * f.fillSize;
        totalSize     += f.fillSize;
      }

      report.push({
        orderId:       order.orderId,
        clientOrderId: order.clientOrderId,
        symbol:        order.symbol,
        venue:         order.venue,
        side:          order.side,
        quantity:      order.quantity,
        avgFillPrice:  totalSize > 0 ? totalNotional / totalSize : 0,
        arrivalMid:    order.arrivalMid,
        slippage_bps:  Math.round(slippageBps * 100) / 100,
        allInCost_bps: Math.round(allIn * 100) / 100,
        fills:         fills.length,
        createdTs:     order.createdTs,
      });
    }

    return report;
  }

  /**
   * Venue scorecard — ranks venues by all-in cost for a symbol over N days.
   *
   * @param {string} symbol - Canonical symbol
   * @param {number} [days=7] - Lookback period
   * @returns {Promise<object[]>} Ranked array: [{ venue, fills, avgSlippage_bps, avgFee_bps, allInCost_bps, score }]
   */
  async getVenueScorecard(symbol, days = 7) {
    const cutoff = Date.now() - days * 86_400_000;

    const fillResult = await db.query({
      query: `SELECT * FROM ${T_FILLS} WHERE symbol = '${symbol}' AND fillTs >= ${cutoff}`,
      format: 'JSONEachRow',
    });
    const fills = await fillResult.json();

    // Group by venue
    const venueMap = new Map();
    for (const f of fills) {
      if (!venueMap.has(f.venue)) venueMap.set(f.venue, []);
      venueMap.get(f.venue).push(f);
    }

    const scorecard = [];

    for (const [venue, venueFills] of venueMap) {
      const avgSlippage = venueFills.reduce((s, f) => {
        return s + slippage.fillSlippage(f);
      }, 0) / venueFills.length;

      const venueFees = fees[venue] || { taker: 5 };
      const feeBps    = venueFees.taker;

      // Average spread from BBO data
      const bboResult = await db.query({
        query: `SELECT * FROM ${T_BBO} WHERE venue = '${venue}' AND symbol = '${symbol}' AND receivedTs >= ${cutoff} ORDER BY receivedTs DESC LIMIT 100`,
        format: 'JSONEachRow',
      });
      const bbos = await bboResult.json();
      const avgSpread = bbos.length > 0
        ? bbos.reduce((s, b) => s + (b.spreadBps || 0), 0) / bbos.length
        : 0;

      const allIn = slippage.allInCost(avgSlippage, feeBps, avgSpread);

      scorecard.push({
        venue,
        fills:           venueFills.length,
        avgSlippage_bps: Math.round(avgSlippage * 100) / 100,
        avgFee_bps:      feeBps,
        avgSpread_bps:   Math.round(avgSpread * 100) / 100,
        allInCost_bps:   Math.round(allIn * 100) / 100,
        score:           venueScorer.getScore(venue, symbol),
      });
    }

    // Sort by allInCost ascending (cheapest first)
    scorecard.sort((a, b) => a.allInCost_bps - b.allInCost_bps);
    return scorecard;
  }

  /**
   * Order latency — avg and p99 ACK and fill latency per venue.
   *
   * @param {string} venue
   * @param {number} [days=7]
   * @returns {Promise<object>} { venue, avgAckMs, p99AckMs, avgFillMs, p99FillMs, sampleSize }
   */
  async getOrderLatency(venue, days = 7) {
    const cutoff = Date.now() - days * 86_400_000;

    // Get orders for this venue
    const orderResult = await db.query({
      query: `SELECT * FROM ${T_ORDERS} WHERE venue = '${venue}' AND createdTs >= ${cutoff}`,
      format: 'JSONEachRow',
    });
    const orders = await orderResult.json();

    // Get fills for this venue
    const fillResult = await db.query({
      query: `SELECT * FROM ${T_FILLS} WHERE venue = '${venue}' AND fillTs >= ${cutoff}`,
      format: 'JSONEachRow',
    });
    const fills = await fillResult.json();

    // ACK latency = acknowledgedTs - submittedTs (Deribit response time)
    const ackLatencies = orders
      .filter(o => o.acknowledgedTs && o.submittedTs && o.acknowledgedTs > o.submittedTs)
      .map(o => o.acknowledgedTs - o.submittedTs);

    // Build order lookup and per-order first/last fill times
    const orderMap = new Map(orders.map(o => [o.orderId, o]));
    const orderFirstFill = new Map(); // orderId → earliest fillTs
    const orderLastFill  = new Map(); // orderId → latest fillTs

    for (const f of fills) {
      if (!orderMap.has(f.orderId)) continue;
      const ts = f.receivedTs || f.fillTs;
      if (!orderFirstFill.has(f.orderId) || ts < orderFirstFill.get(f.orderId)) {
        orderFirstFill.set(f.orderId, ts);
      }
      if (!orderLastFill.has(f.orderId) || ts > orderLastFill.get(f.orderId)) {
        orderLastFill.set(f.orderId, ts);
      }
    }

    // First fill latency = firstFillTs - submittedTs
    const firstFillLatencies = [];
    // Total fill latency = lastFillTs - submittedTs
    const totalFillLatencies = [];

    for (const [orderId, firstTs] of orderFirstFill) {
      const order = orderMap.get(orderId);
      if (!order || !order.submittedTs) continue;
      const firstLat = firstTs - order.submittedTs;
      if (firstLat > 0) firstFillLatencies.push(firstLat);
      const lastTs = orderLastFill.get(orderId);
      if (lastTs) {
        const totalLat = lastTs - order.submittedTs;
        if (totalLat > 0) totalFillLatencies.push(totalLat);
      }
    }

    return {
      venue,
      avgAckMs:   _avg(ackLatencies),
      p99AckMs:   _percentile(ackLatencies, 99),
      avgFillMs:  _avg(firstFillLatencies),
      p99FillMs:  _percentile(totalFillLatencies, 99),
      sampleSize: orders.length,
    };
  }

  /**
   * Market impact for a specific order — price drift and execution duration.
   *
   * @param {string} orderId
   * @returns {Promise<object>} { orderId, symbol, side, driftBps, durationMs, firstFillPrice, lastFillPrice, arrivalMid }
   */
  async getMarketImpact(orderId) {
    // Get order
    const orderResult = await db.query({
      query: `SELECT * FROM ${T_ORDERS} WHERE orderId = '${orderId}'`,
      format: 'JSONEachRow',
    });
    const orders = await orderResult.json();
    if (orders.length === 0) return null;
    const order = orders[orders.length - 1]; // latest state

    // Get fills
    const fillResult = await db.query({
      query: `SELECT * FROM ${T_FILLS} WHERE orderId = '${orderId}' ORDER BY fillTs ASC`,
      format: 'JSONEachRow',
    });
    const fills = await fillResult.json();
    if (fills.length === 0) return { orderId, symbol: order.symbol, side: order.side, driftBps: 0, durationMs: 0 };

    const firstFill = fills[0];
    const lastFill  = fills[fills.length - 1];
    const driftBps  = slippage.marketImpact(firstFill, lastFill, order);
    const durationMs = lastFill.fillTs - firstFill.fillTs;

    return {
      orderId,
      symbol:          order.symbol,
      side:            order.side,
      driftBps:        Math.round(driftBps * 100) / 100,
      durationMs,
      firstFillPrice:  firstFill.fillPrice,
      lastFillPrice:   lastFill.fillPrice,
      arrivalMid:      order.arrivalMid,
      fills:           fills.length,
    };
  }

  /**
   * Live VWAP — computed from recent trades in the stub store.
   *
   * @param {string} venue
   * @param {string} symbol
   * @param {number} [windowMs=60000] - Lookback window in ms (default 1 minute)
   * @returns {Promise<object>} { venue, symbol, vwap, volume, tradeCount, windowMs }
   */
  async getLiveVwap(venue, symbol, windowMs = 60_000) {
    const cutoff = Date.now() - windowMs;

    const tradeResult = await db.query({
      query: `SELECT * FROM ${T_TRADES} WHERE venue = '${venue}' AND symbol = '${symbol}' AND exchangeTs >= ${cutoff}`,
      format: 'JSONEachRow',
    });
    const trades = await tradeResult.json();

    let totalNotional = 0;
    let totalVolume   = 0;

    for (const t of trades) {
      totalNotional += t.price * t.size;
      totalVolume   += t.size;
    }

    return {
      venue,
      symbol,
      vwap:       totalVolume > 0 ? Math.round((totalNotional / totalVolume) * 100) / 100 : 0,
      volume:     totalVolume,
      tradeCount: trades.length,
      windowMs,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _avg(arr) {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100;
}

function _percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

// Singleton
const instance = new TCAService();

// Debug helper — exposes store row counts for logging
instance.getStoreDebug = function() {
  return {
    orders: db.count(T_ORDERS),
    fills:  db.count(T_FILLS),
    bbo:    db.count(T_BBO),
    trades: db.count(T_TRADES),
  };
};

module.exports = instance;
