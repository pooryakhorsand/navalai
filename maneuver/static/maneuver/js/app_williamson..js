/**
 * app_williamson.js
 * NavalAI — Williamson Turn (MOB Recovery)
 *
 * Optimized for:
 * - lazy Plotly loading
 * - lazy KaTeX loading
 * - compact API response decoding
 * - request aborting / frontend cache
 * - low CPU 3D animation
 * - fallback to legacy payload if backend doesn't yet accept compact hints
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.williamsonApi || '/api/v1/maneuvering/williamson/';

const ANIM_DURATION = 5.0;
const DEBOUNCE_MS = 350;
const MAX_PLOT_POINTS = 1500;
const MAX_RETURN_POINTS = 9000;
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;

const EXCELLENT_THRESHOLD = 1.0;
const ACCEPTABLE_THRESHOLD = 3.0;

const COLOR_P1  = '#c8a84b';
const COLOR_P2  = '#fb7185';
const COLOR_P3  = '#4ed0e1';
const COLOR_MOB = '#ef4444';
const COLOR_CTE = '#fb7185';

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

let state = {
  U0: 7.7175,
  max_rudder_rate_deg: 5.0,
  Tmax: 1200
};

let simCache = null;
let responseCache = new Map();

let phaseIdx1 = -1;
let phaseIdx2 = -1;

let currentView = 'cad';
let isPlaying = true;

let scene, camera, renderer, controls;
let clock = null;

let waterPlane, waterGeometry;
let shipModel;
let mobBeacon;
let phaseMarker1, phaseMarker2, finalMarker, cteLine;
let trajLineP1, trajLineP2, trajLineP3;
let trajGeomP1, trajGeomP2, trajGeomP3;

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

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  initSliders();
  initCoefficientChangeEvents();
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

  const runBtn = byId('btn-run');
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

function initCoefficientChangeEvents() {
  COEF_IDS.forEach(function (id) {
    const el = byId('c-' + id);
    if (!el) return;

    el.addEventListener('change', function () {
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
    if (simCache) frameToTrajectory(simCache.time_series);
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;

    renderer.render(scene, camera);

    const a = document.createElement('a');
    a.download = 'NavalAI_Williamson.png';
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
// Payload / API
// ─────────────────────────────────────────────────────────────
function readPayload(opts) {
  opts = opts || {};

  const payload = {
    U0: state.U0,
    Tmax: state.Tmax,
    max_rudder_rate_deg: state.max_rudder_rate_deg
  };

  COEF_IDS.forEach(function (id) {
    const el = byId('c-' + id);
    if (!el) return;

    const v = parseFloat(el.value);
    if (!isNaN(v)) payload[id] = v;
  });

  if (opts.compact) {
    const h = Number(payload.h || 0.1);
    const estimatedSamples = Math.max(
      1,
      Math.round((payload.Tmax || state.Tmax) / Math.max(h, 1e-9)) + 1
    );

    payload.response_format = 'compact';
    payload.output_stride = Math.max(1, Math.ceil(estimatedSamples / MAX_RETURN_POINTS));
  }

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

async function fetchSimulation(payload, signal) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal: signal,
    body: JSON.stringify(payload)
  });

  let json = null;
  try {
    json = await resp.json();
  } catch (_) {
    json = null;
  }

  if (!resp.ok) {
    const err = new Error(
      (json && (json.message || json.detail)) || ('HTTP ' + resp.status)
    );
    err.status = resp.status;
    err.responseJson = json;
    throw err;
  }

  if (!json || !json.success) {
    const err = new Error(json && (json.message || json.detail) ? (json.message || json.detail) : 'API failure');
    err.status = resp.status;
    err.responseJson = json;
    throw err;
  }

  return json;
}

async function runSimulation() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const cachePayload = readPayload({ compact: false });
  const key = hashPayload(cachePayload);
  const seq = ++requestSeq;

  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }

  if (responseCache.has(key)) {
    simCache = responseCache.get(key);
    [phaseIdx1, phaseIdx2] = findPhaseIndices();

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
    let json;
    const compactPayload = readPayload({ compact: true });

    try {
      json = await fetchSimulation(compactPayload, controller.signal);
    } catch (err) {
      if (err && err.name === 'AbortError') return;

      const shouldRetryLegacy =
        compactPayload.response_format === 'compact' &&
        (err.status === 400 || err.status === 415 || err.status === 422);

      if (!shouldRetryLegacy) throw err;

      console.warn('Compact Williamson payload not accepted, retrying legacy payload...', err);
      json = await fetchSimulation(cachePayload, controller.signal);
    }

    if (seq !== requestSeq) return;

    const normalized = normalizeSimData(json.data);

    simCache = normalized;
    [phaseIdx1, phaseIdx2] = findPhaseIndices();

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

    console.error('NavalAI Williamson simulation error:', err);

    setStatus('err', 'ERROR');

    [
      't-t1',
      't-t2',
      't-topp',
      't-cte',
      't-cte-L',
      't-hdg-err',
      't-quality',
      't-samples',
      't-duration',
      't-maxyaw'
    ].forEach(function (id) {
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
    const decoded = {};

    Object.keys(ts).forEach(function (k) {
      if (k === '_format') return;

      const v = ts[k];
      if (typeof v === 'string') decoded[k] = decodeFloat32Base64(v);
      else decoded[k] = v;
    });

    return Object.assign({}, data, {
      time_series: decoded
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

// ─────────────────────────────────────────────────────────────
// Maneuver utilities
// ─────────────────────────────────────────────────────────────
function findPhaseIndices() {
  if (!simCache) return [-1, -1];

  const ts = simCache.time_series || {};
  const t = ts.t_series;
  const cmd = ts.rudder_cmd_deg;
  const info = simCache.maneuver_info || {};

  if (!t || !t.length) return [-1, -1];

  function timeToIdx(target) {
    if (target == null || isNaN(target)) return -1;

    for (let i = 0; i < t.length; i++) {
      if (t[i] >= target) return i;
    }

    return t.length - 1;
  }

  let idx1 = timeToIdx(info.t1_60deg);
  let idx2 = timeToIdx(info.t2_minus130deg);

  if ((idx1 < 0 || idx2 < 0) && cmd && cmd.length) {
    if (idx1 < 0) {
      for (let i = 1; i < cmd.length; i++) {
        if (cmd[i - 1] > 0.5 && cmd[i] < -0.5) {
          idx1 = i;
          break;
        }
      }
    }

    if (idx2 < 0) {
      const startScan = idx1 > 0 ? idx1 : 0;

      for (let i = startScan + 1; i < cmd.length; i++) {
        if (cmd[i - 1] < -0.5 && Math.abs(cmd[i]) < 0.5) {
          idx2 = i;
          break;
        }
      }
    }
  }

  return [idx1, idx2];
}

function getPhaseBoundaries(n) {
  const k1 = (phaseIdx1 > 0 && phaseIdx1 < n) ? phaseIdx1 : Math.floor(n / 3);
  const k2 = (phaseIdx2 > k1 && phaseIdx2 < n) ? phaseIdx2 : Math.floor(n * 2 / 3);
  return [k1, k2];
}

function phaseOfIndex(i) {
  if (phaseIdx2 > 0 && i >= phaseIdx2) return 3;
  if (phaseIdx1 > 0 && i >= phaseIdx1) return 2;
  return 1;
}

function findIndexAtTime(tArr, target) {
  if (!tArr || !tArr.length) return -1;

  for (let i = 0; i < tArr.length; i++) {
    if (tArr[i] >= target) return i;
  }

  return tArr.length - 1;
}

function getRecoveryVerdict(cteOverL) {
  if (cteOverL == null || isNaN(cteOverL)) {
    return { text: '—', cls: '' };
  }

  if (cteOverL < EXCELLENT_THRESHOLD) {
    return { text: '✓ EXCELLENT', cls: 'excellent' };
  }

  if (cteOverL < ACCEPTABLE_THRESHOLD) {
    return { text: '~ ACCEPTABLE', cls: 'acceptable' };
  }

  return { text: '✗ POOR RECOVERY', cls: 'poor' };
}

// ─────────────────────────────────────────────────────────────
// Telemetry
// ─────────────────────────────────────────────────────────────
function updateTelemetry() {
  if (!simCache) return;

  const m = simCache.metrics || {};
  const info = simCache.maneuver_info || {};
  const ts = simCache.time_series || {};
  const meta = simCache.series_meta || {};
  const L = parseFloat((byId('c-L') && byId('c-L').value) || '160.93') || 160.93;

  function setT(id, val, qualityCls) {
    const el = byId(id);
    if (!el) return;

    el.classList.remove('error-state', 'quality-val', 'excellent', 'acceptable', 'poor');
    el.textContent = val;

    if (qualityCls) {
      el.classList.add('quality-val', qualityCls);
    }
  }

  function fmt(v, unit, digits) {
    digits = (digits == null ? 2 : digits);
    return (v === null || v === undefined || isNaN(v))
      ? '— ' + unit
      : Number(v).toFixed(digits) + ' ' + unit;
  }

  const returnedSamples = ts.t_series ? ts.t_series.length : 0;
  const solverSamples = meta.sample_count_solver || returnedSamples;

  setT('t-t1', fmt(info.t1_60deg, 's'));
  setT('t-t2', fmt(info.t2_minus130deg, 's'));
  setT('t-topp', fmt(info.t_opp_heading, 's'));
  setT('t-cte', fmt(m.cross_track_error_m, 'm'));
  setT('t-hdg-err', fmt(m.heading_error_deg, '°'));
  setT('t-maxyaw', fmt(m.max_yaw_deg, '°'));

  if (solverSamples && solverSamples !== returnedSamples) {
    setT('t-samples', returnedSamples + ' / ' + solverSamples);
  } else {
    setT('t-samples', returnedSamples ? String(returnedSamples) : '—');
  }

  setT(
    't-duration',
    ts.t_series && ts.t_series.length
      ? Number(ts.t_series[ts.t_series.length - 1]).toFixed(0) + ' s'
      : '— s'
  );

  let cteOverL = null;
  if (m.cross_track_error_m != null && !isNaN(m.cross_track_error_m) && L > 0) {
    cteOverL = m.cross_track_error_m / L;
    setT('t-cte-L', cteOverL.toFixed(2) + ' L');
  } else {
    setT('t-cte-L', '—');
  }

  const verdict = getRecoveryVerdict(cteOverL);
  setT('t-quality', verdict.text, verdict.cls);
}

// ─────────────────────────────────────────────────────────────
// Plotly
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

function subsampleSegmentPair(xArr, yArr, start, endInclusive, maxPoints) {
  if (!xArr || !yArr || start > endInclusive) return [[], []];

  const len = endInclusive - start + 1;
  const step = Math.max(1, Math.ceil(len / maxPoints));

  const xs = [];
  const ys = [];

  for (let i = start; i <= endInclusive; i += step) {
    xs.push(xArr[i]);
    ys.push(yArr[i]);
  }

  if (xs.length === 0 || xs[xs.length - 1] !== xArr[endInclusive] || ys[ys.length - 1] !== yArr[endInclusive]) {
    xs.push(xArr[endInclusive]);
    ys.push(yArr[endInclusive]);
  }

  return [xs, ys];
}

function makeBaseLayout() {
  return {
    paper_bgcolor: '#060d18',
    plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 65, r: 30, t: 30, b: 52 },
    xaxis: { gridcolor: '#1e293b', linecolor: '#334155', zerolinecolor: '#475569' },
    yaxis: { gridcolor: '#1e293b', linecolor: '#334155', zerolinecolor: '#475569' },
    legend: {
      font: { size: 10 },
      bgcolor: 'rgba(6,13,24,0.85)',
      bordercolor: '#1e293b',
      borderwidth: 1
    },
    hovermode: 'closest',
    shapes: [],
    annotations: []
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

  const ts = simCache.time_series || {};
  const info = simCache.maneuver_info || {};
  const sel = byId('plot-selector');
  const mode = sel ? sel.value : 'trajectory';

  const t = ts.t_series || [];
  const x = ts.x_series || [];
  const y = ts.y_series || [];
  const psi = ts.psi_series || [];
  const r = ts.r_series || [];
  const U = ts.U_series || [];
  const u = ts.u_series || [];
  const v = ts.v_series || [];
  const deltaCmd = ts.rudder_cmd_deg || [];
  const deltaAct = ts.delta_actual_deg || [];

  let traces = [];

  if (mode === 'trajectory') {
    const n = x.length;
    const bounds = getPhaseBoundaries(n);
    const k1 = bounds[0];
    const k2 = bounds[1];

    const p1 = subsampleSegmentPair(x, y, 0, Math.max(0, k1), Math.max(100, Math.floor(MAX_PLOT_POINTS / 3)));
    const p2 = subsampleSegmentPair(x, y, Math.max(0, k1), Math.max(k1, k2), Math.max(100, Math.floor(MAX_PLOT_POINTS / 3)));
    const p3 = subsampleSegmentPair(x, y, Math.max(0, k2), Math.max(k2, n - 1), Math.max(100, Math.floor(MAX_PLOT_POINTS / 3)));

    traces = [{
      x: p1[0],
      y: p1[1],
      mode: 'lines',
      type: 'scatter',
      name: 'Phase 1 — hard rudder',
      line: { color: COLOR_P1, width: 2.5 }
    }, {
      x: p2[0],
      y: p2[1],
      mode: 'lines',
      type: 'scatter',
      name: 'Phase 2 — counter rudder',
      line: { color: COLOR_P2, width: 2.5 }
    }, {
      x: p3[0],
      y: p3[1],
      mode: 'lines',
      type: 'scatter',
      name: 'Phase 3 — centred / retrace',
      line: { color: COLOR_P3, width: 2.5 }
    }, {
      x: [0],
      y: [0],
      mode: 'markers',
      type: 'scatter',
      name: 'MOB casualty',
      marker: { color: COLOR_MOB, size: 11, symbol: 'x', line: { width: 2 } }
    }];

    if (k1 > 0 && k1 < n) {
      traces.push({
        x: [x[k1]],
        y: [y[k1]],
        mode: 'markers',
        type: 'scatter',
        name: 'P1 → P2',
        marker: { color: COLOR_P2, size: 9, symbol: 'circle' }
      });
    }

    if (k2 > 0 && k2 < n) {
      traces.push({
        x: [x[k2]],
        y: [y[k2]],
        mode: 'markers',
        type: 'scatter',
        name: 'P2 → P3',
        marker: { color: COLOR_P3, size: 9, symbol: 'circle' }
      });
    }

    if (n) {
      const xf = x[n - 1];
      const yf = y[n - 1];

      traces.push({
        x: [xf],
        y: [yf],
        mode: 'markers',
        type: 'scatter',
        name: 'Final position',
        marker: { color: COLOR_P3, size: 10, symbol: 'circle', line: { color: '#ffffff', width: 1 } }
      });

      traces.push({
        x: [xf, 0],
        y: [yf, 0],
        mode: 'lines',
        type: 'scatter',
        name: 'Cross-track error',
        line: { color: COLOR_CTE, width: 1.6, dash: 'dot' }
      });
    }

    layout.title = { text: 'Williamson Turn Trajectory — Track Retracing Recovery', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 'x [m]';
    layout.yaxis.title = 'y [m]';
    layout.yaxis.scaleanchor = 'x';
  }

  else if (mode === 'rudder') {
    const sampled = subsampleSeries([t, deltaCmd, deltaAct], MAX_PLOT_POINTS);

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      type: 'scatter',
      name: 'Commanded δc',
      line: { color: '#94a3b8', width: 1.8, shape: 'hv' }
    }, {
      x: sampled[0],
      y: sampled[2],
      mode: 'lines',
      type: 'scatter',
      name: 'Actual δ',
      line: { color: COLOR_P1, width: 2.4 }
    }];

    if (info.t1_60deg != null) {
      layout.shapes.push({
        type: 'line',
        x0: info.t1_60deg,
        x1: info.t1_60deg,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color: COLOR_P2, width: 1.5, dash: 'dash' }
      });

      layout.annotations.push({
        x: info.t1_60deg,
        xref: 'x',
        y: 1,
        yref: 'paper',
        text: 'ψ = +60°',
        showarrow: false,
        font: { color: COLOR_P2, size: 10 },
        yanchor: 'bottom',
        xanchor: 'left'
      });
    }

    if (info.t2_minus130deg != null) {
      layout.shapes.push({
        type: 'line',
        x0: info.t2_minus130deg,
        x1: info.t2_minus130deg,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color: COLOR_P3, width: 1.5, dash: 'dash' }
      });

      layout.annotations.push({
        x: info.t2_minus130deg,
        xref: 'x',
        y: 1,
        yref: 'paper',
        text: 'ψ = −130°',
        showarrow: false,
        font: { color: COLOR_P3, size: 10 },
        yanchor: 'bottom',
        xanchor: 'left'
      });
    }

    layout.title = { text: 'Rudder — Commanded vs Rate-Limited Actual', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'δ [deg]';
  }

  else if (mode === 'heading') {
    const sampled = subsampleSeries([t, psi], MAX_PLOT_POINTS);
    const tMax = t.length ? t[t.length - 1] : state.Tmax;

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      type: 'scatter',
      name: 'ψ',
      line: { color: COLOR_P1, width: 2.2 }
    }];

    layout.shapes.push(
      {
        type: 'line',
        x0: 0, x1: tMax, y0: 60, y1: 60,
        line: { color: COLOR_P2, width: 1.4, dash: 'dash' }
      },
      {
        type: 'line',
        x0: 0, x1: tMax, y0: -130, y1: -130,
        line: { color: COLOR_P3, width: 1.4, dash: 'dash' }
      },
      {
        type: 'line',
        x0: 0, x1: tMax, y0: 180, y1: 180,
        line: { color: '#22c55e', width: 1.4, dash: 'dash' }
      }
    );

    layout.annotations.push(
      {
        x: 0, xref: 'x', y: 60, yref: 'y',
        text: 'ψ = +60°',
        showarrow: false,
        font: { color: COLOR_P2, size: 10 },
        xanchor: 'left',
        yanchor: 'bottom'
      },
      {
        x: 0, xref: 'x', y: -130, yref: 'y',
        text: 'ψ = −130°',
        showarrow: false,
        font: { color: COLOR_P3, size: 10 },
        xanchor: 'left',
        yanchor: 'bottom'
      },
      {
        x: 0, xref: 'x', y: 180, yref: 'y',
        text: 'ψ = +180° target',
        showarrow: false,
        font: { color: '#22c55e', size: 10 },
        xanchor: 'left',
        yanchor: 'bottom'
      }
    );

    layout.title = { text: 'Heading ψ(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'ψ [deg]';
  }

  else if (mode === 'yaw') {
    const sampled = subsampleSeries([t, r], MAX_PLOT_POINTS);

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      type: 'scatter',
      name: 'r',
      line: { color: COLOR_CTE, width: 2.2 }
    }];

    layout.title = { text: 'Yaw Rate r(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'r [deg/s]';
  }

  else if (mode === 'speed') {
    const sampled = subsampleSeries([t, U], MAX_PLOT_POINTS);

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      type: 'scatter',
      name: 'U',
      line: { color: '#22c55e', width: 2.2 }
    }];

    layout.title = { text: 'Ship Speed U(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'U [m/s]';
  }

  else if (mode === 'surge') {
    const sampled = subsampleSeries([t, u], MAX_PLOT_POINTS);

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      type: 'scatter',
      name: 'u',
      line: { color: '#38bdf8', width: 2.2 }
    }];

    layout.title = { text: 'Surge Velocity u(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'u [m/s]';
  }

  else if (mode === 'sway') {
    const sampled = subsampleSeries([t, v], MAX_PLOT_POINTS);

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      type: 'scatter',
      name: 'v',
      line: { color: '#a78bfa', width: 2.2 }
    }];

    layout.title = { text: 'Sway Velocity v(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'v [m/s]';
  }

  else {
    const sampled = subsampleSeries([t, psi], MAX_PLOT_POINTS);

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      type: 'scatter',
      name: 'ψ',
      line: { color: COLOR_P1, width: 2.2 }
    }];

    layout.title = { text: 'Heading ψ(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'ψ [deg]';
  }

  Plotly.react(target, traces, layout, config);
}

// ─────────────────────────────────────────────────────────────
// Tables / CSV
// ─────────────────────────────────────────────────────────────
function renderTables() {
  const target = byId('table-target');
  if (!target) return;

  if (!simCache) {
    target.innerHTML = '<div class="data-table-empty">Awaiting simulation data — click Run Simulation.</div>';
    return;
  }

  const ts = simCache.time_series || {};
  const info = simCache.maneuver_info || {};
  const m = simCache.metrics || {};
  const meta = simCache.series_meta || {};

  const t = ts.t_series || [];
  const x = ts.x_series || [];
  const y = ts.y_series || [];
  const psi = ts.psi_series || [];
  const r = ts.r_series || [];
  const U = ts.U_series || [];
  const deltaCmd = ts.rudder_cmd_deg || [];
  const deltaAct = ts.delta_actual_deg || [];

  const n = t.length;
  const step = Math.max(1, Math.floor(n / 300));

  const L = parseFloat((byId('c-L') && byId('c-L').value) || '160.93') || 160.93;
  const cteOverL = (m.cross_track_error_m != null && !isNaN(m.cross_track_error_m) && L > 0)
    ? (m.cross_track_error_m / L)
    : null;
  const verdict = getRecoveryVerdict(cteOverL);

  function fmt(v, unit, digits) {
    digits = (digits == null ? 3 : digits);
    return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(digits) + ' ' + unit;
  }

  function cell(arr, i, digits) {
    const v = arr && arr.length > i ? arr[i] : null;
    return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(digits);
  }

  let rows = '';

  for (let i = 0; i < n; i += step) {
    const ph = phaseOfIndex(i);

    rows +=
      '<tr class="phase-' + ph + '">' +
        '<td>' + cell(t, i, 2) + '</td>' +
        '<td>' + cell(x, i, 2) + '</td>' +
        '<td>' + cell(y, i, 2) + '</td>' +
        '<td>' + cell(U, i, 3) + '</td>' +
        '<td>' + cell(psi, i, 2) + '</td>' +
        '<td>' + cell(r, i, 4) + '</td>' +
        '<td>' + cell(deltaCmd, i, 2) + '</td>' +
        '<td>' + cell(deltaAct, i, 2) + '</td>' +
        '<td>' + ph + '</td>' +
      '</tr>';
  }

  const sampleText = meta.sample_count_solver && meta.sample_count_solver !== n
    ? n + ' returned / ' + meta.sample_count_solver + ' solver samples'
    : n + ' samples';

  target.innerHTML =
    '<div class="tbl-block" style="margin-bottom:1rem;">' +
      '<div class="tbl-title">Williamson Turn Recovery Summary</div>' +
      '<table class="data-table">' +
        '<thead><tr><th>Quantity</th><th>Value</th></tr></thead>' +
        '<tbody>' +
          '<tr><td>t₁ (end of Phase 1, ψ = +60°)</td><td>' + fmt(info.t1_60deg, 's', 3) + '</td></tr>' +
          '<tr><td>t₂ (end of Phase 2, ψ = −130°)</td><td>' + fmt(info.t2_minus130deg, 's', 3) + '</td></tr>' +
          '<tr><td>t_opp (ψ ≈ 180°)</td><td>' + fmt(info.t_opp_heading, 's', 3) + '</td></tr>' +
          '<tr><td>Cross-track error</td><td>' + fmt(m.cross_track_error_m, 'm', 3) + '</td></tr>' +
          '<tr><td>CTE / L</td><td>' + (cteOverL == null ? '—' : cteOverL.toFixed(3) + ' L') + '</td></tr>' +
          '<tr><td>Heading error at recovery</td><td>' + fmt(m.heading_error_deg, '°', 3) + '</td></tr>' +
          '<tr><td>Max |ψ| reached</td><td>' + fmt(m.max_yaw_deg, '°', 3) + '</td></tr>' +
          '<tr><td>Verdict</td><td>' + verdict.text + '</td></tr>' +
          '<tr><td>Samples</td><td>' + sampleText + '</td></tr>' +
        '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="tbl-block">' +
      '<div class="tbl-title">Time Series (' + sampleText + ', displayed every ' + step + ')</div>' +
      '<table class="data-table">' +
        '<thead><tr>' +
          '<th>t [s]</th><th>x [m]</th><th>y [m]</th><th>U [m/s]</th><th>ψ [°]</th><th>r [°/s]</th><th>δ_cmd [°]</th><th>δ_act [°]</th><th>Ph</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
}

function exportCSV() {
  if (!simCache) {
    console.warn('No data yet — run solver first.');
    return;
  }

  const ts = simCache.time_series || {};
  const info = simCache.maneuver_info || {};
  const m = simCache.metrics || {};
  const meta = simCache.series_meta || {};

  const t = ts.t_series || [];
  const x = ts.x_series || [];
  const y = ts.y_series || [];
  const U = ts.U_series || [];
  const u = ts.u_series || [];
  const v = ts.v_series || [];
  const psi = ts.psi_series || [];
  const r = ts.r_series || [];
  const deltaCmd = ts.rudder_cmd_deg || [];
  const deltaAct = ts.delta_actual_deg || [];

  let csv = 'NavalAI - Williamson Turn (MOB Recovery) Report\n\n';

  csv += 'INPUTS\n';
  csv += 'U0,' + state.U0 + ',m/s\n';
  csv += 'max_rudder_rate_deg,' + state.max_rudder_rate_deg + ',deg/s\n';
  csv += 'Tmax,' + state.Tmax + ',s\n\n';

  csv += 'SERIES META\n';
  csv += 'Returned samples,' + t.length + '\n';
  csv += 'Solver samples,' + (meta.sample_count_solver || t.length) + '\n';
  csv += 'Output stride,' + (meta.output_stride || 1) + '\n\n';

  csv += 'PHASE TIMING\n';
  csv += 't1_60deg_s,' + (info.t1_60deg == null ? '' : info.t1_60deg) + '\n';
  csv += 't2_minus130deg_s,' + (info.t2_minus130deg == null ? '' : info.t2_minus130deg) + '\n';
  csv += 't_opp_heading_s,' + (info.t_opp_heading == null ? '' : info.t_opp_heading) + '\n\n';

  csv += 'RECOVERY METRICS\n';
  csv += 'cross_track_error_m,' + (m.cross_track_error_m == null ? '' : m.cross_track_error_m) + '\n';
  csv += 'heading_error_deg,' + (m.heading_error_deg == null ? '' : m.heading_error_deg) + '\n';
  csv += 'max_yaw_deg,' + (m.max_yaw_deg == null ? '' : m.max_yaw_deg) + '\n\n';

  csv += 'TIME SERIES\nt_s,x_m,y_m,U_mps,u_mps,v_mps,psi_deg,r_degps,delta_cmd_deg,delta_actual_deg,phase\n';

  for (let i = 0; i < t.length; i++) {
    csv += [
      Number(t[i] == null ? 0 : t[i]).toFixed(3),
      Number(x[i] == null ? 0 : x[i]).toFixed(4),
      Number(y[i] == null ? 0 : y[i]).toFixed(4),
      Number(U[i] == null ? 0 : U[i]).toFixed(5),
      Number(u[i] == null ? 0 : u[i]).toFixed(6),
      Number(v[i] == null ? 0 : v[i]).toFixed(6),
      Number(psi[i] == null ? 0 : psi[i]).toFixed(4),
      Number(r[i] == null ? 0 : r[i]).toFixed(6),
      Number(deltaCmd[i] == null ? 0 : deltaCmd[i]).toFixed(4),
      Number(deltaAct[i] == null ? 0 : deltaAct[i]).toFixed(4),
      phaseOfIndex(i)
    ].join(',') + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'WilliamsonTurn_Report.csv';

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

// ═════════════════════════════════════════════════════════════
// THREE.JS SCENE
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

  camera = new THREE.PerspectiveCamera(
    45,
    Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
    0.5,
    60000
  );
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

  const sun = new THREE.DirectionalLight(0xfff5df, 1.25);
  sun.position.set(400, 800, 300);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x4ed0e1, 0.45);
  fill.position.set(-200, -400, -200);
  scene.add(fill);

  waterGeometry = new THREE.PlaneGeometry(30000, 30000, 12, 12);

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d4d62,
    roughness: 0.2,
    metalness: 0.25,
    flatShading: true,
    transparent: true,
    opacity: 0.58,
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

  const L = shipL;
  const B = L / 3;
  const H = L / 3.5;

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x1f3346,
    roughness: 0.45,
    metalness: 0.5
  });

  const accMat = new THREE.MeshStandardMaterial({
    color: 0xe6e3da,
    roughness: 0.4
  });

  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xc8a84b,
    roughness: 0.25,
    metalness: 0.7
  });

  const hGeo = new THREE.BoxGeometry(L, H, B, 14, 1, 5);
  const hp = hGeo.attributes.position;

  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i);
    const z = hp.getZ(i);
    const nx = x / (L / 2);

    if (nx > 0.5) {
      hp.setZ(i, z * Math.pow(1 - (nx - 0.5) / 0.5, 1.5));
    }
  }

  hGeo.computeVertexNormals();

  const hull = new THREE.Mesh(hGeo, hullMat);
  hull.position.y = H * 0.1;
  grp.add(hull);

  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.99, H * 0.10, B * 1.02),
    trimMat
  );
  trim.position.y = -H * 0.35;
  grp.add(trim);

  const acc = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.22, H * 0.9, B * 0.7),
    accMat
  );
  acc.position.set(-L * 0.15, H * 0.65, 0);
  grp.add(acc);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(B * 0.18, L * 0.12, 10),
    trimMat
  );
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
    new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xef4444,
      emissiveIntensity: 0.5,
      roughness: 0.4
    })
  );
  flag.position.set(size * 0.5, size * 1.7, 0);
  grp.add(flag);

  const base = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.4, 12, 10),
    new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xef4444,
      emissiveIntensity: 0.7
    })
  );
  base.position.y = 0;
  grp.add(base);

  return grp;
}

function disposeThreeObject(obj) {
  if (!obj) return;

  if (obj.traverse) {
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
  } else {
    if (obj.geometry) obj.geometry.dispose();

    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach(function (m) {
          if (m && m.dispose) m.dispose();
        });
      } else if (obj.material.dispose) {
        obj.material.dispose();
      }
    }
  }
}

function clearSceneObject(obj) {
  if (!obj || !scene) return;
  scene.remove(obj);
  disposeThreeObject(obj);
}

function getBoundsIncludingOrigin(xs, ys) {
  let xMin = 0;
  let xMax = 0;
  let yMin = 0;
  let yMax = 0;

  if (xs && ys && xs.length && ys.length) {
    xMin = Math.min(0, xs[0]);
    xMax = Math.max(0, xs[0]);
    yMin = Math.min(0, ys[0]);
    yMax = Math.max(0, ys[0]);

    for (let i = 1; i < xs.length; i++) {
      if (xs[i] < xMin) xMin = xs[i];
      if (xs[i] > xMax) xMax = xs[i];
      if (ys[i] < yMin) yMin = ys[i];
      if (ys[i] > yMax) yMax = ys[i];
    }
  }

  return { xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax };
}

function computeTrajectorySpan(xs, ys) {
  const b = getBoundsIncludingOrigin(xs, ys);
  return Math.max(b.xMax - b.xMin, b.yMax - b.yMin, 50);
}

function frameToTrajectory(ts) {
  if (!ts || !ts.x_series || !ts.x_series.length || !controls || !camera) return;

  const xs = ts.x_series;
  const ys = ts.y_series;

  const b = getBoundsIncludingOrigin(xs, ys);
  const cx = (b.xMin + b.xMax) / 2;
  const cz = (b.yMin + b.yMax) / 2;
  const span = Math.max(180, Math.max(b.xMax - b.xMin, b.yMax - b.yMin)) * 1.3;

  controls.target.set(cx, 0, cz);
  camera.position.set(cx - span * 0.15, span * 0.75, cz + span * 0.95);
  controls.update();
}

function makeTrajectoryLineSegment(xs, ys, start, end, colorHex) {
  const len = end - start + 1;
  if (len < 2) return null;

  const positions = new Float32Array(len * 3);

  for (let i = 0; i < len; i++) {
    positions[i * 3] = xs[start + i];
    positions[i * 3 + 1] = 0.6;
    positions[i * 3 + 2] = ys[start + i];
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setDrawRange(0, 0);

  const mat = new THREE.LineBasicMaterial({
    color: colorHex,
    linewidth: 2
  });

  return {
    line: new THREE.Line(geom, mat),
    geom: geom
  };
}

function rebuildTrajectory() {
  if (!simCache || !scene || typeof THREE === 'undefined') return;

  const ts = simCache.time_series || {};
  const xs = ts.x_series || [];
  const ys = ts.y_series || [];
  const n = xs.length;

  if (!n) return;

  [
    trajLineP1, trajLineP2, trajLineP3, shipModel, mobBeacon,
    phaseMarker1, phaseMarker2, finalMarker, cteLine
  ].forEach(function (obj) {
    clearSceneObject(obj);
  });

  trajLineP1 = trajLineP2 = trajLineP3 = null;
  trajGeomP1 = trajGeomP2 = trajGeomP3 = null;
  shipModel = mobBeacon = phaseMarker1 = phaseMarker2 = finalMarker = cteLine = null;

  const span = computeTrajectorySpan(xs, ys);
  const shipL = Math.max(15, Math.min(span * 0.035, 200));
  const beaconSize = Math.max(15, Math.min(span * 0.025, 60));
  const markerR = Math.max(8, Math.min(span * 0.012, 60));

  const bounds = getPhaseBoundaries(n);
  const k1 = bounds[0];
  const k2 = bounds[1];

  const p1 = makeTrajectoryLineSegment(xs, ys, 0, k1, 0xc8a84b);
  if (p1) {
    trajLineP1 = p1.line;
    trajGeomP1 = p1.geom;
    scene.add(trajLineP1);
  }

  const p2 = makeTrajectoryLineSegment(xs, ys, k1, k2, 0xfb7185);
  if (p2) {
    trajLineP2 = p2.line;
    trajGeomP2 = p2.geom;
    scene.add(trajLineP2);
  }

  const p3 = makeTrajectoryLineSegment(xs, ys, k2, n - 1, 0x4ed0e1);
  if (p3) {
    trajLineP3 = p3.line;
    trajGeomP3 = p3.geom;
    scene.add(trajLineP3);
  }

  mobBeacon = buildMobBeacon(beaconSize);
  scene.add(mobBeacon);

  if (k1 > 0 && k1 < n) {
    phaseMarker1 = new THREE.Mesh(
      new THREE.SphereGeometry(markerR, 12, 10),
      new THREE.MeshStandardMaterial({
        color: 0xfb7185,
        emissive: 0xfb7185,
        emissiveIntensity: 0.65
      })
    );
    phaseMarker1.position.set(xs[k1], 1, ys[k1]);
    scene.add(phaseMarker1);
  }

  if (k2 > 0 && k2 < n) {
    phaseMarker2 = new THREE.Mesh(
      new THREE.SphereGeometry(markerR, 12, 10),
      new THREE.MeshStandardMaterial({
        color: 0x4ed0e1,
        emissive: 0x4ed0e1,
        emissiveIntensity: 0.65
      })
    );
    phaseMarker2.position.set(xs[k2], 1, ys[k2]);
    scene.add(phaseMarker2);
  }

  finalMarker = new THREE.Mesh(
    new THREE.SphereGeometry(markerR * 1.08, 12, 10),
    new THREE.MeshStandardMaterial({
      color: 0x4ed0e1,
      emissive: 0x4ed0e1,
      emissiveIntensity: 0.55
    })
  );
  finalMarker.position.set(xs[n - 1], 1, ys[n - 1]);
  scene.add(finalMarker);

  const ctePos = new Float32Array([
    xs[n - 1], 1.2, ys[n - 1],
    0, 1.2, 0
  ]);

  const cteGeom = new THREE.BufferGeometry();
  cteGeom.setAttribute('position', new THREE.BufferAttribute(ctePos, 3));

  const cteMat = new THREE.LineDashedMaterial({
    color: 0xfb7185,
    dashSize: shipL * 0.4,
    gapSize: shipL * 0.25,
    linewidth: 1.5
  });

  cteLine = new THREE.Line(cteGeom, cteMat);
  cteLine.computeLineDistances();
  scene.add(cteLine);

  shipModel = buildShip(shipL);
  scene.add(shipModel);

  frameToTrajectory(ts);
  animElapsed = 0;
}

// ─────────────────────────────────────────────────────────────
// Animation loop
// ─────────────────────────────────────────────────────────────
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
          Math.sin(u * 0.004 + t * 1.3) * 5.0
        + Math.cos(v * 0.0035 + t * 1.0) * 4.0
        + Math.sin((u + v) * 0.007 + t * 1.7) * 1.5;

      p.setZ(i, z);
    }

    waterGeometry.attributes.position.needsUpdate = true;
    lastWaterUpdate = t;
  }

  frameDelta += dt;

  if (frameDelta >= FRAME_INTERVAL) {
    if (simCache && shipModel) {
      if (isPlaying) {
        animElapsed = (animElapsed + frameDelta) % ANIM_DURATION;
      }

      const ts = simCache.time_series || {};
      const xs = ts.x_series || [];
      const ys = ts.y_series || [];
      const psis = ts.psi_series || [];
      const tArr = ts.t_series || [];
      const n = xs.length;

      if (n > 1) {
        const phase = animElapsed / ANIM_DURATION;
        const fIdx = phase * (n - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(n - 1, i0 + 1);
        const frac = fIdx - i0;

        const x = xs[i0] * (1 - frac) + xs[i1] * frac;
        const y = ys[i0] * (1 - frac) + ys[i1] * frac;

        let psi0 = psis[i0];
        let psi1 = psis[i1];
        let dPsi = psi1 - psi0;

        if (dPsi > 180) dPsi -= 360;
        if (dPsi < -180) dPsi += 360;

        const psiDeg = psi0 + dPsi * frac;

        shipModel.position.set(x, Math.sin(t * 1.5) * 0.6, y);
        shipModel.rotation.y = -psiDeg * Math.PI / 180;

        const bounds = getPhaseBoundaries(n);
        const k1 = bounds[0];
        const k2 = bounds[1];

        if (trajGeomP1) {
          trajGeomP1.setDrawRange(0, Math.min(i0, k1) + 1);
        }

        if (trajGeomP2) {
          if (i0 > k1) trajGeomP2.setDrawRange(0, Math.min(i0, k2) - k1 + 1);
          else trajGeomP2.setDrawRange(0, 0);
        }

        if (trajGeomP3) {
          if (i0 > k2) trajGeomP3.setDrawRange(0, i0 - k2 + 1);
          else trajGeomP3.setDrawRange(0, 0);
        }

        const animHud = byId('hud-anim');
        const phaseHud = byId('hud-phase');

        if (animHud) animHud.textContent = animElapsed.toFixed(2) + ' s';

        if (phaseHud) {
          let label = 'PHASE 1 — HARD RUDDER';
          if (i0 >= k2) label = 'PHASE 3 — CENTRED / RETRACE';
          else if (i0 >= k1) label = 'PHASE 2 — COUNTER RUDDER';
          phaseHud.textContent = label;
        }

        const realTimeHud = byId('hud-real-t');
        if (realTimeHud && tArr.length) {
          realTimeHud.textContent = Number(tArr[i0]).toFixed(1) + ' s';
        }
      }

      if (mobBeacon) {
        mobBeacon.position.y = Math.sin(t * 2.2) * 0.8;
      }
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