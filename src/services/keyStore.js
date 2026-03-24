/**
 * Key store — single point of access for all API key operations.
 *
 * Every part of the codebase that needs exchange credentials MUST go through
 * this module. When the storage backend is swapped (e.g. to AWS Secrets Manager),
 * only this file changes.
 *
 * Usage:
 *   const keyStore = require('./keyStore');
 *   const creds = keyStore.getKey('Deribit', 'My Testnet Key');
 *   // creds = { clientId: '...', clientSecret: '...' }
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Configuration ────────────────────────────────────────────────────────────

const STORE_PATH = path.join(__dirname, '..', '..', 'keys_store.json');

/** Which field IDs contain secret values for each exchange */
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

// ── Encryption (AES-256-GCM) ────────────────────────────────────────────────

const ENC_KEY_HEX = process.env.ENCRYPTION_KEY;
let _encKey = null;

function _getEncKey() {
  if (_encKey) return _encKey;
  if (!ENC_KEY_HEX) return null;
  if (ENC_KEY_HEX.length !== 64) return null;
  _encKey = Buffer.from(ENC_KEY_HEX, 'hex');
  return _encKey;
}

function _encrypt(plaintext) {
  const key = _getEncKey();
  if (!key) throw new Error('ENCRYPTION_KEY not configured');
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function _decrypt(ciphertext) {
  const key = _getEncKey();
  if (!key) throw new Error('ENCRYPTION_KEY not configured');
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const iv      = Buffer.from(ivHex, 'hex');
  const tag     = Buffer.from(tagHex, 'hex');
  const enc     = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
}

// ── Store I/O ────────────────────────────────────────────────────────────────

function _loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read key store:', e.message);
  }
  return { keys: [] };
}

function _saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether the encryption key is configured.
 * @returns {boolean}
 */
function isReady() {
  return !!_getEncKey();
}

/**
 * Get decrypted credentials for a specific exchange + label.
 * This is the primary function everything else should call.
 *
 * @param {string} exchange - e.g. 'Deribit', 'Binance'
 * @param {string} [label]  - key label (optional; if omitted, returns first match for exchange)
 * @returns {{ id: string, exchange: string, label: string, testnet: boolean, permissions: string, fields: object } | null}
 *   fields contains all decrypted values, e.g. { clientId: '...', clientSecret: '...' }
 */
function getKey(exchange, label) {
  const store = _loadStore();
  const exUp = exchange?.toUpperCase();
  const entry = label
    ? store.keys.find(k => k.exchange?.toUpperCase() === exUp && k.label === label)
    : store.keys.find(k => k.exchange?.toUpperCase() === exUp);
  if (!entry) return null;

  const fields = _decryptFields(entry.fields);
  return {
    id:          entry.id,
    exchange:    entry.exchange,
    label:       entry.label,
    testnet:     entry.testnet,
    permissions: entry.permissions,
    fields,
  };
}

/**
 * Get decrypted credentials by entry ID.
 * @param {string} id
 * @returns {object|null} Same shape as getKey()
 */
function getKeyById(id) {
  const store = _loadStore();
  const entry = store.keys.find(k => k.id === id);
  if (!entry) return null;

  const fields = _decryptFields(entry.fields);
  return {
    id:          entry.id,
    exchange:    entry.exchange,
    label:       entry.label,
    testnet:     entry.testnet,
    permissions: entry.permissions,
    fields,
  };
}

/**
 * List all stored keys with secrets redacted.
 * @returns {object[]} Array of { id, exchange, label, permissions, testnet, status, lastTested, fields }
 */
function listKeys() {
  const store = _loadStore();
  return store.keys.map(entry => {
    const safeFields = {};
    for (const [k, v] of Object.entries(entry.fields || {})) {
      const isSecret = (SECRET_FIELDS[entry.exchange] || []).includes(k);
      if (isSecret) {
        safeFields[k] = null;
      } else {
        try { safeFields[k] = _decrypt(v); } catch { safeFields[k] = null; }
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
}

/**
 * Save (create or update) a key entry. All field values are encrypted before storage.
 *
 * @param {object} params
 * @param {string} [params.id]          - Entry ID (if updating)
 * @param {string}  params.exchange
 * @param {string}  params.label
 * @param {object}  params.fields       - { fieldName: plaintextValue }
 * @param {string} [params.permissions] - 'read' | 'read_write'
 * @param {boolean}[params.testnet]
 * @returns {{ ok: boolean, id: string }}
 */
function saveKey({ id, exchange, label, fields, permissions, testnet }) {
  if (!_getEncKey()) throw new Error('ENCRYPTION_KEY not configured');
  if (!exchange) throw new Error('exchange is required');
  if (!label)    throw new Error('label is required');

  const store = _loadStore();
  let entry = id ? store.keys.find(k => k.id === id) : null;

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
    if (v === '' || v == null) continue; // blank → keep existing
    entry.fields[k] = _encrypt(v);
  }

  _saveStore(store);
  return { ok: true, id: entry.id };
}

/**
 * Delete a key entry by ID.
 * @param {string} id
 * @returns {{ ok: boolean }}
 */
function deleteKey(id) {
  const store = _loadStore();
  const idx = store.keys.findIndex(k => k.id === id);
  if (idx === -1) throw new Error('Not found');
  store.keys.splice(idx, 1);
  _saveStore(store);
  return { ok: true };
}

/**
 * Test a key's connection to its exchange.
 * Decrypts credentials and calls the exchange-specific test function.
 *
 * @param {string} id - Entry ID
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function testKey(id) {
  const store = _loadStore();
  const entry = store.keys.find(k => k.id === id);
  if (!entry) throw new Error('Key entry not found');

  const fields = _decryptFields(entry.fields);

  try {
    const message = await _testConnection(entry.exchange, fields, entry.testnet);
    entry.status     = 'ok';
    entry.lastTested = new Date().toISOString();
    _saveStore(store);
    return { ok: true, message };
  } catch (e) {
    entry.status     = 'error';
    entry.lastTested = new Date().toISOString();
    _saveStore(store);
    throw e;
  }
}

/**
 * Update a key entry's status without re-testing.
 * @param {string} id
 * @param {string} status
 */
function updateStatus(id, status) {
  const store = _loadStore();
  const entry = store.keys.find(k => k.id === id);
  if (!entry) return;
  entry.status     = status;
  entry.lastTested = new Date().toISOString();
  _saveStore(store);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _decryptFields(encryptedFields) {
  const fields = {};
  for (const [k, v] of Object.entries(encryptedFields || {})) {
    try { fields[k] = _decrypt(v); }
    catch { throw new Error('Decryption failed — is ENCRYPTION_KEY unchanged?'); }
  }
  return fields;
}

// ── Exchange test-connection implementations ─────────────────────────────────

async function _testConnection(exchange, fields, testnet) {
  switch (exchange) {
    case 'Deribit':   return _testDeribit(fields, testnet);
    case 'Binance':   return _testBinance(fields, testnet);
    case 'OKX':       return _testOKX(fields, testnet);
    case 'Bybit':     return _testBybit(fields, testnet);
    case 'Gate.io':   return _testGateio(fields);
    case 'KuCoin':    return _testKucoin(fields);
    case 'Kraken':    return _testKraken(fields, testnet);
    case 'BitMEX':    return _testBitmex(fields, testnet);
    default: throw new Error(`Unknown exchange: ${exchange}`);
  }
}

async function _testDeribit(f, testnet) {
  const base = testnet ? 'https://test.deribit.com/api/v2' : 'https://www.deribit.com/api/v2';
  const url  = `${base}/public/auth?client_id=${encodeURIComponent(f.clientId)}`
             + `&client_secret=${encodeURIComponent(f.clientSecret)}`
             + `&grant_type=client_credentials`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return `Connected to Deribit${testnet ? ' (testnet)' : ''}`;
}

async function _testBinance(f, testnet) {
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

async function _testOKX(f, testnet) {
  const p  = '/api/v5/account/balance';
  const ts = new Date().toISOString();
  const sign = crypto.createHmac('sha256', f.secretKey)
                     .update(`${ts}GET${p}`).digest('base64');
  const headers = {
    'OK-ACCESS-KEY': f.apiKey, 'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': f.passphrase,
    'Content-Type': 'application/json',
  };
  if (testnet) headers['x-simulated-trading'] = '1';
  const r = await fetch(`https://www.okx.com${p}`, { headers });
  const j = await r.json();
  if (j.code !== '0') throw new Error(j.msg || `OKX error ${j.code}`);
  return `Connected to OKX${testnet ? ' (simulated)' : ''}`;
}

async function _testBybit(f, testnet) {
  const base       = testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const ts         = Date.now().toString();
  const recvWindow = '5000';
  const qs         = 'accountType=UNIFIED';
  const toSign     = `${ts}${f.apiKey}${recvWindow}${qs}`;
  const sig        = crypto.createHmac('sha256', f.secretKey).update(toSign).digest('hex');
  const r = await fetch(`${base}/v5/account/wallet-balance?${qs}`, {
    headers: {
      'X-BAPI-API-KEY': f.apiKey, 'X-BAPI-SIGN': sig,
      'X-BAPI-SIGN-METHOD': 'HMAC-SHA256', 'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recvWindow,
    },
  });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit error ${j.retCode}`);
  return `Connected to Bybit${testnet ? ' (testnet)' : ''}`;
}

async function _testGateio(f) {
  const p        = '/api/v4/spot/accounts';
  const ts       = Math.floor(Date.now() / 1000).toString();
  const bodyHash = crypto.createHash('sha512').update('').digest('hex');
  const toSign   = `GET\n${p}\n\n${bodyHash}\n${ts}`;
  const sig      = crypto.createHmac('sha512', f.secretKey).update(toSign).digest('hex');
  const r = await fetch(`https://api.gateio.ws${p}`, {
    headers: { 'KEY': f.apiKey, 'SIGN': sig, 'Timestamp': ts },
  });
  const j = await r.json();
  if (j.label) throw new Error(j.message || j.label);
  return 'Connected to Gate.io';
}

async function _testKucoin(f) {
  const p      = '/api/v1/accounts';
  const ts     = Date.now().toString();
  const toSign = `${ts}GET${p}`;
  const sig    = crypto.createHmac('sha256', f.secretKey).update(toSign).digest('base64');
  const passEnc = crypto.createHmac('sha256', f.secretKey)
                        .update(f.passphrase).digest('base64');
  const r = await fetch(`https://api.kucoin.com${p}`, {
    headers: {
      'KC-API-KEY': f.apiKey, 'KC-API-SIGN': sig,
      'KC-API-TIMESTAMP': ts, 'KC-API-PASSPHRASE': passEnc,
      'KC-API-KEY-VERSION': '2',
    },
  });
  const j = await r.json();
  if (j.code !== '200000') throw new Error(j.msg || `KuCoin error ${j.code}`);
  return 'Connected to KuCoin';
}

async function _testKraken(f, testnet) {
  const isFutures = f.keyType === 'futures';
  const keyBuf = Buffer.from(f.privateKey || f.secretKey, 'base64');

  if (isFutures) {
    // Kraken Futures SDK: strip '/derivatives' prefix from path before hashing
    const base = testnet ? 'https://demo-futures.kraken.com' : 'https://futures.kraken.com';
    const fullPath = '/derivatives/api/v3/accounts';
    const signPath = '/api/v3/accounts';
    const postData = '';
    const nonce = Date.now().toString();
    const hash = crypto.createHash('sha256').update(postData + nonce + signPath).digest();
    const cleanKey = (f.privateKey || f.secretKey).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const paddedKey = cleanKey + '='.repeat((4 - cleanKey.length % 4) % 4);
    const futuresKeyBuf = Buffer.from(paddedKey, 'base64');
    const sig = crypto.createHmac('sha512', futuresKeyBuf).update(hash).digest('base64');
    const r = await fetch(`${base}${fullPath}`, {
      method: 'GET',
      headers: { 'APIKey': f.apiKey.trim(), 'Authent': sig, 'Nonce': nonce },
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return `Connected to Kraken Futures${testnet ? ' (demo)' : ''}`;
  } else {
    // Kraken Spot: POST /0/private/Balance with API-Key + API-Sign
    const p = '/0/private/Balance';
    const nonce = Date.now().toString();
    const body = `nonce=${nonce}`;
    const hash = crypto.createHash('sha256').update(nonce + body).digest();
    const sig = crypto.createHmac('sha512', keyBuf)
                      .update(Buffer.concat([Buffer.from(p), hash]))
                      .digest('base64');
    const r = await fetch(`https://api.kraken.com${p}`, {
      method: 'POST',
      headers: { 'API-Key': f.apiKey, 'API-Sign': sig, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json();
    if (j.error?.length) throw new Error(j.error.join(', '));
    return 'Connected to Kraken Spot';
  }
}

async function _testBitmex(f, testnet) {
  const base    = testnet ? 'https://testnet.bitmex.com' : 'https://www.bitmex.com';
  const verb    = 'GET';
  const p       = '/api/v1/user/margin';
  const expires = String(Math.floor(Date.now() / 1000) + 60);
  const sigData = verb + p + expires;
  const sig     = crypto.createHmac('sha256', f.apiSecret)
                        .update(sigData).digest('hex');
  const url     = `${base}${p}`;
  let r;
  try {
    r = await fetch(url, {
      method: verb,
      headers: {
        'api-key':       f.apiKey,
        'api-signature': sig,
        'api-expires':   expires,
        'Content-Type':  'application/json',
      },
    });
  } catch (netErr) {
    throw new Error(`Network error connecting to ${url}: ${netErr.message}`);
  }
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`BitMEX returned non-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`); }
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  if (!r.ok) throw new Error(`BitMEX HTTP ${r.status}: ${text.slice(0, 200)}`);
  return `Connected to BitMEX${testnet ? ' (testnet)' : ''} — margin balance: ${j.marginBalance ?? '?'} sat`;
}

module.exports = {
  isReady,
  getKey,
  getKeyById,
  listKeys,
  saveKey,
  deleteKey,
  testKey,
  updateStatus,
  SECRET_FIELDS,
  _testConnectionDirect: _testConnection,
};
