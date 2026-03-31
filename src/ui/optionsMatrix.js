/**
 * OptionsMatrix — Self-contained options matrix panel module
 *
 * Owns all options matrix panel creation, rendering, data fetching, and lifecycle.
 * Registers as a panel type with PanelGrid for layout persistence.
 *
 * Global dependencies (from deribit_testnet.html):
 *   nextId (or PanelGrid.allocateId), panels, nextPanelPos, updateAreaSize,
 *   persistLayouts, startDrag, startResize, attachShorthandInput,
 *   openOrderModal, fmt, TCA_BASE
 */

'use strict';

// ── Constants ───────────────────────────────────────────────────────────────
const OM_INSTRUMENTS = [
  { id: 'BTC',      label: 'BTC',      currency: 'BTC',  inverse: true,  prefix: 'BTC-' },
  { id: 'BTC_USDC', label: 'BTC USDC', currency: 'USDC', inverse: false, prefix: 'BTC_USDC-' },
  { id: 'ETH',      label: 'ETH',      currency: 'ETH',  inverse: true,  prefix: 'ETH-' },
  { id: 'ETH_USDC', label: 'ETH USDC', currency: 'USDC', inverse: false, prefix: 'ETH_USDC-' },
  { id: 'SOL_USDC', label: 'SOL USDC', currency: 'USDC', inverse: false, prefix: 'SOL_USDC-' },
  { id: 'XRP_USDC', label: 'XRP USDC', currency: 'USDC', inverse: false, prefix: 'XRP_USDC-' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function _omParseInstr(name) {
  const m = name.match(/^([\w_]+)-(\d{1,2}[A-Z]{3}\d{2})-(\d+)-(C|P)$/);
  if (!m) return null;
  return { currency: m[1], expiryStr: m[2], strike: parseInt(m[3]), type: m[4] === 'C' ? 'call' : 'put', instrument: name };
}

function _omParseExpiry(str) {
  const m = str.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  return new Date(2000 + parseInt(m[3]), months[m[2]], parseInt(m[1]));
}

function _omDte(expiryDate) { return Math.max(0, Math.ceil((expiryDate - new Date()) / 86400000)); }

function _omFmtUsd(v) {
  if (v == null) return '—';
  return '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: v >= 100 ? 0 : v >= 1 ? 2 : 4, maximumFractionDigits: v >= 100 ? 0 : v >= 1 ? 2 : 4 });
}

function _omHeatBg(val, min, max) {
  if (val == null || max <= min) return '';
  const t = Math.min(1, Math.max(0, (val - min) / (max - min)));
  return `background:rgba(55,138,221,${(0.1 + t * 0.5).toFixed(2)})`;
}

// ── Calendar picker ─────────────────────────────────────────────────────────
function _omShowCalendar(inputEl) {
  let cal = document.querySelector('.om-cal'); if (cal) cal.remove();
  cal = document.createElement('div'); cal.className = 'om-cal';
  const r = inputEl.getBoundingClientRect();
  cal.style.cssText = `position:fixed;z-index:200;left:${r.left}px;top:${r.bottom+2}px;background:#0d0d14;border:1px solid #1e1e28;border-radius:6px;padding:6px;box-shadow:0 4px 12px rgba(0,0,0,.5);font-size:10px;color:#bbb;width:180px`;
  let viewDate = new Date();
  function render() {
    const y = viewDate.getFullYear(), m = viewDate.getMonth();
    const firstDay = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let h = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <button class="om-cal-nav" data-dir="-1">&lt;</button>
      <span style="font-weight:700">${mNames[m]} ${y}</span>
      <button class="om-cal-nav" data-dir="1">&gt;</button></div>`;
    h += '<div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;gap:1px">';
    for (const d of ['Su','Mo','Tu','We','Th','Fr','Sa']) h += `<span style="color:#444;font-size:8px">${d}</span>`;
    for (let i = 0; i < firstDay; i++) h += '<span></span>';
    const today = new Date();
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
      h += `<span class="om-cal-day${isToday?' om-cal-today':''}" data-day="${d}" style="cursor:pointer;padding:2px;border-radius:3px">${d}</span>`;
    }
    h += '</div>';
    cal.innerHTML = h;
    cal.querySelectorAll('.om-cal-nav').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); viewDate.setMonth(viewDate.getMonth() + parseInt(e.target.dataset.dir)); render(); }));
    cal.querySelectorAll('.om-cal-day').forEach(span => span.addEventListener('click', e => {
      e.stopPropagation();
      const day = parseInt(e.target.dataset.day);
      inputEl.value = `${String(day).padStart(2,'0')}/${String(m+1).padStart(2,'0')}/${String(y).slice(-2)}`;
      inputEl.dispatchEvent(new Event('change'));
      cal.remove();
    }));
  }
  render();
  document.body.appendChild(cal);
  const closeCal = e => { if (!cal.contains(e.target) && e.target !== inputEl) { cal.remove(); document.removeEventListener('click', closeCal); } };
  setTimeout(() => document.addEventListener('click', closeCal), 0);
}

// ── Cell rendering ──────────────────────────────────────────────────────────
function _omCellHtml(s, d, _unused, omSpec, heatMin, heatMax) {
  if (!d) return '<td class="om-cell-empty"></td>';
  const instr = d.instrument;
  const isBuy = s.buySell === 'buy';
  const inv = d.isInverse;
  let bgStyle = '';
  if (s.heatmap) { bgStyle = _omHeatBg(s.display === 'iv' ? (d.markIv || 0) : (d.markUsd || 0), heatMin, heatMax); }
  if (s.display === 'iv') {
    const mkFb = (d.markIv > 0) ? d.markIv.toFixed(1) + '%' : '—';
    const bIv = (d.bidIv > 0) ? d.bidIv.toFixed(1) + '%' : mkFb;
    const aIv = (d.askIv > 0) ? d.askIv.toFixed(1) + '%' : mkFb;
    return `<td class="om-cell" data-instr="${instr}" data-bid="${d.bid||''}" data-ask="${d.ask||''}" style="${bgStyle}"><span class="${isBuy?'om-buy-price':'om-sell-price'}">${isBuy?aIv:bIv}</span></td>`;
  }
  const baseCcy = omSpec.id.replace('_USDC', '');
  const idx = s._indexPrice || 1;
  function fp(raw, rawUsd) {
    if (raw == null || raw === 0) return null;
    if (inv) return `${fmt(raw, 4)} ${baseCcy}<br><span style="color:#666;font-size:8px">${_omFmtUsd(rawUsd)}</span>`;
    const ne = idx > 0 ? rawUsd / idx : 0;
    return `${_omFmtUsd(rawUsd)}<br><span style="color:#666;font-size:8px">${ne >= 0.01 ? ne.toPrecision(4) : ne.toFixed(6)} ${baseCcy}</span>`;
  }
  const bH = fp(d.bid, d.bidUsd), aH = fp(d.ask, d.askUsd);
  const content = isBuy ? (aH ? `<span class="om-buy-price">${aH}</span>` : '—') : (bH ? `<span class="om-sell-price">${bH}</span>` : '—');
  return `<td class="om-cell" data-instr="${instr}" data-bid="${d.bid||''}" data-ask="${d.ask||''}" style="${bgStyle}">${content}</td>`;
}

// ── Fetch ───────────────────────────────────────────────────────────────────
async function _omFetch(s) {
  try {
    const params = new URLSearchParams({ instrument: s.instrument, type: s.cpFilter, testnet: String(s.testnet) });
    if (s.minStrike) params.set('minStrike', String(s.minStrike).replace(/,/g, ''));
    if (s.maxStrike) params.set('maxStrike', String(s.maxStrike).replace(/,/g, ''));
    if (s.expiryFrom) params.set('fromExpiry', s.expiryFrom);
    if (s.expiryTo) params.set('toExpiry', s.expiryTo);
    if (s.atmOnly) params.set('atmOnly', 'true');
    const resp = await fetch(`${TCA_BASE}/api/options/matrix?${params}`);
    const matrix = await resp.json();
    if (matrix.error) throw new Error(matrix.error);
    s._indexPrice = matrix.indexPrice; s._atmStrike = matrix.atmStrike;
    const omSpec = OM_INSTRUMENTS.find(i => i.id === s.instrument) || OM_INSTRUMENTS[0];
    s._matrix = matrix; s._data = [];
    for (const strike of matrix.strikes) { const row = matrix.cells[strike]; if (!row) continue;
      for (const expiry of matrix.expiries) { const cell = row[expiry]; if (!cell) continue;
        s._data.push({ instrument:cell.instrument, currency:cell.instrument.split('-')[0], expiryStr:cell.expiry, strike:cell.strike, type:cell.type, bid:cell.bid, ask:cell.ask, mark:cell.mark, bidUsd:cell.bidUsd, askUsd:cell.askUsd, markUsd:cell.markUsd, markIv:cell.markIv, bidIv:cell.bidIv, askIv:cell.askIv, oi:cell.openInterest, vol:cell.volume, underlying:cell.underlying, isInverse:cell.isInverse });
      }
    }
    s._lastUpdate = Date.now();
    _omRender(s);
  } catch (e) { console.error('[OptionsMatrix] fetch error:', e); }
}

// ── Render ───────────────────────────────────────────────────────────────────
function _omRender(s) {
  const wrap = document.getElementById(`om-gwrap-${s.id}`);
  const idxEl = document.getElementById(`om-idx-${s.id}`);
  const updEl = document.getElementById(`om-upd-${s.id}`);
  if (!wrap) return;
  const omSpec = OM_INSTRUMENTS.find(i => i.id === s.instrument) || OM_INSTRUMENTS[0];
  const matrix = s._matrix;
  if (idxEl && s._indexPrice) { const bc = omSpec.id.replace('_USDC',''); idxEl.textContent = `${bc} Index: $${Number(s._indexPrice).toLocaleString('en-US',{maximumFractionDigits:0})}`; }
  if (updEl && s._lastUpdate) { const ago = Math.round((Date.now()-s._lastUpdate)/1000); updEl.textContent = ago<2?'just now':`${ago}s ago`; }
  if (!matrix || !matrix.strikes?.length) { wrap.innerHTML = '<div class="om-empty">No options data</div>'; return; }
  const { strikes, expiries, cells } = matrix;
  let heatMin = Infinity, heatMax = 0;
  if (s.heatmap && s._data) { for (const d of s._data) { const v = s.display==='iv'?(d.markIv||0):(d.markUsd||0); if(v>0){heatMin=Math.min(heatMin,v);heatMax=Math.max(heatMax,v);} } if(heatMin===Infinity)heatMin=0; }
  let html = '<table class="om-grid"><thead><tr><th class="om-strike-hdr">Strike</th>';
  for (const exp of expiries) { const dt = _omParseExpiry(exp); html += `<th>${exp}<br><span style="font-weight:400;color:#333">(${dt?_omDte(dt):'?'}d)</span></th>`; }
  html += '</tr></thead><tbody>';
  for (const strike of strikes) {
    const isAtm = strike === s._atmStrike;
    html += `<tr${isAtm?' class="om-atm"':''}><td class="om-strike-cell">$${strike.toLocaleString()}</td>`;
    const row = cells[strike] || {};
    for (const exp of expiries) { const cell = row[exp]; html += cell ? _omCellHtml(s, cell, null, omSpec, heatMin, heatMax) : '<td class="om-cell-empty"></td>'; }
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
  const minW = 80 + expiries.length * 90 + 10;
  const panelEl = document.getElementById(`panel-${s.id}`);
  if (panelEl) panelEl.style.minWidth = Math.max(400, minW) + 'px';
}

// ── Create ──────────────────────────────────────────────────────────────────
function create(opts = {}) {
  const pos = (typeof nextPanelPos === 'function') ? nextPanelPos(820, 440) : { x: 10, y: 10 };
  const id = (typeof nextId !== 'undefined') ? nextId++ : Date.now();
  const isDefault = !opts.instrument && !opts.cpFilter;
  const s = {
    id, panelType: 'options-matrix',
    instrument: opts.instrument || 'BTC_USDC',
    cpFilter: opts.cpFilter || (isDefault ? 'calls' : 'both'),
    buySell: opts.buySell || 'buy',
    display: opts.display || 'price',
    heatmap: opts.heatmap != null ? opts.heatmap : false,
    minStrike: opts.minStrike || '', maxStrike: opts.maxStrike || '',
    expiryFrom: opts.expiryFrom || (isDefault ? '1d' : ''),
    expiryTo: opts.expiryTo || (isDefault ? '1w' : ''),
    atmOnly: opts.atmOnly === true || isDefault,
    x: opts.x ?? pos.x, y: opts.y ?? pos.y,
    testnet: true,
    _data: null, _indexPrice: null, _lastUpdate: 0, _timer: null, _tickTimer: null,
  };
  if (typeof panels !== 'undefined') panels.push(s);

  const omSpec = OM_INSTRUMENTS.find(i => i.id === s.instrument) || OM_INSTRUMENTS[0];
  const el = document.createElement('div');
  el.className = 'om-panel'; el.id = `panel-${id}`;
  el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
  el.innerHTML = `
    <div class="panel-header" id="om-drag-${id}">
      <span style="font-size:9px;font-weight:700;color:#888;letter-spacing:.05em">OPTIONS MATRIX</span>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="om-updated" id="om-upd-${id}"></span>
        <button class="panel-close" id="om-close-${id}">×</button>
      </div>
    </div>
    <div class="om-toolbar" id="om-toolbar-${id}">
      <span class="om-label">Instrument</span>
      <div class="om-pill-group" id="om-instr-${id}">${OM_INSTRUMENTS.map(i=>`<button class="om-pill${i.id===s.instrument?' active':''}" data-instr="${i.id}">${i.label}</button>`).join('')}</div>
      <span class="om-label">Type</span>
      <div class="om-pill-group" id="om-cp-${id}">${['calls','puts','both'].map(v=>`<button class="om-pill${v===s.cpFilter?' active':''}" data-cp="${v}">${v[0].toUpperCase()+v.slice(1)}</button>`).join('')}</div>
      <span class="om-label">Side</span>
      <div class="om-pill-group" id="om-bs-${id}">
        <button class="om-pill${s.buySell==='buy'?' active-buy':''}" data-bs="buy">Buy</button>
        <button class="om-pill${s.buySell==='sell'?' active-sell':''}" data-bs="sell">Sell</button>
      </div>
      <span class="om-label">View</span>
      <div class="om-pill-group" id="om-disp-${id}">
        <button class="om-pill${s.display==='price'?' active':''}" data-disp="price">Bid/Ask</button>
        <button class="om-pill${s.display==='iv'?' active':''}" data-disp="iv">IV%</button>
      </div>
      <label style="display:flex;align-items:center;gap:3px;font-size:8px;color:#555;cursor:pointer"><input type="checkbox" class="om-chk" id="om-heat-${id}" ${s.heatmap?'checked':''}>Heatmap</label>
      <span class="om-label">Strike</span>
      <input class="om-input" id="om-minK-${id}" placeholder="Min" value="${s.minStrike}">
      <span style="color:#333;font-size:9px">–</span>
      <input class="om-input" id="om-maxK-${id}" placeholder="Max" value="${s.maxStrike}">
      <span class="om-label">Expiry</span>
      <input class="om-input om-exp-input" id="om-expFrom-${id}" placeholder="1d" value="${s.expiryFrom}" style="width:50px" title="Nd, Nw, Nm or DD/MM/YY">
      <span style="color:#333;font-size:9px">–</span>
      <input class="om-input om-exp-input" id="om-expTo-${id}" placeholder="1w" value="${s.expiryTo}" style="width:50px" title="Nd, Nw, Nm or DD/MM/YY">
      <label style="display:flex;align-items:center;gap:3px;font-size:8px;color:#555;cursor:pointer"><input type="checkbox" class="om-chk" id="om-atm-${id}" ${s.atmOnly?'checked':''}>ATM±10%</label>
      <span class="om-index" id="om-idx-${id}"></span>
    </div>
    <div class="om-grid-wrap" id="om-gwrap-${id}"><div class="om-empty">Loading options data…</div></div>`;
  const rh = document.createElement('div'); rh.className = 'panel-resize'; rh.id = `resize-${id}`; el.appendChild(rh);
  document.getElementById('panels-canvas').appendChild(el);
  if (typeof updateAreaSize === 'function') updateAreaSize();

  // Events
  document.getElementById(`om-drag-${id}`).addEventListener('mousedown', e => { if (e.target.tagName === 'BUTTON') return; startDrag(el, s, e); });
  rh.addEventListener('mousedown', e => startResize(el, s, e));
  document.getElementById(`om-close-${id}`).addEventListener('click', () => destroy(s));
  function _omUnderlying(instrId) { return instrId.replace('_USDC', ''); }
  el.querySelector(`#om-instr-${id}`).addEventListener('click', e => {
    const btn = e.target.closest('[data-instr]'); if (!btn) return;
    const prev = _omUnderlying(s.instrument); s.instrument = btn.dataset.instr;
    if (_omUnderlying(s.instrument) !== prev) { s.minStrike = ''; s.maxStrike = ''; const mk = document.getElementById(`om-minK-${id}`); const xk = document.getElementById(`om-maxK-${id}`); if(mk)mk.value=''; if(xk)xk.value=''; }
    el.querySelectorAll(`#om-instr-${id} .om-pill`).forEach(b => b.classList.toggle('active', b.dataset.instr === s.instrument));
    _omFetch(s);
  });
  el.querySelector(`#om-cp-${id}`).addEventListener('click', e => { const btn = e.target.closest('[data-cp]'); if(!btn)return; s.cpFilter=btn.dataset.cp; el.querySelectorAll(`#om-cp-${id} .om-pill`).forEach(b=>b.classList.toggle('active',b.dataset.cp===s.cpFilter)); _omFetch(s); });
  el.querySelector(`#om-bs-${id}`).addEventListener('click', e => { const btn = e.target.closest('[data-bs]'); if(!btn)return; s.buySell=btn.dataset.bs; el.querySelectorAll(`#om-bs-${id} .om-pill`).forEach(b=>{b.classList.remove('active-buy','active-sell','active');if(b.dataset.bs===s.buySell)b.classList.add(s.buySell==='buy'?'active-buy':'active-sell');}); _omRender(s); });
  el.querySelector(`#om-disp-${id}`).addEventListener('click', e => { const btn = e.target.closest('[data-disp]'); if(!btn)return; s.display=btn.dataset.disp; el.querySelectorAll(`#om-disp-${id} .om-pill`).forEach(b=>b.classList.toggle('active',b.dataset.disp===s.display)); _omRender(s); });
  document.getElementById(`om-heat-${id}`).addEventListener('change', e => { s.heatmap = e.target.checked; _omRender(s); });
  const minKEl = document.getElementById(`om-minK-${id}`), maxKEl = document.getElementById(`om-maxK-${id}`);
  const onStrikeChange = () => { s.minStrike=String(minKEl.value).replace(/,/g,''); s.maxStrike=String(maxKEl.value).replace(/,/g,''); _omFetch(s); };
  minKEl.addEventListener('change', onStrikeChange); maxKEl.addEventListener('change', onStrikeChange);
  if (typeof attachShorthandInput === 'function') { attachShorthandInput(minKEl); attachShorthandInput(maxKEl); }
  const expFromEl = document.getElementById(`om-expFrom-${id}`), expToEl = document.getElementById(`om-expTo-${id}`);
  const onExpRange = () => { s.expiryFrom=expFromEl.value; s.expiryTo=expToEl.value; _omFetch(s); };
  expFromEl.addEventListener('change', onExpRange); expToEl.addEventListener('change', onExpRange);
  [expFromEl, expToEl].forEach(inp => inp.addEventListener('click', e => { e.stopPropagation(); _omShowCalendar(inp); }));
  document.getElementById(`om-atm-${id}`).addEventListener('change', e => { s.atmOnly=e.target.checked; _omFetch(s); });
  el.querySelector(`#om-gwrap-${id}`).addEventListener('click', e => { const cell = e.target.closest('td[data-instr]'); if(!cell)return; const price=s.buySell==='buy'?parseFloat(cell.dataset.ask):parseFloat(cell.dataset.bid); openOrderModal(cell.dataset.instr, s.buySell, price||null, null, 'Deribit'); });

  // Polling
  _omFetch(s);
  s._timer = setInterval(() => _omFetch(s), 10000);
  s._tickTimer = setInterval(() => { const u = document.getElementById(`om-upd-${s.id}`); if(u&&s._lastUpdate){const a=Math.round((Date.now()-s._lastUpdate)/1000);u.textContent=a<2?'just now':`${a}s ago`;} }, 1000);
  if (typeof persistLayouts === 'function') persistLayouts();
  return s;
}

// ── Destroy ─────────────────────────────────────────────────────────────────
function destroy(s) {
  if (!s) return;
  clearInterval(s._timer); clearInterval(s._tickTimer);
  if (typeof panels !== 'undefined') { const idx = panels.indexOf(s); if (idx >= 0) panels.splice(idx, 1); }
  const el = document.getElementById(`panel-${s.id}`); if (el) el.remove();
  if (typeof updateAreaSize === 'function') updateAreaSize();
  if (typeof persistLayouts === 'function') persistLayouts();
}

// ── Snapshot ────────────────────────────────────────────────────────────────
function snapshot(s) {
  const el = document.getElementById(`panel-${s.id}`);
  return { panelType: 'options-matrix', instrument: s.instrument, cpFilter: s.cpFilter,
    buySell: s.buySell, display: s.display, heatmap: s.heatmap,
    minStrike: s.minStrike, maxStrike: s.maxStrike,
    expiryFrom: s.expiryFrom, expiryTo: s.expiryTo, atmOnly: s.atmOnly,
    x: s.x, y: s.y, width: el ? el.offsetWidth : 820, testnet: s.testnet };
}

// ── Init ────────────────────────────────────────────────────────────────────
function init() {
  if (typeof PanelGrid !== 'undefined') {
    PanelGrid.addPanelType('options-matrix', {
      snapshot,
      destroy,
      restore: (p) => create(p),
    });
  }
}

// ── Export ───────────────────────────────────────────────────────────────────
window.OptionsMatrix = { init, create, destroy, snapshot, OM_INSTRUMENTS };
// Keep createOptionsMatrix as a global for backward compatibility
window.createOptionsMatrix = create;
// Also expose _omShowCalendar for the GTD date picker reuse
window._omShowCalendar = _omShowCalendar;

// Auto-init
if (typeof PanelGrid !== 'undefined') init();
