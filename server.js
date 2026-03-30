// Requires Node.js >= 18 (uses built-in fetch).
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const keyStore = require('./src/services/keyStore');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (_, res) => res.redirect('/deribit_testnet.html'));

// ── API Keys — all access goes through keyStore ──────────────────────────────

app.get('/api/keys/list', (req, res) => {
  res.json({ keys: keyStore.listKeys() });
});

app.post('/api/keys/save', (req, res) => {
  if (!keyStore.isReady()) {
    return res.status(503).json({
      error: 'ENCRYPTION_KEY is not configured on the server. ' +
             'Copy .env.example to .env, set ENCRYPTION_KEY, and restart.',
    });
  }
  try {
    const result = keyStore.saveKey(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/keys/test', async (req, res) => {
  try {
    const result = await keyStore.testKey(req.body.id);
    res.json(result);
  } catch (e) {
    if (e.message === 'Key entry not found') return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// Test connection with plaintext credentials (for browser vault — keys not stored)
app.post('/api/keys/test-direct', async (req, res) => {
  try {
    const { exchange, fields, testnet } = req.body;
    if (!exchange || !fields) return res.status(400).json({ error: 'exchange and fields required' });
    const message = await keyStore._testConnectionDirect(exchange, fields, !!testnet);
    res.json({ ok: true, message });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/keys/delete', (req, res) => {
  try {
    res.json(keyStore.deleteKey(req.body.id));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── Instrument proxy — for exchanges that block browser CORS ─────────────────

app.get('/api/instruments/bitmex', async (req, res) => {
  try {
    const r = await fetch('https://testnet.bitmex.com/api/v1/instrument/active');
    const j = await r.json();
    res.json(j);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Helper: fetch JSON from exchange, always return JSON to browser
async function proxyFetch(url, req, res) {
  try {
    const r = await fetch(url);
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.status(502).json({ error: `Non-JSON response from ${url} (HTTP ${r.status})`, body: text.slice(0, 200) }); }
  } catch (e) { res.status(502).json({ error: e.message }); }
}

app.get('/api/instruments/kucoin-futures', (req, res) => proxyFetch('https://api-futures.kucoin.com/api/v1/contracts/active', req, res));
app.get('/api/instruments/kucoin-spot', (req, res) => proxyFetch('https://api.kucoin.com/api/v1/symbols', req, res));
app.get('/api/instruments/kraken-futures', (req, res) => proxyFetch('https://futures.kraken.com/derivatives/api/v3/instruments', req, res));
app.get('/api/instruments/kraken-spot', (req, res) => proxyFetch('https://api.kraken.com/0/public/AssetPairs', req, res));
app.get('/api/instruments/binance-futures', (req, res) => proxyFetch('https://fapi.binance.com/fapi/v1/exchangeInfo', req, res));
app.get('/api/instruments/binance-spot', (req, res) => proxyFetch('https://api.binance.com/api/v3/exchangeInfo', req, res));

app.get('/api/instruments/bybit', (req, res) => {
  const cat = req.query.category || 'linear';
  proxyFetch(`https://api.bybit.com/v5/market/instruments-info?category=${cat}&limit=1000`, req, res);
});

app.get('/api/instruments/okx', (req, res) => {
  const instType = req.query.instType || 'SWAP';
  proxyFetch(`https://www.okx.com/api/v5/public/instruments?instType=${instType}`, req, res);
});

// ── Instrument spec — automatic spec fetching from exchange APIs ──────────────

const instrumentSpecService = require('./src/services/instrumentSpecService');
instrumentSpecService.clearAll(); // Clear stale cache on startup
console.log('[startup] Instrument spec cache cleared');

app.get('/api/instrument-spec/clear', (req, res) => {
  instrumentSpecService.clearAll();
  console.log('[spec] Cache cleared via API');
  res.json({ ok: true, message: 'Instrument spec cache cleared' });
});

app.get('/api/instrument-spec/:exchange/:symbol', async (req, res) => {
  try {
    const spec = await instrumentSpecService.getSpec(
      req.params.exchange.toUpperCase(),
      req.params.symbol
    );
    if (!spec) return res.status(404).json({ error: `No spec found for ${req.params.exchange}/${req.params.symbol}` });
    res.json(spec);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/instrument-spec-cache/stats', (req, res) => {
  res.json(instrumentSpecService.stats());
});

// ── Options Matrix API ───────────────────────────────────────────────────────
const optionsService = require('./src/services/optionsService');
const { OptionsService } = require('./src/services/optionsService');

app.get('/api/options/matrix', async (req, res) => {
  try {
    const { instrument, type, minStrike, maxStrike, fromExpiry, toExpiry, atmOnly, testnet } = req.query;
    const instr = instrument || 'BTC_USDC';
    const isTestnet = testnet !== 'false';
    const filter = {};
    if (type && type !== 'both') filter.type = type === 'calls' ? 'call' : type === 'puts' ? 'put' : type;
    if (minStrike) filter.minStrike = parseFloat(minStrike);
    if (maxStrike) filter.maxStrike = parseFloat(maxStrike);
    if (fromExpiry) filter.fromDays = OptionsService.parseDurationToDays(fromExpiry);
    if (toExpiry) filter.toDays = OptionsService.parseDurationToDays(toExpiry);
    if (atmOnly === 'true') filter.atmOnly = true;
    const matrix = await optionsService.getMatrix(instr, filter, isTestnet);
    res.json(matrix);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/options/index-price', async (req, res) => {
  try {
    const { index, testnet } = req.query;
    const indexName = index || 'btc_usd';
    const isTestnet = testnet !== 'false';
    const price = await optionsService.fetchIndexPrice(indexName, isTestnet);
    res.json({ indexName, price });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Discretion order API ─────────────────────────────────────────────────────
const discretionService = require('./src/services/discretionService');
const { validateSize } = require('./src/utils/sizeUtils');

app.post('/api/validate-size', (req, res) => {
  const { size, lotSize } = req.body;
  res.json(validateSize(parseFloat(size) || 0, parseFloat(lotSize) || 0));
});

app.post('/api/discretion/calculate', (req, res) => {
  try {
    const { limitPrice, discretionBps, discretionPct, side, tickSize, totalSize, lotSize } = req.body;
    if (!limitPrice || !discretionBps || !side) return res.status(400).json({ error: 'limitPrice, discretionBps, and side required' });
    const result = discretionService.calculate({
      limitPrice: parseFloat(limitPrice),
      discretionBps: parseFloat(discretionBps),
      discretionPct: parseFloat(discretionPct) || 50,
      side: String(side).toUpperCase(),
      tickSize: parseFloat(tickSize) || 0.0001,
      totalSize: totalSize ? parseFloat(totalSize) : null,
      lotSize: lotSize ? parseFloat(lotSize) : null,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Venue colours — single source of truth from venues.js ────────────────────

app.get('/api/config/exchange-colors', (req, res) => {
  const venues = require('./src/config/venues');
  const colors = {};
  for (const [key, cfg] of Object.entries(venues)) {
    colors[cfg.id || key] = { color: cfg.exchangeColor, bg: cfg.exchangeBg, text: cfg.exchangeText };
  }
  res.json(colors);
});

// ── Kraken Futures auth test (diagnostic endpoint) ──────────────────────────

app.post('/api/test/kraken-futures-auth', async (req, res) => {
  try {
    const { apiKey, privateKey, testnet } = req.body;
    if (!apiKey || !privateKey) return res.status(400).json({ error: 'apiKey and privateKey required' });
    const crypto = require('crypto');
    const base = testnet ? 'https://demo-futures.kraken.com' : 'https://futures.kraken.com';
    const fullPath = '/derivatives/api/v3/accounts';
    const signPath = '/api/v3/accounts'; // SDK strips '/derivatives' prefix
    const postData = '';
    const nonce = Date.now().toString();

    // Clean key: handle base64url encoding
    const cleanKey = privateKey.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = cleanKey + '='.repeat((4 - cleanKey.length % 4) % 4);
    const keyBuf = Buffer.from(padded, 'base64');

    // Signature per official SDK: SHA256(postData + nonce + signPath) → HMAC-SHA512
    const hashInput = postData + nonce + signPath;
    const sha256 = crypto.createHash('sha256').update(hashInput).digest();
    const sig = crypto.createHmac('sha512', keyBuf).update(sha256).digest('base64');

    const diagnostic = {
      endpoint: base + fullPath,
      signPath,
      nonce,
      hashInput,
      keyDecodedLength: keyBuf.length,
      apiKeyFirst6: apiKey.substring(0, 6),
      sigFirst10: sig.substring(0, 10),
    };

    const r = await fetch(`${base}${fullPath}`, {
      method: 'GET',
      headers: { 'APIKey': apiKey.trim(), 'Authent': sig, 'Nonce': nonce },
    });
    const rawText = await r.text();
    let parsed;
    try { parsed = JSON.parse(rawText); } catch { parsed = null; }

    res.json({
      diagnostic,
      httpStatus: r.status,
      rawResponse: parsed || rawText.slice(0, 500),
      success: parsed?.result === 'success' || (!parsed?.error && r.ok),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Exchange logo proxy (cached 24h in memory) ──────────────────────────────

const _logoCache = new Map(); // exchange → { buffer, contentType, fetchedAt }
const LOGO_CACHE_TTL = 24 * 60 * 60 * 1000;

app.get('/api/exchange-logo/:exchange', async (req, res) => {
  const exchange = req.params.exchange.toUpperCase();
  const cached = _logoCache.get(exchange);
  if (cached && Date.now() - cached.fetchedAt < LOGO_CACHE_TTL) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buffer);
  }
  try {
    const venues = require('./src/config/venues');
    // Case-insensitive lookup: try uppercase, then find by comparing keys
    let cfg = venues[exchange];
    if (!cfg) {
      const key = Object.keys(venues).find(k => k.toUpperCase() === exchange);
      if (key) cfg = venues[key];
    }
    if (!cfg?.logoUrl) return res.status(404).json({ error: 'No logo for ' + exchange });
    // Handle data: URLs — decode and return directly without fetching
    if (cfg.logoUrl.startsWith('data:')) {
      const match = cfg.logoUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Invalid data URL' });
      const buffer = Buffer.from(match[2], 'base64');
      _logoCache.set(exchange, { buffer, contentType: match[1], fetchedAt: Date.now() });
      res.set('Content-Type', match[1]);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }
    const r = await fetch(cfg.logoUrl, { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ error: 'Logo fetch failed: ' + r.status });
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return res.status(404).json({ error: 'Not an image: ' + contentType });
    const buffer = Buffer.from(await r.arrayBuffer());
    _logoCache.set(exchange, { buffer, contentType, fetchedAt: Date.now() });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── TCA API endpoints ─────────────────────────────────────────────────────────

const tcaService = require('./src/services/tcaService');
const { useRealKafka, useRealClickhouse } = require('./src/config/services');

app.get('/api/tca/slippage', async (req, res) => {
  try {
    const { clientId, from, to } = req.query;
    const fromTs = from ? new Date(from).getTime() : Date.now() - 86_400_000;
    const toTs   = to   ? new Date(to).getTime()   : Date.now();
    console.log('[GET /api/tca/slippage] clientId=%s from=%s to=%s', clientId || '(empty)', from || '(default -24h)', to || '(default now)');
    console.log('[GET /api/tca/slippage] Store debug:', tcaService.getStoreDebug());
    const report = await tcaService.getClientSlippageReport(clientId || '', fromTs, toTs);
    console.log('[GET /api/tca/slippage] Returning %d rows', report.length);
    res.json(report);
  } catch (e) {
    console.error('[GET /api/tca/slippage] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tca/venue-scorecard', async (req, res) => {
  try {
    const { symbol, days } = req.query;
    const scorecard = await tcaService.getVenueScorecard(symbol || 'BTC-PERP', parseInt(days) || 7);
    res.json(scorecard);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tca/order-latency', async (req, res) => {
  try {
    const { venue, days } = req.query;
    const latency = await tcaService.getOrderLatency(venue || 'DERIBIT', parseInt(days) || 7);
    res.json(latency);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tca/market-impact', async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const impact = await tcaService.getMarketImpact(orderId);
    if (!impact) return res.status(404).json({ error: 'Order not found' });
    res.json(impact);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tca/live-vwap', async (req, res) => {
  try {
    const { venue, symbol, windowMs } = req.query;
    const vwap = await tcaService.getLiveVwap(
      venue || 'DERIBIT',
      symbol || 'BTC-PERP',
      parseInt(windowMs) || 60_000
    );
    res.json(vwap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tca/config', (req, res) => {
  res.json({
    useRealClickhouse,
    useRealKafka,
  });
});

// ── Risk check endpoint — UI calls this before sending orders to exchanges ───

const riskService = require('./src/services/riskService');

app.post('/api/risk/check', (req, res) => {
  try {
    const o = req.body;
    const order = {
      symbol:     o.symbol || o.instrument_name || '',
      venue:      o.venue || 'DERIBIT',
      side:       (o.side || o.direction || '').toUpperCase(),
      quantity:   o.quantity || o.amount || 0,
      limitPrice: o.price || o.limitPrice || null,
      orderType:  (o.order_type || o.type || 'MARKET').toUpperCase(),
      arrivalMid: o.arrivalMid || 0,
      accountId:  o.accountId || 'default',
      metadata:   o.metadata || {},
    };
    const result = riskService.check(order);
    res.json(result);
  } catch (e) {
    console.error('[risk/check] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/risk/headroom', (req, res) => {
  try {
    const { symbol, exchange, accountId } = req.query;
    const limits = require('./src/config/riskLimits');
    const d = limits.default;
    const s = limits.symbols?.[symbol] || {};
    const a = limits.accounts?.[accountId] || {};
    const cfg = { ...d, ...s, ...a };

    const state = riskService.getState();
    const currentPos = state.positions[symbol] || 0;
    const posHeadroom = cfg.maxPositionSize - Math.abs(currentPos);

    let totalNotional = 0;
    for (const n of Object.values(state.openNotional)) totalNotional += n;
    const notionalHeadroom = cfg.maxTotalNotional - totalNotional;

    const { getBaseCurrency } = require('./src/adapters/orderInterface');
    const unit = symbol ? getBaseCurrency(exchange || 'DERIBIT', symbol) : '';
    res.json({
      positionHeadroom: Math.max(0, posHeadroom),
      positionUnit:     unit,
      maxPositionSize:  cfg.maxPositionSize,
      currentPosition:  currentPos,
      notionalHeadroom: Math.max(0, notionalHeadroom),
      maxTotalNotional: cfg.maxTotalNotional,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Blotter API — unified cross-exchange data ────────────────────────────────

const blotterService = require('./src/services/blotterService');

app.get('/api/blotter', (req, res) => {
  const { venue } = req.query;
  const snap = blotterService.getSnapshot(venue || undefined);
  if (!global._blotterApiLogOnce) { console.log(`[blotter api] orders count: ${snap.orders?.length}, trades: ${snap.trades?.length}, positions: ${snap.positions?.length}`); global._blotterApiLogOnce = true; }
  res.json(snap);
});

app.get('/api/positions/consolidated', async (req, res) => {
  try {
    const cps = require('./src/services/consolidatedPositionService');
    const view = await cps.getConsolidatedView();
    res.json(view);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/positions/all', (req, res) => {
  try {
    const cps = require('./src/services/consolidatedPositionService');
    const { venue } = req.query;
    res.json(cps.getAllPositions(venue || undefined));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/prices/oracle', (req, res) => {
  try {
    const po = require('./src/services/priceOracle');
    res.json(po.stats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trigger private channel auth for all exchanges with credentials
app.post('/api/auth/subscribe-private', async (req, res) => {
  try {
    const { credentials } = req.body;
    console.log('[auth] subscribe-private called for:', credentials ? Object.keys(credentials) : 'none');
    // Log credential shape per exchange (never log actual key values)
    if (credentials) {
      for (const [ex, c] of Object.entries(credentials)) {
        const f = c?.fields || {};
        console.log(`[auth] ${ex} creds shape: testnet=${c?.testnet}, hasApiKey=${!!f.apiKey}, hasSecretKey=${!!f.secretKey}, hasApiSecret=${!!f.apiSecret}, fieldKeys=${Object.keys(f).join(',')}`);
      }
    }
    if (!credentials) return res.status(400).json({ error: 'credentials required' });
    // Wait for public WS connections to establish (Deribit needs its public WS open first)
    await new Promise(resolve => setTimeout(resolve, 2000));
    const registry = require('./src/adapters/adapterRegistry');
    const results = await registry.authenticateAll(credentials);
    res.json({ ok: true, exchanges: results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Generic order submission — routes through orderService → adapter ─────────

const orderService = require('./src/services/orderService');

app.post('/api/order/submit', async (req, res) => {
  try {
    const o = req.body;
    const { credentials, ...loggable } = o;
    console.log('[order/submit] Received:', JSON.stringify(loggable));
    const order = await orderService.submit({
      venue:       o.venue || o.exchange || 'DERIBIT',
      symbol:      o.symbol || o.instrument_name || '',
      side:        (o.side || o.direction || '').toUpperCase(),
      quantity:    parseFloat(o.quantity || o.amount) || 0,
      limitPrice:  parseFloat(o.limitPrice || o.price) || null,
      orderType:   o.orderType || o.type || 'LIMIT',
      timeInForce: o.timeInForce || 'IOC',
      algoType:    o.algoType || 'MANUAL',
      accountLabel: o.accountLabel || undefined,
      credentials: o.credentials || undefined,  // from browser vault
      metadata:    { source: 'ui', ...(o.metadata || {}) },
    });
    console.log('[order/submit] Order state:', order.state, 'id:', order.orderId, 'rejectReason:', order.rejectReason || '(none)');
    if (order.state === 'REJECTED') {
      const reason = order.rejectReason || order.metadata?.rejectReason || 'Rejected';
      const resp = { ok: false, error: reason, orderId: order.orderId, state: order.state };
      if (process.env.DEBUG_ORDERS === 'true') console.log('[DEBUG] Order submit response to UI:', JSON.stringify(resp));
      return res.json(resp);
    }
    const resp = { ok: true, orderId: order.orderId, venueOrderId: order.venueOrderId, state: order.state };
    if (process.env.DEBUG_ORDERS === 'true') console.log('[DEBUG] Order submit response to UI:', JSON.stringify(resp));
    res.json(resp);
  } catch (e) {
    console.error('[order/submit] Error:', e.message, e.stack);
    res.status(500).json({ ok: false, error: e.message || 'Internal server error' });
  }
});

// ── Historical trade/order fetching per exchange ─────────────────────────────

const _histFetchCache = new Map();

async function fetchExchangeHistory(type, exchange, startTime, endTime, creds) {
  const exch = exchange.toUpperCase();
  const isTradesReq = type === 'trades';

  if (exch === 'DERIBIT') {
    const base = creds?.testnet ? 'https://test.deribit.com' : 'https://www.deribit.com';
    const authR = await fetch(`${base}/api/v2/public/auth?client_id=${encodeURIComponent(creds.fields.clientId)}&client_secret=${encodeURIComponent(creds.fields.clientSecret)}&grant_type=client_credentials`);
    const authJ = await authR.json();
    if (authJ.error) throw new Error(authJ.error.message);
    const token = authJ.result.access_token;
    if (isTradesReq) {
      const results = [];
      for (const cur of ['BTC','ETH','USDC']) {
        const r = await fetch(`${base}/api/v2/private/get_user_trades_by_currency?currency=${cur}&start_timestamp=${startTime}&end_timestamp=${endTime}&count=100&sorting=desc`, { headers: { 'Authorization': `Bearer ${token}` } });
        const j = await r.json();
        if (j.result?.trades) results.push(...j.result.trades.map(t => ({
          venue: 'DERIBIT', tradeId: t.trade_id, orderId: t.order_id, symbol: t.instrument_name,
          side: t.direction?.toUpperCase(), size: t.amount, price: t.price,
          fee: t.fee, timestamp: t.timestamp,
        })));
      }
      return results;
    } else {
      const results = [];
      for (const cur of ['BTC','ETH','USDC']) {
        const r = await fetch(`${base}/api/v2/private/get_order_history_by_currency?currency=${cur}&count=100`, { headers: { 'Authorization': `Bearer ${token}` } });
        const j = await r.json();
        if (Array.isArray(j.result)) results.push(...j.result.filter(o => {
          const ts = o.last_update_timestamp || o.creation_timestamp || 0;
          return ts >= startTime && ts <= endTime;
        }).map(o => ({
          venue: 'DERIBIT', orderId: o.order_id, symbol: o.instrument_name,
          side: o.direction?.toUpperCase(), orderType: o.order_type,
          quantity: o.amount, filled: o.filled_amount, price: o.price,
          state: o.order_state?.toUpperCase(), timestamp: o.last_update_timestamp || o.creation_timestamp,
        })));
      }
      return results;
    }
  }

  if (exch === 'BITMEX') {
    const base = creds?.testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
    const startISO = new Date(startTime).toISOString();
    const endISO = new Date(endTime).toISOString();
    const { hmacSha256Hex } = require('./src/adapters/orderInterface');
    const expires = String(Math.floor(Date.now() / 1000) + 60);
    if (isTradesReq) {
      const path = `/api/v1/execution?startTime=${encodeURIComponent(startISO)}&endTime=${encodeURIComponent(endISO)}&count=500`;
      const sig = hmacSha256Hex(creds.fields.apiSecret, 'GET' + path + expires);
      const r = await fetch(`${base}${path}`, { headers: { 'api-key': creds.fields.apiKey, 'api-signature': sig, 'api-expires': expires } });
      const j = await r.json();
      return (Array.isArray(j) ? j : []).filter(e => e.execType === 'Trade').map(t => ({
        venue: 'BITMEX', tradeId: t.execID, orderId: t.orderID, symbol: t.symbol,
        side: t.side?.toUpperCase(), size: t.lastQty, price: t.lastPx,
        fee: t.commission, timestamp: new Date(t.timestamp).getTime(),
      }));
    } else {
      const path = `/api/v1/order?startTime=${encodeURIComponent(startISO)}&endTime=${encodeURIComponent(endISO)}&count=500`;
      const sig = hmacSha256Hex(creds.fields.apiSecret, 'GET' + path + expires);
      const r = await fetch(`${base}${path}`, { headers: { 'api-key': creds.fields.apiKey, 'api-signature': sig, 'api-expires': expires } });
      const j = await r.json();
      return (Array.isArray(j) ? j : []).map(o => ({
        venue: 'BITMEX', orderId: o.orderID, symbol: o.symbol, side: o.side?.toUpperCase(),
        orderType: o.ordType?.toUpperCase(), quantity: o.orderQty, filled: o.cumQty,
        price: o.price, state: ({ New:'OPEN', Filled:'FILLED', Canceled:'CANCELLED' }[o.ordStatus]) || o.ordStatus,
        timestamp: new Date(o.timestamp).getTime(),
      }));
    }
  }

  if (exch === 'BYBIT') {
    const { hmacSha256Hex } = require('./src/adapters/orderInterface');
    const base = creds?.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
    const ts = String(Date.now()), recv = '5000';
    if (isTradesReq) {
      const qs = `category=linear&startTime=${startTime}&endTime=${endTime}&limit=50`;
      const sig = hmacSha256Hex(creds.fields.secretKey, ts + creds.fields.apiKey + recv + qs);
      const r = await fetch(`${base}/v5/execution/list?${qs}`, { headers: { 'X-BAPI-API-KEY': creds.fields.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv } });
      const j = await r.json();
      return (j.result?.list || []).map(t => ({
        venue: 'BYBIT', tradeId: t.execId, orderId: t.orderId, symbol: t.symbol,
        side: t.side?.toUpperCase(), size: parseFloat(t.execQty) || 0, price: parseFloat(t.execPrice) || 0,
        fee: parseFloat(t.execFee) || 0, timestamp: parseInt(t.execTime) || 0,
      }));
    } else {
      const qs = `category=linear&limit=50`;
      const sig = hmacSha256Hex(creds.fields.secretKey, ts + creds.fields.apiKey + recv + qs);
      const r = await fetch(`${base}/v5/order/history?${qs}`, { headers: { 'X-BAPI-API-KEY': creds.fields.apiKey, 'X-BAPI-SIGN': sig, 'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': recv } });
      const j = await r.json();
      return (j.result?.list || []).filter(o => {
        const ts = parseInt(o.updatedTime) || 0;
        return ts >= startTime && ts <= endTime;
      }).map(o => ({
        venue: 'BYBIT', orderId: o.orderId, symbol: o.symbol, side: o.side?.toUpperCase(),
        orderType: o.orderType?.toUpperCase(), quantity: parseFloat(o.qty) || 0,
        filled: parseFloat(o.cumExecQty) || 0, price: parseFloat(o.price) || 0,
        state: ({ New:'OPEN', Filled:'FILLED', Cancelled:'CANCELLED', Rejected:'REJECTED' }[o.orderStatus]) || o.orderStatus,
        timestamp: parseInt(o.updatedTime) || 0,
      }));
    }
  }

  return []; // unsupported exchange
}

app.get('/api/history/trades', async (req, res) => {
  try {
    const { startTime, endTime } = req.query;
    const start = parseInt(startTime) || 0;
    const end = parseInt(endTime) || Date.now();
    const cacheKey = `trades::${start}::${end}`;
    const cached = _histFetchCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 300000) return res.json({ trades: cached.data });

    const registry = require('./src/adapters/adapterRegistry');
    const allCreds = registry.getStoredCredentials ? registry.getStoredCredentials() : {};
    const results = [];
    const errors = [];

    for (const [exch, creds] of Object.entries(allCreds)) {
      try {
        const trades = await fetchExchangeHistory('trades', exch, start, end, creds);
        results.push(...trades);
      } catch (e) {
        errors.push({ exchange: exch, error: e.message });
        console.error(`[history] ${exch} trades fetch failed:`, e.message);
      }
    }

    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    _histFetchCache.set(cacheKey, { data: results, fetchedAt: Date.now() });
    res.json({ trades: results, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/history/orders', async (req, res) => {
  try {
    const { startTime, endTime } = req.query;
    const start = parseInt(startTime) || 0;
    const end = parseInt(endTime) || Date.now();
    const cacheKey = `orders::${start}::${end}`;
    const cached = _histFetchCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 300000) return res.json({ orders: cached.data });

    const registry = require('./src/adapters/adapterRegistry');
    const allCreds = registry.getStoredCredentials ? registry.getStoredCredentials() : {};
    const results = [];
    const errors = [];

    for (const [exch, creds] of Object.entries(allCreds)) {
      try {
        const orders = await fetchExchangeHistory('orders', exch, start, end, creds);
        results.push(...orders);
      } catch (e) {
        errors.push({ exchange: exch, error: e.message });
        console.error(`[history] ${exch} orders fetch failed:`, e.message);
      }
    }

    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    _histFetchCache.set(cacheKey, { data: results, fetchedAt: Date.now() });
    res.json({ orders: results, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TCA: receive order/fill notifications from the frontend UI ───────────────

const { publish } = require('./src/core/eventBus');
const { Topics }  = require('./src/schemas/events');

/**
 * POST /api/tca/notify-order
 * Called by the frontend when a Deribit order is placed.
 * Captures arrivalMid at submission time and publishes to orders.events.DERIBIT.
 */
app.post('/api/tca/notify-order', async (req, res) => {
  try {
    const o = req.body;
    console.log('[notify-order] Raw body from UI:', JSON.stringify(o, null, 2));

    // Use Deribit's order_id as our orderId so fills can join on it
    const deribitOrderId = o.order_id || '';
    const now = Date.now();
    const order = {
      orderId:           deribitOrderId,
      venueOrderId:      deribitOrderId,
      clientOrderId:     o.clientOrderId || `UI-${now}`,
      venue:             o.venue || 'DERIBIT',
      symbol:            o.symbol || o.instrument_name || '',
      side:              (o.side || o.direction || '').toUpperCase(),
      quantity:          o.quantity || o.amount || 0,
      filledQuantity:    o.filled_amount || 0,
      remainingQuantity: (o.quantity || o.amount || 0) - (o.filled_amount || 0),
      limitPrice:        o.price || null,
      stopPrice:         o.stop_price || null,
      orderType:         (o.order_type || o.type || 'MARKET').toUpperCase(),
      state:             (o.order_state || 'OPEN').toUpperCase(),
      // Timing anchors — submittedTs/acknowledgedTs come from the browser
      createdTs:         o.submittedTs || now,
      updatedTs:         o.acknowledgedTs || now,
      submittedTs:       o.submittedTs || now,
      acknowledgedTs:    o.acknowledgedTs || now,
      arrivalBid:        o.arrivalBid || 0,
      arrivalAsk:        o.arrivalAsk || 0,
      arrivalMid:        o.arrivalMid || 0,
      arrivalSpreadBps:  o.arrivalSpreadBps || 0,
      algoType:          o.algoType || 'MANUAL',
      parentOrderId:     null,
      metadata:          { source: 'deribit-ui' },
    };

    console.log('[notify-order] Normalised order:', JSON.stringify({
      orderId: order.orderId, symbol: order.symbol, side: order.side,
      quantity: order.quantity, arrivalMid: order.arrivalMid,
      arrivalBid: order.arrivalBid, arrivalAsk: order.arrivalAsk,
      state: order.state,
    }));

    await publish(Topics.ORDERS, order, order.symbol);
    console.log('[notify-order] Published to bus. orderId=%s symbol=%s', order.orderId, order.symbol);

    // Verify it landed in the store
    const storeCheck = tcaService.getStoreDebug ? tcaService.getStoreDebug() : null;
    if (storeCheck) console.log('[notify-order] Store row counts:', storeCheck);

    res.json({ ok: true, orderId: order.orderId });
  } catch (e) {
    console.error('[notify-order] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/tca/notify-fill
 * Called by the frontend when a Deribit fill (user.trades) arrives via WebSocket.
 * Publishes to orders.fills.DERIBIT so TCA picks it up.
 */
app.post('/api/tca/notify-fill', async (req, res) => {
  try {
    const f = req.body;
    console.log('[notify-fill] Raw body from UI:', JSON.stringify(f, null, 2));

    // Use Deribit's order_id so it joins with the order stored by notify-order
    const serverNow = Date.now();
    const fill = {
      fillId:          f.trade_id || f.fillId || crypto.randomUUID(),
      orderId:         f.order_id || f.orderId || '',
      venue:           f.venue || 'DERIBIT',
      symbol:          f.instrument_name || f.symbol || '',
      side:            (f.direction || f.side || '').toUpperCase(),
      fillPrice:       f.price || f.fillPrice || 0,
      fillSize:        f.amount || f.fillSize || 0,
      fillTs:          f.timestamp || f.fillTs || serverNow,
      // Use browser's receivedTs (when WS message arrived) for accurate latency
      receivedTs:      f.receivedTs || serverNow,
      commission:      f.fee || f.commission || 0,
      commissionAsset: f.fee_currency || f.commissionAsset || 'BTC',
      slippageBps:     0,
      arrivalMid:      f.arrivalMid || 0,
    };

    // Compute slippage if arrivalMid is known
    if (fill.arrivalMid > 0) {
      const sideSign = fill.side === 'BUY' ? 1 : -1;
      fill.slippageBps = (fill.fillPrice - fill.arrivalMid) / fill.arrivalMid * 10000 * sideSign;
    }

    console.log('[notify-fill] Normalised fill:', JSON.stringify({
      fillId: fill.fillId, orderId: fill.orderId, symbol: fill.symbol,
      side: fill.side, fillPrice: fill.fillPrice, fillSize: fill.fillSize,
      arrivalMid: fill.arrivalMid, slippageBps: fill.slippageBps,
    }));

    await publish(Topics.FILLS, fill, fill.symbol);
    console.log('[notify-fill] Published to bus. fillId=%s orderId=%s', fill.fillId, fill.orderId);

    // Verify it landed in the store
    const storeCheck = tcaService.getStoreDebug ? tcaService.getStoreDebug() : null;
    if (storeCheck) console.log('[notify-fill] Store row counts:', storeCheck);

    res.json({ ok: true, fillId: fill.fillId });
  } catch (e) {
    console.error('[notify-fill] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── Algo execution engine (worker thread) ────────────────────────────────────

const { Worker } = require('worker_threads');
const path       = require('path');

let _algoWorker    = null;
let _algoCallbacks = new Map(); // requestId → { resolve, reject, timer }
let _algoStrategies = new Map(); // strategyId → latest status
let _algoConfigs    = [];        // strategy plugin configs from worker

function spawnAlgoWorker() {
  // Kill existing worker if any (ensures fresh code on restart)
  if (_algoWorker) {
    try { _algoWorker.terminate(); } catch {}
    _algoWorker = null;
  }
  const workerPath = path.join(__dirname, 'src', 'algo', 'engine.js');
  const worker = new Worker(workerPath);

  worker.on('message', (msg) => {
    switch (msg.type) {
      case 'STRATEGY_STARTED':
        _algoStrategies.set(msg.strategyId, { state: 'RUNNING', ...msg });
        console.log(`[algo] Strategy ${msg.strategyId} (${msg.strategyType}) started`);
        _resolveCallback(msg.strategyId, msg);
        break;

      case 'STRATEGY_STOPPED':
        if (_algoStrategies.has(msg.strategyId)) _algoStrategies.get(msg.strategyId).state = 'STOPPED';
        console.log(`[algo] Strategy ${msg.strategyId} stopped`);
        _cleanupOpenOrders(msg.strategyId);
        _resolveCallback(msg.strategyId, msg);
        break;

      case 'STRATEGY_ERROR':
        if (_algoStrategies.has(msg.strategyId)) _algoStrategies.get(msg.strategyId).state = 'ERROR';
        console.error(`[algo] Strategy ${msg.strategyId} error: ${msg.error}`);
        _resolveCallback(msg.strategyId, msg);
        break;

      case 'STATUS_UPDATE':
        if (msg.strategies) {
          for (const [sid, s] of Object.entries(msg.strategies)) {
            _algoStrategies.set(sid, s);
          }
        }
        if (msg.strategyId) {
          if (_algoStrategies.has(msg.strategyId)) _algoStrategies.get(msg.strategyId).state = msg.state;
        }
        _resolveCallback('_status', msg);
        break;

      case 'ALGO_PROGRESS': {
        if (_algoStrategies.has(msg.strategyId)) Object.assign(_algoStrategies.get(msg.strategyId), msg);
        // Cleanup open orders when strategy completes
        const progState = (msg.state || msg.status || '').toUpperCase();
        if (progState === 'COMPLETED' || progState === 'STOPPED') _cleanupOpenOrders(msg.strategyId);
        publish('system.algo_progress', msg, msg.strategyId).catch(() => {});
        break;
      }

      case 'ORDER_INTENT':
        _handleOrderIntent(msg);
        break;

      case 'CANCEL_INTENT': {
        const cid = msg.childId;
        const cancelledOrder = _openSimOrders.get(cid);
        if (cancelledOrder) {
          _openSimOrders.delete(cid);
          publish(Topics.ORDERS, {
            orderId: cid, venueOrderId: cid,
            venue: cancelledOrder.venue, symbol: cancelledOrder.symbol,
            side: cancelledOrder.side, quantity: cancelledOrder.quantity,
            filledQuantity: 0, remainingQuantity: 0,
            limitPrice: cancelledOrder.limitPrice, orderType: 'LIMIT',
            state: 'CANCELLED', updatedTs: Date.now(), algoType: 'ALGO',
            parentOrderId: cancelledOrder.parentOrderId,
            metadata: { source: 'algo', strategyId: cancelledOrder.strategyId, intentId: cid, simulated: true },
          }, cancelledOrder.symbol).catch(() => {});
        }
        break;
      }

      case 'SIMULATED_FILL': {
        // Publish simulated fill to blotter — normalise venue to uppercase
        const venue = (msg.venue || 'UNKNOWN').toUpperCase();
        const fillTs = Date.now();
        console.log(`[algo] Simulated fill: ${msg.symbol} ${msg.side} ${msg.fillSize} @ ${msg.fillPrice}`);
        console.log(`[sim] publishing FILLED for orderId: ${msg.intentId}`);
        _openSimOrders.delete(msg.intentId);
        // Publish FILLED order update so blotter/child order table shows filled state
        // Note: do not set parentOrderId here — the OPEN event already set it correctly
        // and blotterService merge preserves existing fields via spread
        // Look up parentOrderId from the original OPEN event
        const origOrder = _openSimOrders.get(msg.intentId);
        publish(Topics.ORDERS, {
          orderId:           msg.intentId,
          venueOrderId:      msg.intentId,
          venue, symbol:     msg.symbol,
          side:              msg.side,
          quantity:          msg.fillSize,
          filledQuantity:    msg.fillSize,
          remainingQuantity: 0,
          limitPrice:        msg.fillPrice,
          orderType:         'LIMIT',
          state:             'FILLED',
          updatedTs:         fillTs,
          algoType:          'ALGO',
          parentOrderId:     origOrder?.parentOrderId || msg.strategyId,
          metadata:          { source: 'algo', strategyId: msg.strategyId, intentId: msg.intentId, simulated: true },
        }, msg.symbol).catch(() => {});
        publish(Topics.FILLS, {
          fillId: 'sim-' + msg.intentId, orderId: msg.intentId,
          venue, symbol: msg.symbol,
          side: msg.side, fillPrice: msg.fillPrice, fillSize: msg.fillSize,
          fillTs, receivedTs: fillTs,
          commission: 0, commissionAsset: '', slippageBps: 0, arrivalMid: 0,
          simulated: true,
        }, msg.symbol).catch(() => {});
        // Update position — read existing and adjust size
        const posKey = `${venue}::${msg.symbol}`;
        const existingPos = blotterService.getPositions().find(p => p.venue === venue && p.symbol === msg.symbol);
        const curSize = existingPos?.size || 0;
        const curSide = existingPos?.side || 'FLAT';
        const fillSigned = msg.side === 'BUY' ? msg.fillSize : -msg.fillSize;
        const prevSigned = curSide === 'LONG' ? curSize : curSide === 'SHORT' ? -curSize : 0;
        const newSigned = prevSigned + fillSigned;
        const newSide = newSigned > 0 ? 'LONG' : newSigned < 0 ? 'SHORT' : 'FLAT';
        publish(Topics.POSITIONS, {
          venue, symbol: msg.symbol, side: newSide,
          size: Math.abs(newSigned),
          sizeUnit: existingPos?.sizeUnit || msg.symbol.replace(/USD.*|USDT$|USDC$/, ''),
          avgEntryPrice: msg.fillPrice, markPrice: msg.fillPrice,
          unrealisedPnl: 0, liquidationPrice: 0,
          timestamp: Date.now(), simulated: true,
        }, msg.symbol).catch(() => {});
        break;
      }

      case 'STRATEGY_CONFIGS':
        _algoConfigs = msg.configs || [];
        console.log(`[algo] Received ${_algoConfigs.length} strategy configs from worker`);
        _resolveCallback('_configs', msg);
        break;

      case 'PLUGINS_RELOADED':
        console.log(`[algo] Plugins reloaded: ${(msg.plugins || []).join(', ')}`);
        break;
    }
  });

  worker.on('error', (err) => {
    console.error('CRITICAL: Algo engine worker error:', err.message);
  });

  worker.on('exit', (code) => {
    console.error(`CRITICAL: Algo engine worker exited with code ${code} — restarting in 2s`);
    _algoWorker = null;
    setTimeout(() => { _algoWorker = spawnAlgoWorker(); }, 2000);
  });

  _algoWorker = worker;

  // Send simulated fill venues config
  const venues = require('./src/config/venues');
  const simVenues = Object.keys(venues).filter(k => venues[k].simulateFills);
  if (simVenues.length) {
    setTimeout(() => worker.postMessage({ type: 'SET_SIM_VENUES', venues: simVenues }), 500);
  }

  return worker;
}

/** Map exchange orderId → intentId so order state updates reach the correct strategy */
const _orderIdToIntentId = new Map();

/** Track open sim orders for cleanup on strategy completion */
const _openSimOrders = new Map(); // intentId → { strategyId, symbol, venue, side, quantity, limitPrice, parentOrderId }

function _cleanupOpenOrders(strategyId) {
  let cancelled = 0;
  for (const [intentId, order] of _openSimOrders) {
    if (order.strategyId === strategyId) {
      console.log(`[algo] Cancelling open sim order ${intentId} for completed strategy ${strategyId.substring(strategyId.length - 6)}`);
      publish(Topics.ORDERS, {
        orderId:           intentId,
        venueOrderId:      intentId,
        venue:             order.venue,
        symbol:            order.symbol,
        side:              order.side,
        quantity:          order.quantity,
        filledQuantity:    0,
        remainingQuantity: 0,
        limitPrice:        order.limitPrice,
        orderType:         'LIMIT',
        state:             'CANCELLED',
        updatedTs:         Date.now(),
        algoType:          'ALGO',
        parentOrderId:     order.parentOrderId,
        metadata:          { source: 'algo', strategyId, intentId, simulated: true },
      }, order.symbol).catch(() => {});
      _openSimOrders.delete(intentId);
      cancelled++;
    }
  }
  if (cancelled) console.log(`[algo] Cleaned up ${cancelled} open sim orders for strategy ${strategyId.substring(strategyId.length - 6)}`);
}

/** Venues where fills are simulated — skip real exchange submission */
let _simFillVenueSet = new Set();
{
  const venues = require('./src/config/venues');
  for (const k of Object.keys(venues)) {
    if (venues[k].simulateFills) _simFillVenueSet.add(k.toUpperCase());
  }
}

async function _handleOrderIntent(intent) {
  const venue = (intent.venue || 'DERIBIT').toUpperCase();

  // For sim-fill venues, skip real exchange — the worker's sim fill system handles it
  if (_simFillVenueSet.has(venue)) {
    console.log(`[algo] ORDER_INTENT ${intent.intentId} — sim-fill venue ${venue}, strategy=${intent.strategyId?.slice(-6)}, type=${intent.algoType}, qty=${intent.quantity}`);
    // Publish synthetic OPEN order so it appears in blotter and child order tables
    console.log(`[sim] publishing OPEN for orderId: ${intent.intentId} parentOrderId: ${intent.parentOrderId || intent.strategyId} strategyId: ${intent.strategyId?.slice(-6)}`);
    const now = Date.now();
    publish(Topics.ORDERS, {
      orderId:           intent.intentId,
      venueOrderId:      intent.intentId,
      clientOrderId:     intent.intentId,
      venue:             venue,
      symbol:            intent.symbol,
      side:              intent.side,
      quantity:          intent.quantity,
      filledQuantity:    0,
      remainingQuantity: intent.quantity,
      limitPrice:        intent.limitPrice,
      orderType:         intent.orderType || 'LIMIT',
      state:             'OPEN',
      createdTs:         now,
      updatedTs:         now,
      submittedTs:       now,
      acknowledgedTs:    now,
      algoType:          intent.algoType || 'ALGO',
      parentOrderId:     intent.parentOrderId || intent.strategyId,
      metadata:          { source: 'algo', strategyId: intent.strategyId, intentId: intent.intentId, simulated: true },
    }, intent.symbol).catch(() => {});
    // Track open order for cleanup on strategy completion
    _openSimOrders.set(intent.intentId, {
      strategyId: intent.strategyId, symbol: intent.symbol, venue,
      side: intent.side, quantity: intent.quantity, limitPrice: intent.limitPrice,
      parentOrderId: intent.parentOrderId || intent.strategyId,
    });
    return;
  }

  // Submit through orderService for real venues
  try {
    const orderService = require('./src/services/orderService');
    const order = await orderService.submit({
      symbol:      intent.symbol,
      venueSymbol: intent.symbol, // adapter will resolve
      venue:       intent.venue || 'DERIBIT',
      side:        intent.side,
      quantity:    intent.quantity,
      limitPrice:  intent.limitPrice,
      orderType:   intent.orderType || 'LIMIT',
      timeInForce: intent.timeInForce || 'IOC',
      algoType:    intent.algoType || 'ALGO',
      parentOrderId: intent.parentOrderId || intent.strategyId,
      metadata:    {
        source: 'algo', strategyId: intent.strategyId, intentId: intent.intentId,
        shortId: intent.shortId, parentOrderId: intent.parentOrderId,
        sliceNumber: intent.sliceNumber,
      },
    });
    console.log(`[algo] ORDER_INTENT ${intent.intentId} submitted as order ${order.orderId}`);
    // Map exchange orderId → intentId for order state updates
    if (order.orderId) _orderIdToIntentId.set(order.orderId, intent.intentId);
    // If immediately rejected, notify worker
    if (order.state === 'REJECTED') {
      console.log(`[algo] ORDER_INTENT ${intent.intentId} immediately rejected: ${order.rejectReason || 'unknown'}`);
      if (_algoWorker) {
        _algoWorker.postMessage({
          type: 'ORDER_UPDATE',
          payload: { orderId: intent.intentId, intentId: intent.intentId, state: 'REJECTED', reason: order.rejectReason },
        });
      }
    }
  } catch (err) {
    console.error(`[algo] ORDER_INTENT ${intent.intentId} failed:`, err.message);
    // Treat submission failure as rejection
    if (_algoWorker) {
      _algoWorker.postMessage({
        type: 'ORDER_UPDATE',
        payload: { orderId: intent.intentId, intentId: intent.intentId, state: 'REJECTED', reason: err.message },
      });
    }
  }
}

function _resolveCallback(key, data) {
  const cb = _algoCallbacks.get(key);
  if (cb) {
    clearTimeout(cb.timer);
    _algoCallbacks.delete(key);
    cb.resolve(data);
  }
}

function _sendToWorker(msg) {
  if (!_algoWorker) throw new Error('Algo engine not running');
  _algoWorker.postMessage(msg);
}

function _sendAndWait(msg, key, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { _algoCallbacks.delete(key); reject(new Error('Algo engine timeout')); }, timeoutMs);
    _algoCallbacks.set(key, { resolve, reject, timer });
    _sendToWorker(msg);
  });
}

// Forward market data and trades to the worker
const { subscribe: busSubscribe } = require('./src/core/eventBus');
async function _wireAlgoDataFeeds() {
  await busSubscribe('market.l1.bbo', 'algo-engine-l1', async (event) => {
    if (_algoWorker) _algoWorker.postMessage({ type: 'MARKET_DATA', payload: event });
  });
  await busSubscribe('market.trades', 'algo-engine-trades', async (event) => {
    if (_algoWorker) _algoWorker.postMessage({ type: 'TRADE_DATA', payload: event });
  });
  await busSubscribe('orders.fills', 'algo-engine-fills', async (event) => {
    if (_algoWorker) _algoWorker.postMessage({ type: 'FILL_DATA', payload: event });
  });
  await busSubscribe('orders.state', 'algo-engine-orders', async (event) => {
    if (_algoWorker && (event.state === 'REJECTED' || event.state === 'CANCELLED')) {
      // Map exchange orderId back to intentId so the worker can match it
      const intentId = _orderIdToIntentId.get(event.orderId);
      if (intentId) {
        event.intentId = intentId;
        _orderIdToIntentId.delete(event.orderId);
      }
      _algoWorker.postMessage({ type: 'ORDER_UPDATE', payload: event });
    }
  });
}

// ── Algo API endpoints ───────────────────────────────────────────────────────

app.post('/api/algo/start', async (req, res) => {
  try {
    const { strategyType, params } = req.body;
    if (!strategyType) return res.status(400).json({ error: 'strategyType required' });
    if (!params?.symbol || !params?.side || !params?.totalSize) {
      return res.status(400).json({ error: 'params.symbol, params.side, params.totalSize required' });
    }
    const strategyId = `algo-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const result = await _sendAndWait(
      { type: 'START_STRATEGY', payload: { strategyId, strategyType, params } },
      strategyId,
    );
    res.json({ ok: true, strategyId, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/algo/stop/:strategyId', async (req, res) => {
  try {
    const result = await _sendAndWait(
      { type: 'STOP_STRATEGY', strategyId: req.params.strategyId },
      req.params.strategyId,
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/algo/pause/:strategyId', (req, res) => {
  try {
    _sendToWorker({ type: 'PAUSE_STRATEGY', strategyId: req.params.strategyId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/algo/resume/:strategyId', (req, res) => {
  try {
    _sendToWorker({ type: 'RESUME_STRATEGY', strategyId: req.params.strategyId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Acceleration: immediately execute remaining qty aggressively
app.post('/api/algo/accelerate/:strategyId', (req, res) => {
  try {
    const { quantity } = req.body;
    _sendToWorker({ type: 'ACCELERATE', strategyId: req.params.strategyId, quantity: parseFloat(quantity) || 0 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Browser pushes live market data for active algo strategies
app.post('/api/algo/market-data', (req, res) => {
  try {
    if (_algoWorker) _algoWorker.postMessage({ type: 'MARKET_DATA', payload: req.body });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/algo/status', async (req, res) => {
  try {
    if (_algoWorker) {
      const result = await _sendAndWait({ type: 'GET_STATUS' }, '_status');
      res.json({ strategies: result.strategies || {} });
    } else {
      res.json({ strategies: Object.fromEntries(_algoStrategies), workerStatus: 'DOWN' });
    }
  } catch (e) {
    res.json({ strategies: Object.fromEntries(_algoStrategies), workerStatus: 'TIMEOUT' });
  }
});

app.post('/api/algo/reload-plugins', async (req, res) => {
  try {
    if (_algoWorker) {
      _algoWorker.postMessage({ type: 'RELOAD_PLUGINS' });
      res.json({ ok: true, message: 'Plugin reload triggered' });
    } else {
      res.status(503).json({ ok: false, error: 'Algo worker not running' });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/algo/strategies', (req, res) => {
  // Read configs directly from strategy files — no dependency on worker
  try {
    const fs = require('fs');
    const stratDir = path.join(__dirname, 'src', 'algo', 'strategies');
    const files = fs.readdirSync(stratDir).filter(f => f.endsWith('.js'));
    const configs = [];
    for (const file of files) {
      try {
        const mod = require(path.join(stratDir, file));
        if (mod.config && mod.config.name && mod.config.params) {
          configs.push(mod.config);
        }
      } catch (e) {
        console.error(`[algo/strategies] Failed to load ${file}:`, e.message);
      }
    }
    res.json({ strategies: configs });
  } catch (e) {
    console.error('[algo/strategies] Directory scan failed:', e.message);
    res.json({ strategies: _algoConfigs }); // fallback to worker-provided configs
  }
});

app.get('/api/algo/estimate', (req, res) => {
  try {
    const { type } = req.query;
    if (!type) return res.json({ estimate: '' });
    const fs = require('fs');
    const stratPath = path.join(__dirname, 'src', 'algo', 'strategies');
    const files = fs.readdirSync(stratPath).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const mod = require(path.join(stratPath, file));
      if (mod.config?.name?.toUpperCase() === type.toUpperCase() && mod.estimateDuration) {
        const params = {};
        for (const [k, v] of Object.entries(req.query)) { if (k !== 'type') params[k] = parseFloat(v) || v; }
        return res.json({ estimate: mod.estimateDuration(params) });
      }
    }
    res.json({ estimate: '' });
  } catch (e) { res.json({ estimate: '' }); }
});

// ── Health endpoint ───────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  try {
    const registry = require('./src/adapters/adapterRegistry');
    res.json(registry.getHealth());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (!keyStore.isReady()) {
  console.error('\n⚠️  ENCRYPTION_KEY environment variable is not set or invalid.');
  console.error('   API key storage will be disabled until it is configured.');
  console.error('   1. Generate a key:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('   2. Copy .env.example to .env');
  console.error('   3. Set ENCRYPTION_KEY=<the generated value>');
  console.error('   4. Restart the server.\n');
}

// ── Collybus data pipeline startup ───────────────────────────────────────────
async function startDataPipeline() {
  try {
    const tickStore = require('./src/services/tickStore');
    const { startDataQuality } = require('./src/core/dataQuality');

    await tickStore.start();
    await tcaService.start();
    await blotterService.start();
    const priceOracle = require('./src/services/priceOracle');
    await priceOracle.start();
    const consolidatedPositionService = require('./src/services/consolidatedPositionService');
    await consolidatedPositionService.start();
    await startDataQuality();

    const kafkaMode = useRealKafka ? 'real' : 'stub';
    const chMode    = useRealClickhouse ? 'real' : 'stub';
    console.log(`Collybus — data pipeline active. Kafka: [${kafkaMode}]. ClickHouse: [${chMode}].`);

    // Start algo engine worker
    spawnAlgoWorker();
    await _wireAlgoDataFeeds();
    console.log('[startup] Algo engine worker spawned');
  } catch (e) {
    console.error('[startup] Data pipeline failed to start:', e.message);
  }
}

// Catch-all error handler — always return JSON, never HTML
app.use((err, req, res, _next) => {
  console.error('[express] Unhandled error:', err.message, err.stack);
  res.status(500).json({ ok: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n✓ Server running at http://localhost:${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
  startDataPipeline();
});
