/**
 * app_pullout.js
 * NavalAI — Pullout / Spiral Manoeuvre Solver
 *
 * Optimized for:
 * - lazy Plotly loading
 * - lazy KaTeX loading
 * - compact API response decoding
 * - request aborting / frontend cache
 * - low CPU 3D animation
 * - DUAL ship trajectories (±δ runs)
 *
 * NOTE (fix applied):
 * The backend currently returns time_series fields named:
 *   t_series, yaw_rate_positive, yaw_rate_negative,
 *   heading_positive, heading_negative,
 *   rudder_positive, rudder_negative,
 *   x_positive, y_positive, x_negative, y_negative
 * while the rest of this file expects:
 *   t_series, r_series_pos/neg, psi_series_pos/neg,
 *   delta_series_pos/neg, x_series_pos/neg, y_series_pos/neg
 * normalizeSimData() now maps one naming scheme to the other so the
 * rest of the code (Three.js scene, Plotly charts, tables, CSV export)
 * doesn't need to change.
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.pulloutApi || '/maneuver/pullout/';

const ANIM_DURATION = 5.0;
const DEBOUNCE_MS = 350;
const MAX_PLOT_POINTS = 1500;
const MAX_RETURN_POINTS = 9000;
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;

// Series keys returned by backend when using the base64-encoded float32 format
const SERIES_KEYS_POS = [
  't_series',
  'x_series_pos', 'y_series_pos', 'psi_series_pos',
  'u_series_pos', 'v_series_pos', 'r_series_pos',
  'U_series_pos', 'delta_series_pos'
];

const SERIES_KEYS_NEG = [
  't_series',
  'x_series_neg', 'y_series_neg', 'psi_series_neg',
  'u_series_neg', 'v_series_neg', 'r_series_neg',
  'U_series_neg', 'delta_series_neg'
];

// Mapping from the current plain-JSON backend field names to the
// internal field names used throughout this file.
const BACKEND_FIELD_MAP = {
  x_series_pos: 'x_positive',
  y_series_pos: 'y_positive',
  psi_series_pos: 'heading_positive',
  r_series_pos: 'yaw_rate_positive',
  delta_series_pos: 'rudder_positive',

  x_series_neg: 'x_negative',
  y_series_neg: 'y_negative',
  psi_series_neg: 'heading_negative',
  r_series_neg: 'yaw_rate_negative',
  delta_series_neg: 'rudder_negative'
};

const SLIDER_DEFS = [
  { id: 'sl-U0', key: 'U0', disp: 'val-U0', fmt: v => v.toFixed(2) + ' m/s' },
  { id: 'sl-delta1', key: 'delta1', disp: 'val-delta1', fmt: v => v.toFixed(0) + '°' },
  { id: 'sl-T', key: 'T', disp: 'val-T', fmt: v => v.toFixed(0) + ' s',
    extra: v => { const e = document.getElementById('hint-2T'); if (e) e.textContent = (v * 2).toFixed(0); } }
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

const STABLE_THRESHOLD = 0.015;
const MARGINAL_THRESHOLD = 0.06;

const COLOR_POS = '#fb7185';
const COLOR_NEG = '#4ed0e1';

let state = { U0: 7.7175, delta1: 20, T: 600 };
let simCache = null;
let responseCache = new Map();

let currentView = 'cad';
let isPlaying = true;

let scene, camera, renderer, controls;
let clock = null;

let waterPlane, waterGeometry;
let shipPos, shipNeg;
let rudderPos, rudderNeg;
let trajPosLine, trajNegLine;
let trajPosGeom, trajNegGeom;
let startMarker, releasePosMarker, releaseNegMarker;

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
      if (s.extra) s.extra(v);

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
    if (simCache) frameToTrajectory(simCache.time_series);
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;

    renderer.render(scene, camera);

    const a = document.createElement('a');
    a.download = 'NavalAI_Pullout.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-export-curve-csv', 'click', exportCSV);
  on('btn-export-full-csv', 'click', exportCSV);
}

function updateHUD() {
  const h0 = byId('hud-U0');
  const hd = byId('hud-delta');

  if (h0) h0.textContent = state.U0.toFixed(2);
  if (hd) hd.textContent = state.delta1.toFixed(0) + '°';
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
function readPayload() {
  const payload = {
    U0: state.U0,
    delta1: state.delta1,
    T: state.T,
    x_initial: [0, 0, 0, 0, 0, 0, 0],
    response_format: 'compact'
  };

  COEF_IDS.forEach(function (id) {
    const el = byId('c-' + id);
    if (!el) return;

    const v = parseFloat(el.value);
    if (!isNaN(v)) payload[id] = v;
  });

  const h = Number(payload.h || 0.1);
  const estimatedSamples = Math.max(1, Math.round((payload.T * 2 || state.T * 2) / Math.max(h, 1e-9)) + 1);
  payload.output_stride = Math.max(1, Math.ceil(estimatedSamples / MAX_RETURN_POINTS));

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

    setStatus('ok', 'READY (cached)');
    updateTelemetry();
    rebuildTrajectories();

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

    const normalized = normalizeSimData(json.data);

    simCache = normalized;

    if (responseCache.size > 20) {
      responseCache.delete(responseCache.keys().next().value);
    }
    responseCache.set(key, simCache);

    setStatus('ok', 'READY');
    updateTelemetry();
    rebuildTrajectories();

    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();

  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq !== requestSeq) return;

    console.error('NavalAI Pullout simulation error:', err);

    setStatus('err', 'ERROR');

    ['t-rfin-pos', 't-rfin-neg', 't-gap', 't-stable'].forEach(function (id) {
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

/**
 * Looks up a value on the raw time_series object trying, in order:
 *   1) the internal name itself (e.g. "x_series_pos")
 *   2) the mapped current-backend name (e.g. "x_positive")
 * Returns undefined if neither key exists.
 */
function lookupSeriesRaw(ts, internalKey) {
  if (ts[internalKey] !== undefined) return ts[internalKey];

  const backendKey = BACKEND_FIELD_MAP[internalKey];
  if (backendKey && ts[backendKey] !== undefined) return ts[backendKey];

  return undefined;
}

/**
 * Normalizes the raw API payload's time_series block into the internal
 * field naming scheme used by the rest of this file:
 *   t_series, x_series_pos/neg, y_series_pos/neg, psi_series_pos/neg,
 *   r_series_pos/neg, delta_series_pos/neg
 *
 * Handles two orthogonal variations coming from the backend, which can
 * combine independently:
 *   A) Encoding: either plain JSON number arrays, OR base64-encoded
 *      float32 buffers (ts._format === 'f32-base64-v1'). The backend
 *      applies base64 encoding even when using its own field names, so
 *      the encoding check and the field-name mapping must both run
 *      regardless of which naming scheme is present.
 *   B) Field names: either the internal names this file expects
 *      (x_series_pos, r_series_pos, psi_series_pos, delta_series_pos, ...)
 *      OR the current backend names (x_positive, yaw_rate_positive,
 *      heading_positive, rudder_positive, ...). BACKEND_FIELD_MAP
 *      covers the translation; lookupSeriesRaw() tries both.
 */
function normalizeSimData(data) {
  if (!data || !data.time_series) return data;

  const ts = data.time_series;
  const isBase64 = ts._format === 'f32-base64-v1';
  const internalKeys = ['x_series_pos', 'y_series_pos', 'psi_series_pos', 'r_series_pos', 'delta_series_pos',
                         'x_series_neg', 'y_series_neg', 'psi_series_neg', 'r_series_neg', 'delta_series_neg'];

  const mapped = {};

  // t_series: try both encodings/names (name is the same in both schemes)
  const rawT = lookupSeriesRaw(ts, 't_series');
  mapped.t_series = isBase64 ? decodeFloat32Base64(rawT || '') : (rawT || []);

  internalKeys.forEach(function (internalKey) {
    const raw = lookupSeriesRaw(ts, internalKey);

    if (isBase64) {
      mapped[internalKey] = decodeFloat32Base64(raw || '');
    } else {
      mapped[internalKey] = raw || [];
    }
  });

  // Sanity check: warn if array lengths don't line up with t_series.
  const n = mapped.t_series ? mapped.t_series.length : 0;
  internalKeys.forEach(function (internalKey) {
    const arr = mapped[internalKey];
    if (arr && arr.length !== n) {
      console.warn(
        'NavalAI: series length mismatch for "' + internalKey + '" (' +
        arr.length + ' vs t_series length ' + n + '). Check backend field names / encoding for this key.'
      );
    }
  });

  return Object.assign({}, data, { time_series: mapped });
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

function updateTelemetry() {
  if (!simCache) return;

  const m = simCache.metrics || {};
  const ts = simCache.time_series || {};
  const meta = simCache.series_meta || {};

  function setT(id, val) {
    const el = byId(id);
    if (!el) return;

    el.classList.remove('error-state');
    el.textContent = val;
  }

  function fmt(v, suffix) {
    return (v === null || v === undefined || isNaN(v)) ? '— ' + suffix : Number(v).toFixed(4) + ' ' + suffix;
  }

  const returnedSamples = ts.t_series ? ts.t_series.length : 0;
  const solverSamples = meta.sample_count_solver || returnedSamples;

  const rPosFinal = ts.r_series_pos && ts.r_series_pos.length ? ts.r_series_pos[ts.r_series_pos.length - 1] : null;
  const rNegFinal = ts.r_series_neg && ts.r_series_neg.length ? ts.r_series_neg[ts.r_series_neg.length - 1] : null;
  const gap = (rPosFinal !== null && rNegFinal !== null) ? Math.abs(rPosFinal - rNegFinal) : null;

  setT('t-rfin-pos', fmt(rPosFinal, '°/s'));
  setT('t-rfin-neg', fmt(rNegFinal, '°/s'));
  setT('t-gap',     fmt(gap, '°/s'));

  // Stability verdict
  if (rPosFinal !== null && rNegFinal !== null) {
    const peak = Math.max(Math.abs(rPosFinal), Math.abs(rNegFinal));
    let verdict, cls;
    if (peak < STABLE_THRESHOLD)          { verdict = '✓ DYNAMICALLY STABLE';   cls = 'stable'; }
    else if (peak < MARGINAL_THRESHOLD)   { verdict = '~ MARGINAL';              cls = 'marginal'; }
    else                                  { verdict = '✗ DYNAMICALLY UNSTABLE'; cls = 'unstable'; }

    const el = byId('t-stable');
    if (el) {
      el.classList.remove('error-state', 'stable', 'marginal', 'unstable');
      el.classList.add(cls);
      el.textContent = verdict;
    }
  }

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

function makeBaseLayout() {
  return {
    paper_bgcolor: '#060d18',
    plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 65, r: 30, t: 30, b: 52 },
    xaxis: { gridcolor: '#1e293b', linecolor: '#334155' },
    yaxis: { gridcolor: '#1e293b', linecolor: '#334155' },
    legend: {
      font: { size: 10 },
      bgcolor: 'rgba(6,13,24,0.85)',
      bordercolor: '#1e293b',
      borderwidth: 1
    },
    hovermode: 'x unified'
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

  const ts = simCache.time_series;
  const sel = byId('plot-selector');
  const mode = sel ? sel.value : 'signature';

  let traces = [];

  if (mode === 'signature') {
    const sampled = subsampleSeries([ts.t_series, ts.r_series_pos, ts.r_series_neg], MAX_PLOT_POINTS);

    traces = [
      { x: sampled[0], y: sampled[1], mode: 'lines', name: 'r (+δ run)',
        line: { color: COLOR_POS, width: 2.5 } },
      { x: sampled[0], y: sampled[2], mode: 'lines', name: 'r (−δ run)',
        line: { color: COLOR_NEG, width: 2.5 } }
    ];

    layout.shapes = [{
      type: 'line', x0: state.T, x1: state.T,
      yref: 'paper', y0: 0, y1: 1,
      line: { color: '#c8a84b', width: 1.5, dash: 'dash' }
    }];
    layout.annotations = [{
      x: state.T, xref: 'x', y: 1, yref: 'paper',
      text: 'rudder released', showarrow: false,
      font: { color: '#c8a84b', size: 10 },
      yanchor: 'bottom', xanchor: 'left'
    }];

    layout.title = { text: 'Pullout Signature — yaw rate r(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'r [deg/s]';
  }

  else if (mode === 'trajectory') {
    const sampledX = subsampleSeries([ts.x_series_pos, ts.x_series_neg], MAX_PLOT_POINTS);
    const sampledY = subsampleSeries([ts.y_series_pos, ts.y_series_neg], MAX_PLOT_POINTS);

    traces = [
      { x: sampledX[0], y: sampledY[0], mode: 'lines', name: '+δ track',
        line: { color: COLOR_POS, width: 2.2 } },
      { x: sampledX[1], y: sampledY[1], mode: 'lines', name: '−δ track',
        line: { color: COLOR_NEG, width: 2.2 } },
      { x: [ts.x_series_pos[0]], y: [ts.y_series_pos[0]], mode: 'markers',
        name: 'Start', marker: { color: '#22c55e', size: 10 } }
    ];

    layout.title = { text: 'Ship Trajectories — both rudder runs', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 'x [m]';
    layout.yaxis.title = 'y [m]';
    layout.yaxis.scaleanchor = 'x';
  }

  else if (mode === 'heading') {
    const sampled = subsampleSeries([ts.t_series, ts.psi_series_pos, ts.psi_series_neg], MAX_PLOT_POINTS);

    traces = [
      { x: sampled[0], y: sampled[1], mode: 'lines', name: 'ψ (+δ)',
        line: { color: COLOR_POS, width: 2.2 } },
      { x: sampled[0], y: sampled[2], mode: 'lines', name: 'ψ (−δ)',
        line: { color: COLOR_NEG, width: 2.2 } }
    ];

    layout.title = { text: 'Heading (ψ) vs Time', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'ψ [deg]';
  }

  else if (mode === 'rudder') {
    const sampled = subsampleSeries([ts.t_series, ts.delta_series_pos, ts.delta_series_neg], MAX_PLOT_POINTS);

    traces = [
      { x: sampled[0], y: sampled[1], mode: 'lines', name: 'δ (+δ run)',
        line: { color: COLOR_POS, width: 2.2, shape: 'hv' } },
      { x: sampled[0], y: sampled[2], mode: 'lines', name: 'δ (−δ run)',
        line: { color: COLOR_NEG, width: 2.2, shape: 'hv' } }
    ];

    layout.title = { text: 'Rudder Command δ(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'δ [deg]';
  }

  Plotly.react(target, traces, layout, config);
}

// ─────────────────────────────────────────────────────────────
// TABLES
// ─────────────────────────────────────────────────────────────
function renderTables() {
  const target = byId('table-target');
  if (!target) return;

  if (!simCache) {
    target.innerHTML = '<div class="data-table-empty">Awaiting simulation data — click Run Simulation.</div>';
    return;
  }

  const ts = simCache.time_series;
  const meta = simCache.series_meta || {};
  const n = ts.t_series.length;
  const step = Math.max(1, Math.floor(n / 300));

  let rows = '';

  for (let i = 0; i < n; i += step) {
    rows +=
      '<tr><td>' + Number(ts.t_series[i]).toFixed(2) +
      '</td><td class="col-pos">' + Number(ts.x_series_pos[i]).toFixed(2) +
      '</td><td class="col-pos">' + Number(ts.y_series_pos[i]).toFixed(2) +
      '</td><td class="col-pos">' + Number(ts.psi_series_pos[i]).toFixed(2) +
      '</td><td class="col-pos">' + Number(ts.r_series_pos[i]).toFixed(4) +
      '</td><td class="col-pos">' + Number(ts.delta_series_pos[i]).toFixed(2) +
      '</td><td class="col-neg">' + Number(ts.x_series_neg[i]).toFixed(2) +
      '</td><td class="col-neg">' + Number(ts.y_series_neg[i]).toFixed(2) +
      '</td><td class="col-neg">' + Number(ts.psi_series_neg[i]).toFixed(2) +
      '</td><td class="col-neg">' + Number(ts.r_series_neg[i]).toFixed(4) +
      '</td><td class="col-neg">' + Number(ts.delta_series_neg[i]).toFixed(2) +
      '</td></tr>';
  }

  const rPosFinal = ts.r_series_pos[n - 1];
  const rNegFinal = ts.r_series_neg[n - 1];
  const peak = Math.max(Math.abs(rPosFinal), Math.abs(rNegFinal));
  let verdict;
  if (peak < STABLE_THRESHOLD)        verdict = '✓ Dynamically Stable';
  else if (peak < MARGINAL_THRESHOLD) verdict = '~ Marginal';
  else                                verdict = '✗ Dynamically Unstable';

  const sampleText = meta.sample_count_solver && meta.sample_count_solver !== n
    ? n + ' returned / ' + meta.sample_count_solver + ' solver samples'
    : n + ' samples';

  target.innerHTML =
    '<div class="tbl-block" style="margin-bottom:1rem;">' +
      '<div class="tbl-title">Pullout Stability Summary</div>' +
      '<table class="data-table"><thead><tr><th>Quantity</th><th>Value</th></tr></thead><tbody>' +
        '<tr><td>Final yaw rate r (+δ run)</td><td class="col-pos">' + rPosFinal.toFixed(5) + ' °/s</td></tr>' +
        '<tr><td>Final yaw rate r (−δ run)</td><td class="col-neg">' + rNegFinal.toFixed(5) + ' °/s</td></tr>' +
        '<tr><td>Residual yaw gap</td><td>' + Math.abs(rPosFinal - rNegFinal).toFixed(5) + ' °/s</td></tr>' +
        '<tr><td>Verdict</td><td>' + verdict + '</td></tr>' +
        '<tr><td>Total simulation time (2T)</td><td>' + ts.t_series[n - 1].toFixed(0) + ' s</td></tr>' +
        '<tr><td>Samples per run</td><td>' + n + '</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="tbl-block">' +
      '<div class="tbl-title">Time Series (' + sampleText + ', displayed every ' + step + ')</div>' +
      '<table class="data-table"><thead><tr>' +
        '<th>t [s]</th>' +
        '<th>x⁺ [m]</th><th>y⁺ [m]</th><th>ψ⁺ [°]</th><th>r⁺ [°/s]</th><th>δ⁺ [°]</th>' +
        '<th>x⁻ [m]</th><th>y⁻ [m]</th><th>ψ⁻ [°]</th><th>r⁻ [°/s]</th><th>δ⁻ [°]</th>' +
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

  const ts = simCache.time_series;
  const m = simCache.metrics || {};
  const meta = simCache.series_meta || {};

  let csv = 'NavalAI - Pullout / Spiral Manoeuvre Report\n\n';

  csv += 'INPUTS\n';
  csv += 'U0,' + state.U0 + ',m/s\n';
  csv += 'delta1,' + state.delta1 + ',deg\n';
  csv += 'T,' + state.T + ',s\n';
  csv += '2T,' + (state.T * 2) + ',s\n\n';

  csv += 'SERIES META\n';
  csv += 'Returned samples,' + ts.t_series.length + '\n';
  csv += 'Solver samples,' + (meta.sample_count_solver || ts.t_series.length) + '\n';
  csv += 'Output stride,' + (meta.output_stride || 1) + '\n\n';

  csv += 'STABILITY SUMMARY\n';
  const rPosFinal = ts.r_series_pos[ts.t_series.length - 1];
  const rNegFinal = ts.r_series_neg[ts.t_series.length - 1];
  csv += 'Final_r_pos_deg_per_s,' + rPosFinal + '\n';
  csv += 'Final_r_neg_deg_per_s,' + rNegFinal + '\n';
  csv += 'Residual_gap_deg_per_s,' + Math.abs(rPosFinal - rNegFinal) + '\n\n';

  csv += 'TIME SERIES\n';
  csv += 't_s,x_pos_m,y_pos_m,psi_pos_deg,r_pos_dps,delta_pos_deg,' +
         'x_neg_m,y_neg_m,psi_neg_deg,r_neg_dps,delta_neg_deg\n';

  for (let i = 0; i < ts.t_series.length; i++) {
    csv += [
      Number(ts.t_series[i]).toFixed(3),
      Number(ts.x_series_pos[i]).toFixed(4),
      Number(ts.y_series_pos[i]).toFixed(4),
      Number(ts.psi_series_pos[i]).toFixed(4),
      Number(ts.r_series_pos[i]).toFixed(6),
      Number(ts.delta_series_pos[i]).toFixed(3),
      Number(ts.x_series_neg[i]).toFixed(4),
      Number(ts.y_series_neg[i]).toFixed(4),
      Number(ts.psi_series_neg[i]).toFixed(4),
      Number(ts.r_series_neg[i]).toFixed(6),
      Number(ts.delta_series_neg[i]).toFixed(3)
    ].join(',') + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'Pullout_Report.csv';

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

  waterGeometry = new THREE.PlaneGeometry(30000, 30000, 160, 160);

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

function buildShip(accentColor, shipL) {
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
    color: accentColor,
    roughness: 0.25,
    metalness: 0.7,
    emissive: accentColor,
    emissiveIntensity: 0.25
  });

  const hGeo = new THREE.BoxGeometry(L, H, B, 16, 1, 6);
  const hp = hGeo.attributes.position;

  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i);
    const z = hp.getZ(i);
    const nx = x / (L / 2);

    if (nx > 0.5) {
      const t = (nx - 0.5) / 0.5;
      hp.setZ(i, z * Math.pow(1 - t, 1.5));
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
    new THREE.ConeGeometry(B * 0.18, L * 0.12, 12),
    trimMat
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(L * 0.56, H * 0.4, 0);
  grp.add(nose);

  // Rudder
  const rudGrp = new THREE.Group();
  rudGrp.position.set(-L * 0.52, -H * 0.15, 0);
  const rudMesh = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.05, H * 0.5, B * 0.05),
    new THREE.MeshStandardMaterial({ color: 0xc8a84b, roughness: 0.3, metalness: 0.7 })
  );
  rudMesh.position.x = -L * 0.025;
  rudGrp.add(rudMesh);
  grp.add(rudGrp);

  return { ship: grp, rudder: rudGrp };
}

function frameToTrajectory(ts) {
  if (!ts || !ts.x_series_pos || !ts.x_series_pos.length || !controls || !camera) return;

  const xs = Array.from(ts.x_series_pos).concat(Array.from(ts.x_series_neg));
  const ys = Array.from(ts.y_series_pos).concat(Array.from(ts.y_series_neg));

  let xMin = xs[0], xMax = xs[0], yMin = ys[0], yMax = ys[0];

  for (let i = 1; i < xs.length; i++) {
    if (xs[i] < xMin) xMin = xs[i];
    if (xs[i] > xMax) xMax = xs[i];
    if (ys[i] < yMin) yMin = ys[i];
    if (ys[i] > yMax) yMax = ys[i];
  }

  const cx = (xMin + xMax) / 2;
  const cz = (yMin + yMax) / 2;

  const spanX = Math.max(200, xMax - xMin);
  const spanY = Math.max(200, yMax - yMin);
  const span = Math.max(spanX, spanY) * 1.3;

  controls.target.set(cx, 0, cz);
  camera.position.set(cx - span * 0.15, span * 0.75, cz + span * 0.95);
  controls.update();
}

function rebuildTrajectories() {
  if (!simCache || !scene || typeof THREE === 'undefined') return;

  const ts = simCache.time_series;

  // Guard against missing/mismatched data (e.g. backend field-name issues,
  // partial responses, or n === 0) so we never feed NaN into Three.js buffers.
  if (
    !ts || !ts.t_series || !ts.t_series.length ||
    !ts.x_series_pos || !ts.y_series_pos ||
    !ts.x_series_neg || !ts.y_series_neg ||
    ts.x_series_pos.length !== ts.t_series.length ||
    ts.y_series_pos.length !== ts.t_series.length ||
    ts.x_series_neg.length !== ts.t_series.length ||
    ts.y_series_neg.length !== ts.t_series.length
  ) {
    console.error('NavalAI: cannot build 3D trajectories — time_series arrays are missing or mismatched in length.', ts);
    return;
  }

  const n = ts.t_series.length;

  // Clean up old objects
  [trajPosLine, trajNegLine, shipPos, shipNeg, startMarker, releasePosMarker, releaseNegMarker]
    .forEach(function (obj) {
      if (!obj) return;
      scene.remove(obj);
      disposeThreeObject(obj);
    });
  trajPosLine = trajNegLine = shipPos = shipNeg = startMarker = releasePosMarker = releaseNegMarker = null;

  // Build polylines
  function makePolyline(xs, ys, color) {
    const positions = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      positions[i * 3] = xs[i];
      positions[i * 3 + 1] = 0.5;
      positions[i * 3 + 2] = ys[i];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setDrawRange(0, 0);

    const mat = new THREE.LineBasicMaterial({ color: color });
    return { line: new THREE.Line(geom, mat), geom: geom };
  }

  const posL = makePolyline(ts.x_series_pos, ts.y_series_pos, 0xfb7185);
  trajPosLine = posL.line;
  trajPosGeom = posL.geom;
  scene.add(trajPosLine);

  const negL = makePolyline(ts.x_series_neg, ts.y_series_neg, 0x4ed0e1);
  trajNegLine = negL.line;
  trajNegGeom = negL.geom;
  scene.add(trajNegLine);

  // Compute trajectory span → ship scale
  let xMin = ts.x_series_pos[0], xMax = ts.x_series_pos[0], yMin = ts.y_series_pos[0], yMax = ts.y_series_pos[0];
  for (let i = 1; i < n; i++) {
    if (ts.x_series_pos[i] < xMin) xMin = ts.x_series_pos[i]; if (ts.x_series_pos[i] > xMax) xMax = ts.x_series_pos[i];
    if (ts.y_series_pos[i] < yMin) yMin = ts.y_series_pos[i]; if (ts.y_series_pos[i] > yMax) yMax = ts.y_series_pos[i];
    if (ts.x_series_neg[i] < xMin) xMin = ts.x_series_neg[i]; if (ts.x_series_neg[i] > xMax) xMax = ts.x_series_neg[i];
    if (ts.y_series_neg[i] < yMin) yMin = ts.y_series_neg[i]; if (ts.y_series_neg[i] > yMax) yMax = ts.y_series_neg[i];
  }

  const span = Math.max(xMax - xMin, yMax - yMin, 100);
  const shipL = Math.max(15, Math.min(span * 0.035, 200));
  const markerR = Math.max(8, Math.min(span * 0.012, 80));

  // Build two ships
  const sp = buildShip(0xfb7185, shipL);
  shipPos = sp.ship;
  rudderPos = sp.rudder;
  scene.add(shipPos);

  const sn = buildShip(0x4ed0e1, shipL);
  shipNeg = sn.ship;
  rudderNeg = sn.rudder;
  scene.add(shipNeg);

  // Start marker
  startMarker = new THREE.Mesh(
    new THREE.SphereGeometry(markerR, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 0.6 })
  );
  startMarker.position.set(ts.x_series_pos[0], 1, ts.y_series_pos[0]);
  scene.add(startMarker);

  // Release markers (at time t = T)
  const releaseIdx = Math.round(state.T / (ts.t_series[n - 1] / (n - 1)));
  if (releaseIdx > 0 && releaseIdx < n) {
    releasePosMarker = new THREE.Mesh(
      new THREE.SphereGeometry(markerR * 0.75, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xc8a84b, emissive: 0xc8a84b, emissiveIntensity: 0.6 })
    );
    releasePosMarker.position.set(ts.x_series_pos[releaseIdx], 1, ts.y_series_pos[releaseIdx]);
    scene.add(releasePosMarker);

    releaseNegMarker = new THREE.Mesh(
      new THREE.SphereGeometry(markerR * 0.75, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0xc8a84b, emissive: 0xc8a84b, emissiveIntensity: 0.6 })
    );
    releaseNegMarker.position.set(ts.x_series_neg[releaseIdx], 1, ts.y_series_neg[releaseIdx]);
    scene.add(releaseNegMarker);
  }

  frameToTrajectory(ts);
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
    if (simCache && shipPos && shipNeg && trajPosGeom && trajNegGeom) {
      const ts = simCache.time_series;
      const n = ts.t_series ? ts.t_series.length : 0;

      if (n > 1) {
        if (isPlaying) animElapsed = (animElapsed + frameDelta) % ANIM_DURATION;

        const phase = animElapsed / ANIM_DURATION;
        const fIdx = phase * (n - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(n - 1, i0 + 1);
        const frac = fIdx - i0;

        // Place +δ ship
        placeShip(
          shipPos, rudderPos,
          ts.x_series_pos, ts.y_series_pos, ts.psi_series_pos, ts.delta_series_pos,
          i0, i1, frac, t
        );

        // Place −δ ship
        placeShip(
          shipNeg, rudderNeg,
          ts.x_series_neg, ts.y_series_neg, ts.psi_series_neg, ts.delta_series_neg,
          i0, i1, frac, t
        );

        trajPosGeom.setDrawRange(0, i0 + 1);
        trajNegGeom.setDrawRange(0, i0 + 1);

        const animHud = byId('hud-anim');
        const phaseHud = byId('hud-phase');

        if (animHud) animHud.textContent = animElapsed.toFixed(2) + ' s';

        if (phaseHud) {
          const realT = ts.t_series[i0];
          phaseHud.textContent = (realT < state.T) ? 'RUDDER APPLIED' : 'RUDDER RELEASED';
        }
      }
    }

    frameDelta = frameDelta % FRAME_INTERVAL;
  }

  if (renderer && scene && camera) renderer.render(scene, camera);
}

function placeShip(shipGrp, rudGrp, xs, ys, psis, rods, i0, i1, frac, t) {
  if (!xs || !ys || !psis || !rods) return;
  if (xs[i0] === undefined || xs[i1] === undefined) return;

  const x = xs[i0] * (1 - frac) + xs[i1] * frac;
  const y = ys[i0] * (1 - frac) + ys[i1] * frac;

  let p0 = psis[i0], p1 = psis[i1], dp = p1 - p0;
  if (dp > 180) dp -= 360;
  if (dp < -180) dp += 360;
  const psiDeg = p0 + dp * frac;

  if (isNaN(x) || isNaN(y) || isNaN(psiDeg)) return;

  shipGrp.position.set(x, Math.sin(t * 1.6) * 0.6, y);
  shipGrp.rotation.y = -psiDeg * Math.PI / 180;

  const dPos = rods[i0] * (1 - frac) + rods[i1] * frac;
  if (rudGrp && !isNaN(dPos)) rudGrp.rotation.y = -dPos * Math.PI / 180;
}

function onWindowResize() {
  const c = byId('canvas-3d-target');
  if (!c || !renderer || !camera) return;
  if (!c.clientWidth || !c.clientHeight) return;

  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(c.clientWidth, c.clientHeight);
}