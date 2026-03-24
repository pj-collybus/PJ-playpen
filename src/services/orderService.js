/**
 * Order service — order lifecycle management.
 *
 * Generic submit: adapter = registry.getAdapter(venue) → adapter.submitOrder(order, creds)
 * No per-exchange bespoke handling. Adding a new exchange = adding an adapter file only.
 */

'use strict';

const { EventEmitter }  = require('events');
const { v4: uuidv4 }    = require('uuid');
const { publish, Topics } = require('../core/eventBus');
const { OrderState, OrderEventType } = require('../schemas/events');
const { CircuitOpenError } = require('../core/circuitBreaker');
const marketDataService = require('./marketDataService');
const riskService       = require('./riskService');

class OrderService extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} orderId → ORDER */
    this._orders = new Map();
  }

  /**
   * Submit a new order — generic across all exchanges.
   * Flow: build order → risk check → adapter.submitOrder(order, creds)
   */
  async submit(params) {
    const orderId       = uuidv4();
    const clientOrderId = `CLB-${Date.now()}-${orderId.slice(0, 8)}`;
    const now           = Date.now();

    // TCA anchors
    const bbo = marketDataService.getBBO(params.symbol);
    const arrivalBid       = bbo?.bestBid ?? 0;
    const arrivalAsk       = bbo?.bestAsk ?? 0;
    let   arrivalMid       = bbo?.midPrice ?? 0;
    const arrivalSpreadBps = bbo?.spreadBps ?? 0;

    if (!arrivalMid && params.limitPrice) arrivalMid = params.limitPrice;
    if (!arrivalMid) {
      console.error(`[orderService] CRITICAL: no arrivalMid for ${params.symbol}`);
      arrivalMid = arrivalBid || arrivalAsk || params.limitPrice || 0;
    }

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
      orderType:         params.orderType || 'LIMIT',
      timeInForce:       params.timeInForce || 'IOC',
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

    // ── Pre-trade risk check ────────────────────────────────────────────────
    const riskResult = riskService.check(order);
    if (riskResult.rejected) {
      const reason = `[RISK] ${riskResult.reason}: ${riskResult.detail}`;
      order.state = OrderState.REJECTED;
      order.rejectReason = reason;
      order.updatedTs = Date.now();
      await this._emitEvent(orderId, OrderEventType.REJECT, OrderState.PENDING, OrderState.REJECTED, 'SYSTEM', {
        rejectReason: reason,
      });
      await publish(Topics.ORDERS, order, order.symbol);
      this.emit('order', order);
      return order;
    }

    // Emit SUBMIT event
    await this._emitEvent(orderId, OrderEventType.SUBMIT, OrderState.PENDING, OrderState.PENDING, 'TRADER');
    await publish(Topics.ORDERS, order, order.symbol);

    // ── Route to adapter — await the result so caller gets final state ─────
    try {
      await this._executeGeneric(orderId, order, params);
    } catch (err) {
      try {
        if (err instanceof CircuitOpenError) {
          const msg = `Exchange ${params.venue} is temporarily unavailable — circuit breaker open. Order not sent.`;
          console.error(`[orderService] BLOCKED: ${order.symbol} ${order.side} ${order.quantity} — ${msg}`);
          await this._transition(orderId, OrderState.REJECTED, OrderEventType.REJECT, 'SYSTEM', { rejectReason: msg });
        } else {
          console.error(`[orderService] REJECTED: ${order.venue} ${order.symbol} ${order.side} — ${err.message}`);
          await this._transition(orderId, OrderState.REJECTED, OrderEventType.REJECT, 'VENUE', { rejectReason: err.message });
        }
      } catch (transErr) {
        console.error(`[orderService] CRITICAL: transition failed for ${orderId}: ${transErr.message}`);
        order.state = OrderState.REJECTED;
        order.rejectReason = err.message;
        order.updatedTs = Date.now();
        this.emit('order', order);
      }
    }

    return order;
  }

  /**
   * Cancel an open order.
   */
  async cancel(orderId) {
    const order = this._orders.get(orderId);
    if (!order) throw new Error(`Unknown order: ${orderId}`);
    if (order.state === OrderState.FILLED || order.state === OrderState.CANCELLED) {
      throw new Error(`Cannot cancel order in state ${order.state}`);
    }

    await this._emitEvent(orderId, OrderEventType.CANCEL_REQUEST, order.state, order.state, 'TRADER');

    // If we have a venueOrderId, cancel via adapter
    if (order.venueOrderId) {
      try {
        const registry = require('../adapters/adapterRegistry');
        const adapter  = registry.getAdapter(order.venue);
        const keyStore = require('./keyStore');
        const creds    = keyStore.getKey(order.venue);
        if (adapter?.cancelOrder && creds) {
          await adapter.cancelOrder(order.venueOrderId, creds);
        }
      } catch (e) {
        console.error(`[orderService] Cancel via adapter failed: ${e.message}`);
      }
    }

    await this._transition(orderId, OrderState.CANCELLED, OrderEventType.CANCELLED, 'VENUE');
  }

  getOrder(orderId) { return this._orders.get(orderId) || null; }

  listOrders({ symbol, state, venue } = {}) {
    let orders = Array.from(this._orders.values());
    if (symbol) orders = orders.filter(o => o.symbol === symbol);
    if (state)  orders = orders.filter(o => o.state === state);
    if (venue)  orders = orders.filter(o => o.venue === venue);
    return orders;
  }

  // ── Generic adapter execution ──────────────────────────────────────────────

  async _executeGeneric(orderId, order, params) {
    console.log(`[orderService] Generic order path: ${order.venue} ${order.symbol} ${order.side} qty=${order.quantity}`);
    const registry = require('../adapters/adapterRegistry');
    const adapter  = registry.getAdapter(order.venue);
    if (!adapter) throw new Error(`No adapter for venue ${order.venue}`);
    if (!adapter.submitOrder) throw new Error(`Adapter ${order.venue} does not implement submitOrder`);

    // Get credentials — prefer params.credentials (from browser vault), fall back to server-side keyStore
    let creds = params.credentials || null;
    if (!creds || !creds.fields) {
      const keyStore = require('./keyStore');
      creds = keyStore.getKey(order.venue, params.accountLabel);
      // Case-insensitive fallback
      if (!creds) creds = keyStore.getKey(order.venue.toUpperCase(), params.accountLabel);
      if (!creds) creds = keyStore.getKey(order.venue.charAt(0).toUpperCase() + order.venue.slice(1).toLowerCase(), params.accountLabel);
    }
    if (!creds || !creds.fields) {
      throw new Error(`No API credentials configured for ${order.venue} — add keys in the API Keys tab`);
    }

    // Circuit breaker
    const breaker = registry.getBreaker(order.venue, 'rest_orders');

    const result = await breaker.execute(() => adapter.submitOrder(order, creds));

    // Handle normalised response
    if (result.status === 'REJECTED') {
      throw new Error(result.rejectReason || 'Order rejected by exchange');
    }

    order.venueOrderId = result.venueOrderId;
    await this._transition(orderId, OrderState.OPEN, OrderEventType.ACK, 'VENUE');

    // Handle immediate fill — only emit synthetic fill if no private WS is delivering real fills
    // Exchanges with subscribePrivate() send real execution events via WS → avoid duplicate
    const hasPrivateWs = typeof adapter.subscribePrivate === 'function' && adapter._privateWs;
    if (result.filledQty > 0 && !hasPrivateWs) {
      const fill = {
        fillId:     uuidv4(),
        orderId,
        venue:      order.venue,
        symbol:     order.symbol,
        side:       order.side,
        fillPrice:  result.avgFillPrice,
        fillSize:   result.filledQty,
        fillTs:     Date.now(),
        receivedTs: Date.now(),
        commission: 0,
        commissionAsset: '',
        slippageBps: 0,
        arrivalMid: order.arrivalMid,
      };
      await this._applyFill(orderId, fill);
    } else if (result.filledQty > 0 && hasPrivateWs) {
      console.log(`[orderService] Skipping synthetic fill for ${order.venue} — private WS will deliver real fill`);
    }
  }

  // ── Fill handling ──────────────────────────────────────────────────────────

  async _applyFill(orderId, fill) {
    const order = this._orders.get(orderId);
    if (!order) return;

    order.filledQuantity    += fill.fillSize;
    order.remainingQuantity  = order.quantity - order.filledQuantity;

    if (order.arrivalMid) {
      const sideSign   = order.side === 'BUY' ? 1 : -1;
      fill.slippageBps = (fill.fillPrice - order.arrivalMid) / order.arrivalMid * 10_000 * sideSign;
      fill.arrivalMid  = order.arrivalMid;
    }

    await publish(Topics.FILLS, fill, order.symbol);
    this.emit('fill', fill);

    const posDelta = order.side === 'BUY' ? fill.fillSize : -fill.fillSize;
    riskService.updatePosition(order.symbol, posDelta);

    const isFull    = order.remainingQuantity <= 0;
    const newState  = isFull ? OrderState.FILLED : OrderState.PARTIAL;
    const eventType = isFull ? OrderEventType.FILL : OrderEventType.PARTIAL_FILL;

    await this._transition(orderId, newState, eventType, 'VENUE', {
      fillPrice: fill.fillPrice, fillSize: fill.fillSize,
    });
  }

  async _transition(orderId, newState, eventType, actor, metadata = {}) {
    const order = this._orders.get(orderId);
    if (!order) return;
    const stateBefore = order.state;
    order.state       = newState;
    order.updatedTs   = Date.now();
    // Store rejectReason on the order itself so it's available in all downstream reads
    if (metadata.rejectReason) order.rejectReason = metadata.rejectReason;
    await this._emitEvent(orderId, eventType, stateBefore, newState, actor, metadata);
    await publish(Topics.ORDERS, order, order.symbol);
    this.emit('order', order);
  }

  async _emitEvent(orderId, eventType, stateBefore, stateAfter, actor, metadata = {}) {
    const event = {
      eventId: uuidv4(), orderId, eventType, stateBefore, stateAfter,
      eventTs: Date.now(), actor, rawMessage: null, metadata,
    };
    await publish(Topics.ORDER_EVENTS, event, orderId);
    this.emit('event', event);
  }
}

const instance = new OrderService();
module.exports = instance;
