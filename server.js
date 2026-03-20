// Requires Node.js >= 18 (uses built-in fetch).
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const STORE_PATH = path.join(__dirname, 'keys_store.json');

// ── Encryption (AES-256-GCM) ──────────────────────────────────────────────────

const ENC_KEY_HEX = process.env.ENCRYPTION_KEY;
let _encKey = null;

function getEncKey() {
  if (_encKey) return _encKey;
  if (!ENC_KEY_HEX) return null;
  if (ENC_KEY_HEX.length !== 64) return null;
  _encKey = Buffer.from(ENC_KEY_HEX, 'hex');
  return _encKey;
}

function encrypt(plaintext) {
  const key = getEncKey();
  if (!key) throw new Error('ENCRYPTION_KEY not configured');
  const iv      = crypto.randomBytes(12);
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(ciphertext) {
  const key = getEncKey();
  if (!key) throw new Error('ENCRYPTION_KEY not configured');
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const iv      = Buffer.from(ivHex, 'hex');
  const tag     = Buffer.from(tagHex, 'hex');
  const enc     = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
}

// ── Key store (local JSON file) ───────────────────────────────────────────────

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read key store:', e.message);
  }
  return { keys: [] };
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// Which field IDs contain secret values for each exchange
const SECRET_FIELDS = {
  Deribit:  ['clientSecret'],
  Binance:  ['secretKey'],
  OKX:      ['secretKey', 'passphrase'],
  Bybit:    ['secretKey'],
  'Gate.io':['secretKey'],
  KuCoin:   ['secretKey', 'passphrase'],
  Kraken:   ['privateKey'],
  BitMEX:   ['apiSecret'],
};

// ── Middleware ────────────────────────────────────────────────────────────────

// Allow requests from file:// origins (HTML opened directly) and localhost
app.use(cors({
  origin: (origin, cb) => cb(null, true),   // allow all origins for local dev
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
app.use(express.static(__dirname));          // serves deribit_testnet.html etc.
app.get('/', (_, res) => res.redirect('/deribit_testnet.html'));

// ── GET /api/keys/list ────────────────────────────────────────────────────────

app.get('/api/keys/list', (req, res) => {
  const store   = loadStore();
  const secrets = SECRET_FIELDS;

  const safeKeys = store.keys.map(entry => {
    const safeFields = {};
    for (const [k, v] of Object.entries(entry.fields || {})) {
      const isSecret = (secrets[entry.exchange] || []).includes(k);
      if (isSecret) {
        safeFields[k] = null;          // never return secret values
      } else {
        try { safeFields[k] = decrypt(v); } catch { safeFields[k] = null; }
      }
    }
    return {
      id:          entry.id,
      exchange:    entry.exchange,
      label:       entry.label,
      permissions: entry.permissions,
      testnet:     entry.testnet,
      status:      entry.status,
      lastTested:  entry.lastTested,
      fields:      safeFields,
    };
  });

  res.json({ keys: safeKeys });
});

// ── POST /api/keys/save ───────────────────────────────────────────────────────

app.post('/api/keys/save', (req, res) => {
  if (!getEncKey()) {
    return res.status(503).json({
      error: 'ENCRYPTION_KEY is not configured on the server. ' +
             'Copy .env.example to .env, set ENCRYPTION_KEY, and restart.',
    });
  }

  const { id, exchange, label, fields, permissions, testnet } = req.body;
  if (!exchange) return res.status(400).json({ error: 'exchange is required' });
  if (!label)    return res.status(400).json({ error: 'label is required' });

  const store = loadStore();
  let entry   = id ? store.keys.find(k => k.id === id) : null;

  if (!entry) {
    entry = {
      id:          crypto.randomUUID(),
      exchange,
      label,
      fields:      {},
      permissions: 'read',
      testnet:     false,
      status:      'unknown',
      lastTested:  null,
    };
    store.keys.push(entry);
  }

  entry.label       = label;
  entry.permissions = permissions || 'read';
  entry.testnet     = !!testnet;
  entry.exchange    = exchange;
  entry.status      = 'unknown';

  for (const [k, v] of Object.entries(fields || {})) {
    if (v === '' || v == null) continue;   // blank → keep existing encrypted value
    try {
      entry.fields[k] = encrypt(v);        // never log v
    } catch (e) {
      return res.status(500).json({ error: 'Encryption failed: ' + e.message });
    }
  }

  saveStore(store);
  res.json({ ok: true, id: entry.id });
});

// ── POST /api/keys/test ───────────────────────────────────────────────────────

app.post('/api/keys/test', async (req, res) => {
  const { id } = req.body;
  const store   = loadStore();
  const entry   = store.keys.find(k => k.id === id);
  if (!entry) return res.status(404).json({ error: 'Key entry not found' });

  const fields = {};
  for (const [k, v] of Object.entries(entry.fields || {})) {
    try { fields[k] = decrypt(v); }
    catch { return res.status(500).json({ error: 'Decryption failed — is ENCRYPTION_KEY unchanged?' }); }
  }

  try {
    const message = await testConnection(entry.exchange, fields, entry.testnet);
    entry.status     = 'ok';
    entry.lastTested = new Date().toISOString();
    saveStore(store);
    res.json({ ok: true, message });
  } catch (e) {
    entry.status     = 'error';
    entry.lastTested = new Date().toISOString();
    saveStore(store);
    res.status(400).json({ error: e.message });
  }
});

// ── DELETE /api/keys/delete ───────────────────────────────────────────────────

app.delete('/api/keys/delete', (req, res) => {
  const { id } = req.body;
  const store   = loadStore();
  const idx     = store.keys.findIndex(k => k.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store.keys.splice(idx, 1);
  saveStore(store);
  res.json({ ok: true });
});

// ── Exchange test-connection implementations ───────────────────────────────────

async function testConnection(exchange, fields, testnet) {
  switch (exchange) {
    case 'Deribit':   return testDeribit(fields, testnet);
    case 'Binance':   return testBinance(fields, testnet);
    case 'OKX':       return testOKX(fields, testnet);
    case 'Bybit':     return testBybit(fields, testnet);
    case 'Gate.io':   return testGateio(fields);
    case 'KuCoin':    return testKucoin(fields);
    case 'Kraken':    return testKraken(fields);
    case 'BitMEX':    return testBitmex(fields, testnet);
    default: throw new Error(`Unknown exchange: ${exchange}`);
  }
}

async function testDeribit(f, testnet) {
  const base = testnet ? 'https://test.deribit.com/api/v2' : 'https://www.deribit.com/api/v2';
  const url  = `${base}/public/auth?client_id=${encodeURIComponent(f.clientId)}`
             + `&client_secret=${encodeURIComponent(f.clientSecret)}`
             + `&grant_type=client_credentials`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return `Connected to Deribit${testnet ? ' (testnet)' : ''}`;
}

async function testBinance(f, testnet) {
  const base = testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  const ts   = Date.now();
  const qs   = `timestamp=${ts}`;
  const sig  = crypto.createHmac('sha256', f.secretKey).update(qs).digest('hex');
  const r    = await fetch(`${base}/api/v3/account?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': f.apiKey },
  });
  const j = await r.json();
  if (j.code) throw new Error(j.msg || `Binance error ${j.code}`);
  return `Connected to Binance${testnet ? ' (testnet)' : ''} — ${j.balances?.length ?? 0} assets`;
}

async function testOKX(f, testnet) {
  const path = '/api/v5/account/balance';
  const ts   = new Date().toISOString();
  const sign = crypto.createHmac('sha256', f.secretKey)
                     .update(`${ts}GET${path}`).digest('base64');
  const headers = {
    'OK-ACCESS-KEY':       f.apiKey,
    'OK-ACCESS-SIGN':      sign,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE':f.passphrase,
    'Content-Type':        'application/json',
  };
  if (testnet) headers['x-simulated-trading'] = '1';
  const r = await fetch(`https://www.okx.com${path}`, { headers });
  const j = await r.json();
  if (j.code !== '0') throw new Error(j.msg || `OKX error ${j.code}`);
  return `Connected to OKX${testnet ? ' (simulated)' : ''}`;
}

async function testBybit(f, testnet) {
  const base       = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const ts         = Date.now().toString();
  const recvWindow = '5000';
  const qs         = 'accountType=UNIFIED';
  const toSign     = `${ts}${f.apiKey}${recvWindow}${qs}`;
  const sig        = crypto.createHmac('sha256', f.secretKey).update(toSign).digest('hex');
  const r = await fetch(`${base}/v5/account/wallet-balance?${qs}`, {
    headers: {
      'X-BAPI-API-KEY':      f.apiKey,
      'X-BAPI-SIGN':         sig,
      'X-BAPI-SIGN-METHOD':  'HMAC-SHA256',
      'X-BAPI-TIMESTAMP':    ts,
      'X-BAPI-RECV-WINDOW':  recvWindow,
    },
  });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit error ${j.retCode}`);
  return `Connected to Bybit${testnet ? ' (testnet)' : ''}`;
}

async function testGateio(f) {
  const path     = '/api/v4/spot/accounts';
  const ts       = Math.floor(Date.now() / 1000).toString();
  const bodyHash = crypto.createHash('sha512').update('').digest('hex');
  const toSign   = `GET\n${path}\n\n${bodyHash}\n${ts}`;
  const sig      = crypto.createHmac('sha512', f.secretKey).update(toSign).digest('hex');
  const r = await fetch(`https://api.gateio.ws${path}`, {
    headers: { 'KEY': f.apiKey, 'SIGN': sig, 'Timestamp': ts },
  });
  const j = await r.json();
  if (j.label) throw new Error(j.message || j.label);
  return `Connected to Gate.io`;
}

async function testKucoin(f) {
  const path   = '/api/v1/accounts';
  const ts     = Date.now().toString();
  const toSign = `${ts}GET${path}`;
  const sig    = crypto.createHmac('sha256', f.secretKey).update(toSign).digest('base64');
  const passEnc = crypto.createHmac('sha256', f.secretKey)
                        .update(f.passphrase).digest('base64');
  const r = await fetch(`https://api.kucoin.com${path}`, {
    headers: {
      'KC-API-KEY':         f.apiKey,
      'KC-API-SIGN':        sig,
      'KC-API-TIMESTAMP':   ts,
      'KC-API-PASSPHRASE':  passEnc,
      'KC-API-KEY-VERSION': '2',
    },
  });
  const j = await r.json();
  if (j.code !== '200000') throw new Error(j.msg || `KuCoin error ${j.code}`);
  return 'Connected to KuCoin';
}

async function testKraken(f) {
  const path  = '/0/private/Balance';
  const nonce = Date.now().toString();
  const body  = `nonce=${nonce}`;
  const hash  = crypto.createHash('sha256').update(nonce + body).digest();
  const keyBuf = Buffer.from(f.privateKey, 'base64');
  const sig   = crypto.createHmac('sha512', keyBuf)
                      .update(Buffer.concat([Buffer.from(path), hash]))
                      .digest('base64');
  const r = await fetch(`https://api.kraken.com${path}`, {
    method: 'POST',
    headers: {
      'API-Key':    f.apiKey,
      'API-Sign':   sig,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const j = await r.json();
  if (j.error && j.error.length > 0) throw new Error(j.error.join(', '));
  return 'Connected to Kraken';
}

async function testBitmex(f, testnet) {
  const base    = testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
  const path    = '/api/v1/user';
  const expires = Math.floor(Date.now() / 1000) + 60;
  const sig     = crypto.createHmac('sha256', f.apiSecret)
                        .update(`GET${path}${expires}`).digest('hex');
  const r = await fetch(`${base}${path}`, {
    headers: {
      'api-key':       f.apiKey,
      'api-signature': sig,
      'api-expires':   expires.toString(),
    },
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return `Connected to BitMEX${testnet ? ' (testnet)' : ''} — ${j.username || ''}`;
}

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

// ── Start ─────────────────────────────────────────────────────────────────────

if (!ENC_KEY_HEX) {
  console.error('\n⚠️  ENCRYPTION_KEY environment variable is not set.');
  console.error('   API key storage will be disabled until it is configured.');
  console.error('   1. Generate a key:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('   2. Copy .env.example to .env');
  console.error('   3. Set ENCRYPTION_KEY=<the generated value>');
  console.error('   4. Restart the server.\n');
} else if (ENC_KEY_HEX.length !== 64) {
  console.error('\n⚠️  ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).\n');
}

// ── Collybus data pipeline startup ───────────────────────────────────────────
async function startDataPipeline() {
  try {
    const tickStore = require('./src/services/tickStore');
    const { startDataQuality } = require('./src/core/dataQuality');

    await tickStore.start();
    await tcaService.start();
    await startDataQuality();

    const kafkaMode = useRealKafka ? 'real' : 'stub';
    const chMode    = useRealClickhouse ? 'real' : 'stub';
    console.log(`Collybus — data pipeline active. Kafka: [${kafkaMode}]. ClickHouse: [${chMode}].`);
  } catch (e) {
    console.error('[startup] Data pipeline failed to start:', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n✓ Server running at http://localhost:${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
  startDataPipeline();
});
