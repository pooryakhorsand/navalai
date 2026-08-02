/**
 * app_anderson.js
 * NavalAI — Anderson Turn (Williamson / MOB Recovery)
 *
 * Optimized for:
 * - lazy Plotly loading
 * - lazy KaTeX loading
 * - compact API response decoding
 * - request aborting / frontend cache
 * - low CPU 3D animation
 *
 * FIX (2026-07-05): API_URL previously resolved to the page view
 * ('anderson:anderson_main' -> /anderson/), which only allows GET/OPTIONS
 * and is NOT csrf_exempt. POSTing to it triggered Django's CSRF
 * middleware -> HTTP 403. The simulation endpoint is
 * 'anderson:anderson_simulate' -> /anderson/simulate/, which IS
 * @csrf_exempt on the backend. We now default straight to that path and
 * only use window.NAVALAI_ASSETS.andersonApi as an override if it already
 * points at .../simulate/.
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};

const DEFAULT_API_URL = '/anderson/simulate/';
const API_URL = (ASSETS.andersonApi && /\/simulate\/?$/.test(ASSETS.andersonApi))
  ? ASSETS.andersonApi
  : DEFAULT_API_URL;

const ANIM_DURATION = 5.0;
const DEBOUNCE_MS = 350;
const MAX_PLOT_POINTS = 1500;
const MAX_RETURN_POINTS = 9000;
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;

const EXCELLENT_THRESHOLD = 1.0;   // < 1L -> EXCELLENT
const ACCEPTABLE_THRESHOLD = 3.0;  // 1L–3L -> ACCEPTABLE, > 3L -> POOR

const COLOR_P1   = '#c8a84b';   // Phase 1 — hard rudder (amber)
const COLOR_P2   = '#4ed0e1';   // Phase 2 — rudder centred (teal)
const COLOR_MOB  = '#ef4444';   // MOB beacon
const COLOR_CTE  = '#fb7185';   // Cross-track-error line

const SLIDER_DEFS = [
  { id: 'sl-U0',   key: 'U0',                  disp: 'val-U0',   fmt: v => v.toFixed(2) + ' m/s' },
  { id: 'sl-rate', key: 'max_rudder_rate_deg', disp: 'val-rate', fmt: v => v.toFixed(1) + ' °/s' },
  { id: 'sl-Tmax', key: 'Tmax',                disp: 'val-Tmax', fmt: v => v.toFixed(0) + ' s' }
];

const COEF_IDS = [
  'L', 'm', 'xG', 'Iz', 'h',
  'Xudot', 'Yvdot', 'Nvdot', 'Yrdot', 'Nrdot',
  'Xu', 'Xuu', 'Xuuu', 'Yv', 'Nv', 'Yr', 'Nr',
  'Xvv', 'Xrr', 'Xrv', 'Yvu', 'Nvu', 'Yru', 'Nru',
  'Yvvv', 'Nvvv', 'Yvvr', 'Nvvr',
  'Xdd', 'Xudd', 'Xvd', 'Xuvd',
  'Yd', 'Nd', 'Yddd', 'Nddd',
  'Yud', 'Nud', 'Yuud', 'Nuud',
  'Yvdd', 'Nvdd', 'Yvvd', 'Nvvd',
  'Y0', 'N0', 'Y0u', 'N0u', 'Y0uu', 'N0uu'
];

let state = { U0: 7.7175, max_rudder_rate_deg: 5.0, Tmax: 1200 };
let simCache = null;
let responseCache = new Map();
let releaseIdx = -1;

let currentView = 'cad';
let isPlaying = true;

let scene, camera, renderer, controls;
let clock = null;

let waterPlane, waterGeometry;
let shipModel;
let trajLineP1, trajLineP2;
let trajGeomP1, trajGeomP2;
let mobBeacon, phaseChangeMarker, finalMarker, cteLine;

let animElapsed = 0;
let frameDelta = 0;
let lastWaterUpdate = 0;
let debounceTimer = null;

let activeFetchController = null;
let requestSeq = 0;

const assetPromises = new Map();
let plotlyLoadingPromise = null;
let katexLoadingPromise = null;
let katexRendered = false;

document.addEventListener('DOMContentLoaded', function () {
  initSliders();
  initCollapsibleSections();
  initTheoryModalEvents();
  initViewSwitcher();
  initToolbarEvents();

  if (typeof THREE === 'undefined') {
    setStatus('err', 'THREE.JS MISSING');
  } else {
    init3D();
  }

  setStatus('ready', 'READY');
  updateHUD();

  const runBtn = document.getElementById('btn-run');
  if (runBtn) {
    runBtn.addEventListener('click', function () {
      runSimulation();
    });
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(function () {
      runSimulation();
    }, { timeout: 650 });
  } else {
    setTimeout(function () {
      runSimulation();
    }, 0);
  }
});

// ─────────────────────────────────────────────────────────────
// Small DOM helpers
// ─────────────────────────────────────────────────────────────
function byId(id) {
  return document.getElementById(id);
}

function on(id, evt, fn) {
  const el = byId(id);
  if (el) el.addEventListener(evt, fn);
}

// ─────────────────────────────────────────────────────────────
// Lazy asset loaders
// ─────────────────────────────────────────────────────────────
function loadScriptOnce(src, opts) {
  opts = opts || {};
  if (!src) return Promise.reject(new Error('Missing script src'));

  const key = 'script:' + src;
  if (assetPromises.has(key)) return assetPromises.get(key);

  const p = new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;

    if (opts.integrity) s.integrity = opts.integrity;
    if (opts.crossOrigin) s.crossOrigin = opts.crossOrigin;

    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('Failed to load script: ' + src)); };

    document.head.appendChild(s);
  });

  assetPromises.set(key, p);
  return p;
}

function loadCssOnce(href, opts) {
  opts = opts || {};
  if (!href) return Promise.reject(new Error('Missing CSS href'));

  const key = 'css:' + href;
  if (assetPromises.has(key)) return assetPromises.get(key);

  const p = new Promise(function (resolve, reject) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;

    if (opts.integrity) l.integrity = opts.integrity;
    if (opts.crossOrigin) l.crossOrigin = opts.crossOrigin;

    l.onload = function () { resolve(); };
    l.onerror = function () { reject(new Error('Failed to load CSS: ' + href)); };

    document.head.appendChild(l);
  });

  assetPromises.set(key, p);
  return p;
}

function ensurePlotly() {
  if (typeof Plotly !== 'undefined') return Promise.resolve(window.Plotly);
  if (plotlyLoadingPromise) return plotlyLoadingPromise;

  const src = ASSETS.plotly || '/static/core/js/plotly-basic-2.24.1.min.js';

  plotlyLoadingPromise = loadScriptOnce(src)
    .then(function () {
      if (typeof Plotly === 'undefined') {
        throw new Error('Plotly loaded but global Plotly is undefined.');
      }
      return window.Plotly;
    });

  return plotlyLoadingPromise;
}

function ensureKatexRendered() {
  const overlay = byId('theory-overlay');
  if (!overlay) return Promise.resolve();
  if (katexRendered) return Promise.resolve();
  if (katexLoadingPromise) return katexLoadingPromise;

  const cssP = loadCssOnce(ASSETS.katexCss, {
    integrity: ASSETS.katexCssIntegrity,
    crossOrigin: 'anonymous'
  });

  const katexP = loadScriptOnce(ASSETS.katexJs, {
    integrity: ASSETS.katexJsIntegrity,
    crossOrigin: 'anonymous'
  });

  katexLoadingPromise = Promise.all([cssP, katexP])
    .then(function () {
      return loadScriptOnce(ASSETS.katexAutoRender, {
        integrity: ASSETS.katexAutoRenderIntegrity,
        crossOrigin: 'anonymous'
      });
    })
    .then(function () {
      if (typeof renderMathInElement === 'function') {
        renderMathInElement(overlay, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ],
          throwOnError: false
        });
      }
      katexRendered = true;
    })
    .catch(function (err) {
      console.warn('KaTeX lazy load failed:', err);
      katexLoadingPromise = null;
    });

  return katexLoadingPromise;
}

// ─────────────────────────────────────────────────────────────
// UI init
// ─────────────────────────────────────────────────────────────
function initSliders() {
  SLIDER_DEFS.forEach(function (s) {
    const el = byId(s.id);
    const disp = byId(s.disp);
    if (!el) return;

    const initial = parseFloat(el.value);
    if (!isNaN(initial)) state[s.key] = initial;
    if (disp) disp.textContent = s.fmt(state[s.key]);

    el.addEventListener('input', function () {
      const v = parseFloat(el.value);
      if (isNaN(v)) return;

      state[s.key] = v;
      if (disp) disp.textContent = s.fmt(v);

      updateHUD();
      scheduleDebouncedRun();
    });
  });
}

function scheduleDebouncedRun() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function () {
    runSimulation();
  }, DEBOUNCE_MS);
}

function initCollapsibleSections() {
  document.querySelectorAll('.section-label--clickable').forEach(function (lab) {
    lab.addEventListener('click', function () {
      const section = lab.closest('.input-section--collapsible');
      if (section) section.classList.toggle('collapsed');
    });
  });
}

function initTheoryModalEvents() {
  const overlay = byId('theory-overlay');
  const open  = byId('btn-open-theory');
  const close = byId('btn-close-theory');
  const start = byId('btn-start-sim');

  if (open && overlay) {
    open.addEventListener('click', function () {
      overlay.classList.add('active');
      ensureKatexRendered();
    });
  }

  if (close && overlay) {
    close.addEventListener('click', function () {
      overlay.classList.remove('active');
    });
  }

  if (start && overlay) {
    start.addEventListener('click', function () {
      overlay.classList.remove('active');
    });
  }
}

function initViewSwitcher() {
  const btnCad = byId('toggle-cad');
  const btnPlots = byId('toggle-plots');
  const btnTable = byId('toggle-table');

  const panelCad = document.querySelector('.visualizer-panel');
  const panelPlots = document.querySelector('.chart-panel');
  const panelTable = document.querySelector('.table-panel');

  if (!btnCad || !btnPlots || !btnTable || !panelCad || !panelPlots || !panelTable) return;

  function switchView(v) {
    currentView = v;

    panelCad.classList.toggle('is-hidden', v !== 'cad');
    panelPlots.classList.toggle('is-hidden', v !== 'plots');
    panelTable.classList.toggle('is-hidden', v !== 'table');

    btnCad.classList.toggle('active-view', v === 'cad');
    btnPlots.classList.toggle('active-view', v === 'plots');
    btnTable.classList.toggle('active-view', v === 'table');

    if (v === 'plots') {
      renderPlot();
    } else if (v === 'table') {
      renderTables();
    } else {
      onWindowResize();
    }
  }

  btnCad.addEventListener('click', function () { switchView('cad'); });
  btnPlots.addEventListener('click', function () { switchView('plots'); });
  btnTable.addEventListener('click', function () { switchView('table'); });

  const sel = byId('plot-selector');
  if (sel) {
    sel.addEventListener('change', function () {
      if (currentView === 'plots') renderPlot();
    });
  }
}

function initToolbarEvents() {
  on('btn-play-pause', 'click', function () {
    isPlaying = !isPlaying;
    this.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
  });

  on('btn-restart', 'click', function () {
    animElapsed = 0;
  });

  on('btn-zoom-in', 'click', function () {
    if (!camera || !controls) return;
    camera.position.multiplyScalar(0.85);
    controls.update();
  });

  on('btn-zoom-out', 'click', function () {
    if (!camera || !controls) return;
    camera.position.multiplyScalar(1.15);
    controls.update();
  });

  on('btn-reset-view', 'click', function () {
    if (simCache) frameToTrajectory();
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;

    renderer.render(scene, camera);

    const a = document.createElement('a');
    a.download = 'NavalAI_Anderson.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-export-curve-csv', 'click', exportCSV);
  on('btn-export-full-csv', 'click', exportCSV);
}

function updateHUD() {
  const h0 = byId('hud-U0');
  const hr = byId('hud-rate');

  if (h0) h0.textContent = state.U0.toFixed(2);
  if (hr) hr.textContent = state.max_rudder_rate_deg.toFixed(1) + ' °/s';
}

function setStatus(mode, text) {
  const dot = byId('status-dot');
  const txt = byId('status-text');

  if (dot) dot.className = 'status-dot ' + (mode === 'ready' ? 'ok' : mode);
  if (txt) txt.textContent = text;
}

// ─────────────────────────────────────────────────────────────
// Payload / API / Compression
// ─────────────────────────────────────────────────────────────
function readPayload() {
  const payload = {
    U0: state.U0,
    Tmax: state.Tmax,
    max_rudder_rate_deg: state.max_rudder_rate_deg,
    response_format: 'compact'
  };

  COEF_IDS.forEach(function (id) {
    const el = byId('c-' + id);
    if (!el) return;

    const v = parseFloat(el.value);
    if (!isNaN(v)) payload[id] = v;
  });

  return payload;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }

  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(value[k]);
    }).join(',') + '}';
  }

  return JSON.stringify(value);
}

function hashPayload(payload) {
  return stableStringify(payload);
}

async function runSimulation() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const payload = readPayload();
  const key = hashPayload(payload);
  const seq = ++requestSeq;

  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }

  if (responseCache.has(key)) {
    simCache = responseCache.get(key);
    releaseIdx = findReleaseIndex();

    setStatus('ok', 'READY (cached)');
    updateTelemetry();
    rebuildTrajectory();

    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();

    return;
  }

  const runBtn = byId('btn-run');
  const load = byId('loading-overlay');

  setStatus('loading', 'COMPUTING');

  if (runBtn) {
    runBtn.classList.add('is-loading');
    runBtn.textContent = '◌ Computing…';
  }

  if (load) load.classList.add('active');

  const controller = new AbortController();
  activeFetchController = controller;

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
      body: JSON.stringify(payload)
    });

    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const json = await resp.json();
    if (!json || !json.success) {
      throw new Error(json && json.message ? json.message : 'API failure');
    }

    if (seq !== requestSeq) return;

    simCache = normalizeSimData(json.data);
    releaseIdx = findReleaseIndex();

    if (responseCache.size > 20) {
      responseCache.delete(responseCache.keys().next().value);
    }
    responseCache.set(key, simCache);

    setStatus('ok', 'READY');
    updateTelemetry();
    rebuildTrajectory();

    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();

  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq !== requestSeq) return;

    console.error('NavalAI Anderson simulation error:', err);

    setStatus('err', 'ERROR');

    ['t-tend', 't-cte', 't-cte-L', 't-hdg-err', 't-quality'].forEach(function (id) {
      const el = byId(id);
      if (el) {
        el.textContent = 'ERR';
        el.classList.add('error-state');
      }
    });

  } finally {
    if (seq === requestSeq) {
      if (runBtn) {
        runBtn.classList.remove('is-loading');
        runBtn.textContent = '▶ Run Simulation';
      }

      if (load) load.classList.remove('active');
      activeFetchController = null;
    }
  }
}

function normalizeSimData(data) {
  if (!data || !data.time_series) return data;

  const ts = data.time_series;

  if (ts._format === 'f32-base64-v1') {
    const decodedTimeSeries = {};
    ['t', 'psi_deg', 'r_deg_s'].forEach(function (k) {
      if (ts[k] !== undefined) decodedTimeSeries[k] = decodeFloat32Base64(ts[k]);
    });

    const decodedTrajectory = {};
    if (data.trajectory) {
      ['x', 'y'].forEach(function (k) {
        if (data.trajectory[k] !== undefined) decodedTrajectory[k] = decodeFloat32Base64(data.trajectory[k]);
      });
    }

    const decodedRudder = {};
    if (data.rudder) {
      ['rudder_cmd_deg', 'delta_actual_deg'].forEach(function (k) {
        if (data.rudder[k] !== undefined) decodedRudder[k] = decodeFloat32Base64(data.rudder[k]);
      });
    }

    return Object.assign({}, data, {
      time_series: decodedTimeSeries,
      trajectory: decodedTrajectory,
      rudder: decodedRudder
    });
  }

  return data;
}

function decodeFloat32Base64(b64) {
  if (!b64) return new Float32Array(0);

  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }

  return new Float32Array(bytes.buffer);
}

function findReleaseIndex() {
  if (!simCache) return -1;
  const cmd = simCache.rudder && simCache.rudder.rudder_cmd_deg;
  const t   = simCache.time_series && simCache.time_series.t;

  if (cmd && cmd.length) {
    let active = false;
    for (let i = 0; i < cmd.length; i++) {
      if (!active && Math.abs(cmd[i]) > 0.5) active = true;
      if (active && Math.abs(cmd[i]) < 0.5) return i;
    }
  }

  const tEnd = simCache.metrics && simCache.metrics.t_end;
  if (tEnd != null && t && t.length) {
    for (let i = 0; i < t.length; i++) if (t[i] >= tEnd) return i;
  }

  return Math.floor((t ? t.length : 0) * 0.5);
}

// ─────────────────────────────────────────────────────────────
// TELEMETRY
// ─────────────────────────────────────────────────────────────
function updateTelemetry() {
  if (!simCache) return;
  const m = simCache.metrics || {};
  const t = simCache.time_series ? simCache.time_series.t : [];
  const L = parseFloat(byId('c-L').value) || 160.93;

  function setT(id, val, cls) {
    const el = byId(id);
    if (!el) return;
    el.classList.remove('error-state');
    el.textContent = val;
    if (cls) el.className = 'telemetry-val quality-val ' + cls;
  }

  function fmt(v, unit) {
    return (v === null || v === undefined || isNaN(v)) ? '— ' + unit : v.toFixed(2) + ' ' + unit;
  }

  setT('t-tend',    fmt(m.t_end,                's'));
  setT('t-cte',     fmt(m.cross_track_error_m,  'm'));
  setT('t-hdg-err', fmt(m.heading_error_deg,    '°'));
  setT('t-samples', t.length ? String(t.length) : '—');

  let cteOverL = null;
  if (m.cross_track_error_m != null && L > 0) {
    cteOverL = m.cross_track_error_m / L;
    setT('t-cte-L', cteOverL.toFixed(2) + ' L');
  } else {
    setT('t-cte-L', '—');
  }

  let verdict, cls;
  if (cteOverL === null || isNaN(cteOverL))   { verdict = '—';              cls = ''; }
  else if (cteOverL < EXCELLENT_THRESHOLD)    { verdict = '✓ EXCELLENT';    cls = 'excellent'; }
  else if (cteOverL < ACCEPTABLE_THRESHOLD)   { verdict = '~ ACCEPTABLE';   cls = 'acceptable'; }
  else                                        { verdict = '✗ POOR RECOVERY'; cls = 'poor'; }
  setT('t-quality', verdict, cls);
}

// ─────────────────────────────────────────────────────────────
// PLOTLY
// ─────────────────────────────────────────────────────────────
function subsampleSeries(arrays, maxPoints) {
  if (!arrays || !arrays[0]) return arrays;

  const n = arrays[0].length;
  if (n <= maxPoints) return arrays;

  const step = Math.ceil(n / maxPoints);

  return arrays.map(function (arr) {
    const out = [];

    for (let i = 0; i < n; i += step) out.push(arr[i]);

    if ((n - 1) % step !== 0) out.push(arr[n - 1]);

    return out;
  });
}

function makeBaseLayout() {
  return {
    paper_bgcolor: '#060d18',
    plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 65, r: 30, t: 32, b: 52 },
    xaxis: { gridcolor: '#1e293b', linecolor: '#334155', zerolinecolor: '#475569' },
    yaxis: { gridcolor: '#1e293b', linecolor: '#334155', zerolinecolor: '#475569' },
    legend: {
      font: { size: 10 },
      bgcolor: 'rgba(6,13,24,0.85)',
      bordercolor: '#1e293b',
      borderwidth: 1
    },
    hovermode: 'closest'
  };
}

function renderPlot() {
  const target = byId('plot-target');
  if (!target) return;

  if (typeof Plotly === 'undefined') {
    target.innerHTML = '<div class="data-table-empty">Loading analytical plot engine…</div>';

    ensurePlotly()
      .then(function () {
        if (currentView === 'plots') renderPlot();
      })
      .catch(function (err) {
        console.error(err);
        target.innerHTML = '<div class="data-table-empty">Plot engine failed to load.</div>';
      });

    return;
  }

  const config = { displaylogo: false, responsive: true };
  const layout = makeBaseLayout();

  if (!simCache) {
    Plotly.react(target, [], Object.assign(layout, {
      annotations: [{
        text: 'Awaiting simulation data — click Run Simulation',
        showarrow: false,
        font: { color: '#94a3b8', size: 13 },
        xref: 'paper',
        yref: 'paper',
        x: 0.5,
        y: 0.5
      }]
    }), config);
    return;
  }

  const sel = byId('plot-selector');
  const mode = sel ? sel.value : 'trajectory';

  const tr = simCache.trajectory || { x: [], y: [] };
  const ts = simCache.time_series || { t: [], psi_deg: [], r_deg_s: [] };
  const ru = simCache.rudder || { rudder_cmd_deg: [], delta_actual_deg: [] };

  let traces = [];

  if (mode === 'trajectory') {
    const k = releaseIdx > 0 ? releaseIdx : tr.x.length;

    traces = [
      {
        x: tr.x.slice(0, k + 1), y: tr.y.slice(0, k + 1), mode: 'lines',
        name: 'Phase 1 — hard rudder',
        line: { color: COLOR_P1, width: 2.4 }
      },
      {
        x: tr.x.slice(k), y: tr.y.slice(k), mode: 'lines',
        name: 'Phase 2 — rudder centred',
        line: { color: COLOR_P2, width: 2.4 }
      },
      {
        x: [0], y: [0], mode: 'markers',
        name: 'MOB casualty', marker: { color: COLOR_MOB, size: 12, symbol: 'x', line: { width: 2 } }
      }
    ];

    if (tr.x.length) {
      const xf = tr.x[tr.x.length - 1];
      const yf = tr.y[tr.y.length - 1];

      traces.push({
        x: [xf], y: [yf], mode: 'markers',
        name: 'Final position',
        marker: { color: COLOR_P2, size: 10, symbol: 'circle', line: { color: '#fff', width: 1 } }
      });

      traces.push({
        x: [xf, 0], y: [yf, 0], mode: 'lines',
        name: 'Cross-track error',
        line: { color: COLOR_CTE, width: 1.5, dash: 'dot' }
      });
    }

    layout.title = { text: 'Anderson Turn Trajectory — Recovery to MOB', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 'x [m]';
    layout.yaxis.title = 'y [m]';
    layout.yaxis.scaleanchor = 'x';
  }

  else if (mode === 'rudder') {
    traces = [
      {
        x: ts.t, y: ru.rudder_cmd_deg, mode: 'lines',
        name: 'Commanded δc',
        line: { color: '#94a3b8', width: 1.8, shape: 'hv' }
      },
      {
        x: ts.t, y: ru.delta_actual_deg, mode: 'lines',
        name: 'Actual δ',
        line: { color: COLOR_P1, width: 2.4 }
      }
    ];

    if (simCache.metrics && simCache.metrics.t_end != null) {
      layout.shapes = [{
        type: 'line', x0: simCache.metrics.t_end, x1: simCache.metrics.t_end,
        yref: 'paper', y0: 0, y1: 1,
        line: { color: COLOR_P2, width: 1.5, dash: 'dash' }
      }];

      layout.annotations = [{
        x: simCache.metrics.t_end, xref: 'x', y: 1, yref: 'paper',
        text: 'rudder centred', showarrow: false,
        font: { color: COLOR_P2, size: 10 },
        yanchor: 'bottom', xanchor: 'left'
      }];
    }

    layout.title = { text: 'Rudder — Commanded vs Rate-Limited Actual', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'δ [deg]';
  }

  else if (mode === 'heading') {
    traces = [{
      x: ts.t, y: ts.psi_deg, mode: 'lines',
      name: 'ψ(t)', line: { color: COLOR_P1, width: 2.2 }
    }];

    layout.shapes = [{
      type: 'line', x0: 0, x1: ts.t[ts.t.length - 1] || state.Tmax,
      y0: 250, y1: 250,
      line: { color: COLOR_P2, width: 1.5, dash: 'dash' }
    }];

    layout.annotations = [{
      x: 0, xref: 'x', y: 250, yref: 'y',
      text: ' ψ = 250° (phase change)', showarrow: false,
      font: { color: COLOR_P2, size: 10 },
      xanchor: 'left', yanchor: 'bottom'
    }];

    layout.title = { text: 'Heading ψ(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'ψ [deg]';
  }

  else if (mode === 'yaw') {
    traces = [{
      x: ts.t, y: ts.r_deg_s, mode: 'lines',
      name: 'r(t)', line: { color: COLOR_CTE, width: 2.2 }
    }];

    layout.title = { text: 'Yaw Rate r(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'r [deg/s]';
  }

  Plotly.react(target, traces, layout, config);
}

// ─────────────────────────────────────────────────────────────
// DATA TABLE
// ─────────────────────────────────────────────────────────────
function renderTables() {
  const target = byId('table-target');
  if (!target) return;

  if (!simCache) {
    target.innerHTML = '<div class="data-table-empty">Awaiting simulation data — click Run Simulation.</div>';
    return;
  }

  const t = simCache.time_series.t;
  const psi = simCache.time_series.psi_deg;
  const r = simCache.time_series.r_deg_s;
  const cmd = simCache.rudder.rudder_cmd_deg;
  const act = simCache.rudder.delta_actual_deg;
  const tr = simCache.trajectory;
  const n = t.length;
  const step = Math.max(1, Math.floor(n / 300));

  let rows = '';

  for (let i = 0; i < n; i += step) {
    const phase = (releaseIdx > 0 && i >= releaseIdx) ? 2 : 1;
    rows +=
      '<tr class="phase-' + phase + '"><td>' + t[i].toFixed(2) +
      '</td><td>' + tr.x[i].toFixed(2) +
      '</td><td>' + tr.y[i].toFixed(2) +
      '</td><td>' + psi[i].toFixed(2) +
      '</td><td>' + r[i].toFixed(4) +
      '</td><td>' + cmd[i].toFixed(2) +
      '</td><td>' + act[i].toFixed(2) +
      '</td><td>' + phase +
      '</td></tr>';
  }

  const m = simCache.metrics || {};
  const L = parseFloat(byId('c-L').value) || 160.93;
  const cteOverL = (m.cross_track_error_m != null && L > 0) ? m.cross_track_error_m / L : null;

  let verdict;
  if (cteOverL === null) verdict = '—';
  else if (cteOverL < EXCELLENT_THRESHOLD)  verdict = '✓ Excellent';
  else if (cteOverL < ACCEPTABLE_THRESHOLD) verdict = '~ Acceptable';
  else                                      verdict = '✗ Poor Recovery';

  function fmt(v, unit) {
    return (v === null || v === undefined || isNaN(v)) ? '—' : v.toFixed(3) + ' ' + unit;
  }

  target.innerHTML =
    '<div class="tbl-block" style="margin-bottom:1rem;">' +
      '<div class="tbl-title">Anderson Turn Recovery Summary</div>' +
      '<table class="data-table"><thead><tr><th>Quantity</th><th>Value</th></tr></thead><tbody>' +
        '<tr><td>Phase-change time t_end</td><td>' + fmt(m.t_end, 's') + '</td></tr>' +
        '<tr><td>Cross-track error</td><td>' + fmt(m.cross_track_error_m, 'm') + '</td></tr>' +
        '<tr><td>CTE / Ship length L</td><td>' + (cteOverL == null ? '—' : cteOverL.toFixed(3) + ' L') + '</td></tr>' +
        '<tr><td>Heading error at final t</td><td>' + fmt(m.heading_error_deg, '°') + '</td></tr>' +
        '<tr><td>Verdict</td><td>' + verdict + '</td></tr>' +
        '<tr><td>Samples</td><td>' + n + '</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="tbl-block">' +
      '<div class="tbl-title">Time Series  (' + n + ' samples, displayed every ' + step + ')</div>' +
      '<table class="data-table"><thead><tr>' +
        '<th>t [s]</th><th>x [m]</th><th>y [m]</th><th>ψ [°]</th><th>r [°/s]</th>' +
        '<th>δ_cmd [°]</th><th>δ_act [°]</th><th>Ph</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>';
}

// ─────────────────────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────────────────────
function exportCSV() {
  if (!simCache) {
    console.warn('No data yet — run solver first.');
    return;
  }

  const t = simCache.time_series.t;
  const psi = simCache.time_series.psi_deg;
  const r = simCache.time_series.r_deg_s;
  const cmd = simCache.rudder.rudder_cmd_deg;
  const act = simCache.rudder.delta_actual_deg;
  const tr = simCache.trajectory;
  const m = simCache.metrics || {};

  let csv = 'NavalAI - Anderson Turn (MOB Recovery) Report\n\n';
  csv += 'INPUTS\nU0,' + state.U0 + ',m/s\nmax_rudder_rate_deg,' + state.max_rudder_rate_deg + ',deg/s\nTmax,' + state.Tmax + ',s\n\n';
  csv += 'RECOVERY METRICS\n';
  csv += 't_end_s,' + (m.t_end == null ? '' : m.t_end) + '\n';
  csv += 'cross_track_error_m,' + (m.cross_track_error_m == null ? '' : m.cross_track_error_m) + '\n';
  csv += 'heading_error_deg,' + (m.heading_error_deg == null ? '' : m.heading_error_deg) + '\n\n';
  csv += 'TIME SERIES\nt_s,x_m,y_m,psi_deg,r_dps,delta_cmd_deg,delta_actual_deg,phase\n';

  for (let i = 0; i < t.length; i++) {
    const phase = (releaseIdx > 0 && i >= releaseIdx) ? 2 : 1;
    csv += [
      t[i].toFixed(3),
      tr.x[i].toFixed(4),
      tr.y[i].toFixed(4),
      psi[i].toFixed(4),
      r[i].toFixed(6),
      cmd[i].toFixed(3),
      act[i].toFixed(3),
      phase
    ].join(',') + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'AndersonTurn_Report.csv';

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

// ═════════════════════════════════════════════════════════════
// THREE.JS — SCENE
// ═════════════════════════════════════════════════════════════
function init3D() {
  const container = byId('canvas-3d-target');
  if (!container) {
    console.error('#canvas-3d-target not found');
    return;
  }

  clock = new THREE.Clock();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b253a);

  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.5, 60000);
  camera.position.set(800, 700, 900);

  renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });

  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0x3a4b6e, 0.7));

  const sun = new THREE.DirectionalLight(0xfff5df, 1.3);
  sun.position.set(400, 800, 300);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x4ed0e1, 0.6);
  fill.position.set(-200, -400, -200);
  scene.add(fill);

  waterGeometry = new THREE.PlaneGeometry(30000, 30000, 12, 12);

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d4d62,
    roughness: 0.2,
    metalness: 0.25,
    flatShading: true,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide
  });

  waterPlane = new THREE.Mesh(waterGeometry, waterMat);
  waterPlane.rotation.x = -Math.PI / 2;
  scene.add(waterPlane);

  window.addEventListener('resize', onWindowResize, { passive: true });

  animate();
}

function buildShip(shipL) {
  const grp = new THREE.Group();
  const L = shipL, B = L / 3, H = L / 3.5;

  const hullMat = new THREE.MeshStandardMaterial({ color: 0x1f3346, roughness: 0.45, metalness: 0.5 });
  const accMat  = new THREE.MeshStandardMaterial({ color: 0xe6e3da, roughness: 0.4 });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xc8a84b, roughness: 0.2, metalness: 0.8,
    emissive: 0xc8a84b, emissiveIntensity: 0.25
  });

  const hGeo = new THREE.BoxGeometry(L, H, B, 14, 1, 5);
  const hp = hGeo.attributes.position;

  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i), z = hp.getZ(i);
    const nx = x / (L / 2);
    if (nx > 0.5) hp.setZ(i, z * Math.pow(1 - (nx - 0.5) / 0.5, 1.5));
  }

  hGeo.computeVertexNormals();

  const hull = new THREE.Mesh(hGeo, hullMat);
  hull.position.y = H * 0.1;
  grp.add(hull);

  const trim = new THREE.Mesh(new THREE.BoxGeometry(L * 0.99, H * 0.10, B * 1.02), trimMat);
  trim.position.y = -H * 0.35;
  grp.add(trim);

  const acc = new THREE.Mesh(new THREE.BoxGeometry(L * 0.22, H * 0.9, B * 0.7), accMat);
  acc.position.set(-L * 0.15, H * 0.65, 0);
  grp.add(acc);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(B * 0.18, L * 0.12, 10), trimMat);
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(L * 0.56, H * 0.4, 0);
  grp.add(nose);

  return grp;
}

function buildMobBeacon(size) {
  const grp = new THREE.Group();

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.08, size * 0.08, size * 2.0, 10),
    new THREE.MeshStandardMaterial({ color: 0xefefef, roughness: 0.4 })
  );
  pole.position.y = size * 1.0;
  grp.add(pole);

  const flag = new THREE.Mesh(
    new THREE.BoxGeometry(size * 0.8, size * 0.5, size * 0.06),
    new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.5, roughness: 0.4 })
  );
  flag.position.set(size * 0.5, size * 1.7, 0);
  grp.add(flag);

  const base = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.4, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.7 })
  );
  base.position.y = 0;
  grp.add(base);

  return grp;
}

function frameToTrajectory() {
  if (!simCache || !controls || !camera) return;
  const xs = simCache.trajectory.x;
  const ys = simCache.trajectory.y;
  if (!xs.length) return;

  let xMin = 0, xMax = 0, yMin = 0, yMax = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < xMin) xMin = xs[i]; if (xs[i] > xMax) xMax = xs[i];
    if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i];
  }

  const cx = (xMin + xMax) / 2;
  const cz = (yMin + yMax) / 2;
  const span = Math.max(200, Math.max(xMax - xMin, yMax - yMin)) * 1.3;

  controls.target.set(cx, 0, cz);
  camera.position.set(cx - span * 0.15, span * 0.75, cz + span * 0.95);
  controls.update();
}

function rebuildTrajectory() {
  if (!simCache || !scene || typeof THREE === 'undefined') return;
  const xs = simCache.trajectory.x;
  const ys = simCache.trajectory.y;
  const n = xs.length;
  if (!n) return;

  [trajLineP1, trajLineP2, shipModel, mobBeacon, phaseChangeMarker, finalMarker, cteLine]
    .forEach(disposeThreeObject);

  trajLineP1 = trajLineP2 = shipModel = mobBeacon = phaseChangeMarker = finalMarker = cteLine = null;

  let xMin = 0, xMax = 0, yMin = 0, yMax = 0;
  for (let i = 0; i < n; i++) {
    if (xs[i] < xMin) xMin = xs[i]; if (xs[i] > xMax) xMax = xs[i];
    if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i];
  }

  const span = Math.max(xMax - xMin, yMax - yMin, 200);
  const shipL = Math.max(15, Math.min(span * 0.035, 200));
  const beaconSize = Math.max(15, Math.min(span * 0.025, 60));
  const markerR = Math.max(8, Math.min(span * 0.012, 60));

  const k = (releaseIdx > 0 && releaseIdx < n) ? releaseIdx : n - 1;

  function makeLine(start, end, color) {
    const len = end - start + 1;
    if (len < 2) return null;

    const positions = new Float32Array(len * 3);
    for (let i = 0; i < len; i++) {
      positions[i * 3]     = xs[start + i];
      positions[i * 3 + 1] = 0.6;
      positions[i * 3 + 2] = ys[start + i];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setDrawRange(0, 0);

    const mat = new THREE.LineBasicMaterial({ color: color });
    return { line: new THREE.Line(geom, mat), geom: geom };
  }

  const p1 = makeLine(0, k, 0xc8a84b);
  if (p1) {
    trajLineP1 = p1.line;
    trajGeomP1 = p1.geom;
    scene.add(trajLineP1);
  }

  if (k < n - 1) {
    const p2 = makeLine(k, n - 1, 0x4ed0e1);
    if (p2) {
      trajLineP2 = p2.line;
      trajGeomP2 = p2.geom;
      scene.add(trajLineP2);
    }
  }

  mobBeacon = buildMobBeacon(beaconSize);
  mobBeacon.position.set(0, 0, 0);
  scene.add(mobBeacon);

  if (k > 0 && k < n) {
    phaseChangeMarker = new THREE.Mesh(
      new THREE.SphereGeometry(markerR, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xc8a84b, emissive: 0xc8a84b, emissiveIntensity: 0.7 })
    );
    phaseChangeMarker.position.set(xs[k], 1, ys[k]);
    scene.add(phaseChangeMarker);
  }

  finalMarker = new THREE.Mesh(
    new THREE.SphereGeometry(markerR, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x4ed0e1, emissive: 0x4ed0e1, emissiveIntensity: 0.6 })
  );
  finalMarker.position.set(xs[n - 1], 1, ys[n - 1]);
  scene.add(finalMarker);

  const ctePos = new Float32Array([xs[n - 1], 1.2, ys[n - 1],  0, 1.2, 0]);
  const cteGeom = new THREE.BufferGeometry();
  cteGeom.setAttribute('position', new THREE.BufferAttribute(ctePos, 3));

  const cteMat = new THREE.LineDashedMaterial({
    color: 0xfb7185, dashSize: shipL * 0.4, gapSize: shipL * 0.25, linewidth: 1.5
  });

  cteLine = new THREE.Line(cteGeom, cteMat);
  cteLine.computeLineDistances();
  scene.add(cteLine);

  shipModel = buildShip(shipL);
  scene.add(shipModel);

  frameToTrajectory();
  animElapsed = 0;
}

function disposeThreeObject(obj) {
  if (!obj) return;

  obj.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();

    if (o.material) {
      if (Array.isArray(o.material)) {
        o.material.forEach(function (m) {
          if (m && m.dispose) m.dispose();
        });
      } else if (o.material.dispose) {
        o.material.dispose();
      }
    }
  });
}

function animate() {
  requestAnimationFrame(animate);

  if (!clock) return;

  const dt = Math.min(clock.getDelta(), 0.1);

  if (document.hidden || currentView !== 'cad') return;

  if (controls) controls.update();

  const t = clock.getElapsedTime();

  if (waterGeometry && (t - lastWaterUpdate) > 0.08) {
    const p = waterGeometry.attributes.position;

    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i);
      const v = p.getY(i);

      const z =
          Math.sin(u * 0.005 + t * 1.4) * 4.0
        + Math.cos(v * 0.004 + t * 1.1) * 3.0
        + Math.sin((u + v) * 0.008 + t * 1.9) * 1.2;

      p.setZ(i, z);
    }

    waterGeometry.attributes.position.needsUpdate = true;
    lastWaterUpdate = t;
  }

  frameDelta += dt;

  if (frameDelta >= FRAME_INTERVAL) {
    if (simCache && shipModel) {
      if (isPlaying) animElapsed = (animElapsed + frameDelta) % ANIM_DURATION;

      const xs = simCache.trajectory.x;
      const ys = simCache.trajectory.y;
      const psis = simCache.time_series.psi_deg;
      const tArr = simCache.time_series.t;
      const n = xs.length;

      const phase = animElapsed / ANIM_DURATION;
      const fIdx = phase * (n - 1);
      const i0 = Math.floor(fIdx);
      const i1 = Math.min(n - 1, i0 + 1);
      const frac = fIdx - i0;

      const x = xs[i0] * (1 - frac) + xs[i1] * frac;
      const y = ys[i0] * (1 - frac) + ys[i1] * frac;

      let p0 = psis[i0], p1 = psis[i1], dp = p1 - p0;
      if (dp >  180) dp -= 360;
      if (dp < -180) dp += 360;
      const psiDeg = p0 + dp * frac;

      shipModel.position.set(x, Math.sin(t * 1.6) * 0.6, y);
      shipModel.rotation.y = -psiDeg * Math.PI / 180;

      const k = (releaseIdx > 0 && releaseIdx < n) ? releaseIdx : n - 1;
      if (trajGeomP1) {
        const idxInP1 = Math.min(i0, k);
        trajGeomP1.setDrawRange(0, idxInP1 + 1);
      }
      if (trajGeomP2) {
        if (i0 > k) trajGeomP2.setDrawRange(0, i0 - k + 1);
        else trajGeomP2.setDrawRange(0, 0);
      }

      const animHud  = byId('hud-anim');
      const phaseHud = byId('hud-phase');

      if (animHud) animHud.textContent = animElapsed.toFixed(2) + ' s';

      if (phaseHud) {
        const realT = tArr[i0];
        const tEnd  = simCache.metrics && simCache.metrics.t_end;
        phaseHud.textContent = (tEnd != null && realT >= tEnd) ? 'PHASE 2 — CENTRED' : 'PHASE 1 — HARD RUDDER';
      }

      if (mobBeacon) mobBeacon.position.y = Math.sin(t * 2.2) * 0.8;
    }

    frameDelta = frameDelta % FRAME_INTERVAL;
  }

  if (renderer && scene && camera) renderer.render(scene, camera);
}

function onWindowResize() {
  const c = byId('canvas-3d-target');
  if (!c || !renderer || !camera) return;
  if (!c.clientWidth || !c.clientHeight) return;

  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(c.clientWidth, c.clientHeight);
}