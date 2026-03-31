/**
 * PanelGrid — Panel layout management system
 *
 * Owns the panels array, layout persistence, positioning, drag/resize, and
 * collision resolution. Panel types register via addPanelType() to provide
 * create/destroy/snapshot/restore handlers.
 *
 * Dependencies: DOM elements #panels-canvas, #panels-area, #layout-tabs-bar
 *
 * Usage:
 *   PanelGrid.init('panels-canvas')
 *   PanelGrid.addPanelType('options-matrix', { create, destroy, snapshot, restore })
 *   PanelGrid.createPanel('BTC-PERPETUAL')
 */

'use strict';

// ── State ───────────────────────────────────────────────────────────────────
let panels = [];
let nextId = 0;
let layouts = [];
let activeLayoutId = 0;
let layoutNextId = 0;
const LAYOUTS_LS = 'dbt_layouts';
const GRID_SNAP = 10;
const PLACE_GAP = 8;
const SETTLE_GAP = 8;

// Panel type plugins: { create, destroy, snapshot, restore }
const _panelTypes = new Map();

// Layout change callbacks
const _layoutChangeCallbacks = [];

// ── Panel Type Registration ─────────────────────────────────────────────────

function addPanelType(type, handlers) {
  _panelTypes.set(type, handlers);
}

// ── Positioning ─────────────────────────────────────────────────────────────

function _snapToGrid(v) { return Math.round(v / GRID_SNAP) * GRID_SNAP; }

function nextPanelPos(panelW, panelH) {
  const area = document.getElementById('panels-area');
  const areaW = area ? area.clientWidth : 1200;
  const pw = panelW || 480;
  const ph = panelH || 230;
  const rects = [];
  for (const p of panels) {
    const el = document.getElementById(`panel-${p.id}`);
    if (!el) continue;
    rects.push({ x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight });
  }
  if (!rects.length) return { x: PLACE_GAP, y: PLACE_GAP };
  const maxY = rects.reduce((m, r) => Math.max(m, r.y + r.h), 0) + ph + PLACE_GAP;
  for (let y = PLACE_GAP; y < maxY; y += GRID_SNAP) {
    for (let x = PLACE_GAP; x + pw <= areaW; x += GRID_SNAP) {
      const candidate = { x, y, w: pw, h: ph };
      let fits = true;
      for (const r of rects) {
        if (candidate.x < r.x + r.w + PLACE_GAP && candidate.x + candidate.w + PLACE_GAP > r.x &&
            candidate.y < r.y + r.h + PLACE_GAP && candidate.y + candidate.h + PLACE_GAP > r.y) {
          fits = false; break;
        }
      }
      if (fits) return { x: _snapToGrid(x), y: _snapToGrid(y) };
    }
  }
  const bottom = rects.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  return { x: PLACE_GAP, y: _snapToGrid(bottom + PLACE_GAP) };
}

function updateAreaSize() {
  const canvas = document.getElementById('panels-canvas');
  if (!canvas) return;
  let maxB = 0;
  for (const p of panels) {
    const el = document.getElementById(`panel-${p.id}`);
    if (!el) continue;
    maxB = Math.max(maxB, p.y + el.offsetHeight);
  }
  canvas.style.minHeight = (maxB + 20) + 'px';
}

// ── Collision Detection & Resolution ────────────────────────────────────────

function _panelRect(p) {
  const el = document.getElementById(`panel-${p.id}`);
  if (!el) return null;
  return { x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight };
}

function _rectsOverlap(a, b) {
  return a.x < b.x + b.w + SETTLE_GAP && a.x + a.w + SETTLE_GAP > b.x &&
         a.y < b.y + b.h + SETTLE_GAP && a.y + a.h + SETTLE_GAP > b.y;
}

function _applyPos(p, x, y) {
  p.x = _snapToGrid(Math.max(0, x));
  p.y = _snapToGrid(Math.max(0, y));
  const el = document.getElementById(`panel-${p.id}`);
  if (el) { el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; }
}

function _enableTransition(p) {
  const el = document.getElementById(`panel-${p.id}`);
  if (el) el.style.transition = 'left 0.15s ease, top 0.15s ease';
}

function _disableTransition(p) {
  const el = document.getElementById(`panel-${p.id}`);
  if (el) el.style.transition = '';
}

function settleLayout(anchor, dragDir, skipPersist) {
  const area = document.getElementById('panels-area');
  if (!area) return;
  const areaW = area.clientWidth;
  const anchorRect = _panelRect(anchor);

  if (skipPersist && anchorRect) {
    for (const p of panels) {
      if (p === anchor || p._prePushX == null) continue;
      const el = document.getElementById(`panel-${p.id}`);
      if (!el) continue;
      const origRect = { x: p._prePushX, y: p._prePushY, w: el.offsetWidth, h: el.offsetHeight };
      if (!_rectsOverlap(origRect, anchorRect)) {
        _applyPos(p, p._prePushX, p._prePushY);
        delete p._prePushX; delete p._prePushY;
      }
    }
  }

  for (let iter = 0; iter < 80; iter++) {
    let anyMoved = false;
    for (const p of panels) {
      if (p === anchor) continue;
      const pr = _panelRect(p);
      if (!pr) continue;
      const others = [anchor, ...panels.filter(o => o !== p && o !== anchor)];
      for (const other of others) {
        if (!other) continue;
        const or_ = _panelRect(other);
        if (!or_ || !_rectsOverlap(pr, or_)) continue;
        if (p._prePushX == null) { p._prePushX = p.x; p._prePushY = p.y; }
        const pushR = or_.x + or_.w + SETTLE_GAP - pr.x;
        const pushL = pr.x + pr.w  + SETTLE_GAP - or_.x;
        const pushD = or_.y + or_.h + SETTLE_GAP - pr.y;
        const pushU = pr.y + pr.h  + SETTLE_GAP - or_.y;
        let dx = 0, dy = 0;
        if (dragDir && (dragDir.dx !== 0 || dragDir.dy !== 0)) {
          if (dragDir.dx > 0 && p.x + pushR + pr.w <= areaW) dx = pushR;
          else if (dragDir.dx < 0 && p.x - pushL >= 0) dx = -pushL;
          else if (dragDir.dy > 0) dy = pushD;
          else if (dragDir.dy < 0 && p.y - pushU >= 0) dy = -pushU;
          else dy = pushD;
        }
        if (dx === 0 && dy === 0) {
          const candidates = [
            { dx: pushR, dy: 0, cost: pushR, valid: p.x + pushR + pr.w <= areaW },
            { dx: -pushL, dy: 0, cost: pushL, valid: p.x - pushL >= 0 },
            { dx: 0, dy: pushD, cost: pushD, valid: true },
            { dx: 0, dy: -pushU, cost: pushU, valid: p.y - pushU >= 0 },
          ].filter(c => c.valid);
          if (candidates.length) { const best = candidates.reduce((a, b) => a.cost < b.cost ? a : b); dx = best.dx; dy = best.dy; }
          else dy = pushD;
        }
        _applyPos(p, p.x + dx, p.y + dy);
        anyMoved = true;
        break;
      }
    }
    if (!anyMoved) break;
  }
  updateAreaSize();
  if (!skipPersist) persistLayouts();
}

// ── Drag & Resize ───────────────────────────────────────────────────────────

function startDrag(panelEl, s, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const area = document.getElementById('panels-area');
  const areaRect = area.getBoundingClientRect();
  const scrollTop = area.scrollTop;
  const ox = e.clientX - panelEl.getBoundingClientRect().left;
  const oy = e.clientY - panelEl.getBoundingClientRect().top + scrollTop;
  let prevX = s.x, prevY = s.y;
  panelEl.style.transition = '';
  for (const p of panels) { if (p !== s) _enableTransition(p); }
  panelEl.style.zIndex = '10';

  function onMove(ev) {
    const maxX = Math.max(0, area.clientWidth - panelEl.offsetWidth);
    const rawX = ev.clientX - areaRect.left - ox;
    const rawY = ev.clientY - areaRect.top + area.scrollTop - oy;
    s.x = _snapToGrid(Math.max(0, Math.min(maxX, Math.round(rawX))));
    s.y = _snapToGrid(Math.max(0, Math.round(rawY)));
    panelEl.style.left = s.x + 'px';
    panelEl.style.top = s.y + 'px';
    const dragDir = { dx: s.x - prevX, dy: s.y - prevY };
    prevX = s.x; prevY = s.y;
    settleLayout(s, dragDir, true);
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    panelEl.style.zIndex = '';
    for (const p of panels) { delete p._prePushX; delete p._prePushY; }
    settleLayout(s);
    setTimeout(() => { for (const p of panels) _disableTransition(p); }, 200);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startResize(panelEl, s, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const area = document.getElementById('panels-area');
  const startX = e.clientX;
  const startW = panelEl.offsetWidth;
  const handle = document.getElementById(`resize-${s.id}`);
  if (handle) handle.classList.add('resizing');

  function onMove(ev) {
    const maxW = Math.max(200, area.clientWidth - s.x);
    const w = Math.max(200, Math.min(maxW, startW + ev.clientX - startX));
    panelEl.style.width = w + 'px';
    // Call panel-type-specific resize if available
    if (typeof window.resizeAndRender === 'function') window.resizeAndRender(s);
  }

  function onUp() {
    if (handle) handle.classList.remove('resizing');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    settleLayout(s);
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function snapPanel(s, panelEl) {
  const area = document.getElementById('panels-area');
  const maxX = Math.max(0, area.clientWidth - panelEl.offsetWidth);
  s.x = _snapToGrid(Math.max(0, Math.min(maxX, s.x)));
  s.y = _snapToGrid(Math.max(0, s.y));
  panelEl.style.left = s.x + 'px';
  panelEl.style.top = s.y + 'px';
  updateAreaSize();
  persistLayouts();
}

// ── Layout Persistence ──────────────────────────────────────────────────────

function persistLayouts() {
  saveCurrentLayout();
  try {
    localStorage.setItem(LAYOUTS_LS, JSON.stringify({ layouts, activeLayoutId, layoutNextId }));
  } catch (e) { console.warn('Layout save failed:', e.message); }
}

function loadPersistedLayouts() {
  try {
    const raw = localStorage.getItem(LAYOUTS_LS);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!Array.isArray(d.layouts) || d.layouts.length === 0) return false;
    layouts = d.layouts;
    activeLayoutId = d.activeLayoutId ?? d.layouts[0].id;
    layoutNextId = d.layoutNextId ?? d.layouts.length;
    if (!layouts.find(l => l.id === activeLayoutId)) activeLayoutId = layouts[0].id;
    return true;
  } catch { return false; }
}

function saveCurrentLayout() {
  const layout = layouts.find(l => l.id === activeLayoutId);
  if (layout) layout.panels = panels.filter(p => !p._isSpreadLeg).map(panelSnapshot);
}

function panelSnapshot(s) {
  // Delegate to registered panel type handler if available
  const typeHandler = _panelTypes.get(s.panelType);
  if (typeHandler?.snapshot) return typeHandler.snapshot(s);

  // Default snapshot for standard price tiles
  if (s.panelType === 'spread') {
    const el = document.getElementById(`panel-${s.id}`);
    return { panelType: 'spread',
      legA: { instrument: s.legA.instrument, exchange: s.legA.exchange, instrType: s.legA.instrType },
      legB: { instrument: s.legB.instrument, exchange: s.legB.exchange, instrType: s.legB.instrType },
      x: s.x, y: s.y, width: el ? el.offsetWidth : 420, qty: s.qty };
  }
  const el = document.getElementById(`panel-${s.id}`);
  return { instrument: s.instrument, exchange: s.exchange, instrType: s.instrType,
    x: s.x, y: s.y, width: el ? el.offsetWidth : 480, gran: s.gran, qty: s.qty,
    locked: s.locked, activeOrderType: s.activeOrderType, tileName: s.tileName,
    ocHidden: s.ocHidden, testnet: s.testnet, priceTick: s.priceTick || null };
}

// ── Layout Switching ────────────────────────────────────────────────────────

function switchLayout(id) {
  if (id === activeLayoutId) return;
  // Save current before switching — delegated to caller via destroyFn
  persistLayouts();
  if (typeof window._pgDestroyAllPanels === 'function') window._pgDestroyAllPanels();
  activeLayoutId = id;
  const layout = layouts.find(l => l.id === id);
  if (layout && typeof window._pgRestoreLayoutPanels === 'function') {
    window._pgRestoreLayoutPanels(layout);
  }
  renderLayoutTabs();
  persistLayouts();
  for (const cb of _layoutChangeCallbacks) cb(id);
}

function addLayout() {
  const id = layoutNextId++;
  const name = `Layout ${layouts.length + 1}`;
  layouts.push({ id, name, panels: [] });
  switchLayout(id);
}

function deleteLayout(id) {
  if (layouts.length <= 1) return;
  const idx = layouts.findIndex(l => l.id === id);
  if (idx < 0) return;
  layouts.splice(idx, 1);
  if (activeLayoutId === id) {
    switchLayout(layouts[0].id);
  } else {
    renderLayoutTabs();
    persistLayouts();
  }
}

function onLayoutChange(callback) {
  _layoutChangeCallbacks.push(callback);
}

// ── Layout Tab Bar ──────────────────────────────────────────────────────────

function renderLayoutTabs() {
  const bar = document.getElementById('layout-tabs-bar');
  if (!bar) return;
  bar.querySelectorAll('.layout-tab').forEach(el => el.remove());
  const addBtn = document.getElementById('add-layout-btn');
  for (const layout of layouts) {
    const tab = document.createElement('div');
    tab.className = 'layout-tab' + (layout.id === activeLayoutId ? ' active' : '');
    tab.dataset.id = layout.id;
    const showClose = layouts.length > 1;
    tab.innerHTML = `<span class="layout-tab-name">${layout.name}</span>`
      + (showClose ? `<button class="layout-tab-close" title="Delete layout">×</button>` : '');

    tab.addEventListener('click', e => {
      if (e.target.closest('.layout-tab-close')) return;
      if (e.target.closest('.layout-tab-name')?.contentEditable === 'true') return;
      switchLayout(layout.id);
    });

    const nameEl = tab.querySelector('.layout-tab-name');
    nameEl.addEventListener('dblclick', e => {
      e.stopPropagation();
      const saved = layout.name;
      nameEl.contentEditable = 'true';
      nameEl.focus();
      document.execCommand('selectAll', false, null);
      function finish() {
        nameEl.contentEditable = 'false';
        layout.name = nameEl.textContent.trim() || saved;
        nameEl.textContent = layout.name;
        nameEl.removeEventListener('keydown', onKey);
        persistLayouts();
      }
      function onKey(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); }
        if (ev.key === 'Escape') { nameEl.textContent = saved; nameEl.blur(); }
      }
      nameEl.addEventListener('blur', finish, { once: true });
      nameEl.addEventListener('keydown', onKey);
    });

    const closeBtn = tab.querySelector('.layout-tab-close');
    if (closeBtn) closeBtn.addEventListener('click', e => { e.stopPropagation(); deleteLayout(layout.id); });

    if (addBtn) bar.insertBefore(tab, addBtn);
  }
}

// ── Accessors ───────────────────────────────────────────────────────────────

function getPanels() { return panels; }
function getNextId() { return nextId; }
function allocateId() { return nextId++; }
function getLayouts() { return layouts; }
function getActiveLayoutId() { return activeLayoutId; }

// ── Export ───────────────────────────────────────────────────────────────────

window.PanelGrid = {
  // State access
  getPanels, getNextId, allocateId, getLayouts, getActiveLayoutId,
  // Positioning
  nextPanelPos, updateAreaSize, settleLayout, snapPanel,
  // Drag/resize
  startDrag, startResize,
  // Layout management
  persistLayouts, loadPersistedLayouts, saveCurrentLayout, switchLayout, addLayout, deleteLayout, renderLayoutTabs,
  panelSnapshot,
  // Plugin registration
  addPanelType,
  onLayoutChange,
  // Internal helpers exposed for compatibility
  _snapToGrid, _panelRect, _rectsOverlap, _applyPos,
  _enableTransition, _disableTransition,
  // Constants
  GRID_SNAP, PLACE_GAP, SETTLE_GAP,
};

// Also expose key functions as direct window globals for backward compatibility
// (used by inline onclick handlers and other modules that reference these directly)
window.nextPanelPos = nextPanelPos;
window.updateAreaSize = updateAreaSize;
window.startDrag = startDrag;
window.startResize = startResize;
window.persistLayouts = persistLayouts;
window.panels = panels;
window.nextId = nextId;

// Keep panels/nextId synchronized — modules that write to window.panels
// need the same reference. Override with getter/setter.
Object.defineProperty(window, 'panels', {
  get() { return panels; },
  set(v) { panels = v; },
  configurable: true,
});
Object.defineProperty(window, 'nextId', {
  get() { return nextId; },
  set(v) { nextId = v; },
  configurable: true,
});
