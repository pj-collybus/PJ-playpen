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

app.listen(PORT, () => {
  console.log(`\n✓ Server running at http://localhost:${PORT}`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
