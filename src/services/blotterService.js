/**
 * Blotter service — aggregates order, fill, position, and balance events
 * from ALL exchanges into a single unified view.
 *
 * Subscribes to the event bus (not to any specific exchange).
 * Adding a new exchange requires only that its adapter publishes
 * to the standard Topics — nothing changes here.
 *
 * Usage:
 *   const blotter = require('./blotterService');
 *   await blotter.start();
 *   const trades = blotter.getTrades();           // all exchanges
 *   const trades = blotter.getTrades('DERIBIT');   // filtered
 *   const orders = blotter.getOrders();
 *   const positions = blotter.getPositions();
 *   const balances = blotter.getBalances();
 */

'use strict';

const { EventEmitter } = require('events');
const { subscribe, Topics } = require('../core/eventBus');

const MAX_TRADES = 500;
const MAX_ORDERS = 500;

class BlotterService extends EventEmitter {
  constructor() {
    super();
    this._trades    = [];                    // newest first
    this._orders    = new Map();             // orderId → order
    this._positions = new Map();             // `${venue}::${symbol}` → position
    this._balances  = new Map();             // `${venue}::${currency}` → balance
    this._started   = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    // Fills → trades list
    await subscribe(Topics.FILLS, 'blotterService-fills', async (fill) => {
      // Dedup by fillId
      const existingFill = this._trades.find(t => t.tradeId === fill.fillId);
      if (existingFill) {
        console.log('[blotter] fill dedup:', fill.fillId, 'DUPLICATE — skipping (venue:', fill.venue + ')');
        return;
      }
      console.log('[blotter] fill dedup:', fill.fillId, 'NEW');
      console.log('[blotterService] Received fill:', fill.venue, fill.symbol, fill.fillPrice);
      const trade = {
        venue:       fill.venue,
        tradeId:     fill.fillId,
        orderId:     fill.orderId,
        symbol:      fill.symbol,
        side:        fill.side,
        price:       fill.fillPrice,
        size:        fill.fillSize,
        fee:         fill.commission || 0,
        feeCurrency: fill.commissionAsset || '',
        timestamp:   fill.fillTs || Date.now(),
        simulated:   !!fill.simulated,
      };
      this._trades.unshift(trade);
      if (this._trades.length > MAX_TRADES) this._trades.pop();
      this.emit('trade', trade);
    });

    // Order state changes
    await subscribe(Topics.ORDERS, 'blotterService-orders', async (order) => {
      console.log('[blotterService] Received order:', order.venue, order.symbol, order.state);
      // Deduplicate: if a venue orderId matches an existing entry, update it instead of creating new
      let key = order.orderId;
      if (order.venueOrderId) {
        for (const [k, v] of this._orders) {
          if (v.venueOrderId === order.venueOrderId || k === order.venueOrderId) {
            key = k; break;
          }
        }
      }
      this._orders.set(key, {
        venue:        order.venue,
        orderId:      key,
        venueOrderId: order.venueOrderId || order.orderId,
        symbol:       order.symbol,
        side:         order.side,
        orderType:    (order.orderType || '').toUpperCase(),
        quantity:     order.quantity,
        filled:       order.filledQuantity || 0,
        remaining:    Math.max(0, order.remainingQuantity || 0),
        price:        order.limitPrice,
        state:        order.state,
        rejectReason: order.rejectReason || null,
        timestamp:    order.updatedTs || order.createdTs || Date.now(),
        parentOrderId: order.parentOrderId || order.metadata?.parentOrderId || null,
        sliceNumber:   order.metadata?.sliceNumber || null,
        strategyId:    order.metadata?.strategyId || null,
        shortId:       order.metadata?.shortId || null,
      });
      // Cap size
      if (this._orders.size > MAX_ORDERS) {
        const oldest = this._orders.keys().next().value;
        this._orders.delete(oldest);
      }
      this.emit('order', this._orders.get(order.orderId));
    });

    // Positions
    await subscribe(Topics.POSITIONS, 'blotterService-positions', async (pos) => {
      const key = `${pos.venue}::${pos.symbol}`;
      if (pos.size === 0 || pos.side === 'FLAT') {
        console.log('[blotterService] Removing position:', key);
        this._positions.delete(key);
      } else {
        console.log('[blotterService] Storing position key:', key, 'venue:', pos.venue, 'symbol:', pos.symbol, 'side:', pos.side, 'size:', pos.size, 'unit:', pos.sizeUnit);
        this._positions.set(key, pos);
      }
      this.emit('position', pos);
    });

    // Balances
    await subscribe(Topics.BALANCES, 'blotterService-balances', async (bal) => {
      const key = `${bal.venue}::${bal.currency}`;
      this._balances.set(key, bal);
      this.emit('balance', bal);
    });

    console.log('[blotterService] Started — listening for fills, orders, positions, balances');
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  getTrades(venue) {
    return venue ? this._trades.filter(t => t.venue === venue) : [...this._trades];
  }

  getOrders(venue) {
    const all = Array.from(this._orders.values());
    return venue ? all.filter(o => o.venue === venue) : all;
  }

  getPositions(venue) {
    const all = Array.from(this._positions.values());
    return venue ? all.filter(p => p.venue === venue) : all;
  }

  getBalances(venue) {
    const all = Array.from(this._balances.values());
    return venue ? all.filter(b => b.venue === venue) : all;
  }

  /** Snapshot for API endpoint */
  getSnapshot(venue) {
    return {
      trades:    this.getTrades(venue),
      orders:    this.getOrders(venue),
      positions: this.getPositions(venue),
      balances:  this.getBalances(venue),
    };
  }
}

const instance = new BlotterService();
module.exports = instance;
