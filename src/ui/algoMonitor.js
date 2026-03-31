/**
 * AlgoMonitor — Self-contained algo monitor panel module
 *
 * Exports functions that create, update, and destroy algo monitor panels
 * as first-class participants in the panel layout grid.
 *
 * Dependencies: expects these globals from deribit_testnet.html:
 *   - panels, nextId, nextPanelPos(), updateAreaSize(), persistLayouts()
 *   - startDrag(), startResize()
 *   - blotterData, exchPill(), formatNum(), BL_TS(), BL_FMT(), tickDecimals()
 *   - Chart (Chart.js)
 *   - TCA_BASE
 *
 * The module manages its own Maps for monitors and chart instances.
 */

'use strict';

// ── Internal state ──────────────────────────────────────────────────────────
const _monitors = new Map();        // sid → panel state object (in panels array)
const _chartInstances = new Map();  // sid → Chart.js instance
const _chartVisible = {};           // sid → boolean
const _chartAttached = {};          // sid → boolean

// ── Create ──────────────────────────────────────────────────────────────────

function createAlgoMonitorPanel(sid, strategyState, opts = {}) {
  if (_monitors.has(sid)) return _monitors.get(sid);

  const s = strategyState || {};
  const pos = opts.x != null ? { x: opts.x, y: opts.y } : nextPanelPos(500, 400);
  const id = nextId++;

  const panelState = {
    id,
    panelType: 'algo-monitor',
    strategyId: sid,
    x: pos.x, y: pos.y,
    _chartVisible: false,
  };
  panels.push(panelState);

  const el = document.createElement('div');
  el.className = 'algo-monitor status-' + (s.state || s.status || 'STOPPED');
  el.id = `panel-${id}`;
  el.style.position = 'absolute';
  el.style.left = panelState.x + 'px';
  el.style.top = panelState.y + 'px';

  el.innerHTML = `
    <div class="algo-monitor-hdr" data-sid="${sid}">
      <span class="algo-monitor-title"></span>
      <div class="algo-monitor-btns">
        <span id="amon-chart-btn-${sid}"></span>
        <button onclick="window._amMinimise('${sid}')" title="Minimise">_</button>
        <button onclick="window._amClose('${sid}')" title="Close">&times;</button>
      </div>
    </div>
    <div class="algo-monitor-body" id="algo-mon-body-${sid}"></div>
    <div class="panel-resize" id="resize-${id}"></div>`;

  document.getElementById('panels-canvas').appendChild(el);
  _monitors.set(sid, panelState);
  panelState._el = el;

  // Wire CHART button
  const chartBtnSlot = document.getElementById('amon-chart-btn-' + sid);
  if (chartBtnSlot) {
    const chartBtn = document.createElement('button');
    chartBtn.textContent = 'CHART';
    chartBtn.title = 'Execution chart';
    chartBtn.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid #4488ff;background:#0a1628;color:#4488ff;font-weight:700;cursor:pointer;margin-right:4px;pointer-events:all;position:relative;z-index:10;';
    chartBtn.addEventListener('mousedown', e => e.stopPropagation());
    chartBtn.onclick = function(e) {
      e.stopImmediatePropagation(); e.preventDefault();
      if (_chartVisible[sid]) { _closeChartInternal(sid); }
      else { _chartVisible[sid] = true; _openChartInternal(sid); }
    };
    chartBtnSlot.replaceWith(chartBtn);
  }

  // Drag via panel system
  const hdr = el.querySelector('.algo-monitor-hdr');
  hdr.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    if (e.button !== 0) return;
    startDrag(el, panelState, e);
  });

  // Resize
  const rh = el.querySelector('.panel-resize');
  if (rh) rh.addEventListener('mousedown', e => startResize(el, panelState, e));

  // Initial render
  if (s.type) updateAlgoMonitor(sid, s);
  updateAreaSize();
  persistLayouts();

  return panelState;
}

// ── Update ──────────────────────────────────────────────────────────────────

function updateAlgoMonitor(sid, s) {
  const panelState = _monitors.get(sid);
  if (!panelState) return;
  const el = panelState._el || document.getElementById(`panel-${panelState.id}`);
  if (!el) return;

  // Delegate to the existing _updateMonitor which builds the body HTML
  // This function is defined in deribit_testnet.html and exposed globally
  if (typeof window._amRenderMonitor === 'function') {
    window._amRenderMonitor(sid, s, el);
  }

  // Update chart if visible
  if (_chartInstances.has(sid)) _updateChartInternal(sid, s);
}

// ── Destroy ─────────────────────────────────────────────────────────────────

function destroyAlgoMonitorPanel(panelState) {
  if (!panelState || panelState.panelType !== 'algo-monitor') return;
  const sid = panelState.strategyId;
  _closeChartInternal(sid);
  const el = panelState._el || document.getElementById(`panel-${panelState.id}`);
  if (el) el.remove();
  _monitors.delete(sid);
  delete _chartVisible[sid];
  delete _chartAttached[sid];
}

// ── Snapshot ────────────────────────────────────────────────────────────────

function snapshotAlgoMonitor(panelState) {
  const el = panelState._el || document.getElementById(`panel-${panelState.id}`);
  return {
    panelType: 'algo-monitor',
    strategyId: panelState.strategyId,
    x: panelState.x, y: panelState.y,
    width: el ? el.offsetWidth : 500,
  };
}

// ── Chart (internal) ────────────────────────────────────────────────────────

function _openChartInternal(sid) {
  if (document.getElementById('amon-chart-' + sid)) return;
  const panelState = _monitors.get(sid);
  if (!panelState) return;
  const monEl = panelState._el || document.getElementById(`panel-${panelState.id}`);
  if (!monEl) return;

  const savedAttached = localStorage.getItem('algo-chart-attached-' + sid);
  const attached = savedAttached !== 'false';
  _chartAttached[sid] = attached;

  const panel = document.createElement('div');
  panel.className = 'panel amon-chart-panel';
  panel.id = 'amon-chart-' + sid;
  panel.style.position = 'absolute';
  panel.style.height = monEl.offsetHeight + 'px';
  panel.style.width = '320px';

  if (attached) {
    panel.style.borderRadius = '0 8px 8px 0';
    panel.style.borderLeft = 'none';
    monEl.style.borderRadius = '8px 0 0 8px';
    monEl.style.borderRight = 'none';
    panel.style.top = monEl.offsetTop + 'px';
    panel.style.left = (monEl.offsetLeft + monEl.offsetWidth) + 'px';
  } else {
    panel.style.top = monEl.offsetTop + 'px';
    panel.style.left = (monEl.offsetLeft + monEl.offsetWidth + 8) + 'px';
  }

  const ro = new ResizeObserver(() => {
    const h = monEl.getBoundingClientRect().height;
    panel.style.height = h + 'px';
    if (_chartAttached[sid]) _syncChartPos(sid);
    const ch = _chartInstances.get(sid);
    if (ch) ch.resize();
  });
  ro.observe(monEl);
  panel._ro = ro;

  const attachLabel = attached ? '↗' : '↙';
  panel.innerHTML = `<div class="amon-chart-hdr">
    <span>Execution Chart</span>
    <div style="display:flex;gap:2px">
      <button class="amon-chart-attach-btn" style="background:none;border:none;color:#555;cursor:pointer;font-size:11px;padding:0 3px" title="${attached?'Detach':'Attach'}">${attachLabel}</button>
      <button style="background:none;border:none;color:#555;cursor:pointer;font-size:11px;padding:0 3px" onclick="window._amCloseChart('${sid}')">&times;</button>
    </div>
  </div>
  <div style="padding:4px;flex:1;position:relative;min-height:0"><canvas id="amon-chart-canvas-${sid}"></canvas></div>`;

  document.getElementById('panels-canvas').appendChild(panel);

  const attachBtn = panel.querySelector('.amon-chart-attach-btn');
  if (attachBtn) attachBtn.onclick = () => { _chartAttached[sid] ? _detachChartInternal(sid) : _attachChartInternal(sid); };

  const hdr = panel.querySelector('.amon-chart-hdr');
  hdr.style.cursor = attached ? 'default' : 'grab';
  hdr.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || _chartAttached[sid]) return;
    hdr.style.cursor = 'grabbing';
    const ox = e.clientX - panel.offsetLeft, oy = e.clientY - panel.offsetTop;
    function mv(ev) { panel.style.left = (ev.clientX - ox) + 'px'; panel.style.top = (ev.clientY - oy) + 'px'; }
    function up() { hdr.style.cursor = 'grab'; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });

  // Create Chart.js
  requestAnimationFrame(() => {
    const ctx = document.getElementById('amon-chart-canvas-' + sid)?.getContext('2d');
    if (!ctx || typeof Chart === 'undefined') return;
    const algoState = blotterData.algos[sid];
    const seedBids = [], seedAsks = [], seedTimes = [], seedOrders = [];
    if (algoState?.chartBids?.length >= 1) {
      seedBids.push(...algoState.chartBids); seedAsks.push(...algoState.chartAsks);
      seedTimes.push(...algoState.chartTimes); seedOrders.push(...(algoState.chartOrder || []));
    }
    const chart = new Chart(ctx, {
      type: 'line',
      data: { datasets: [
        { label: 'Bid', data: seedBids.map((v,i)=>({x:seedTimes[i],y:v})), borderColor: '#e05252', borderWidth: 1, pointRadius: 0, tension: 0 },
        { label: 'Ask', data: seedAsks.map((v,i)=>({x:seedTimes[i],y:v})), borderColor: '#00c896', borderWidth: 1, pointRadius: 0, tension: 0 },
        { label: 'Order', data: seedOrders.map((v,i)=>v?{x:seedTimes[i],y:v}:null).filter(Boolean), borderColor: '#00cc88', borderWidth: 1.5, pointRadius: 0, tension: 0, borderDash: [4,2] },
        { label: 'Fills', data: [], type: 'scatter', pointRadius: 8, pointStyle: [], rotation: [], backgroundColor: [], borderColor: [], borderWidth: 1 },
        { label: 'Volume', data: [], type: 'bar', yAxisID: 'y2', backgroundColor: 'rgba(55,138,221,0.15)', borderWidth: 0, barThickness: 2, maxBarThickness: 3 },
        { label: 'VWAP', data: [], borderColor: '#7F77DD', borderWidth: 1, borderDash: [3,3], pointRadius: 0, tension: 0 },
        { label: 'Target', data: [], borderColor: '#ccaa44', borderWidth: 1, borderDash: [5,3], pointRadius: 0, tension: 0 },
        { label: 'Snipe', data: [], borderColor: '#7F77DD', borderWidth: 1, borderDash: [3,5], pointRadius: 0, tension: 0 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: { type: 'time', time: { unit: 'second', displayFormats: { second: 'HH:mm:ss' }, tooltipFormat: 'HH:mm:ss' }, display: true, ticks: { color: '#333', font: { size: 8 }, maxTicksLimit: 6, autoSkip: true }, grid: { color: '#111' } },
          y: { display: true, ticks: { color: '#444', font: { size: 9 } }, grid: { color: '#111' } },
          y2: { display: false, position: 'right', beginAtZero: true, grid: { display: false } },
        },
        plugins: { legend: { display: false }, tooltip: { enabled: true, callbacks: {
          label: item => {
            if (item.datasetIndex === 3) { const f = item.raw._fill; return f ? `${f.side} ${f.size.toFixed(4)} @ ${f.price.toFixed(4)}${f.simulated?' (SIM)':''}` : ''; }
            return `${item.dataset.label}: ${item.parsed.y?.toFixed(4)}`;
          }
        }}},
      },
    });
    _chartInstances.set(sid, chart);
  });
}

function _closeChartInternal(sid) {
  const el = document.getElementById('amon-chart-' + sid);
  if (el) { if (el._ro) el._ro.disconnect(); el.remove(); }
  _chartInstances.delete(sid);
  _chartVisible[sid] = false;
  const monState = _monitors.get(sid);
  const monEl = monState?._el || document.getElementById(`panel-${monState?.id}`);
  if (monEl) { monEl.style.borderRadius = '8px'; monEl.style.borderRight = ''; }
  delete _chartAttached[sid];
}

function _syncChartPos(sid) {
  const monState = _monitors.get(sid);
  const monEl = monState?._el || document.getElementById(`panel-${monState?.id}`);
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (!monEl || !chartEl) return;
  chartEl.style.left = (monEl.offsetLeft + monEl.offsetWidth) + 'px';
  chartEl.style.top = monEl.offsetTop + 'px';
}

function _detachChartInternal(sid) {
  _chartAttached[sid] = false;
  localStorage.setItem('algo-chart-attached-' + sid, 'false');
  const monState = _monitors.get(sid);
  const monEl = monState?._el;
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (!chartEl) return;
  chartEl.style.left = (parseInt(chartEl.style.left) + 20) + 'px';
  chartEl.style.borderRadius = '8px'; chartEl.style.borderLeft = '';
  if (monEl) { monEl.style.borderRadius = '8px'; monEl.style.borderRight = ''; }
  const hdr = chartEl.querySelector('.amon-chart-hdr'); if (hdr) hdr.style.cursor = 'grab';
  const btn = chartEl.querySelector('.amon-chart-attach-btn');
  if (btn) { btn.textContent = '↙'; btn.title = 'Attach'; btn.onclick = () => _attachChartInternal(sid); }
}

function _attachChartInternal(sid) {
  _chartAttached[sid] = true;
  localStorage.setItem('algo-chart-attached-' + sid, 'true');
  const monState = _monitors.get(sid);
  const monEl = monState?._el;
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (!chartEl) return;
  chartEl.style.borderRadius = '0 8px 8px 0'; chartEl.style.borderLeft = 'none';
  if (monEl) { monEl.style.borderRadius = '8px 0 0 8px'; monEl.style.borderRight = 'none'; }
  const hdr = chartEl.querySelector('.amon-chart-hdr'); if (hdr) hdr.style.cursor = 'default';
  _syncChartPos(sid);
  const btn = chartEl.querySelector('.amon-chart-attach-btn');
  if (btn) { btn.textContent = '↗'; btn.title = 'Detach'; btn.onclick = () => _detachChartInternal(sid); }
}

function _updateChartInternal(sid, s) {
  // Delegate to the existing _updateCharts logic exposed globally
  if (typeof window._amUpdateChart === 'function') {
    window._amUpdateChart(sid, _chartInstances.get(sid), s);
  }
}

// ── Global API (called from inline onclick handlers) ────────────────────────
window._amClose = function(sid) {
  const ps = _monitors.get(sid);
  if (ps) {
    destroyAlgoMonitorPanel(ps);
    const idx = panels.indexOf(ps);
    if (idx >= 0) panels.splice(idx, 1);
    updateAreaSize();
    persistLayouts();
  }
};

window._amMinimise = function(sid) {
  const ps = _monitors.get(sid);
  if (ps) {
    const el = ps._el || document.getElementById(`panel-${ps.id}`);
    if (el) el.classList.toggle('minimised');
  }
};

window._amCloseChart = function(sid) { _closeChartInternal(sid); };

// ── Exports ─────────────────────────────────────────────────────────────────
window.AlgoMonitor = {
  createAlgoMonitorPanel,
  updateAlgoMonitor,
  destroyAlgoMonitorPanel,
  snapshotAlgoMonitor,
  getMonitors: () => _monitors,
  getChartInstances: () => _chartInstances,
  getChartVisible: () => _chartVisible,
  getChartAttached: () => _chartAttached,
};
