/**
 * AlgoMonitor — Self-contained algo monitor panel module
 *
 * Owns all monitor panel creation, rendering, chart management, and lifecycle.
 * Registers as a panel type with PanelGrid for layout persistence.
 *
 * Global dependencies (from deribit_testnet.html):
 *   exchPill, formatNum, BL_TS, BL_FMT, tickDecimals, blotterData, panels,
 *   blotterPriceFmt, Chart (Chart.js), TCA_BASE, updateAreaSize, persistLayouts,
 *   nextPanelPos, startDrag, startResize
 */

'use strict';

// ── Internal State ──────────────────────────────────────────────────────────
const _monitors = new Map();        // sid → { id, panelType, strategyId, x, y, _el }
const _chartInstances = new Map();  // sid → Chart.js instance
const _chartVisible = {};           // sid → boolean
const _chartAttached = {};          // sid → boolean
let _dataProvider = null;           // fn(sid) => strategyData

// ── Data Provider ───────────────────────────────────────────────────────────
function setDataProvider(fn) { _dataProvider = fn; }
function _getData(sid) {
  if (_dataProvider) return _dataProvider(sid);
  return typeof blotterData !== 'undefined' ? blotterData.algos?.[sid] : null;
}

// ── Panel Creation ──────────────────────────────────────────────────────────
function openMonitor(sid, opts) {
  if (typeof sid === 'string' && typeof opts === 'object' && opts.centre !== undefined) {
    // Called as openMonitor(sid, { centre: true }) — legacy signature
    return _openMonitor(sid, opts);
  }
  return _openMonitor(sid, opts || {});
}

function _openMonitor(sid, { centre = false, x, y, width, height, chartOpen } = {}) {
  console.log('[AlgoMonitor] openMonitor called:', sid, { centre, x, y, width, chartOpen });
  if (_monitors.has(sid)) return _monitors.get(sid);
  const s = _getData(sid) || {};
  const id = (typeof nextId !== 'undefined') ? nextId++ : Date.now();
  let pos;
  if (x != null && y != null) {
    pos = { x, y };
  } else if (centre) {
    pos = { x: Math.round((window.innerWidth - 500) / 2), y: Math.round((window.innerHeight - 400) / 2) };
  } else {
    const saved = localStorage.getItem('algo-mon-' + sid);
    pos = saved ? JSON.parse(saved) : (typeof nextPanelPos === 'function' ? nextPanelPos(500, 400) : { x: 80 + _monitors.size * 30, y: window.innerWidth - 510 });
  }

  const panelState = {
    id, panelType: 'algo-monitor', strategyId: sid,
    x: pos.x ?? pos.left ?? 10, y: pos.y ?? pos.top ?? 10,
    _chartVisible: false,
  };

  // Add to panels array
  if (typeof panels !== 'undefined') {
    panels.push(panelState);
    console.log('[AlgoMonitor] pushed to panels:', panelState.panelType, panelState.strategyId, 'panels.length:', panels.length);
  }

  const el = document.createElement('div');
  el.className = 'algo-monitor status-' + (s.state || s.status || 'STOPPED');
  el.id = `panel-${id}`;
  el.style.cssText = `position:absolute;left:${panelState.x}px;top:${panelState.y}px;width:480px;min-height:380px;display:flex;flex-direction:column`;

  el.innerHTML = `
    <div class="algo-monitor-hdr" data-sid="${sid}">
      <span class="algo-monitor-title"></span>
      <div class="algo-monitor-btns">
        <button class="amon-chart-toggle" style="font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid #4488ff;background:#0a1628;color:#4488ff;font-weight:700;cursor:pointer;margin-right:4px">CHART</button>
        <button class="amon-close-btn" style="background:none;border:1px solid #1e1e28;border-radius:4px;color:#555;cursor:pointer;padding:1px 6px;font-family:inherit" title="Close">&times;</button>
      </div>
    </div>
    <div class="algo-monitor-body" id="algo-mon-body-${sid}" style="flex:1;overflow-y:auto;min-height:0;padding:0"></div>
    <div class="panel-resize" id="resize-${id}"></div>`;

  document.getElementById('panels-canvas').appendChild(el);
  panelState._el = el;
  _monitors.set(sid, panelState);

  // Wire buttons
  el.querySelector('.amon-close-btn').addEventListener('click', () => closeMonitor(sid));
  el.querySelector('.amon-chart-toggle').addEventListener('mousedown', e => e.stopPropagation());
  el.querySelector('.amon-chart-toggle').addEventListener('click', e => { e.stopImmediatePropagation(); e.preventDefault(); _toggleChart(sid); });

  // Drag — sync attached chart position
  const hdr = el.querySelector('.algo-monitor-hdr');
  hdr.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    function mv(ev) {
      const newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, ev.clientX - ox));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - oy));
      el.style.left = newLeft + 'px'; el.style.top = newTop + 'px';
      panelState.x = newLeft; panelState.y = newTop;
      if (_chartAttached[sid]) _syncChartPosition(sid);
    }
    function up() {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      localStorage.setItem('algo-mon-' + sid, JSON.stringify({ top: parseInt(el.style.top), left: parseInt(el.style.left) }));
    }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });

  // Resize
  const rh = el.querySelector('.panel-resize');
  if (rh && typeof startResize === 'function') rh.addEventListener('mousedown', e => startResize(el, panelState, e));

  // Apply restored width
  if (width) el.style.width = width + 'px';

  // Initial render
  if (s.type) updateMonitor(sid, s);
  if (typeof updateAreaSize === 'function') updateAreaSize();
  if (typeof persistLayouts === 'function') persistLayouts();

  // Restore chart if it was open
  if (chartOpen) setTimeout(() => _openChart(sid), 100);

  return panelState;
}

// ── Monitor Update (full rendering logic) ───────────────────────────────────
function updateMonitor(sid, s) {
  const panelState = _monitors.get(sid);
  if (!panelState) return;
  const el = panelState._el || document.getElementById(`panel-${panelState.id}`);
  if (!el) return;
  if (!s) s = _getData(sid);
  if (!s) return;

  _renderMonitorBody(sid, s, el);

  // Update chart if visible
  if (_chartInstances.has(sid)) {
    _updateSingleChart(sid, _chartInstances.get(sid), s);
  }
}

function _renderMonitorBody(sid, s, el) {
  const _rawState = s.state || s.status || 'STOPPED';
  const _stratStatus = (s.status || '').toUpperCase();
  const state = (_stratStatus === 'COMPLETED' || _stratStatus === 'STOPPED' || _stratStatus === 'EXPIRED') ? _stratStatus : _rawState;
  el.className = 'algo-monitor status-' + state;

  const title = el.querySelector('.algo-monitor-title');
  const pct = s.totalSize ? Math.round((s.filledQty || 0) / s.totalSize * 100) : 0;
  if (title) title.innerHTML = `${exchPill(s.venue||'Deribit')} <strong>${s.type||'?'}</strong> ${s.symbol||''} ${s.side||''} <span style="color:#ccc">${pct}%</span> <span class="amon-status-pill amon-status-${state}">${state}</span>`;

  const body = document.getElementById('algo-mon-body-' + sid);
  if (!body || el.classList.contains('minimised')) return;

  if (state === 'COMPLETED' && body.dataset.frozen === 'completed') return;
  if (state === 'STOPPED' && body.dataset.frozen === 'stopped') return;
  if (state === 'COMPLETED') body.dataset.frozen = 'completed';
  else if (state === 'STOPPED') body.dataset.frozen = 'stopped';
  else body.dataset.frozen = '';

  const pxD = s.tickSize ? tickDecimals(s.tickSize) : 4;
  const tile = panels.find(p => p.instrument === s.symbol && p.exchange === (s.venue || 'Deribit'));
  const bid = tile?.ticker?.best_bid_price || 0;
  const ask = tile?.ticker?.best_ask_price || 0;
  const mid = bid && ask ? (bid + ask) / 2 : 0;
  const spreadBps = mid > 0 ? ((ask - bid) / mid * 10000).toFixed(1) : '-';

  const slipArrRaw = s.slippageVsArrival != null ? -s.slippageVsArrival : null;
  const slipVwapRaw = s.slippageVsVwap != null ? -s.slippageVsVwap : null;
  const slipArr = slipArrRaw != null ? (slipArrRaw >= 0 ? '+' : '') + slipArrRaw.toFixed(1) : '-';
  const slipVwap = slipVwapRaw != null ? (slipVwapRaw >= 0 ? '+' : '') + slipVwapRaw.toFixed(1) : '-';
  const slipArrCls = (slipArrRaw||0) >= 0 ? 'bl-green' : 'bl-red';
  const slipVwapCls = (slipVwapRaw||0) >= 0 ? 'bl-green' : 'bl-red';
  const nextSec = s.nextSliceIn ? Math.round(s.nextSliceIn/1000) : 0;
  const schedTxt = s.currentSlice != null ? `Slice ${s.currentSlice}/${s.numSlices}` : '-';
  const remQty = s.remainingQty ?? (s.totalSize - (s.filledQty||0));
  const behindQty = s.totalSize && s.currentSlice && s.numSlices ? ((s.currentSlice/s.numSlices)*s.totalSize)-(s.filledQty||0) : 0;
  const onSch = behindQty <= 0;
  const _fmtDur = ms => { if (!ms) return '-'; const sec=Math.round(ms/1000); const m=Math.floor(sec/60); const r=sec%60; return m>0?`${m}m ${r}s`:`${sec}s`; };
  const timeRem = _fmtDur(s.timeRemaining);
  const elTxt = _fmtDur(s.elapsed);
  let urgCtx = '';
  const urg = s.urgency || 'passive';
  const aop = s.activeOrderPrice;
  if (urg === 'passive' && s.sliceCrossed) urgCtx = aop ? `Passive — crossing now @ $${aop.toFixed(pxD)}` : 'Passive — crossing (unfilled)';
  else if (urg === 'passive') urgCtx = aop ? `Passive — resting @ $${aop.toFixed(pxD)}` : (bid ? `Passive — next at ${s.side==='BUY'?'bid':'ask'}` : 'Passive');
  else if (urg === 'aggressive') urgCtx = aop ? `Aggressive — crossing @ $${aop.toFixed(pxD)}` : (ask ? `Aggressive — next crosses spread` : 'Aggressive');
  const pauseBar = state === 'PAUSED' && s.pauseReason ? `<div class="amon-pause-bar">Paused: ${s.pauseReason}</div>` : '';

  // Child orders
  const _expectedSizes = new Set();
  _expectedSizes.add(s.totalSize);
  if (s.currentPostSize) _expectedSizes.add(s.currentPostSize);
  if (s.levels) s.levels.forEach(l => { if (l.allocatedSize) _expectedSizes.add(l.allocatedSize); });
  const _startTs = s.startTime || 0;
  const childOrders = Object.values(blotterData.orders).filter(o => {
    if (o._strategyId === sid) return true;
    const parentId = o._parentOrderId || o._metadata?.parentOrderId;
    if (parentId) {
      const shortId = s.shortId || sid.substring(sid.length - 6);
      if (parentId === sid || parentId === `${s.type||'SNIPER'}-${shortId}` || parentId === `TWAP-${shortId}`) return true;
    }
    if (s.symbol && o.instrument_name === s.symbol && (o.creation_timestamp||0) >= _startTs - 5000 && _expectedSizes.has(o.amount)) return true;
    return false;
  }).sort((a,b) => (b.creation_timestamp||0)-(a.creation_timestamp||0)).slice(0, 50);

  let childHTML = '';
  if (childOrders.length) {
    const pxDec = s.tickSize ? tickDecimals(s.tickSize) : 4;
    const stratDone = state === 'COMPLETED' || state === 'STOPPED';
    childHTML = `<table class="amon-child-tbl"><thead><tr><th>Time</th><th>Side</th><th>Size</th><th>Price</th><th>Status</th><th>Filled</th></tr></thead><tbody>` +
      childOrders.map(o => {
        let st = (o.order_state||'').toLowerCase();
        let filledAmt = o.filled_amount;
        if (stratDone && (st === 'open' || st === 'partial' || st === 'partially_filled')) { st = 'filled'; filledAmt = o.amount; }
        const cls = st==='filled'?'child-filled':st==='open'?'child-open':st==='cancelled'?'child-cancelled':st==='rejected'?'child-rejected':'';
        return `<tr class="${cls}"><td>${BL_TS(o.creation_timestamp||o.last_update_timestamp)}</td><td>${(o.direction||'').toUpperCase()}</td><td>${formatNum(o.amount,4)}</td><td>${BL_FMT(o.price, pxDec)}</td><td>${st}</td><td>${formatNum(filledAmt,4)}</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  const _fmtQty = v => { const n = Number(v); if (isNaN(n)) return '?'; return n.toFixed(4).replace(/\.?0+$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  const _orderSummary = s.summaryLine || `${s.side||''} ${_fmtQty(s.totalSize)} ${s.symbol||''} on ${s.venue||'Deribit'} via ${s.type||'?'}`;

  // Strategy-specific metrics
  let stratMetrics = '';
  if (s.type === 'POV') {
    stratMetrics = `<span style="color:#555">Participation: <span style="color:#ccc">${(s.participationRate||0).toFixed(1)}% (target ${s.targetPct||10}%)</span></span>
      <span style="color:#555">Window vol: <span style="color:#ccc">${formatNum(s.windowVolume||0,1)} · deficit ${formatNum(s.deficit||0,2)}</span></span>`;
  } else if (s.type === 'ICEBERG') {
    stratMetrics = `<span style="color:#555">Slice: <span style="color:#ccc">${s.slicesFired||0} fired · ${s.currentSliceSize?formatNum(s.currentSliceSize,2)+' resting':'waiting'}</span></span>
      <span style="color:#555">Detection: <span style="color:${(s.detectionScore||0)<30?'#00c896':(s.detectionScore||0)<70?'#ccaa44':'#e05252'}">${s.detectionScore||0}/100 ${(s.detectionScore||0)<30?'Low':(s.detectionScore||0)<70?'Medium':'High'}</span>${s.chaseRequired?' · <span style="color:#ccaa44">chasing</span>':''}</span>`;
  } else if (s.type === 'VWAP') {
    stratMetrics = `<span style="color:#555">VWAP: <span style="color:#ccc">$${s.rollingVwap?s.rollingVwap.toFixed(pxD):'—'} <span style="font-size:8px;color:#7F77DD">${s.vwapMode||'realtime'}</span></span></span>
      <span style="color:#555">Dev: <span style="color:${Math.abs(s.deviationFromVwap||0)<10?'#00c896':'#ccaa44'}">${(s.deviationFromVwap||0).toFixed(1)}bps ${s.inParticipationBand?'✓ in band':'outside band'}</span></span>`;
  } else if (s.type === 'SNIPER') {
    if (s.executionMode === 'post_snipe') {
      if (s.levelMode === 'simultaneous' && s.levels?.length > 1) {
        stratMetrics = `<span style="color:#555;font-size:8px">Discretion | Resting: ${formatNum(s.currentPostSize,2)} @ $${s.targetPrice?.toFixed(pxD)||'—'} | ${s.levels.length} snipe levels</span>
          ${s.levels.map((lv, li) => {
            const pctFill = lv.allocatedSize > 0 ? Math.min(100, lv.filledSize / lv.allocatedSize * 100) : 0;
            const barW = 6; const filled = Math.round(pctFill / 100 * barW);
            const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barW - filled);
            const colors = ['#00BFFF','#FFD700','#FF00FF'];
            return `<span style="color:${colors[li%3]};font-size:8px;font-family:monospace">L${li+1} $${lv.price?.toFixed(pxD)} ${bar} ${lv.filledSize?.toFixed(1)}/${lv.allocatedSize?.toFixed(1)} ${lv.status||''}</span>`;
          }).join('')}
          <span style="color:#555">Passive: <span style="color:#00c896">${formatNum(s.passiveFillSize,2)}</span> | Sniped: <span style="color:#00e5ff">${formatNum(s.snipedSize,2)}</span></span>`;
      } else {
        stratMetrics = `<span style="color:#555;font-size:8px">Round ${s.roundNumber||1} — Post+Snipe | Phase: <span style="color:#ccc">${s.postSnipePhase||'?'}</span></span>
          <span style="color:#555">Resting: <span style="color:#ccaa44">${formatNum(s.currentPostSize,2)} @ $${s.targetPrice?.toFixed(pxD)||'—'}</span> | Snipe: <span style="color:#7F77DD">${formatNum(s.currentSnipeSize,2)} @ $${s.snipeLevel?.toFixed(pxD)||'—'}</span></span>
          <span style="color:#555">Snipe cap: <span style="color:#00e5ff">${formatNum(s.snipeCapUsed||0,2)}/${formatNum(s.maxSnipeTotal||0,2)}</span> (${s.snipePct||50}%)</span>
          <span style="color:#555">Passive: <span style="color:#00c896">${formatNum(s.passiveFillSize,2)}</span> | Sniped: <span style="color:#00e5ff">${formatNum(s.snipedSize,2)}</span></span>`;
      }
    } else if (s.levels && s.levels.length > 0) {
      stratMetrics = s.levels.map((lv, li) => {
        const lpct = lv.allocatedSize > 0 ? Math.min(100, lv.filledSize / lv.allocatedSize * 100) : 0;
        const barW = 8; const filled = Math.round(lpct / 100 * barW);
        const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barW - filled);
        const colors = ['#00e5ff','#ccaa44','#cc44cc','#44cc88','#cc8844'];
        const c = colors[li % colors.length];
        const lst = lv.active ? lv.status : lv.status === 'COMPLETED' ? 'DONE' : '';
        return `<span style="color:${c};font-size:8px;font-family:monospace">L${li+1} $${lv.price?.toFixed(pxD)} ${lv.pct}% ${bar} ${lst} ${lv.filledSize?.toFixed(2)}/${lv.allocatedSize?.toFixed(2)}</span>`;
      }).join('')
        + (s.volumeConfirmEnabled ? `<span style="color:#555;font-size:8px">Vol: ${(s.levels[s.activeLevelIndex]?.volumeAtLevel||0).toFixed(0)}/${s.volumeConfirmSize}</span>` : '')
        + (s.momentumFilterEnabled ? `<span style="color:#555;font-size:8px">Mom: ${(s.momentumBps||0).toFixed(1)} bps/s</span>` : '');
    } else {
      stratMetrics = `<span style="color:#555">Snipe: <span style="color:${s.triggered?'#00c896':'#ccaa44'}">$${s.targetPrice?.toFixed(pxD)||'—'}</span> Distance: ${(s.distanceBps||0).toFixed(1)}bps</span>`;
    }
  } else if (s.type === 'IS') {
    stratMetrics = `<span style="color:#555">IS cost: <span style="color:${(s.totalIsCost||0)<=0?'#00c896':'#e05252'};font-weight:700">${(s.totalIsCost||0).toFixed(1)} bps</span> <span style="font-size:8px;color:#666">(timing ${(s.timingCost||0).toFixed(1)} + impact ${(s.marketImpactCost||0).toFixed(1)})</span></span>
      <span style="color:#555">Rate: <span style="color:#ccc">${((s.optimalRate||0)*100).toFixed(0)}% ${s.currentUrgency||''}</span> · Vol: <span style="color:#ccc">${((s.estimatedVolatility||0)*100).toFixed(2)}%</span></span>`;
  } else {
    stratMetrics = `<span style="color:#555">Schedule: <span style="color:#ccc">${schedTxt}${nextSec>0&&state==='RUNNING'?' · next '+nextSec+'s':''}</span></span>
      <span style="color:${onSch?'#00c896':'#ccaa44'};font-size:9px">${onSch?'On schedule':'Behind '+behindQty.toFixed(2)}</span>`;
  }

  // Buttons
  let buttonsHTML;
  if (state === 'COMPLETED') {
    buttonsHTML = `<div style="flex:1;text-align:center;font-size:10px;color:#378ADD;border:1px solid #1a3a5a;border-radius:4px;padding:4px 8px">
      COMPLETED — ${formatNum(s.filledQty,4)} filled at avg $${s.avgFillPrice?.toFixed(pxD)||'—'} | Slip: ${slipArr} bps
    </div><button class="algo-stop-btn" onclick="_algoCloseMonitor('${sid}')" style="min-width:50px">Close</button>`;
  } else if (state === 'STOPPED') {
    buttonsHTML = `<div style="flex:1;text-align:center;font-size:10px;color:#e05252;border:1px solid #3a1a1a;border-radius:4px;padding:4px 8px;line-height:1.6">
      STOPPED — ${formatNum(s.filledQty,4)} of ${formatNum(s.totalSize,4)} filled${s.filledQty > 0 ? ` at avg $${s.avgFillPrice?.toFixed(pxD)||'—'}` : ''}${slipArrRaw != null && s.filledQty > 0 ? ` | Slip: ${slipArr} bps` : ''}
    </div><button class="algo-stop-btn" onclick="_algoCloseMonitor('${sid}')" style="min-width:50px">Close</button>`;
  } else {
    buttonsHTML = `<button class="algo-mon-btn" onclick="_algoTogglePause('${sid}',${state==='PAUSED'})" style="flex:1;min-width:55px">${state==='PAUSED'?'Resume':'Pause'}</button>
      <button class="algo-stop-btn" onclick="_algoStop('${sid}')" style="flex:1;min-width:55px">Stop</button>
      <div class="amon-accel"><span style="color:#555;font-size:9px">Accel:</span>
        <input id="amon-accel-qty-${sid}" type="text" inputmode="decimal" value="${remQty > 0 ? remQty.toFixed(2) : ''}">
        <button class="amon-accel-btn" onclick="_algoAccelerate('${sid}')">Execute Now</button>
      </div>`;
  }

  body.innerHTML = `${pauseBar}
    <div class="amon-section">
      <div class="amon-market">
        <span class="amon-bid">${bid?'$'+bid.toFixed(pxD):'—'}</span>
        <span class="amon-spread">${spreadBps} bps</span>
        <span class="amon-ask">${ask?'$'+ask.toFixed(pxD):'—'}</span>
        <span style="color:#555;margin-left:auto;font-size:9px">${urgCtx}</span>
      </div>
      <div style="font-size:8px;color:#aaa;padding:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_orderSummary}</div>
    </div>
    <div class="amon-section">
      <div class="algo-progress-bar" style="margin-bottom:4px"><div class="algo-progress-fill" style="width:${pct}%"></div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:10px">
        <span style="color:#555">Filled: <span style="color:#ccc">${formatNum(s.filledQty,4)}</span></span>
        <span style="color:#555">Remaining: <span style="color:#ccc">${formatNum(remQty,4)}</span></span>
        <span style="color:#555">Avg fill: <span style="color:#ccc">${s.avgFillPrice?'$'+s.avgFillPrice.toFixed(pxD):'—'}</span></span>
        <span style="color:#555">Arrival: <span style="color:#ccc">${s.arrivalPrice?'$'+s.arrivalPrice.toFixed(pxD):'—'}</span></span>
        ${stratMetrics}
        <span style="color:#555">Elapsed: <span style="color:#ccc">${elTxt}</span></span>
        <span style="color:#555">Time left: <span style="color:#ccc">~${timeRem}</span></span>
        <span style="color:#555">Slip vs arr: <span class="${slipArrCls}">${slipArr} bps</span></span>
        <span style="color:#555">Slip vs VWAP: <span class="${slipVwapCls}">${slipVwap} bps</span></span>
      </div>
    </div>
    <div class="amon-section" style="padding:2px 10px 0">
      <div style="font-size:8px;color:#444;margin-bottom:2px">${s.numSlices
        ? `Orders: ${childOrders.filter(o=>(o.order_state||'').toLowerCase()==='filled').length}/${s.numSlices} filled`
        : `Orders: ${s.childCount||childOrders.length} placed · ${childOrders.filter(o=>(o.order_state||'').toLowerCase()==='filled').length} filled`
      }</div>
      <div style="max-height:112px;overflow-y:auto">${childHTML||'<span style="color:#333;font-size:9px">No child orders yet</span>'}</div>
    </div>
    <div class="amon-section" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${buttonsHTML}</div>`;
}

// ── Close / Minimise ────────────────────────────────────────────────────────
function closeMonitor(sid) {
  const ps = _monitors.get(sid);
  if (ps) {
    _closeChart(sid);
    const el = ps._el || document.getElementById(`panel-${ps.id}`);
    if (el) el.remove();
    _monitors.delete(sid);
    if (typeof panels !== 'undefined') {
      const idx = panels.indexOf(ps);
      if (idx >= 0) panels.splice(idx, 1);
    }
    if (typeof updateAreaSize === 'function') setTimeout(updateAreaSize, 50);
    if (typeof persistLayouts === 'function') persistLayouts();
  }
}

function minimiseMonitor(sid) {
  const ps = _monitors.get(sid);
  if (ps) {
    const el = ps._el || document.getElementById(`panel-${ps.id}`);
    if (el) el.classList.toggle('minimised');
  }
}

// ── Chart Management ────────────────────────────────────────────────────────
function _toggleChart(sid) {
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (chartEl) { _closeChart(sid); } else { _openChart(sid); }
}

function _setChartBtnStyle(sid, open) {
  const ps = _monitors.get(sid);
  const btn = ps?._el?.querySelector('.amon-chart-toggle');
  if (!btn) return;
  btn.style.background = open ? '#1a2a1a' : '#0a1628';
  btn.style.color = open ? '#00c896' : '#4488ff';
  btn.style.borderColor = open ? '#2a4a2a' : '#4488ff';
}

function _openChart(sid) {
  if (_chartInstances.has(sid)) return;
  const ps = _monitors.get(sid);
  if (!ps) return;
  const monEl = ps._el || document.getElementById(`panel-${ps.id}`);
  if (!monEl) return;

  _chartAttached[sid] = true;
  _chartVisible[sid] = true;
  _setChartBtnStyle(sid, true);

  // Create separate chart panel div as sibling
  const panel = document.createElement('div');
  panel.className = 'panel amon-chart-panel';
  panel.id = 'amon-chart-' + sid;
  panel.style.cssText = `position:absolute;width:320px;height:${monEl.offsetHeight}px;top:${monEl.offsetTop}px;left:${monEl.offsetLeft + monEl.offsetWidth}px;background:#0a0a10;border:1px solid #1a1a22;border-radius:0 8px 8px 0;border-left:none;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.4)`;
  monEl.style.borderRadius = '8px 0 0 8px';
  monEl.style.borderRight = 'none';

  panel.innerHTML = `
    <div class="amon-chart-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;background:#0c0c14;font-size:9px;color:#555;flex-shrink:0">
      <span>Execution Chart</span>
      <div style="display:flex;gap:2px">
        <button class="amon-chart-detach" style="background:none;border:none;color:#555;cursor:pointer;font-size:11px;padding:0 3px" title="Detach">↗</button>
        <button class="amon-chart-x" style="background:none;border:none;color:#555;cursor:pointer;font-size:11px;padding:0 3px" title="Close chart">&times;</button>
      </div>
    </div>
    <div style="flex:1;position:relative;min-height:0;padding:4px"><canvas id="amon-chart-canvas-${sid}" style="position:absolute;top:4px;left:4px;right:4px;bottom:4px;width:calc(100% - 8px);height:calc(100% - 8px)"></canvas></div>`;

  document.getElementById('panels-canvas').appendChild(panel);

  // Wire chart panel buttons
  panel.querySelector('.amon-chart-x').addEventListener('click', () => _closeChart(sid));
  panel.querySelector('.amon-chart-detach').addEventListener('click', () => {
    if (_chartAttached[sid]) _detachChart(sid); else _attachChart(sid);
  });

  // Drag on chart header (only when detached)
  const chartHdr = panel.querySelector('.amon-chart-hdr');
  chartHdr.style.cursor = _chartAttached[sid] ? 'default' : 'grab';
  chartHdr.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || _chartAttached[sid]) return;
    if (e.button !== 0) return;
    e.preventDefault();
    chartHdr.style.cursor = 'grabbing';
    const ox = e.clientX - panel.offsetLeft, oy = e.clientY - panel.offsetTop;
    function mv(ev) { panel.style.left = (ev.clientX - ox) + 'px'; panel.style.top = (ev.clientY - oy) + 'px'; }
    function up() { chartHdr.style.cursor = 'grab'; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });

  // ResizeObserver to sync chart height with monitor
  const ro = new ResizeObserver(() => {
    panel.style.height = monEl.offsetHeight + 'px';
    if (_chartAttached[sid]) _syncChartPosition(sid);
    const ch = _chartInstances.get(sid); if (ch) try { ch.resize(); } catch {}
  });
  ro.observe(monEl);
  panel._ro = ro;

  // Force reflow then create Chart.js
  void panel.offsetHeight;
  requestAnimationFrame(() => {
    const ctx = document.getElementById('amon-chart-canvas-' + sid)?.getContext('2d');
    if (!ctx || typeof Chart === 'undefined') return;
    const algoState = _getData(sid);
    const seedBids = [], seedAsks = [], seedTimes = [], seedOrders = [];
    if (algoState?.chartBids?.length >= 1) {
      seedBids.push(...algoState.chartBids); seedAsks.push(...algoState.chartAsks);
      seedTimes.push(...algoState.chartTimes); seedOrders.push(...(algoState.chartOrder || []));
    }
    const chart = new Chart(ctx, {
      type: 'line',
      data: { datasets: [
        { label:'Bid', data:seedBids.map((v,i)=>({x:seedTimes[i],y:v})), borderColor:'#e05252', borderWidth:1, pointRadius:0, tension:0 },
        { label:'Ask', data:seedAsks.map((v,i)=>({x:seedTimes[i],y:v})), borderColor:'#00c896', borderWidth:1, pointRadius:0, tension:0 },
        { label:'Order', data:seedOrders.map((v,i)=>v?{x:seedTimes[i],y:v}:null).filter(Boolean), borderColor:'#00cc88', borderWidth:1.5, pointRadius:0, tension:0, borderDash:[4,2] },
        { label:'Fills', data:[], type:'scatter', pointRadius:8, pointStyle:[], rotation:[], backgroundColor:[], borderColor:[], borderWidth:1 },
        { label:'Volume', data:[], type:'bar', yAxisID:'y2', backgroundColor:'rgba(55,138,221,0.15)', borderWidth:0, barThickness:2, maxBarThickness:3 },
        { label:'VWAP', data:[], borderColor:'#7F77DD', borderWidth:1, borderDash:[3,3], pointRadius:0, tension:0 },
        { label:'Target', data:[], borderColor:'#ccaa44', borderWidth:1, borderDash:[5,3], pointRadius:0, tension:0 },
        { label:'Snipe', data:[], borderColor:'#7F77DD', borderWidth:1, borderDash:[3,5], pointRadius:0, tension:0 },
      ]},
      options: {
        responsive:true, maintainAspectRatio:false, animation:false,
        scales: {
          x:{type:'time',time:{unit:'second',displayFormats:{second:'HH:mm:ss'},tooltipFormat:'HH:mm:ss'},display:true,ticks:{color:'#333',font:{size:8},maxTicksLimit:6,autoSkip:true},grid:{color:'#111'}},
          y:{display:true,ticks:{color:'#444',font:{size:9}},grid:{color:'#111'}},
          y2:{display:false,position:'right',beginAtZero:true,grid:{display:false}},
        },
        plugins:{legend:{display:false},tooltip:{enabled:true,callbacks:{
          label:item=>{
            if(item.datasetIndex===3){const f=item.raw._fill;return f?`${f.side} ${f.size.toFixed(4)} @ ${f.price.toFixed(4)}${f.simulated?' (SIM)':''}`:''}
            return `${item.dataset.label}: ${item.parsed.y?.toFixed(4)}`;
          }
        }}},
      },
    });
    _chartInstances.set(sid, chart);
    setTimeout(() => { try { chart.resize(); } catch {} }, 100);
    setTimeout(() => { try { chart.resize(); } catch {} }, 500);
  });
}

function _closeChart(sid) {
  const chart = _chartInstances.get(sid);
  if (chart) { try { chart.destroy(); } catch {} _chartInstances.delete(sid); }
  _chartVisible[sid] = false;
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (chartEl) { if (chartEl._ro) chartEl._ro.disconnect(); chartEl.remove(); }
  // Restore monitor borders
  const ps = _monitors.get(sid);
  const monEl = ps?._el;
  if (monEl) { monEl.style.borderRadius = '8px'; monEl.style.borderRight = ''; }
  delete _chartAttached[sid];
  _setChartBtnStyle(sid, false);
}

function _syncChartPosition(sid) {
  const ps = _monitors.get(sid);
  const monEl = ps?._el || document.getElementById(`panel-${ps?.id}`);
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (!monEl || !chartEl) return;
  chartEl.style.left = (monEl.offsetLeft + monEl.offsetWidth) + 'px';
  chartEl.style.top = monEl.offsetTop + 'px';
}

function _detachChart(sid) {
  _chartAttached[sid] = false;
  localStorage.setItem('algo-chart-attached-' + sid, 'false');
  const ps = _monitors.get(sid);
  const monEl = ps?._el;
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (!chartEl) return;
  chartEl.style.left = (parseInt(chartEl.style.left) + 20) + 'px';
  chartEl.style.borderRadius = '8px'; chartEl.style.borderLeft = '';
  if (monEl) { monEl.style.borderRadius = '8px'; monEl.style.borderRight = ''; }
  const hdr = chartEl.querySelector('.amon-chart-hdr'); if (hdr) hdr.style.cursor = 'grab';
  const btn = chartEl.querySelector('.amon-chart-detach');
  if (btn) { btn.textContent = '↙'; btn.title = 'Attach'; }
}

function _attachChart(sid) {
  _chartAttached[sid] = true;
  localStorage.setItem('algo-chart-attached-' + sid, 'true');
  const ps = _monitors.get(sid);
  const monEl = ps?._el;
  const chartEl = document.getElementById('amon-chart-' + sid);
  if (!chartEl) return;
  chartEl.style.borderRadius = '0 8px 8px 0'; chartEl.style.borderLeft = 'none';
  if (monEl) { monEl.style.borderRadius = '8px 0 0 8px'; monEl.style.borderRight = 'none'; }
  const hdr = chartEl.querySelector('.amon-chart-hdr'); if (hdr) hdr.style.cursor = 'default';
  _syncChartPosition(sid);
  const btn = chartEl.querySelector('.amon-chart-detach');
  if (btn) { btn.textContent = '↗'; btn.title = 'Detach'; }
}

// ── Chart Update (full rendering logic) ─────────────────────────────────────
function _updateSingleChart(sid, chart, s) {
  if (!s?.chartTimes?.length || !chart) return;
  const times = s.chartTimes, bids = s.chartBids, asks = s.chartAsks, orders = s.chartOrder, fills = s.chartFills || [];

  chart.data.datasets[0].data = bids.map((v,i) => ({ x: times[i], y: v }));
  chart.data.datasets[1].data = asks.map((v,i) => ({ x: times[i], y: v }));
  if (s.type === 'SNIPER' && s.executionMode === 'post_snipe' && s.chartTargetPrice && times.length >= 2) {
    chart.data.datasets[2].data = [{ x: times[0], y: s.chartTargetPrice }, { x: times[times.length-1], y: s.chartTargetPrice }];
  } else if (s.type === 'SNIPER') {
    chart.data.datasets[2].data = [];
  } else {
    chart.data.datasets[2].data = orders.map((v,i) => v ? { x: times[i], y: v } : null).filter(Boolean);
  }

  const volBars = s.chartVolBars || [];
  if (chart.data.datasets[4] && volBars.length) {
    chart.data.datasets[4].data = volBars.map((v,i) => ({ x: times[i], y: v }));
    chart.options.scales.y2.max = Math.max(...volBars, 1) * 5;
  }
  const vwapLine = s.chartVwap || [];
  if (chart.data.datasets[5] && vwapLine.length) {
    chart.data.datasets[5].data = vwapLine.map((v,i) => v ? { x: times[i], y: v } : null).filter(Boolean);
  }
  if (chart.data.datasets[6] && s.chartTargetPrice && times.length >= 2) {
    chart.data.datasets[6].data = [{ x: times[0], y: s.chartTargetPrice }, { x: times[times.length-1], y: s.chartTargetPrice }];
    chart.data.datasets[6].borderColor = s.triggered ? '#00c896' : '#ccaa44';
    chart.data.datasets[6].label = s.executionMode === 'post_snipe' ? 'Limit' : s.type === 'SNIPER' ? 'Snipe' : 'Target';
  }
  if (chart.data.datasets[7] && s.chartSnipeLevel && times.length >= 2) {
    chart.data.datasets[7].data = [{ x: times[0], y: s.chartSnipeLevel }, { x: times[times.length-1], y: s.chartSnipeLevel }];
  } else if (chart.data.datasets[7]) {
    chart.data.datasets[7].data = [];
  }

  // Level lines
  const levelPrices = s.chartLevelPrices || [];
  const levelColors = ['#00BFFF', '#FFD700', '#FF00FF', '#00FF88', '#FF6600'];
  if (levelPrices.length && times.length >= 2) {
    while (chart.data.datasets.length < 8 + levelPrices.length) {
      chart.data.datasets.push({ label:'', data:[], borderColor:'#555', borderWidth:1, borderDash:[4,4], pointRadius:0, tension:0, fill:false });
    }
    for (let li = 0; li < levelPrices.length; li++) {
      const ds = chart.data.datasets[8 + li];
      const lp = levelPrices[li];
      const price = lp?.price || lp;
      if (price > 0) {
        ds.label = `L${li+1}`; ds.data = [{ x: times[0], y: price }, { x: times[times.length-1], y: price }];
        ds.borderColor = levelColors[li % levelColors.length]; ds.borderDash = [6,3]; ds.borderWidth = 1.5;
      } else { ds.data = []; }
    }
    for (let li = levelPrices.length; li < chart.data.datasets.length - 8; li++) chart.data.datasets[8+li].data = [];
  }

  // Fills
  const _timeCount = {};
  const fillPts = fills.map(f => { const t = f.time; _timeCount[t]=(_timeCount[t]||0)+1; return { x: t+(_timeCount[t]-1)*800, y: f.price, _fill: f }; });
  chart.data.datasets[3].data = fillPts;
  const _lfc = { 'snipe-L1':'#00BFFF','snipe-L2':'#FFD700','snipe-L3':'#FF00FF','snipe-L4':'#00FF88','snipe-L5':'#FF6600' };
  const bgColors = fills.map(f => _lfc[f.fillType] || (f.fillType==='snipe'?'#00e5ff':(f.side==='BUY'?'#00c896':'#e05252')));
  const bdColors = fills.map(f => _lfc[f.fillType] || (f.fillType==='snipe'?'#00e5ff':f.simulated?'#ccaa44':(f.side==='BUY'?'#00c896':'#e05252')));
  const styles = fills.map(() => 'triangle');
  const rotations = fills.map(f => f.side === 'BUY' ? 0 : 180);
  const radii = fills.map(() => 8);
  const sState = s.status || s.state;
  if ((sState==='COMPLETED'||sState==='STOPPED'||s.state==='COMPLETED'||s.state==='STOPPED') && styles.length > 0) {
    const last = styles.length - 1;
    styles[last] = 'rect'; rotations[last] = 0; radii[last] = 6;
    let cc = '#378ADD';
    if (s.type==='SNIPER'&&s.levels?.length) { const ci = s.levelMode==='simultaneous'?0:Math.max(0,(s.activeLevelIndex??s.levels.length)-1); cc = levelColors[ci%levelColors.length]; }
    bgColors[last] = cc; bdColors[last] = cc;
  }
  chart.data.datasets[3].backgroundColor = bgColors;
  chart.data.datasets[3].borderColor = bdColors;
  chart.data.datasets[3].pointStyle = styles;
  chart.data.datasets[3].rotation = rotations;
  chart.data.datasets[3].pointRadius = radii;

  const lvlPrices = (s.chartLevelPrices||[]).map(lp=>lp?.price||lp).filter(v=>v>0);
  const tgtPrice = s.chartTargetPrice > 0 ? [s.chartTargetPrice] : [];
  const allPrices = [...bids,...asks,...lvlPrices,...tgtPrice].filter(v=>v>0);
  if (allPrices.length) {
    const mn = Math.min(...allPrices), mx = Math.max(...allPrices);
    const pad = (mx-mn)*0.1||0.001;
    chart.options.scales.y.min = mn-pad; chart.options.scales.y.max = mx+pad;
  }
  chart.update('none');
}

function updateAllCharts() {
  for (const [sid, chart] of _chartInstances) {
    const s = _getData(sid);
    if (s) _updateSingleChart(sid, chart, s);
  }
}

// ── Destroy ─────────────────────────────────────────────────────────────────
// Full destroy — removes from panels array (used by close button)
function destroyMonitorPanel(panelState) {
  if (!panelState || panelState.panelType !== 'algo-monitor') return;
  closeMonitor(panelState.strategyId);
}

// DOM-only destroy — cleans up chart and DOM but leaves panels array intact
// Used by destroyAllPanels during layout switch (panels = [] happens after)
function _destroyDomOnly(sid) {
  const chart = _chartInstances.get(sid);
  if (chart) { try { chart.destroy(); } catch {} _chartInstances.delete(sid); }
  _chartVisible[sid] = false;
  const ps = _monitors.get(sid);
  if (ps) {
    const el = ps._el || document.getElementById(`panel-${ps.id}`);
    if (el) el.remove();
    _monitors.delete(sid);
  }
}

// ── Snapshot ────────────────────────────────────────────────────────────────
function snapshotMonitor(s) {
  const el = s._el || document.getElementById(`panel-${s.id}`);
  const result = { panelType: 'algo-monitor', strategyId: s.strategyId, x: s.x, y: s.y, width: el ? el.offsetWidth : 480, chartOpen: !!_chartVisible[s.strategyId] };
  console.log('[AlgoMonitor] snapshot:', result);
  return result;
}

// ── Register with PanelGrid ─────────────────────────────────────────────────
function init() {
  if (typeof PanelGrid !== 'undefined') {
    PanelGrid.addPanelType('algo-monitor', {
      snapshot: snapshotMonitor,
      destroy: destroyMonitorPanel,
      restore: (p) => {
        if (!_getData(p.strategyId)) return; // strategy no longer active
        openMonitor(p.strategyId, { x: p.x, y: p.y, width: p.width, chartOpen: p.chartOpen });
      },
    });
  }
}

// ── Window Globals (for inline onclick handlers) ────────────────────────────
window._algoOpenMonitor = openMonitor;
window._algoCloseMonitor = closeMonitor;
window._algoMinimiseMonitor = minimiseMonitor;
window._algoToggleChart = _toggleChart;
window._closeChart = _closeChart;
window._detachChart = _detachChart;
window._attachChart = _attachChart;

// ── Export ───────────────────────────────────────────────────────────────────
window.AlgoMonitor = {
  init,
  openMonitor,
  closeMonitor,
  minimiseMonitor,
  updateMonitor,
  updateAllCharts,
  setDataProvider,
  destroyAlgoMonitorPanel: destroyMonitorPanel,
  destroyDomOnly: _destroyDomOnly,
  snapshotAlgoMonitor: snapshotMonitor,
  getMonitors: () => _monitors,
  getChartInstances: () => _chartInstances,
  getChartVisible: () => _chartVisible,
  getChartAttached: () => _chartAttached,
};

// Auto-init if PanelGrid is already loaded
if (typeof PanelGrid !== 'undefined') init();
