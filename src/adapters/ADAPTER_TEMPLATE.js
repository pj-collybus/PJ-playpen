/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ADAPTER TEMPLATE — copy this file to add a new exchange
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This template contains a complete working adapter skeleton. Every method,
 * event, and integration point is documented. Follow the checklist below and
 * fill in the TODOs marked with "// TODO:" in the code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CHECKLIST — every file you must touch when adding a new exchange
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. CREATE this adapter file
 *    Copy this template to: src/adapters/{exchange}.js
 *    Replace VENUE, class name, and all TODO sections.
 *
 * 2. src/adapters/adapterRegistry.js
 *    - Add: const { MyExchangeAdapter } = require('./{exchange}');
 *    - Add to _classes Map: ['MYEXCHANGE', MyExchangeAdapter]
 *    The registry auto-creates circuit breakers (ws_connect, rest_orders,
 *    rest_data) and injects dataBreaker into the constructor.
 *
 * 3. src/config/venues.js
 *    Add a config block:
 *      MYEXCHANGE: {
 *        id:         'MYEXCHANGE',
 *        wsUrl:      'wss://...',
 *        restBase:   'https://...',
 *        testnet:    false,
 *        feedType:   'WEBSOCKET',     // or 'FIX' for FIX stubs
 *        assetClass: ['CRYPTO_SPOT'], // which instrument classes
 *      }
 *
 * 4. src/config/fees.js
 *    Add fee schedule:
 *      MYEXCHANGE: { maker: 1.0, taker: 5.0 }   // in basis points
 *
 * 5. src/core/symbolRegistry.js
 *    Add seed mappings for the top symbols this exchange trades:
 *      ['MYEXCHANGE', 'BTCUSDT', 'BTC-USDT', InstrumentClass.CRYPTO_SPOT]
 *    These map the exchange's native symbol to the canonical format.
 *    The normalise() function will use heuristic fallback for unmapped symbols,
 *    but explicit mappings are more reliable.
 *
 * 6. src/services/keyStore.js (SECRET_FIELDS)
 *    Add which credential fields are secrets:
 *      MyExchange: ['secretKey']
 *    This controls which fields are redacted in GET /api/keys/list.
 *
 * 7. src/services/keyStore.js (_testConnection switch)
 *    Add a test function:
 *      case 'MyExchange': return _testMyExchange(fields, testnet);
 *    Implement _testMyExchange() that makes an authenticated API call.
 *
 * 8. VERIFY — after completing the above, run:
 *      node -e "const r = require('./src/adapters/adapterRegistry'); r.getAllAdapters(); console.log(r.getHealth())"
 *    Every venue should appear in the health output.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Data flow:
 *   Exchange WS → adapter._onMessage()
 *     → receivedTs captured immediately (Date.now() before JSON.parse)
 *     → raw message parsed
 *     → routed to handler (_handleTicker, _handleBook, _handleTrades)
 *     → normalised to canonical event shape (L1_BBO, L2_BOOK, TRADE)
 *     → sequence gap check via BookGuard (book updates only)
 *     → published to event bus → Kafka stub → ClickHouse stub
 *     → consumed by: marketDataService, tickStore, tcaService, dataQuality
 *
 * Order flow:
 *   orderService.submit() → adapter.sendOrder()
 *     → wrapped in CircuitBreaker (rest_orders)
 *     → REST call to exchange
 *     → returns { orderId, venueOrderId, state, fill? }
 *     → orderService publishes ORDER + FILL events to bus
 *
 * Circuit breakers (auto-created by adapterRegistry):
 *   {VENUE}_ws_connect  — wraps connect()
 *   {VENUE}_rest_orders — wraps sendOrder() (via orderService)
 *   {VENUE}_rest_data   — wraps snapshot fetches (via BookGuard)
 *
 * Sequence gap detection (BookGuard):
 *   Tracks sequence IDs per symbol. On gap:
 *     1. Marks feed STALE
 *     2. Stops publishing L2 events for that symbol
 *     3. Fetches REST snapshot (throttled: 2s cooldown)
 *     4. Resets sequence baseline
 *     5. Resumes publishing
 *
 * Stale feed detection (BookGuard):
 *   If no message received for a symbol for 5 seconds:
 *     → Publishes { type: 'feed_status', status: 'STALE' } to bus
 *     → UI health dot turns amber/red
 *     → dataQuality logs CRITICAL if stale > 30s
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CANONICAL EVENT SHAPES (must not be changed)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * L1_BBO (published to Topics.L1_BBO):
 *   { venue, instrumentClass, symbol, venueSymbol, exchangeTs, receivedTs,
 *     sequenceId, bidPrice, bidSize, bidOrderCount, askPrice, askSize,
 *     askOrderCount, midPrice, spreadBps, feedType }
 *
 * L2_BOOK (published to Topics.L2_BOOK):
 *   { venue, symbol, exchangeTs, receivedTs, sequenceId, updateId, side,
 *     price, size, orderCount, levelDepth, updateType }
 *   updateType: 'SNAPSHOT' | 'DELTA' | 'CLEAR'
 *   side: 'BID' | 'ASK'
 *
 * TRADE (published to Topics.TRADES):
 *   { venue, symbol, exchangeTs, receivedTs, tradeId, price, size, side,
 *     isLiquidation, isBlockTrade, notionalUsd }
 *   side: 'BUY' | 'SELL' | 'UNKNOWN'
 *
 * See src/schemas/events.js for full JSDoc definitions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REQUIRED EVENTS TO EMIT (on the adapter EventEmitter):
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   this.emit('connected')       — after WS connection established
 *   this.emit('disconnected')    — after WS connection lost
 *   this.emit('error', err)      — on any error
 *   this.emit('l1', event)       — on every L1 BBO update
 *   this.emit('l2', event)       — on every L2 book update (if subscribed)
 *   this.emit('trade', event)    — on every trade print
 *   this.emit('fill', fill)      — on order fill (if adapter handles orders)
 *   this.emit('feed_status', ev) — emitted by BookGuard (automatic)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

const { EventEmitter } = require('events');
const WebSocket        = require('ws');
const { normalise }    = require('../core/symbolRegistry');
const { publish }      = require('../core/eventBus');
const { Topics, InstrumentClass, FeedType } = require('../schemas/events');
const { BookGuard }    = require('./bookGuard');
const venues           = require('../config/venues');

// ─── Constants ───────────────────────────────────────────────────────────────

// TODO: Change to your exchange's uppercase ID. Must match the key in venues.js.
const VENUE = 'MYEXCHANGE';

// TODO: Reference your venue config from src/config/venues.js
const cfg = venues.MYEXCHANGE;

// ─── Instrument class detection ──────────────────────────────────────────────
// TODO: Implement logic to detect what kind of instrument a venue symbol is.
// Each exchange has its own naming conventions:
//   Deribit: 'BTC-PERPETUAL' → CRYPTO_PERP, 'BTC-27DEC24' → CRYPTO_FUTURE
//   Binance: 'BTCUSDT' → CRYPTO_SPOT
//   OKX:     'BTC-USDT-SWAP' → CRYPTO_PERP, 'BTC-USDT-231229' → CRYPTO_FUTURE

function detectInstrumentClass(venueSymbol) {
  // TODO: Add your exchange's pattern matching
  if (venueSymbol.includes('PERP') || venueSymbol.includes('SWAP')) {
    return InstrumentClass.CRYPTO_PERP;
  }
  if (/\d{6,8}$/.test(venueSymbol)) {
    return InstrumentClass.CRYPTO_FUTURE;
  }
  return InstrumentClass.CRYPTO_SPOT;
}

// ─── Adapter class ───────────────────────────────────────────────────────────

// TODO: Rename the class to match your exchange: MyExchangeAdapter
class MyExchangeAdapter extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.publishToBus=true] - Set false for unit testing
   * @param {object}  [opts.dataBreaker=null]  - CircuitBreaker for REST data calls (injected by registry)
   */
  constructor({ publishToBus = true, dataBreaker = null } = {}) {
    super();
    this.publishToBus   = publishToBus;
    this._ws            = null;
    this._subscriptions = new Set(); // Set of venueSymbol strings
    this._dead          = false;     // True after disconnect() — prevents reconnection
    this._reconnectMs   = 2000;      // Delay before reconnection attempt
    this._pingTimer     = null;      // Keepalive ping interval

    // BookGuard handles:
    //   - Sequence gap detection on book updates
    //   - Stale feed timeout (5s no update → STALE event)
    //   - Snapshot throttling (2s cooldown between REST snapshots)
    //   - dataBreaker wraps snapshot REST calls in circuit breaker
    this._guard = new BookGuard(VENUE, this, (sym) => this._fetchSnapshot(sym), { publishToBus, dataBreaker });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — these methods are called by adapterRegistry and orderService
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Connect to the exchange WebSocket.
   * Called by adapterRegistry.startAll() — wrapped in ws_connect circuit breaker.
   * MUST emit 'connected' on success.
   * MUST schedule reconnection on close (unless this._dead).
   */
  async connect() {
    return new Promise((resolve, reject) => {
      // TODO: Replace with your exchange's WebSocket URL
      const ws = new WebSocket(cfg.wsUrl);
      this._ws = ws;

      ws.once('open', () => {
        this._startPing();     // Start keepalive
        this.emit('connected');
        resolve();
      });

      ws.once('error', reject);

      // IMPORTANT: receivedTs must be captured at the very top of the message
      // handler, before JSON.parse — this is the "wire time" for latency measurement.
      ws.on('message', (data) => this._onMessage(data));

      ws.on('close', () => {
        this._stopPing();
        this.emit('disconnected');
        // Auto-reconnect unless disconnect() was called explicitly
        if (!this._dead) this._scheduleReconnect();
      });

      ws.on('error', (err) => this.emit('error', err));
    });
  }

  /**
   * Subscribe to market data for a symbol.
   * Called after connect(). Can be called multiple times for different symbols.
   * Must send the appropriate subscription message to the exchange WS.
   *
   * @param {string} venueSymbol - The exchange's native symbol (e.g. 'BTCUSDT', 'BTC-PERPETUAL')
   */
  async subscribe(venueSymbol) {
    this._subscriptions.add(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      // TODO: Send your exchange's subscription message.
      // Examples:
      //   Deribit: this._rpc('public/subscribe', { channels: [`book.${venueSymbol}.100ms`] })
      //   Binance: this._ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [...], id: Date.now() }))
      //   Bybit:   this._ws.send(JSON.stringify({ op: 'subscribe', args: [...] }))
      //   OKX:     this._ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: venueSymbol }] }))

      this._ws.send(JSON.stringify({
        // TODO: your subscribe message here
      }));
    }
  }

  /**
   * Unsubscribe from market data for a symbol.
   * @param {string} venueSymbol
   */
  async unsubscribe(venueSymbol) {
    this._subscriptions.delete(venueSymbol);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      // TODO: Send your exchange's unsubscribe message
      this._ws.send(JSON.stringify({
        // TODO: your unsubscribe message here
      }));
    }
  }

  /**
   * Disconnect cleanly. Sets _dead=true to prevent reconnection.
   * Always call _guard.destroy() to clean up stale-check timers.
   */
  disconnect() {
    this._dead = true;
    this._stopPing();
    this._guard.destroy();
    if (this._ws) this._ws.close();
  }

  /**
   * Send an order to the exchange (optional — only needed for execution venues).
   * Called by orderService._executeOnAdapter(), wrapped in rest_orders circuit breaker.
   *
   * MUST return: { orderId, venueOrderId, state, fill? }
   *   - orderId:      your internal ID or the exchange's ID
   *   - venueOrderId: the exchange-assigned order ID
   *   - state:        OrderState.FILLED | OrderState.OPEN | etc
   *   - fill:         optional immediate fill object (for FOK/IOC orders)
   *
   * The fill object shape (if returned):
   *   { fillId, orderId, venue, symbol, side, fillPrice, fillSize,
   *     fillTs, receivedTs, commission, commissionAsset, slippageBps, arrivalMid }
   *
   * @param {object} params
   * @param {string} params.symbol       - Canonical symbol
   * @param {string} params.venueSymbol  - Exchange-native symbol
   * @param {'BUY'|'SELL'} params.side
   * @param {number} params.quantity
   * @param {number|null} params.limitPrice
   * @returns {Promise<object>}
   */
  async sendOrder({ symbol, venueSymbol, side, quantity, limitPrice }) {
    // TODO: Implement REST order submission to your exchange.
    // Use the exchange's REST API with proper authentication.
    // Return the shape described above.
    throw new Error('sendOrder not implemented for ' + VENUE);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL — message parsing and event normalisation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * WebSocket message handler.
   * CRITICAL: receivedTs = Date.now() MUST be the very first line.
   */
  _onMessage(raw) {
    const receivedTs = Date.now(); // Capture BEFORE any parsing
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // TODO: Skip control messages (pong, subscribe acks, heartbeats).
    // Examples:
    //   if (msg.op === 'pong') return;
    //   if (msg.event === 'subscribe') return;

    // TODO: Route to the appropriate handler based on message type/channel.
    // Each exchange has a different message structure:
    //
    //   Deribit:  msg.method === 'subscription' → msg.params.channel → 'ticker.*' or 'book.*'
    //   Binance:  msg.stream → 'btcusdt@bookTicker' or 'btcusdt@trade'
    //   Bybit:    msg.topic → 'orderbook.1.BTCUSDT' or 'publicTrade.BTCUSDT'
    //   OKX:      msg.arg.channel → 'tickers' or 'trades'
    //   Kraken:   msg.channel → 'ticker' or 'trade' or 'book'

    // this._handleTicker(data, receivedTs);
    // this._handleBook(data, receivedTs);
    // this._handleTrades(data, receivedTs);
  }

  /**
   * Handle ticker / L1 BBO updates.
   * Normalise to canonical L1_BBO shape and publish.
   */
  _handleTicker(data, receivedTs) {
    // TODO: Extract the venue symbol from the message
    const venueSymbol = ''; // TODO

    // Tell BookGuard we received data for this symbol (stale feed detection)
    this._guard.touch(venueSymbol);

    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol = normalise(VENUE, venueSymbol, instrumentClass);

    // TODO: Extract bid/ask from your exchange's message format
    const bidPrice = 0; // TODO: parseFloat(data.???) || 0
    const askPrice = 0; // TODO: parseFloat(data.???) || 0
    const bidSize  = 0; // TODO
    const askSize  = 0; // TODO

    const midPrice  = bidPrice && askPrice ? (bidPrice + askPrice) / 2 : 0;
    const spreadBps = midPrice > 0 ? (askPrice - bidPrice) / midPrice * 10_000 : 0;

    // Canonical L1_BBO event — do not change this shape
    const event = {
      venue:          VENUE,
      instrumentClass,
      symbol,
      venueSymbol,
      exchangeTs:     receivedTs,  // TODO: use exchange timestamp if available
      receivedTs,
      sequenceId:     null,        // TODO: set if exchange provides one
      bidPrice,
      bidSize,
      bidOrderCount:  0,           // TODO: set if exchange provides order count
      askPrice,
      askSize,
      askOrderCount:  0,
      midPrice,
      spreadBps,
      feedType:       FeedType.WEBSOCKET,
    };

    // Emit locally (for in-process consumers) and publish to bus (for services)
    this.emit('l1', event);
    if (this.publishToBus) publish(Topics.L1_BBO, event, symbol).catch(() => {});
  }

  /**
   * Handle order book / L2 updates.
   * MUST check sequence via BookGuard before publishing.
   * If BookGuard returns false (gap detected), do NOT publish — it will
   * trigger a snapshot fetch automatically.
   */
  _handleBook(data, receivedTs) {
    // TODO: Extract venue symbol and sequence ID
    const venueSymbol = ''; // TODO
    const seqId       = null; // TODO: extract sequence/change_id/updateId from message
    const isSnapshot  = false; // TODO: true if this is a full snapshot, false for delta

    // ──────────────────────────────────────────────────────────────────────
    // SEQUENCE GAP CHECK — this is the critical integration point.
    // If check() returns false, a gap was detected:
    //   - BookGuard marks the feed STALE
    //   - BookGuard triggers _fetchSnapshot() (with circuit breaker + throttle)
    //   - You MUST return here and NOT publish the event
    // ──────────────────────────────────────────────────────────────────────
    if (!this._guard.check(venueSymbol, seqId, isSnapshot)) return;

    const instrumentClass = detectInstrumentClass(venueSymbol);
    const symbol = normalise(VENUE, venueSymbol, instrumentClass);

    // TODO: Iterate over bid/ask levels and emit L2_BOOK events
    // Example for a snapshot with arrays of [price, size]:
    //
    //   const bids = data.bids || [];
    //   const asks = data.asks || [];
    //   bids.forEach(([price, size], depth) => {
    //     const event = {
    //       venue: VENUE, symbol,
    //       exchangeTs: receivedTs, receivedTs,
    //       sequenceId: seqId, updateId: null,
    //       side: 'BID', price, size,
    //       orderCount: 0, levelDepth: depth,
    //       updateType: isSnapshot ? 'SNAPSHOT' : 'DELTA',
    //     };
    //     this.emit('l2', event);
    //     if (this.publishToBus) publish(Topics.L2_BOOK, event, symbol).catch(() => {});
    //   });
  }

  /**
   * Handle public trade prints.
   * Touch BookGuard for stale detection.
   */
  _handleTrades(data, receivedTs) {
    // TODO: data may be a single trade or an array of trades
    const trades = Array.isArray(data) ? data : [data];

    for (const t of trades) {
      // TODO: Extract venue symbol
      const venueSymbol = ''; // TODO

      // Touch BookGuard (stale feed detection)
      this._guard.touch(venueSymbol);

      const instrumentClass = detectInstrumentClass(venueSymbol);
      const symbol = normalise(VENUE, venueSymbol, instrumentClass);

      // TODO: Extract trade fields
      const price = 0; // TODO: parseFloat(t.???)
      const size  = 0; // TODO

      // Canonical TRADE event — do not change this shape
      const event = {
        venue:         VENUE,
        symbol,
        exchangeTs:    receivedTs, // TODO: use exchange timestamp if available
        receivedTs,
        tradeId:       String(t.id || Date.now()), // TODO: use exchange trade ID
        price,
        size,
        side:          'UNKNOWN',  // TODO: 'BUY' | 'SELL' | 'UNKNOWN'
        isLiquidation: false,      // TODO: set if exchange flags liquidations
        isBlockTrade:  false,      // TODO: set if exchange flags block trades
        notionalUsd:   price * size,
      };

      this.emit('trade', event);
      if (this.publishToBus) publish(Topics.TRADES, event, symbol).catch(() => {});
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SNAPSHOT — called by BookGuard when a sequence gap is detected
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Fetch a full order book snapshot via REST.
   * Called automatically by BookGuard on sequence gaps.
   * Wrapped in the rest_data circuit breaker (via BookGuard's dataBreaker).
   * Throttled to at most once per 2 seconds per symbol.
   *
   * After fetching, you MUST:
   *   1. Call this._guard.check(venueSymbol, newSeqId, true) to reset the baseline
   *   2. Emit the snapshot levels as L2_BOOK events with updateType: 'SNAPSHOT'
   *
   * @param {string} venueSymbol
   */
  async _fetchSnapshot(venueSymbol) {
    // TODO: Replace with your exchange's REST order book endpoint
    const url = `${cfg.restBase}/api/v1/depth?symbol=${encodeURIComponent(venueSymbol)}&limit=50`;
    const r = await fetch(url);
    const j = await r.json();
    // TODO: Check for errors in the response

    // TODO: Extract the new sequence ID from the snapshot
    const newSeqId = null; // TODO

    // Reset BookGuard sequence baseline (isSnapshot=true)
    this._guard.check(venueSymbol, newSeqId, true);

    // TODO: Emit L2_BOOK events for each level in the snapshot
    // (see _handleBook for the event shape)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KEEPALIVE & RECONNECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start sending ping messages to keep the WS connection alive.
   * Most exchanges require periodic pings or they'll disconnect you.
   * Typical intervals: 15-30 seconds.
   */
  _startPing() {
    // TODO: Adjust interval and ping message for your exchange.
    // Examples:
    //   Bybit/OKX: JSON { op: 'ping' } every 20s
    //   Kraken:    JSON { method: 'ping' } every 30s
    //   OKX:       plain text 'ping' every 25s
    //   Binance:   no ping needed (server sends pong frames automatically)

    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ op: 'ping' })); // TODO: your ping format
      }
    }, 20_000);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  /**
   * Schedule a reconnection attempt after connection loss.
   * Re-subscribes to all previously subscribed symbols after reconnecting.
   * The ws_connect circuit breaker is applied by adapterRegistry.startAll(),
   * but manual reconnections bypass it — this is intentional for resilience.
   */
  _scheduleReconnect() {
    setTimeout(async () => {
      try {
        await this.connect();
        for (const sym of this._subscriptions) await this.subscribe(sym);
      } catch (err) {
        this.emit('error', err);
        this._scheduleReconnect(); // Keep trying
      }
    }, this._reconnectMs);
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────
// TODO: Rename the export to match your class name
module.exports = { MyExchangeAdapter };
