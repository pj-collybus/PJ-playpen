/**
 * Order service — order lifecycle management.
 *
 * Creates, tracks, and manages orders. Publishes ORDER and ORDER_EVENT
 * records to the event bus. Delegates execution to venue adapters.
 *
 * Usage:
 *   const orderService = require('./orderService');
 *   const order = await orderService.submit({ symbol, venue, side, quantity, ... });
 *   await orderService.cancel(orderId);
 *   const state = orderService.getOrder(orderId);
 */

'use strict';

const { EventEmitter }  = require('events');
const { v4: uuidv4 }    = require('uuid');
const { publish, Topics } = require('../core/eventBus');
const { OrderState, OrderEventType } = require('../schemas/events');
const marketDataService = require('./marketDataService');

class OrderService extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} orderId → ORDER */
    this._orders = new Map();
    /** @type {Map<string, object>} orderId → adapter reference */
    this._adapters = new Map();
  }

  /**
   * Register a venue adapter for order routing.
   * @param {string} venue
   * @param {object} adapter - Must implement sendOrder() and optionally cancelOrder()
   */
  registerAdapter(venue, adapter) {
    this._adapters.set(venue, adapter);
  }

  /**
   * Submit a new order.
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.venueSymbol
   * @param {string} params.venue
   * @param {'BUY'|'SELL'} params.side
   * @param {number} params.quantity
   * @param {number|null} [params.limitPrice]
   * @param {number|null} [params.stopPrice]
   * @param {string} [params.orderType='MARKET']
   * @param {string} [params.algoType='MANUAL']
   * @param {string|null} [params.parentOrderId]
   * @param {object} [params.metadata={}]
   * @returns {Promise<object>} ORDER
   */
  async submit(params) {
    const orderId       = uuidv4();
    const clientOrderId = `CLB-${Date.now()}-${orderId.slice(0, 8)}`;
    const now           = Date.now();

    // TCA anchors from current market data — arrivalMid must NEVER be null
    const bbo = marketDataService.getBBO(params.symbol);
    const arrivalBid       = bbo?.bestBid ?? 0;
    const arrivalAsk       = bbo?.bestAsk ?? 0;
    let   arrivalMid       = bbo?.midPrice ?? 0;
    const arrivalSpreadBps = bbo?.spreadBps ?? 0;

    // Hard constraint: arrivalMid must never be null/0
    // Fall back to limit price or a sensible default from params
    if (!arrivalMid && params.limitPrice) {
      arrivalMid = params.limitPrice;
    }
    if (!arrivalMid) {
      console.error(`[orderService] CRITICAL: no arrivalMid available for ${params.symbol} — order ${params.side} ${params.quantity}. Using last known price.`);
      // Use any available price data
      arrivalMid = arrivalBid || arrivalAsk || params.limitPrice || 0;
    }

    /** @type {import('../schemas/events').ORDER} */
    const order = {
      orderId,
      venueOrderId:      null,
      clientOrderId,
      venue:             params.venue,
      symbol:            params.symbol,
      side:              params.side,
      quantity:          params.quantity,
      filledQuantity:    0,
      remainingQuantity: params.quantity,
      limitPrice:        params.limitPrice ?? null,
      stopPrice:         params.stopPrice ?? null,
      orderType:         params.orderType || 'MARKET',
      state:             OrderState.PENDING,
      createdTs:         now,
      updatedTs:         now,
      arrivalBid,
      arrivalAsk,
      arrivalMid,
      arrivalSpreadBps,
      algoType:          params.algoType || 'MANUAL',
      parentOrderId:     params.parentOrderId || null,
      metadata:          params.metadata || {},
    };

    this._orders.set(orderId, order);

    // Emit SUBMIT event
    await this._emitEvent(orderId, OrderEventType.SUBMIT, OrderState.PENDING, OrderState.PENDING, 'TRADER');

    // Publish order state
    await publish(Topics.ORDERS, order, order.symbol);

    // Route to adapter
    const adapter = this._adapters.get(params.venue);
    if (!adapter) {
      await this._transition(orderId, OrderState.REJECTED, OrderEventType.REJECT, 'SYSTEM', {
        rejectReason: `No adapter registered for venue ${params.venue}`,
      });
      return this._orders.get(orderId);
    }

    // Fire and forget — adapter will call back via fills
    this._executeOnAdapter(orderId, order, adapter, params).catch((err) => {
      this._transition(orderId, OrderState.REJECTED, OrderEventType.REJECT, 'VENUE', {
        rejectReason: err.message,
      });
    });

    return order;
  }

  /**
   * Cancel an open order.
   * @param {string} orderId
   */
  async cancel(orderId) {
    const order = this._orders.get(orderId);
    if (!order) throw new Error(`Unknown order: ${orderId}`);
    if (order.state === OrderState.FILLED || order.state === OrderState.CANCELLED) {
      throw new Error(`Cannot cancel order in state ${order.state}`);
    }

    await this._emitEvent(orderId, OrderEventType.CANCEL_REQUEST, order.state, order.state, 'TRADER');
    await this._transition(orderId, OrderState.CANCELLED, OrderEventType.CANCELLED, 'VENUE');
  }

  /** Get current order state */
  getOrder(orderId) {
    return this._orders.get(orderId) || null;
  }

  /** List all orders, optionally filtered */
  listOrders({ symbol, state, venue } = {}) {
    let orders = Array.from(this._orders.values());
    if (symbol) orders = orders.filter(o => o.symbol === symbol);
    if (state)  orders = orders.filter(o => o.state === state);
    if (venue)  orders = orders.filter(o => o.venue === venue);
    return orders;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _executeOnAdapter(orderId, order, adapter, params) {
    const result = await adapter.sendOrder({
      symbol:      order.symbol,
      venueSymbol: params.venueSymbol,
      side:        order.side,
      quantity:    order.quantity,
      limitPrice:  order.limitPrice,
    });

    // Update venue order ID
    order.venueOrderId = result.venueOrderId;

    // ACK
    await this._transition(orderId, OrderState.OPEN, OrderEventType.ACK, 'VENUE');

    // If adapter returned immediate fill
    if (result.fill) {
      await this._applyFill(orderId, result.fill);
    }
  }

  async _applyFill(orderId, fill) {
    const order = this._orders.get(orderId);
    if (!order) return;

    order.filledQuantity    += fill.fillSize;
    order.remainingQuantity  = order.quantity - order.filledQuantity;

    // Compute slippage
    if (order.arrivalMid) {
      const sideSign  = order.side === 'BUY' ? 1 : -1;
      fill.slippageBps = (fill.fillPrice - order.arrivalMid) / order.arrivalMid * 10_000 * sideSign;
      fill.arrivalMid  = order.arrivalMid;
    }

    await publish(Topics.FILLS, fill, order.symbol);
    this.emit('fill', fill);

    const isFull     = order.remainingQuantity <= 0;
    const newState   = isFull ? OrderState.FILLED : OrderState.PARTIAL;
    const eventType  = isFull ? OrderEventType.FILL : OrderEventType.PARTIAL_FILL;

    await this._transition(orderId, newState, eventType, 'VENUE', {
      fillPrice: fill.fillPrice,
      fillSize:  fill.fillSize,
    });
  }

  async _transition(orderId, newState, eventType, actor, metadata = {}) {
    const order = this._orders.get(orderId);
    if (!order) return;

    const stateBefore = order.state;
    order.state       = newState;
    order.updatedTs   = Date.now();

    await this._emitEvent(orderId, eventType, stateBefore, newState, actor, metadata);
    await publish(Topics.ORDERS, order, order.symbol);
    this.emit('order', order);
  }

  async _emitEvent(orderId, eventType, stateBefore, stateAfter, actor, metadata = {}) {
    /** @type {import('../schemas/events').ORDER_EVENT} */
    const event = {
      eventId:     uuidv4(),
      orderId,
      eventType,
      stateBefore,
      stateAfter,
      eventTs:     Date.now(),
      actor,
      rawMessage:  null,
      metadata,
    };

    await publish(Topics.ORDER_EVENTS, event, orderId);
    this.emit('event', event);
  }
}

// Singleton
const instance = new OrderService();
module.exports = instance;
