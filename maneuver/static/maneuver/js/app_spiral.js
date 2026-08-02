/**
 * app_spiral.js
 * NavalAI — Dieudonné Spiral Manoeuvre Solver
 *
 * Optimized to match app_turning.js performance profile:
 * - lazy Plotly loading
 * - lazy KaTeX loading
 * - compact (base64 float32) API response decoding
 * - request aborting + frontend response cache
 * - debounced slider-driven re-runs
 * - output_stride to cap payload size
 * - low CPU 3D animation (fixed-fps loop, dt clamp, background/tab pause)
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.spiralApi || 'http://127.0.0.1:8000/api/v1/maneuvering/spiral/';

const ANIM_DURATION = 5.0;
const DEBOUNCE_MS = 350;
const MAX_PLOT_POINTS = 1500;
const MAX_RETURN_POINTS = 9000;      // per-case cap (applies to each of the 9 series)
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;

// Rudder angles the backend is expected to compute (used only as a fallback
// for estimating stride before the first response arrives).
const RUDDER_COUNT = 9;

const SLIDER_DEFS = [
  { id: 'sl-U0',     key: 'U0',      disp: 'val-U0',     fmt: v => v.toFixed(2) + ' m/s' },
  { id: 'sl-T',      key: 'T',       disp: 'val-T',      fmt: v => v.toFixed(0) + ' s' },
  { id: 'sl-Tdelta', key: 'T_delta', disp: 'val-Tdelta', fmt: v => v.toFixed(1) + ' s' }
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

// 9 colours mapping rudder angle  −20° → +20°  (cool-red → warm-violet gradient)
const RUDDER_COLORS = [
  '#ef4444', // -20°
  '#f97316', // -15°
  '#eab308', // -10°
  '#84cc16', //  -5°
  '#94a3b8', //   0° (neutral grey)
  '#06b6d4', //  +5°
  '#3b82f6', // +10°
  '#8b5cf6', // +15°
  '#d946ef'  // +20°
];

// ── State ──
let state = { U0: 7.7175, T: 400, T_delta: 1.0 };
let simCache = null;
let runMap = [];               // [{rudder, color, traj:{x,y}, heading:[], yaw:[]}, ...]
let responseCache = new Map();

let currentView = 'cad';
let isPlaying = true;

let scene, camera, renderer, controls;
let clock = null;

let waterPlane, waterGeometry;
let ships = [];
let trajLines = [];
let trajGeoms = [];
let startMarker;

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
document.addEventListener('DOMContentLoaded', function () {
  initSliders();
  initCollapsibleSections();
  initTheoryModalEvents();
  initViewSwitcher();
  initToolbarEvents();
  initRudderLegend();

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
// Lazy asset loaders (Plotly / KaTeX) — identical pattern to app_turning.js
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
// SLIDERS
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
      const sec = lab.closest('.input-section--collapsible');
      if (sec) sec.classList.toggle('collapsed');
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
    if (runMap.length) frameToTrajectories();
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;

    renderer.render(scene, camera);

    const a = document.createElement('a');
    a.download = 'NavalAI_Spiral.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-export-curve-csv', 'click', exportCSV);
  on('btn-export-full-csv', 'click', exportCSV);
}

// ─────────────────────────────────────────────────────────────
// RUDDER LEGEND (color strip)
// ─────────────────────────────────────────────────────────────
function initRudderLegend() {
  const strip = byId('leg-strip');
  if (!strip) return;
  strip.innerHTML = '';
  RUDDER_COLORS.forEach(function (c) {
    const s = document.createElement('div');
    s.className = 'leg-swatch';
    s.style.background = c;
    s.style.color = c;
    strip.appendChild(s);
  });
}

// ─────────────────────────────────────────────────────────────
// HUD / STATUS
// ─────────────────────────────────────────────────────────────
function updateHUD() {
  const h0 = byId('hud-U0');
  const ht = byId('hud-Tdelta');
  if (h0) h0.textContent = state.U0.toFixed(2);
  if (ht) ht.textContent = state.T_delta.toFixed(1) + ' s';
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
    U0:      state.U0,
    T:       state.T,
    T_delta: state.T_delta,
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
  const estimatedSamples = Math.max(1, Math.round((payload.T || state.T) / Math.max(h, 1e-9)) + 1);
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
    buildRunMap();

    setStatus('ok', 'READY (cached)');
    updateTelemetry();
    rebuildTrajectories();

    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();

    return;
  }

  const runBtn = byId('btn-run');
  const load = byId('loading-overlay');

  setStatus('loading', 'COMPUTING 9 CASES');

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
    buildRunMap();

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

    console.error('NavalAI Spiral simulation error:', err);

    setStatus('err', 'ERROR');

    ['t-r-pos20', 't-r-neg20', 't-r-zero', 't-slope', 't-stable', 't-shape'].forEach(function (id) {
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

// ─────────────────────────────────────────────────────────────
// COMPACT DECODING
//
// If the backend returns response_format:'compact', numeric series may be
// delivered as base64-encoded Float32 buffers instead of JSON arrays. Every
// series (time_series.t_series and each per-rudder dict entry) is checked
// individually: a string value is treated as f32-base64 and decoded, an
// array value is used as-is. This keeps the frontend compatible with both
// the compact and legacy plain-JSON solver outputs.
// ─────────────────────────────────────────────────────────────
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

function decodeMaybeSeries(value) {
  if (typeof value === 'string') return decodeFloat32Base64(value);
  if (Array.isArray(value)) return value;
  if (value && value.buffer) return value; // already a typed array
  return value;
}

function decodeDict(dict) {
  if (!dict) return dict;
  const out = {};

  Object.keys(dict).forEach(function (key) {
    const v = dict[key];

    if (v && typeof v === 'object' && !Array.isArray(v) && !v.buffer) {
      // traj_dict style: { x: ..., y: ... }
      const inner = {};
      Object.keys(v).forEach(function (ik) {
        inner[ik] = decodeMaybeSeries(v[ik]);
      });
      out[key] = inner;
    } else {
      out[key] = decodeMaybeSeries(v);
    }
  });

  return out;
}

function normalizeSimData(data) {
  if (!data) return data;

  const out = Object.assign({}, data);

  if (out.time_series) {
    const ts = {};
    Object.keys(out.time_series).forEach(function (k) {
      if (k === '_format') return;
      ts[k] = decodeMaybeSeries(out.time_series[k]);
    });
    out.time_series = ts;
  }

  if (out.detailed) {
    out.detailed = {
      yaw_rate_dict: decodeDict(out.detailed.yaw_rate_dict),
      heading_dict:  decodeDict(out.detailed.heading_dict),
      traj_dict:     decodeDict(out.detailed.traj_dict),
      u_dict:        decodeDict(out.detailed.u_dict),
      v_dict:        decodeDict(out.detailed.v_dict),
      U_dict:        decodeDict(out.detailed.U_dict)
    };
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// BUILD A NORMALISED runMap[] FROM THE API RESPONSE
// ─────────────────────────────────────────────────────────────
function buildRunMap() {
  runMap = [];
  if (!simCache) return;

  const rudders = simCache.metrics && simCache.metrics.rudder_deg ? simCache.metrics.rudder_deg : [];
  const trajD = simCache.detailed ? simCache.detailed.traj_dict     : {};
  const yawD  = simCache.detailed ? simCache.detailed.yaw_rate_dict : {};
  const hdgD  = simCache.detailed ? simCache.detailed.heading_dict  : {};

  function findKey(dict, target) {
    let bestKey = null, bestDelta = Infinity;
    for (const k in dict) {
      const d = Math.abs(parseFloat(k) - target);
      if (d < bestDelta) { bestDelta = d; bestKey = k; }
    }
    return bestDelta < 0.5 ? bestKey : null;
  }

  rudders.forEach(function (r, i) {
    const kT = findKey(trajD, r);
    const kY = findKey(yawD,  r);
    const kH = findKey(hdgD,  r);
    runMap.push({
      rudder:  r,
      color:   RUDDER_COLORS[i] || '#ffffff',
      traj:    kT ? trajD[kT] : { x: [], y: [] },
      yaw:     kY ? yawD[kY]  : [],
      heading: kH ? hdgD[kH]  : []
    });
  });
}

// ─────────────────────────────────────────────────────────────
// TELEMETRY (+ stability verdict from monotonicity of rₛₛ(δ))
// ─────────────────────────────────────────────────────────────
function updateTelemetry() {
  if (!simCache || !simCache.metrics) return;
  const rud = simCache.metrics.rudder_deg;
  const rss = simCache.metrics.steady_yaw_deg_s;
  const n = rud.length;
  if (!n) return;

  const sorted = rud.map((d, i) => [d, rss[i]]).sort((a, b) => a[0] - b[0]);
  const sortedRud = sorted.map(p => p[0]);
  const sortedYaw = sorted.map(p => p[1]);

  function lookup(deg) {
    for (let i = 0; i < sortedRud.length; i++)
      if (Math.abs(sortedRud[i] - deg) < 0.5) return sortedYaw[i];
    return NaN;
  }
  function fmt(v, suffix) {
    return (v === null || v === undefined || isNaN(v)) ? '— ' + suffix : v.toFixed(4) + ' ' + suffix;
  }
  function setT(id, val, cls) {
    const el = byId(id);
    if (!el) return;
    el.classList.remove('error-state');
    el.textContent = val;
    if (cls) el.className = 'telemetry-val stability-val ' + cls;
  }

  setT('t-r-pos20', fmt(lookup( 20), '°/s'));
  setT('t-r-neg20', fmt(lookup(-20), '°/s'));
  setT('t-r-zero',  fmt(lookup(  0), '°/s'));

  const rNeg5 = lookup(-5);
  const rPos5 = lookup( 5);
  let slope = NaN;
  if (!isNaN(rNeg5) && !isNaN(rPos5)) slope = (rPos5 - rNeg5) / 10.0;
  setT('t-slope', isNaN(slope) ? '— °/s·deg' : slope.toFixed(5) + ' °/s·deg');

  let monotonic = true;
  for (let i = 1; i < sortedYaw.length; i++) {
    if (sortedYaw[i] < sortedYaw[i - 1] - 1e-6) { monotonic = false; break; }
  }
  let verdict, cls;
  if (monotonic && !isNaN(slope) && slope > 0.0001)        { verdict = '✓ COURSE STABLE';   cls = 'stable'; }
  else if (monotonic)                                       { verdict = '~ NEUTRAL / WEAK'; cls = 'marginal'; }
  else                                                      { verdict = '✗ COURSE UNSTABLE'; cls = 'unstable'; }
  setT('t-stable', verdict, cls);

  const samples = runMap.length && runMap[0].yaw ? runMap[0].yaw.length : (simCache.time_series ? simCache.time_series.t_series.length : 0);
  setT('t-shape', n + ' / ' + samples);
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
    paper_bgcolor: '#060d18', plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 65, r: 30, t: 32, b: 52 },
    xaxis: { gridcolor: '#1e293b', linecolor: '#334155', zerolinecolor: '#475569' },
    yaxis: { gridcolor: '#1e293b', linecolor: '#334155', zerolinecolor: '#475569' },
    legend: { font: { size: 10 }, bgcolor: 'rgba(6,13,24,0.85)', bordercolor: '#1e293b', borderwidth: 1 },
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
        xref: 'paper', yref: 'paper', x: 0.5, y: 0.5
      }]
    }), config);
    return;
  }

  const sel = byId('plot-selector');
  const mode = sel ? sel.value : 'spiral';
  let traces = [];

  if (mode === 'spiral') {
    const rud = simCache.metrics.rudder_deg;
    const rss = simCache.metrics.steady_yaw_deg_s;
    const pairs = rud.map((d, i) => [d, rss[i], i]).sort((a, b) => a[0] - b[0]);

    traces = [{
      x: pairs.map(p => p[0]),
      y: pairs.map(p => p[1]),
      mode: 'lines+markers',
      name: 'r_ss(δ)',
      line: { color: '#c8a84b', width: 2.5 },
      marker: {
        size: 10,
        color: pairs.map(p => RUDDER_COLORS[p[2]] || '#fff'),
        line: { color: '#fff', width: 1 }
      }
    }];

    layout.shapes = [
      { type: 'line', x0: -20, x1: 20, y0: 0, y1: 0, line: { color: '#475569', width: 1, dash: 'dot' } },
      { type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: '#475569', width: 1, dash: 'dot' } }
    ];
    layout.title = { text: 'Spiral Diagram  —  rₛₛ vs δ', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 'Rudder δ [deg]';
    layout.yaxis.title = 'Steady-state yaw rate rₛₛ [deg/s]';
    layout.showlegend = false;
  }

  else if (mode === 'trajectory') {
    traces = runMap.map(function (run) {
      const sampled = subsampleSeries([run.traj.x, run.traj.y], MAX_PLOT_POINTS);
      return {
        x: sampled[0], y: sampled[1], mode: 'lines',
        name: 'δ = ' + run.rudder.toFixed(0) + '°',
        line: { color: run.color, width: 1.8 }
      };
    });
    traces.push({
      x: [0], y: [0], mode: 'markers',
      name: 'Start', marker: { color: '#22c55e', size: 11, symbol: 'circle' }
    });
    layout.title = { text: 'Trajectory Fan — 9 rudder angles', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 'x [m]';
    layout.yaxis.title = 'y [m]';
    layout.yaxis.scaleanchor = 'x';
  }

  else if (mode === 'yaw') {
    const t = simCache.time_series.t_series;
    traces = runMap.map(function (run) {
      const sampled = subsampleSeries([t, run.yaw], MAX_PLOT_POINTS);
      return {
        x: sampled[0], y: sampled[1], mode: 'lines',
        name: 'δ = ' + run.rudder.toFixed(0) + '°',
        line: { color: run.color, width: 1.6 }
      };
    });
    layout.title = { text: 'Yaw Rate r(t) — all 9 cases', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'r [deg/s]';
  }

  else if (mode === 'heading') {
    const t = simCache.time_series.t_series;
    traces = runMap.map(function (run) {
      const sampled = subsampleSeries([t, run.heading], MAX_PLOT_POINTS);
      return {
        x: sampled[0], y: sampled[1], mode: 'lines',
        name: 'δ = ' + run.rudder.toFixed(0) + '°',
        line: { color: run.color, width: 1.6 }
      };
    });
    layout.title = { text: 'Heading ψ(t) — all 9 cases', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'ψ [deg]';
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

  const rud = simCache.metrics.rudder_deg;
  const rss = simCache.metrics.steady_yaw_deg_s;

  const pairs = rud.map((d, i) => [d, rss[i], i]).sort((a, b) => a[0] - b[0]);
  const rows = pairs.map(function (p) {
    const col = RUDDER_COLORS[p[2]];
    return '<tr>' +
      '<td><span class="col-swatch" style="background:' + col + '; color:' + col + ';"></span>' + p[0].toFixed(1) + '°</td>' +
      '<td>' + Number(p[1]).toFixed(5) + '</td>' +
      '<td>' + (Math.abs(p[1]) < 1e-6 ? '0' : (p[1] / p[0]).toFixed(5)) + '</td>' +
    '</tr>';
  }).join('');

  let monotonic = true;
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i][1] < pairs[i - 1][1] - 1e-6) { monotonic = false; break; }
  }
  const rNeg5 = pairs.find(p => Math.abs(p[0] + 5) < 0.5);
  const rPos5 = pairs.find(p => Math.abs(p[0] - 5) < 0.5);
  const slope = (rNeg5 && rPos5) ? (rPos5[1] - rNeg5[1]) / 10.0 : NaN;
  let verdict;
  if (monotonic && !isNaN(slope) && slope > 0.0001)  verdict = '✓ Course Stable';
  else if (monotonic)                                 verdict = '~ Neutral / Weak';
  else                                                verdict = '✗ Course Unstable';

  const samplesEach = runMap.length && runMap[0].yaw ? runMap[0].yaw.length : '—';

  target.innerHTML =
    '<div class="tbl-block" style="margin-bottom:1rem;">' +
      '<div class="tbl-title">Stability Summary</div>' +
      '<table class="data-table"><thead><tr><th>Quantity</th><th>Value</th></tr></thead><tbody>' +
        '<tr><td>Monotonic rₛₛ(δ)?</td><td>' + (monotonic ? 'Yes' : 'No') + '</td></tr>' +
        '<tr><td>Slope at origin (∂rₛₛ/∂δ)</td><td>' + (isNaN(slope) ? '—' : slope.toFixed(5) + ' (°/s)/°') + '</td></tr>' +
        '<tr><td>Verdict</td><td>' + verdict + '</td></tr>' +
        '<tr><td>Cases</td><td>' + rud.length + '</td></tr>' +
        '<tr><td>Samples per case</td><td>' + samplesEach + '</td></tr>' +
        '<tr><td>Sim time per case</td><td>' + state.T + ' s</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="tbl-block">' +
      '<div class="tbl-title">Steady-State Yaw Rate Table</div>' +
      '<table class="data-table"><thead><tr>' +
        '<th>Rudder δ</th><th>Steady r<sub>ss</sub> [°/s]</th><th>r<sub>ss</sub> / δ [1/s]</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>';
}

// ─────────────────────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────────────────────
function exportCSV() {
  if (!simCache) { console.warn('No data yet — run solver first.'); return; }

  let csv = 'NavalAI - Dieudonné Spiral Manoeuvre Report\n\n';
  csv += 'INPUTS\nU0,' + state.U0 + ',m/s\nT,' + state.T + ',s\nT_delta,' + state.T_delta + ',s\n\n';

  csv += 'SPIRAL DIAGRAM (steady-state yaw rate)\n';
  csv += 'rudder_deg,steady_yaw_deg_s\n';
  const rud = simCache.metrics.rudder_deg;
  const rss = simCache.metrics.steady_yaw_deg_s;
  rud.forEach(function (d, i) { csv += d.toFixed(2) + ',' + rss[i] + '\n'; });

  csv += '\nTIME SERIES — yaw rate r(t) per case [deg/s]\n';
  csv += 't_s,' + runMap.map(r => 'r_' + r.rudder.toFixed(0) + 'deg').join(',') + '\n';
  const t = simCache.time_series.t_series;
  for (let i = 0; i < t.length; i++) {
    csv += Number(t[i]).toFixed(3);
    runMap.forEach(function (r) { csv += ',' + (r.yaw[i] === undefined ? '' : Number(r.yaw[i]).toFixed(5)); });
    csv += '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'Spiral_Report.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
    80000
  );
  camera.position.set(900, 800, 1000);

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

  waterGeometry = new THREE.PlaneGeometry(40000, 40000, 24, 24);

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x4ed0e1,
    roughness: 0.2,
    metalness: 0.35,
    flatShading: true,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide
  });

  waterPlane = new THREE.Mesh(waterGeometry, waterMat);
  waterPlane.rotation.x = -Math.PI / 2;
  scene.add(waterPlane);

  window.addEventListener('resize', onWindowResize, { passive: true });

  animate();
}

function buildShip(accentHex, shipL) {
  const grp = new THREE.Group();
  const L = shipL, B = L / 3, H = L / 3.5;

  const hullMat = new THREE.MeshStandardMaterial({ color: 0x1f3346, roughness: 0.45, metalness: 0.5 });
  const accMat  = new THREE.MeshStandardMaterial({ color: 0xe6e3da, roughness: 0.4 });
  const trimMat = new THREE.MeshStandardMaterial({
    color: accentHex, roughness: 0.2, metalness: 0.8,
    emissive: accentHex, emissiveIntensity: 0.30
  });

  const hGeo = new THREE.BoxGeometry(L, H, B, 12, 1, 5);
  const hp = hGeo.attributes.position;
  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i), z = hp.getZ(i);
    const nx = x / (L / 2);
    if (nx > 0.5) hp.setZ(i, z * Math.pow(1 - (nx - 0.5) / 0.5, 1.5));
  }
  hGeo.computeVertexNormals();
  const hull = new THREE.Mesh(hGeo, hullMat); hull.position.y = H * 0.1; grp.add(hull);

  const trim = new THREE.Mesh(new THREE.BoxGeometry(L * 0.99, H * 0.10, B * 1.02), trimMat);
  trim.position.y = -H * 0.35; grp.add(trim);

  const acc = new THREE.Mesh(new THREE.BoxGeometry(L * 0.22, H * 0.9, B * 0.7), accMat);
  acc.position.set(-L * 0.15, H * 0.65, 0); grp.add(acc);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(B * 0.18, L * 0.12, 10), trimMat);
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(L * 0.56, H * 0.4, 0);
  grp.add(nose);

  return grp;
}

function computeGlobalSpan() {
  let xMin = 0, xMax = 0, yMin = 0, yMax = 0;
  runMap.forEach(function (run) {
    const xs = run.traj.x, ys = run.traj.y;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < xMin) xMin = xs[i];
      if (xs[i] > xMax) xMax = xs[i];
      if (ys[i] < yMin) yMin = ys[i];
      if (ys[i] > yMax) yMax = ys[i];
    }
  });
  return { xMin, xMax, yMin, yMax };
}

function frameToTrajectories() {
  if (!runMap.length) return;

  const { xMin, xMax, yMin, yMax } = computeGlobalSpan();
  const cx = (xMin + xMax) / 2;
  const cz = (yMin + yMax) / 2;
  const span = Math.max(300, Math.max(xMax - xMin, yMax - yMin)) * 1.3;

  controls.target.set(cx, 0, cz);
  camera.position.set(cx - span * 0.18, span * 0.78, cz + span * 0.95);
  controls.update();
}

function disposeThreeObject(obj) {
  if (!obj) return;

  obj.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();

    if (o.material) {
      if (Array.isArray(o.material)) {
        o.material.forEach(function (m) { if (m && m.dispose) m.dispose(); });
      } else if (o.material.dispose) {
        o.material.dispose();
      }
    }
  });
}

function rebuildTrajectories() {
  if (!runMap.length || !scene || typeof THREE === 'undefined') return;

  ships.forEach(function (s) { scene.remove(s); disposeThreeObject(s); });
  trajLines.forEach(function (l) {
    scene.remove(l);
    if (l.geometry) l.geometry.dispose();
    if (l.material) l.material.dispose();
  });
  ships = []; trajLines = []; trajGeoms = [];

  if (startMarker) {
    scene.remove(startMarker);
    disposeThreeObject(startMarker);
    startMarker = null;
  }

  const { xMin, xMax, yMin, yMax } = computeGlobalSpan();
  const span = Math.max(xMax - xMin, yMax - yMin, 200);
  const shipL = Math.max(12, Math.min(span * 0.022, 150));
  const markerR = Math.max(10, Math.min(span * 0.012, 80));

  runMap.forEach(function (run) {
    const xs = run.traj.x, ys = run.traj.y;
    const n = xs.length;
    if (!n) { ships.push(null); trajLines.push(null); trajGeoms.push(null); return; }

    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3]     = xs[i];
      positions[i * 3 + 1] = 0.6;
      positions[i * 3 + 2] = ys[i];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setDrawRange(0, 0);

    const mat = new THREE.LineBasicMaterial({ color: run.color });
    const line = new THREE.Line(geom, mat);
    scene.add(line);
    trajLines.push(line);
    trajGeoms.push(geom);

    const ship = buildShip(parseInt(run.color.replace('#', ''), 16), shipL);
    scene.add(ship);
    ships.push(ship);
  });

  startMarker = new THREE.Mesh(
    new THREE.SphereGeometry(markerR, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 0.6 })
  );
  startMarker.position.set(0, 1, 0);
  scene.add(startMarker);

  frameToTrajectories();
  animElapsed = 0;
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
          Math.sin(u * 0.0035 + t * 1.3) * 5.5
        + Math.cos(v * 0.003  + t * 1.0) * 4.2
        + Math.sin((u + v) * 0.006 + t * 1.7) * 1.6;

      p.setZ(i, z);
    }

    waterGeometry.attributes.position.needsUpdate = true;
    lastWaterUpdate = t;
  }

  frameDelta += dt;

  if (frameDelta >= FRAME_INTERVAL) {
    if (runMap.length && ships.length === runMap.length) {
      if (isPlaying) animElapsed = (animElapsed + frameDelta) % ANIM_DURATION;

      const phase = animElapsed / ANIM_DURATION;
      const tArr = simCache && simCache.time_series ? simCache.time_series.t_series : null;

      runMap.forEach(function (run, idx) {
        const ship = ships[idx];
        const geom = trajGeoms[idx];
        if (!ship || !geom) return;

        const xs = run.traj.x, ys = run.traj.y;
        const n = xs.length;
        if (!n) return;

        const fIdx = phase * (n - 1);
        const i0 = Math.floor(fIdx);
        const i1 = Math.min(n - 1, i0 + 1);
        const frac = fIdx - i0;

        const x = xs[i0] * (1 - frac) + xs[i1] * frac;
        const y = ys[i0] * (1 - frac) + ys[i1] * frac;

        let p0 = run.heading[i0] || 0;
        let p1 = run.heading[i1] || 0;
        let dp = p1 - p0;

        if (dp > 180) dp -= 360;
        if (dp < -180) dp += 360;

        const psiDeg = p0 + dp * frac;

        ship.position.set(x, Math.sin(t * 1.4 + idx * 0.3) * 0.5, y);
        ship.rotation.y = -psiDeg * Math.PI / 180;

        geom.setDrawRange(0, i0 + 1);
      });

      const animHud = byId('hud-anim');
      const realHud = byId('hud-realt');

      if (animHud) animHud.textContent = animElapsed.toFixed(2) + ' s';

      if (realHud && tArr && tArr.length) {
        realHud.textContent = (phase * tArr[tArr.length - 1]).toFixed(1) + ' s';
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