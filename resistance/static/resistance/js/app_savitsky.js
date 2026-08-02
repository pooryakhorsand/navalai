/**
 * app_savitsky.js
 * NavalAI — Savitsky Planing Hull Solver
 *
 * Optimized for:
 * - lazy Plotly loading
 * - lazy KaTeX loading
 * - request aborting / frontend cache
 * - debounced live updates
 * - low CPU 3D animation (frame-throttled, pauses off-screen)
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.savitskyApi || '/api/v1/maneuvering/savitsky/';

const DEBOUNCE_MS = 160;
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;
const WATER_UPDATE_INTERVAL = 0.08;

// ── Three.js globals ──
let scene, camera, renderer, controls;
let hullGroup, waterPlane, waterGeometry;
let isWireframe = false;
let waveAmp = 0.08;
let clock = null;

let frameDelta = 0;
let lastWaterUpdate = 0;

// ── DOM refs ──
let valAspect, valBetaHud;

// ── App state ──
let state = {
  speed: 13.07,
  weight: 827400,
  beam: 7.315,
  length: 24.38,
  lcg: 10.67,
  vcg: 1.045,
  beta: 15.0,
  epsilon: 0.0,
  Lf: 0.3048,
  sigma: 1.0,
  delta: 5.0,
  H_sig: 1.402,
  wetted_lengths_type: 3,
  roughness_penalty_type: 2
};

let resCache = null;
let responseCache = new Map();
let debounceTimer = null;
let currentView = 'cad';
let chartMode = 'forces';

let activeFetchController = null;
let requestSeq = 0;

// ── Lazy asset bookkeeping ──
const assetPromises = new Map();
let plotlyLoadingPromise = null;
let katexLoadingPromise = null;
let katexRendered = false;

// ─────────────────────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  valAspect  = byId('val-aspect');
  valBetaHud = byId('val-beta-hud');

  initSliders();
  initTheoryModalEvents();
  initViewSwitcher();
  initToolbarEvents();

  if (typeof THREE === 'undefined') {
    setStatus('err', 'THREE.JS MISSING');
  } else {
    init3D();
  }

  balanceAndValidateParameters();
  renderHullShape();
  updateHUD();
  setStatus('ready', 'READY');

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(function () { fetchData(); }, { timeout: 650 });
  } else {
    setTimeout(function () { fetchData(); }, 0);
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

  plotlyLoadingPromise = loadScriptOnce(src).then(function () {
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
  if (!ASSETS.katexJs) return Promise.resolve(); // theory uses plain text — skip
  if (katexLoadingPromise) return katexLoadingPromise;

  const cssP = loadCssOnce(ASSETS.katexCss, { crossOrigin: 'anonymous' });
  const katexP = loadScriptOnce(ASSETS.katexJs, { crossOrigin: 'anonymous' });

  katexLoadingPromise = Promise.all([cssP, katexP])
    .then(function () {
      return loadScriptOnce(ASSETS.katexAutoRender, { crossOrigin: 'anonymous' });
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
// SMART PARAMETER BOUNDING & BALANCING CONTROLLER
// ─────────────────────────────────────────────────────────────
function balanceAndValidateParameters() {
  let changed = false;

  // 1. L/B ratio limits (Savitsky validity, extended 1.5–7)
  const lb = state.length / state.beam;
  const maxLB = 7.0;
  const minLB = 1.5;

  const beamSlider = byId('sl-beam');
  const beamDisp = byId('val-beam');

  if (lb > maxLB) {
    state.beam = state.length / maxLB;
    if (beamSlider) beamSlider.value = state.beam.toFixed(3);
    if (beamDisp) beamDisp.textContent = state.beam.toFixed(2) + ' m';
    changed = true;
  } else if (lb < minLB) {
    state.beam = state.length / minLB;
    if (beamSlider) beamSlider.value = state.beam.toFixed(3);
    if (beamDisp) beamDisp.textContent = state.beam.toFixed(2) + ' m';
    changed = true;
  }

  // 2. LCG must stay ahead of transom line
  const lcgSlider = byId('sl-lcg');
  const lcgDisp = byId('val-lcg');

  if (state.lcg >= state.length) {
    state.lcg = state.length * 0.45;
    if (lcgSlider) lcgSlider.value = state.lcg.toFixed(3);
    if (lcgDisp) lcgDisp.textContent = state.lcg.toFixed(2) + ' m';
    changed = true;
  }

  return changed;
}

// ─────────────────────────────────────────────────────────────
// SLIDERS SYSTEM
// ─────────────────────────────────────────────────────────────
function initSliders() {
  const defs = [
    { id: 'sl-speed',   key: 'speed',   disp: 'val-speed',   fmt: v => v.toFixed(1) + ' m/s' },
    { id: 'sl-weight',  key: 'weight',  disp: 'val-weight',  fmt: v => (v / 1000).toFixed(0) + ' kN' },
    { id: 'sl-beam',    key: 'beam',    disp: 'val-beam',    fmt: v => v.toFixed(2) + ' m' },
    { id: 'sl-length',  key: 'length',  disp: 'val-length',  fmt: v => v.toFixed(1) + ' m' },
    { id: 'sl-lcg',     key: 'lcg',     disp: 'val-lcg',     fmt: v => v.toFixed(2) + ' m' },
    { id: 'sl-vcg',     key: 'vcg',     disp: 'val-vcg',     fmt: v => v.toFixed(2) + ' m' },
    { id: 'sl-beta',    key: 'beta',    disp: 'val-beta',    fmt: v => v.toFixed(1) + '°' },
    { id: 'sl-epsilon', key: 'epsilon', disp: 'val-epsilon', fmt: v => v.toFixed(1) + '°' },
    { id: 'sl-lf',      key: 'Lf',      disp: 'val-lf',      fmt: v => v.toFixed(3) + ' m' },
    { id: 'sl-sigma',   key: 'sigma',   disp: 'val-sigma',   fmt: v => v.toFixed(2) },
    { id: 'sl-delta',   key: 'delta',   disp: 'val-delta',   fmt: v => v.toFixed(1) + '°' },
    { id: 'sl-hsig',    key: 'H_sig',   disp: 'val-hsig',    fmt: v => v.toFixed(2) + ' m' }
  ];

  defs.forEach(function (s) {
    const el   = byId(s.id);
    const disp = byId(s.disp);
    if (!el) return;

    const initial = parseFloat(el.value);
    if (!isNaN(initial)) state[s.key] = initial;
    if (disp) disp.textContent = s.fmt(state[s.key]);

    el.addEventListener('input', function () {
      const v = parseFloat(el.value);
      if (isNaN(v)) return;

      state[s.key] = v;
      balanceAndValidateParameters();

      if (disp) disp.textContent = s.fmt(state[s.key]);
      scheduleUpdate();
    });
  });
}

// ─────────────────────────────────────────────────────────────
// TOGGLE BUTTONS (wetted-length / roughness-penalty type selectors)
// ─────────────────────────────────────────────────────────────
function setWLType(val) {
  state.wetted_lengths_type = val;
  [1, 2, 3].forEach(function (i) {
    const b = byId('wl-' + i);
    if (b) b.classList.toggle('active', i === val);
  });
  scheduleUpdate();
}

function setRPType(val) {
  state.roughness_penalty_type = val;
  [1, 2].forEach(function (i) {
    const b = byId('rp-' + i);
    if (b) b.classList.toggle('active', i === val);
  });
  scheduleUpdate();
}

// ─────────────────────────────────────────────────────────────
// THEORY MODAL
// ─────────────────────────────────────────────────────────────
function initTheoryModalEvents() {
  const overlay = byId('theory-overlay');
  const open    = byId('btn-open-theory');
  const close   = byId('btn-close-theory');
  const start   = byId('btn-start-sim');

  if (open && overlay) {
    open.addEventListener('click', function () {
      overlay.classList.add('active');
      ensureKatexRendered();
    });
  }
  if (close && overlay) close.addEventListener('click', function () { overlay.classList.remove('active'); });
  if (start && overlay) start.addEventListener('click', function () { overlay.classList.remove('active'); });
}

// ─────────────────────────────────────────────────────────────
// VIEW SWITCHER
// ─────────────────────────────────────────────────────────────
function initViewSwitcher() {
  const btnCad   = byId('toggle-cad');
  const btnPlots = byId('toggle-plots');
  const btnTable = byId('toggle-table');

  const panelCad   = document.querySelector('.visualizer-panel');
  const panelPlots = document.querySelector('.chart-panel');
  const panelTable = document.querySelector('.table-panel');

  if (!btnCad || !btnPlots || !btnTable || !panelCad || !panelPlots || !panelTable) return;

  function switchView(view) {
    currentView = view;

    panelCad.classList.toggle('is-hidden',   view !== 'cad');
    panelPlots.classList.toggle('is-hidden', view !== 'plots');
    panelTable.classList.toggle('is-hidden', view !== 'table');

    btnCad.classList.toggle('active-view',   view === 'cad');
    btnPlots.classList.toggle('active-view', view === 'plots');
    btnTable.classList.toggle('active-view', view === 'table');

    if (view === 'plots') {
      renderPlot();
    } else if (view === 'table') {
      renderTable();
    } else {
      onWindowResize();
    }
  }

  btnCad.addEventListener('click',   function () { switchView('cad'); });
  btnPlots.addEventListener('click', function () { switchView('plots'); });
  btnTable.addEventListener('click', function () { switchView('table'); });

  const modeEl = byId('chart-mode');
  if (modeEl) {
    modeEl.addEventListener('change', function (e) {
      chartMode = e.target.value;
      if (currentView === 'plots') renderPlot();
    });
  }
}

// ─────────────────────────────────────────────────────────────
// TOOLBAR
// ─────────────────────────────────────────────────────────────
function initToolbarEvents() {
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

  on('btn-reset-view', 'click', frameCamera);

  on('btn-wireframe', 'click', function () {
    isWireframe = !isWireframe;
    renderHullShape();
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.download = 'NavalAI_Savitsky_L' + state.length + 'm.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-export-csv', 'click', exportCSV);
  on('btn-export-curve-csv', 'click', exportCSV);
  on('btn-export-full-csv', 'click', exportCSV);

  // Wetted-length-method and roughness-penalty toggle buttons.
  [1, 2, 3].forEach(function (i) {
    on('wl-' + i, 'click', function () { setWLType(i); });
  });

  [1, 2].forEach(function (i) {
    on('rp-' + i, 'click', function () { setRPType(i); });
  });
}

// ─────────────────────────────────────────────────────────────
// UPDATE SCHEDULER
// ─────────────────────────────────────────────────────────────
function scheduleUpdate() {
  renderHullShape();
  updateHUD();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fetchData, DEBOUNCE_MS);
}

function updateHUD() {
  const lb = (state.length / state.beam).toFixed(2);
  if (valAspect)  valAspect.textContent  = lb;
  if (valBetaHud) valBetaHud.textContent = state.beta.toFixed(1) + '°';

  const hudLb   = byId('hud-lb');
  const hudBeta = byId('hud-beta');
  if (hudLb)   hudLb.textContent   = lb;
  if (hudBeta) hudBeta.textContent = state.beta.toFixed(1);
}

function setStatus(mode, text) {
  const dot = byId('status-dot');
  const txt = byId('status-text');
  if (dot) dot.className = 'status-dot ' + (mode === 'ready' ? 'ok' : mode);
  if (txt) txt.textContent = text;
}

// ─────────────────────────────────────────────────────────────
// API CORE (POST) with abort + cache
// ─────────────────────────────────────────────────────────────
function buildPayload() {
  return {
    speed:   state.speed,
    weight:  state.weight,
    beam:    state.beam,
    length:  state.length,
    lcg:     state.lcg,
    vcg:     state.vcg,
    beta:    state.beta,
    epsilon: state.epsilon,
    Lf:      state.Lf,
    sigma:   state.sigma,
    delta:   state.delta,
    H_sig:   state.H_sig,
    wetted_lengths_type:    state.wetted_lengths_type,
    roughness_penalty_type: state.roughness_penalty_type
  };
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

async function fetchData() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  balanceAndValidateParameters();

  const payload = buildPayload();
  const key = stableStringify(payload);
  const seq = ++requestSeq;

  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }

  // Frontend cache hit
  if (responseCache.has(key)) {
    resCache = responseCache.get(key);
    setStatus('ok', 'READY (cached)');
    updateTelemetry();
    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTable();
    return;
  }

  setStatus('loading', 'COMPUTING');
  const load = byId('loading-overlay');
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

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      throw new Error(errJson.message || 'HTTP ' + resp.status);
    }

    const json = await resp.json();
    if (!json || !json.success) {
      throw new Error((json && json.message) || 'API failure');
    }

    if (seq !== requestSeq) return;

    resCache = json.data;

    if (responseCache.size > 20) {
      responseCache.delete(responseCache.keys().next().value);
    }
    responseCache.set(key, resCache);

    setStatus('ok', 'READY');
    updateTelemetry();
    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTable();

  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq !== requestSeq) return;

    console.error('NavalAI Savitsky error:', err.message);
    setStatus('err', err.message && err.message.length < 60 ? err.message : 'ERROR');

    ['t-fnb', 't-tau', 't-wsa', 't-lambda', 't-thrust', 't-power', 't-hp'].forEach(function (id) {
      const el = byId(id);
      if (el) { el.textContent = 'ERR'; el.classList.add('error-state'); }
    });

  } finally {
    if (seq === requestSeq) {
      if (load) load.classList.remove('active');
      activeFetchController = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TELEMETRY
// ─────────────────────────────────────────────────────────────
function updateTelemetry() {
  if (!resCache) return;
  const d = resCache;

  function setT(id, val) {
    const el = byId(id);
    if (!el) return;
    el.classList.remove('error-state');
    el.textContent = val;
  }

  setT('t-fnb',    d.vessel_specs.fn_beam.toFixed(3));
  setT('t-tau',    d.equilibrium_attitude.trim_tau_deg.toFixed(2) + '°');
  setT('t-wsa',    d.running_geometry.wetted_surface_area_m2.toFixed(1) + ' m²');
  setT('t-lambda', d.running_geometry.mean_wetted_length_ratio_lambda.toFixed(3));
  setT('t-thrust', (d.power_metrics.thrust_magnitude_n / 1000).toFixed(1) + ' kN');
  setT('t-power',  d.power_metrics.effective_power_kw.toFixed(1) + ' kW');
  setT('t-hp',     d.power_metrics.effective_horsepower.toFixed(0) + ' HP');
}

// ─────────────────────────────────────────────────────────────
// PLOTLY (lazy-loaded)
// ─────────────────────────────────────────────────────────────
function makeBaseLayout() {
  return {
    paper_bgcolor: '#060d18',
    plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 72, r: 25, t: 30, b: 52 },
    xaxis: { gridcolor: '#1e293b', linecolor: '#334155', tickfont: { size: 10 } },
    yaxis: { gridcolor: '#1e293b', linecolor: '#334155', rangemode: 'tozero' },
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
      .then(function () { if (currentView === 'plots') renderPlot(); })
      .catch(function (err) {
        console.error(err);
        target.innerHTML = '<div class="data-table-empty">Plot engine failed to load.</div>';
      });
    return;
  }

  const config = { displaylogo: false, responsive: true };
  const layout = makeBaseLayout();

  if (!resCache) {
    Plotly.react(target, [], Object.assign(layout, {
      annotations: [{
        text: 'Awaiting solver data…', showarrow: false,
        font: { color: '#94a3b8', size: 13 }, xref: 'paper', yref: 'paper', x: 0.5, y: 0.5
      }]
    }), config);
    return;
  }

  const d = resCache;
  let traces = [];

  if (chartMode === 'forces') {
    const fh  = d.forces_breakdown.hydrodynamic_force_n;
    const ff  = d.forces_breakdown.skin_friction_n;
    const ffl = d.forces_breakdown.flap_force_n;
    const fn  = d.forces_breakdown.net_force_n;
    const labels = ['Horizontal', 'Vertical', 'Moment'];

    const makeBar = (name, data, color) => ({
      x: labels, y: data, type: 'bar', name: name,
      marker: { color: color, opacity: 0.82 }
    });

    traces = [
      makeBar('Hydrodynamic (N)', fh, '#38bdf8'),
      makeBar('Skin Friction (N)', ff, '#f59e0b'),
      makeBar('Flap Force (N)', ffl, '#a78bfa'),
      makeBar('Net Force (N)', fn, '#22c55e')
    ];
    layout.barmode = 'group';
    layout.yaxis.title = 'Force (N) / Moment (N·m)';
    layout.xaxis.title = 'Component Direction';
    layout.title = { text: 'Force Component Breakdown', font: { color: '#c8a84b', size: 13 }, x: 0.5 };

  } else if (chartMode === 'power') {
    const cats = ['Thrust (N)', 'Effective Power (kW)', 'Horsepower'];
    const vals = [
      d.power_metrics.thrust_magnitude_n,
      d.power_metrics.effective_power_kw,
      d.power_metrics.effective_horsepower
    ];
    traces = [{
      x: cats, y: vals, type: 'bar',
      marker: { color: ['#4ed0e1', '#f59e0b', '#22c55e'], opacity: 0.85 },
      name: 'Power Metrics'
    }];
    layout.yaxis.title = 'Value';
    layout.title = { text: 'Propulsion Performance', font: { color: '#c8a84b', size: 13 }, x: 0.5 };

  } else if (chartMode === 'geometry') {
    const rg = d.running_geometry;
    const cats = ['L_K (m)', 'L_C (m)', 'λ', 'Draft at Transom (m)', 'Wetted Area (m²)'];
    const vals = [
      rg.keel_wetted_length_lk,
      rg.chine_wetted_length_lc,
      rg.mean_wetted_length_ratio_lambda,
      rg.draft_at_transom_m,
      rg.wetted_surface_area_m2
    ];
    traces = [{
      x: cats, y: vals, type: 'bar',
      marker: { color: '#a78bfa', opacity: 0.85 },
      name: 'Running Geometry'
    }];
    layout.yaxis.title = 'Value';
    layout.title = { text: 'Running Geometry Data', font: { color: '#c8a84b', size: 13 }, x: 0.5 };

  } else if (chartMode === 'seaway') {
    const sw = d.seaway_behavior;
    const cats = ['Added Resistance (N)', 'CG Acceleration (g)', 'Bow Acceleration (g)'];
    const vals = [sw.added_resistance_waves_n, sw.cg_acceleration_g, sw.bow_acceleration_g];
    traces = [{
      x: cats, y: vals, type: 'bar',
      marker: { color: '#fb7185', opacity: 0.85 },
      name: 'Seaway'
    }];
    layout.yaxis.title = 'Value';
    layout.title = { text: 'Seaway Behaviour Responses', font: { color: '#c8a84b', size: 13 }, x: 0.5 };
  }

  Plotly.react(target, traces, layout, config);
}

// ─────────────────────────────────────────────────────────────
// TABLE
// ─────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTable() {
  const target = byId('table-target');
  if (!target) return;

  if (!resCache) {
    target.innerHTML = '<div class="data-table-empty">Awaiting solver data from API…</div>';
    return;
  }
  const d = resCache;

  function tblBlock(title, rows) {
    const rowsHtml = rows.map(function (r) {
      return '<tr><td>' + escHtml(r[0]) + '</td><td>' + escHtml(r[1]) + '</td>' +
             '<td style="color:var(--muted);font-size:10px">' + escHtml(r[2]) + '</td></tr>';
    }).join('');
    return '<div class="tbl-block"><div class="tbl-title">' + title + '</div>' +
      '<table class="data-table"><thead><tr><th>Parameter</th><th>Value</th><th>Unit</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table></div>';
  }

  const cfg = [
    ['Speed', state.speed.toFixed(2), 'm/s'],
    ['Weight', state.weight.toFixed(0), 'N'],
    ['Beam', state.beam.toFixed(3), 'm'],
    ['Length', state.length.toFixed(2), 'm'],
    ['L/B Ratio', (state.length / state.beam).toFixed(2), '—'],
    ['LCG', state.lcg.toFixed(3), 'm'],
    ['VCG', state.vcg.toFixed(3), 'm'],
    ['Deadrise β', state.beta.toFixed(1), '°'],
    ['Thrust Angle ε', state.epsilon.toFixed(1), '°'],
    ['Flap Chord Lf', state.Lf.toFixed(4), 'm'],
    ['Flap Span σ', state.sigma.toFixed(2), '—'],
    ['Flap Deflect. δ', state.delta.toFixed(1), '°'],
    ['H_sig', state.H_sig.toFixed(3), 'm'],
    ['Wetted Length Method', state.wetted_lengths_type, '—'],
    ['Roughness Penalty', state.roughness_penalty_type, '—']
  ];

  const vs = d.vessel_specs;
  const ea = d.equilibrium_attitude;
  const rg = d.running_geometry;
  const fb = d.forces_breakdown;
  const pm = d.power_metrics;
  const sw = d.seaway_behavior;

  const vesselRows = [
    ['Fn Beam',        vs.fn_beam.toFixed(4),             '—'],
    ['Fn Volume',      vs.fn_volume.toFixed(4),           '—'],
    ['Volume Displ.',  vs.volume_displacement.toFixed(2), 'm³'],
    ['Mass',           vs.mass_kg.toFixed(1),             'kg']
  ];
  const attRows = [
    ['Trim τ',  ea.trim_tau_deg.toFixed(3), '°'],
    ['Heave z', ea.heave_z_wl_m.toFixed(4), 'm']
  ];
  const geomRows = [
    ['L_K (keel wetted)',  rg.keel_wetted_length_lk.toFixed(3), 'm'],
    ['L_C (chine wetted)', rg.chine_wetted_length_lc.toFixed(3), 'm'],
    ['λ mean',             rg.mean_wetted_length_ratio_lambda.toFixed(4), '—'],
    ['Transom Draft',      rg.draft_at_transom_m.toFixed(4), 'm'],
    ['Wetted Area',        rg.wetted_surface_area_m2.toFixed(2), 'm²']
  ];

  function fvec(arr) { return arr ? arr.map(v => v.toFixed(1)).join(' / ') : '—'; }
  const forceRows = [
    ['Hydrodynamic (H/V/M)',  fvec(fb.hydrodynamic_force_n), 'N'],
    ['Skin Friction (H/V/M)', fvec(fb.skin_friction_n),      'N'],
    ['Flap Force (H/V/M)',    fvec(fb.flap_force_n),         'N'],
    ['Net Force (H/V/M)',     fvec(fb.net_force_n),          'N']
  ];
  const powerRows = [
    ['Thrust',     (pm.thrust_magnitude_n / 1000).toFixed(2), 'kN'],
    ['Eff. Power', pm.effective_power_kw.toFixed(1),          'kW'],
    ['Horsepower', pm.effective_horsepower.toFixed(0),        'HP']
  ];
  const seaRows = [
    ['Added Resistance', sw.added_resistance_waves_n.toFixed(1), 'N'],
    ['CG Acceleration',  sw.cg_acceleration_g.toFixed(4),        'g'],
    ['Bow Acceleration', sw.bow_acceleration_g.toFixed(4),       'g']
  ];

  target.innerHTML =
    '<div class="tables-grid">' +
      tblBlock('Hull Configuration', cfg) +
      tblBlock('Vessel Specs', vesselRows) +
      tblBlock('Equilibrium Attitude', attRows) +
      tblBlock('Running Geometry', geomRows) +
      tblBlock('Force Breakdown (H / V / Moment)', forceRows) +
      tblBlock('Power Metrics', powerRows) +
      tblBlock('Seaway Behaviour', seaRows) +
    '</div>';
}

// ─────────────────────────────────────────────────────────────
// CSV EXPORT
// ─────────────────────────────────────────────────────────────
function exportCSV() {
  if (!resCache) { console.warn('No data — run solver first.'); return; }
  const d = resCache;

  let csv = 'NavalAI - Savitsky Planing Hull Report\n\nHULL CONFIGURATION\nParameter,Value,Unit\n';
  csv += 'Speed,' + state.speed + ',m/s\n';
  csv += 'Weight,' + state.weight + ',N\n';
  csv += 'Beam,' + state.beam + ',m\n';
  csv += 'Length,' + state.length + ',m\n';
  csv += 'LCG,' + state.lcg + ',m\n';
  csv += 'VCG,' + state.vcg + ',m\n';
  csv += 'Deadrise,' + state.beta + ',deg\n';
  csv += 'H_sig,' + state.H_sig + ',m\n\n';

  csv += 'VESSEL SPECS\n';
  const vs = d.vessel_specs;
  csv += 'Fn_Beam,' + vs.fn_beam + ',\nFn_Volume,' + vs.fn_volume + ',\n';
  csv += 'Volume_Displ,' + vs.volume_displacement + ',m3\nMass,' + vs.mass_kg + ',kg\n\n';

  csv += 'EQUILIBRIUM\nTrim_tau,' + d.equilibrium_attitude.trim_tau_deg + ',deg\n';
  csv += 'Heave_z,' + d.equilibrium_attitude.heave_z_wl_m + ',m\n\n';

  csv += 'RUNNING GEOMETRY\n';
  const rg = d.running_geometry;
  csv += 'L_K,' + rg.keel_wetted_length_lk + ',m\n';
  csv += 'L_C,' + rg.chine_wetted_length_lc + ',m\n';
  csv += 'Lambda,' + rg.mean_wetted_length_ratio_lambda + ',\n';
  csv += 'Transom_Draft,' + rg.draft_at_transom_m + ',m\n';
  csv += 'Wetted_Area,' + rg.wetted_surface_area_m2 + ',m2\n\n';

  csv += 'POWER METRICS\n';
  csv += 'Thrust,' + d.power_metrics.thrust_magnitude_n + ',N\n';
  csv += 'Eff_Power,' + d.power_metrics.effective_power_kw + ',kW\n';
  csv += 'Horsepower,' + d.power_metrics.effective_horsepower + ',HP\n\n';

  csv += 'SEAWAY\n';
  csv += 'Added_Resistance,' + d.seaway_behavior.added_resistance_waves_n + ',N\n';
  csv += 'CG_Acceleration,' + d.seaway_behavior.cg_acceleration_g + ',g\n';
  csv += 'Bow_Acceleration,' + d.seaway_behavior.bow_acceleration_g + ',g\n';

  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'Savitsky_Report_L' + state.length + 'm.csv';
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
  if (!container) { console.error('#canvas-3d-target not found'); return; }

  clock = new THREE.Clock();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1f35);

  camera = new THREE.PerspectiveCamera(
    45,
    Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
    0.1,
    2000
  );

  renderer = new THREE.WebGLRenderer({
    antialias: true,
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

  scene.add(new THREE.AmbientLight(0x3a4b6e, 0.7));
  const sun = new THREE.DirectionalLight(0xfff5df, 1.4);
  sun.position.set(80, 120, 60);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x4ed0e1, 0.5);
  fill.position.set(-40, -80, -40);
  scene.add(fill);

  waterGeometry = new THREE.PlaneGeometry(400, 400, 60, 60);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x4ed0e1, roughness: 0.1, metalness: 0.5,
    flatShading: true, transparent: true, opacity: 0.52,
    side: THREE.DoubleSide
  });
  waterPlane = new THREE.Mesh(waterGeometry, waterMat);
  waterPlane.rotation.x = -Math.PI / 2;
  scene.add(waterPlane);

  hullGroup = new THREE.Group();
  scene.add(hullGroup);

  frameCamera();
  window.addEventListener('resize', onWindowResize, { passive: true });
  animate();
}

function frameCamera() {
  if (!camera || !controls) return;
  const L = state.length;
  camera.position.set(L * 0.8, L * 0.45, L * 1.1);
  controls.target.set(0, L * 0.04, 0);
  controls.update();
}

// ═════════════════════════════════════════════════════════════
// THREE.JS — PRISMATIC PLANING HULL (corrected geometry)
// ═════════════════════════════════════════════════════════════
//
// Cross-section layout (7 vertices per station):
//   0: keel (bottom centerline)
//   1: port mid-panel   (deadrise surface between keel and chine)
//   2: stbd mid-panel
//   3: port chine
//   4: stbd chine
//   5: port deck edge
//   6: stbd deck edge
//
// Fixes applied vs. the old version:
//   - Plan-view beam actually tapers to a point at the stem (bScale
//     goes to 0), instead of bottoming out around 0.55 — this is what
//     gives the bow its pointed look instead of a rounded box.
//   - Keel rocker: the keel line rises toward the bow instead of
//     running perfectly straight fore-and-aft.
//   - Sheer: the deck edge line also rises toward the bow (and very
//     slightly at the transom corners), instead of a flat deckline.
//   - Midbody is now perfectly parallel/flat (no stray sine wobble),
//     matching a real prismatic planing hull's straight buttock lines.
function renderHullShape() {
  if (!hullGroup || typeof THREE === 'undefined') return;

  while (hullGroup.children.length) {
    const obj = hullGroup.children[0];
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(function (m) { m.dispose(); });
      else obj.material.dispose();
    }
    hullGroup.remove(obj);
  }

  const L    = state.length;
  const B    = state.beam;
  const beta = state.beta * (Math.PI / 180);
  const T    = B * 0.5 * Math.tan(beta) + state.vcg * 0.25;
  const hH   = T * 1.8;
  const deckY = hH - T;

  waveAmp = Math.max(0.04, L * 0.008);

  function M(c, r, m) {
    return new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, wireframe: isWireframe });
  }

  const mHull  = M(0x1a3a5e, 0.45, 0.45);
  const mBoot  = M(0x4ed0e1, 0.2, 0.6);
  const mDeck  = M(0x1e2d3e, 0.7, 0.1);
  const mAcc   = M(0xe8e5da, 0.35, 0.05);
  const mGlass = new THREE.MeshStandardMaterial({
    color: 0x0c1a28, emissive: 0x162030, roughness: 0.05, metalness: 1.0,
    transparent: true, opacity: 0.82, wireframe: isWireframe
  });
  const mExhaust = M(0x30404e, 0.5, 0.5);
  const mFlap    = M(0xc8a84b, 0.3, 0.7);

  // Smootherstep easing (0 -> 1, zero slope at both ends) — used for
  // every taper/rise so there are no visible creases at zone boundaries.
  function smoother(u) { return u * u * u * (u * (u * 6 - 15) + 10); }

  const hGeo = new THREE.BufferGeometry();
  const segs = 100;
  const positions = [];
  const indices   = [];
  const vPerSec   = 7;

  const tau = resCache ? resCache.equilibrium_attitude.trim_tau_deg * (Math.PI / 180) : 0.03;

  // Typical planing-hull proportions: fine pointed entry forward,
  // full parallel midbody, flat wide transom aft.
  const bowZone   = 0.30;        // fraction of length used for the bow taper
  const rockerAmt = T * 1.6;     // keel rise at the stem
  const sheerAmt  = T * 0.9;     // deck-edge rise at the bow

  for (let si = 0; si <= segs; si++) {
    const t = si / segs;           // 0 = bow (stem), 1 = transom
    const x = -L / 2 + t * L;

    // ── Plan-view beam: pointed bow, parallel midbody, tiny transom taper ──
    let bScale;
    if (t < bowZone) {
      const u = t / bowZone;
      bScale = smoother(u);                 // 0 at stem -> 1 at start of midbody
    } else if (t > 0.94) {
      const u = (t - 0.94) / 0.06;
      bScale = 1.0 - 0.04 * smoother(u);    // very slight transom taper
    } else {
      bScale = 1.0;                          // parallel midbody
    }
    const b2 = (B / 2) * Math.max(bScale, 0.001);

    // ── Rocker: keel rises toward the bow ──
    let rocker = 0;
    if (t < bowZone) {
      const u = 1 - t / bowZone;
      rocker = rockerAmt * smoother(u);
    }

    // ── Sheer: deck edge rises toward the bow, and slightly at the transom ──
    let sheer = 0;
    if (t < 0.45) {
      const u = 1 - t / 0.45;
      sheer = sheerAmt * smoother(u) * 0.6;
    }
    if (t > 0.9) {
      const u = (t - 0.9) / 0.1;
      sheer += sheerAmt * 0.15 * smoother(u);
    }

    const trimOffset = (x - (-L / 2)) * Math.tan(tau) * 0.5;
    const yBase = trimOffset;

    const keelY     = yBase - T + rocker;
    const chineY    = b2 * Math.tan(beta);
    const chineTopY = keelY + chineY + rocker * 0.15;

    const midB = b2 * 0.55;
    const midY = keelY + (chineTopY - keelY) * 0.42;

    const deckEdgeY = yBase + deckY + sheer;

    positions.push(x, keelY,        0);      // 0: keel
    positions.push(x, midY,        -midB);   // 1: port mid-panel
    positions.push(x, midY,         midB);   // 2: stbd mid-panel
    positions.push(x, chineTopY,   -b2);      // 3: port chine
    positions.push(x, chineTopY,    b2);      // 4: stbd chine
    positions.push(x, deckEdgeY,   -b2);      // 5: port deck edge
    positions.push(x, deckEdgeY,    b2);      // 6: stbd deck edge
  }

  function quad(a, b, a2, b2i) {
    indices.push(a, a2, b2i,  a, b2i, b);
  }

  for (let si = 0; si < segs; si++) {
    const base = si * vPerSec;
    const next = (si + 1) * vPerSec;

    // Keel -> port mid-panel (bottom-port deadrise panel, inner)
    quad(base + 0, next + 0, base + 1, next + 1);
    // Port mid-panel -> port chine (bottom-port deadrise panel, outer)
    quad(base + 1, next + 1, base + 3, next + 3);
    // Keel -> stbd mid-panel
    quad(base + 0, base + 2, next + 0, next + 2);
    // Stbd mid-panel -> stbd chine
    quad(base + 2, base + 4, next + 2, next + 4);
    // Port chine -> port deck edge (topside)
    quad(base + 3, next + 3, base + 5, next + 5);
    // Stbd chine -> stbd deck edge (topside)
    quad(base + 4, base + 6, next + 4, next + 6);
  }

  // Transom cap (last section) — close off the stern face
  const lastBase = segs * vPerSec;
  indices.push(
    lastBase + 0, lastBase + 4, lastBase + 2,
    lastBase + 0, lastBase + 3, lastBase + 4,
    lastBase + 0, lastBase + 6, lastBase + 3,
    lastBase + 0, lastBase + 1, lastBase + 6,
    lastBase + 1, lastBase + 5, lastBase + 6,
    lastBase + 1, lastBase + 2, lastBase + 5
  );

  hGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  hGeo.setIndex(indices);
  hGeo.computeVertexNormals();

  hullGroup.add(new THREE.Mesh(hGeo, mHull));

  const boot = new THREE.Mesh(new THREE.BoxGeometry(L * 0.99, T * 0.06, B * 1.002), mBoot);
  boot.position.y = 0;
  hullGroup.add(boot);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(L * 0.9, T * 0.04, B * 0.9), mDeck);
  deck.position.set(-L * 0.02, deckY + T * 0.02, 0);
  hullGroup.add(deck);

  const cabL = L * 0.28, cabH = hH * 0.7, cabB = B * 0.65, cabX = L * 0.10;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(cabL, cabH, cabB), mAcc);
  cab.position.set(cabX, deckY + cabH / 2, 0);
  hullGroup.add(cab);

  const winH = cabH * 0.35;
  const win  = new THREE.Mesh(new THREE.BoxGeometry(cabL * 0.92, winH, cabB * 1.02), mGlass);
  win.position.set(cabX + cabL * 0.04, deckY + cabH * 0.72, 0);
  hullGroup.add(win);

  const exR = B * 0.04;
  [-B * 0.22, B * 0.22].forEach(function (side) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(exR * 0.7, exR, hH * 0.3, 10), mExhaust);
    ex.position.set(-L * 0.28, deckY + hH * 0.15, side);
    hullGroup.add(ex);
  });

  if (state.delta > 0 && state.Lf > 0) {
    const flapGeo = new THREE.BoxGeometry(state.Lf * 4, T * 0.04, B * state.sigma * 0.9);
    const flap = new THREE.Mesh(flapGeo, mFlap);
    flap.rotation.z = state.delta * (Math.PI / 180);
    flap.position.set(-L * 0.5 + state.Lf * 2, -T * 0.55, 0);
    hullGroup.add(flap);
  }

  const draftLine = new THREE.Mesh(
    new THREE.BoxGeometry(L * 1.01, T * 0.012, B * 1.03),
    new THREE.MeshStandardMaterial({ color: 0x4ed0e1, emissive: 0x4ed0e1, emissiveIntensity: 0.35 })
  );
  draftLine.position.y = -T * 0.5;
  hullGroup.add(draftLine);

  updateHUD();
}

// ═════════════════════════════════════════════════════════════
// THREE.JS — ANIMATION (frame-throttled, pauses off-screen)
// ═════════════════════════════════════════════════════════════
function animate() {
  requestAnimationFrame(animate);
  if (!clock) return;

  const dt = Math.min(clock.getDelta(), 0.1);

  // Save CPU when tab hidden or CAD not visible
  if (document.hidden || currentView !== 'cad') return;

  frameDelta += dt;
  if (frameDelta < FRAME_INTERVAL) {
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
    return;
  }
  frameDelta = frameDelta % FRAME_INTERVAL;

  const t = clock.getElapsedTime();

  if (waterGeometry && (t - lastWaterUpdate) > WATER_UPDATE_INTERVAL) {
    const p = waterGeometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i), v = p.getY(i);
      const z = Math.sin(u * 0.12 + t * 2.2) * waveAmp
              + Math.cos(v * 0.09 + t * 1.7) * waveAmp * 0.7
              + Math.sin((u + v) * 0.18 + t * 3.1) * waveAmp * 0.35;
      p.setZ(i, z);
    }
    waterGeometry.computeVertexNormals();
    p.needsUpdate = true;
    lastWaterUpdate = t;
  }

  if (hullGroup) {
    const tau = resCache ? resCache.equilibrium_attitude.trim_tau_deg * (Math.PI / 180) : 0.03;
    hullGroup.rotation.z = tau + Math.cos(t * 2.1) * 0.008;
    hullGroup.position.y = Math.sin(t * 1.9) * waveAmp * 0.5;
    hullGroup.rotation.x = Math.sin(t * 1.3) * 0.005;
  }

  if (controls) controls.update();
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