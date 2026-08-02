/**
 * app_B.js
 * NavalAI — Wageningen B-Series Propeller Open-Water Solver
 *
 * Optimized for:
 * - 100% client-side computation (zero server load)
 * - lazy Plotly loading
 * - lazy KaTeX loading (theory modal only)
 * - debounced slider recomputation
 * - result caching per parameter hash
 * - FPS-capped 3D animation
 * - Data Table view (raw numerical output)
 * - Physically-valid curve truncation (fixes eta cliff artifact)
 */

'use strict';

// ═════════════════════════════════════════════════════════════
// CONSTANTS
// ═════════════════════════════════════════════════════════════
const ASSETS = window.NAVALAI_ASSETS || {};

const DEBOUNCE_MS      = 120;
const CURVE_POINTS     = 60;
const TELEM_POINTS     = 120;
const J_MAX            = 1.6;
const TARGET_FPS       = 45;
const FRAME_INTERVAL   = 1.0 / TARGET_FPS;
const PARTICLE_COUNT   = 900;

// Domain validity limits (Oosterveld & Van Oossanen regression range)
const LIMITS = {
  Z:   { min: 2, max: 7 },
  EAR: { min: 0.30, max: 1.05 },
  PD:  { min: 0.50, max: 1.40 },
  Re:  { min: 2000000, max: 9000000 }
};

// Combination that is geometrically invalid: too many blades with too little
// expanded area (blades would physically overlap at the root).
function isInvalidCombo(Z, EAR) {
  if (Z >= 6 && EAR < 0.45) return true;
  return false;
}

const SLIDER_DEFS = [
  { id: 'param-blades', key: 'Z',   disp: 'val-blades', parse: parseInt,   fmt: v => String(v) },
  { id: 'param-dar',    key: 'EAR', disp: 'val-dar',    parse: parseFloat, fmt: v => v.toFixed(2) },
  { id: 'param-pmin',   key: 'Pmin',disp: 'val-pmin',   parse: parseFloat, fmt: v => v.toFixed(2) },
  { id: 'param-pmax',   key: 'Pmax',disp: 'val-pmax',   parse: parseFloat, fmt: v => v.toFixed(2) },
  { id: 'param-re',     key: 'Re',  disp: 'val-re',     parse: parseInt,   fmt: v => v.toLocaleString() }
];

// Radial blade profile (Wageningen B geometry envelope)
const RADIAL_STATIONS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];
const CHORD_FACTORS   = [0.182, 0.218, 0.245, 0.264, 0.273, 0.272, 0.257, 0.222, 0.180, 0.000];
const THICK_FACTORS   = [0.045, 0.039, 0.034, 0.029, 0.024, 0.019, 0.015, 0.010, 0.007, 0.002];

// Oosterveld & Van Oossanen 1975 — 47-term open-water regression
// [C_Kq, s, t, u, v, C_Kt, p, q, r, s]
const COEFFS = [
  [0.00379368, 0, 0, 0, 0,  0.00880496, 0, 0, 0, 0],
  [0.00886523, 2, 0, 0, 0, -0.204554,   1, 0, 0, 0],
  [-0.032241,  1, 1, 0, 0,  0.166351,   0, 1, 0, 0],
  [0.00344778, 0, 2, 0, 0,  0.158114,   0, 2, 0, 0],
  [-0.0408811, 0, 1, 1, 0, -0.147581,   2, 0, 1, 0],
  [-0.108009,  1, 1, 1, 0, -0.481497,   1, 1, 1, 0],
  [-0.0885381, 2, 1, 1, 0,  0.415437,   0, 2, 1, 0],
  [0.188561,   0, 2, 1, 0,  0.0144043,  0, 0, 0, 1],
  [-0.00370871,1, 0, 0, 1, -0.0530054,  2, 0, 0, 1],
  [0.00513696, 0, 1, 0, 1,  0.0143481,  0, 1, 0, 1],
  [0.0209449,  1, 1, 0, 1,  0.0606826,  1, 1, 0, 1],
  [0.00474319, 2, 1, 0, 1, -0.0125894,  0, 0, 1, 1],
  [-0.00723408,2, 0, 1, 1,  0.0109689,  1, 0, 1, 1],
  [0.00438388, 1, 1, 1, 1, -0.133698,   0, 3, 0, 0],
  [-0.0269403, 0, 2, 1, 1,  0.00638407, 0, 6, 0, 0],
  [0.0558082,  3, 0, 1, 0, -0.00132718, 2, 6, 0, 0],
  [0.0161886,  0, 3, 1, 0,  0.168496,   3, 0, 1, 0],
  [0.00318086, 1, 3, 1, 0, -0.0507214,  0, 0, 2, 0],
  [0.015896,   0, 0, 2, 0,  0.0854559,  2, 0, 2, 0],
  [0.0471729,  1, 0, 2, 0, -0.0504475,  3, 0, 2, 0],
  [0.0196283,  3, 0, 2, 0,  0.010465,   1, 6, 2, 0],
  [-0.0502782, 0, 1, 2, 0, -0.00648272, 2, 6, 2, 0],
  [-0.030055,  3, 1, 2, 0, -0.00841728, 0, 3, 0, 1],
  [0.0417122,  2, 2, 2, 0,  0.0168424,  1, 3, 0, 1],
  [-0.0397722, 0, 3, 2, 0, -0.00102296, 3, 3, 0, 1],
  [-0.00350024,0, 6, 2, 0, -0.0317791,  0, 3, 1, 1],
  [-0.0106854, 3, 0, 0, 1,  0.018604,   1, 0, 2, 1],
  [0.00110903, 3, 3, 0, 1, -0.00410798, 0, 2, 2, 1],
  [-0.000313912,0,6, 0, 1, -0.000606848,0, 0, 0, 2],
  [0.0035985,  3, 0, 1, 1, -0.0049819,  1, 0, 0, 2],
  [-0.00142121,0, 6, 1, 1,  0.0025983,  2, 0, 0, 2],
  [-0.00383637,1, 0, 2, 1, -0.000560528,3, 0, 0, 2],
  [0.0126803,  0, 2, 2, 1, -0.00163652, 1, 2, 0, 2],
  [-0.00318278,2, 3, 2, 1, -0.000328787,1, 6, 0, 2],
  [0.00334268, 0, 6, 2, 1,  0.000116502,2, 6, 0, 2],
  [-0.00183491,1, 1, 0, 2,  0.000690904,0, 0, 1, 2],
  [0.000112451,3, 2, 0, 2,  0.00421749, 0, 3, 1, 2],
  [-0.0000297228,3,6,0, 2,  0.0000565229,3,6, 1, 2],
  [0.000269551,1, 0, 1, 2, -0.00146564, 0, 3, 2, 2],
  [0.00083265, 2, 0, 1, 2,  0, 0, 0, 0, 0],
  [0.00155334, 0, 2, 1, 2,  0, 0, 0, 0, 0],
  [0.000302683,0, 6, 1, 2,  0, 0, 0, 0, 0],
  [-0.0001843, 0, 0, 2, 2,  0, 0, 0, 0, 0],
  [-0.000425399,0,3, 2, 2,  0, 0, 0, 0, 0],
  [0.0000869243,3,3, 2, 2,  0, 0, 0, 0, 0],
  [-0.0004689, 0, 6, 2, 2,  0, 0, 0, 0, 0],
  [0.0000554194,1,6, 2, 2,  0, 0, 0, 0, 0]
];

// ═════════════════════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════════════════════
let state = {
  Z: 4, EAR: 0.80, Pmin: 0.50, Pmax: 1.40, Re: 2000000
};

let currentView   = 'cad';   // 'cad' | 'plots' | 'table'
let chartMode     = 'all';
let isWireframe   = false;
let solveCache    = new Map();       // param-hash -> { telem, curves }
let lastSolve     = null;            // most recent solve output
let debounceTimer = null;

// THREE.js handles
let scene, camera, renderer, controls, clock;
let propellerGroup, bladeGroup, hubMesh;
let flowParticles, particleGeometry, particlePositions, particleLifetimes;
let frameDelta = 0;

// Lazy assets
const assetPromises = new Map();
let plotlyLoadingPromise = null;
let katexLoadingPromise  = null;
let katexRendered        = false;

// ═════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function () {
  syncStateFromSliders();
  initSliders();
  initViewSwitcher();
  initToolbarEvents();
  initTheoryModalEvents();

  if (typeof THREE === 'undefined') {
    setStatus('err', 'THREE.JS MISSING');
  } else {
    init3D();
  }

  setStatus('ok', 'CLIENT-SIDE SOLVER READY');
  updateHUD();

  // First compute after paint
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(recompute, { timeout: 400 });
  } else {
    setTimeout(recompute, 0);
  }
});

// ─────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────
function byId(id) { return document.getElementById(id); }

function on(id, evt, fn) {
  const el = byId(id);
  if (el) el.addEventListener(evt, fn);
}

function setText(id, text) {
  const el = byId(id);
  if (el) el.textContent = text;
}

function setStatus(mode, text) {
  const dot = byId('status-dot');
  const txt = byId('status-text');
  if (dot) dot.className = 'status-dot ' + (mode === 'ready' ? 'ok' : mode);
  if (txt) txt.textContent = text;
}

function showInputWarning(msg) {
  let el = byId('input-warning-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'input-warning-banner';
    el.className = 'input-warning-banner';
    const panel = document.querySelector('.control-panel');
    if (panel) panel.insertBefore(el, panel.firstChild.nextSibling);
  }
  if (!msg) {
    el.textContent = '';
    el.classList.remove('active');
    return;
  }
  el.textContent = msg;
  el.classList.add('active');
}

// ═════════════════════════════════════════════════════════════
// LAZY ASSET LOADERS
// ═════════════════════════════════════════════════════════════
function loadScriptOnce(src) {
  if (!src) return Promise.reject(new Error('Missing script src'));
  const key = 'script:' + src;
  if (assetPromises.has(key)) return assetPromises.get(key);

  const p = new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload  = function () { resolve(); };
    s.onerror = function () { reject(new Error('Failed to load: ' + src)); };
    document.head.appendChild(s);
  });

  assetPromises.set(key, p);
  return p;
}

function loadCssOnce(href) {
  if (!href) return Promise.reject(new Error('Missing CSS href'));
  const key = 'css:' + href;
  if (assetPromises.has(key)) return assetPromises.get(key);

  const p = new Promise(function (resolve, reject) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload  = function () { resolve(); };
    l.onerror = function () { reject(new Error('Failed to load CSS: ' + href)); };
    document.head.appendChild(l);
  });

  assetPromises.set(key, p);
  return p;
}

function ensurePlotly() {
  if (typeof Plotly !== 'undefined') return Promise.resolve(window.Plotly);
  if (plotlyLoadingPromise) return plotlyLoadingPromise;

  const src = ASSETS.plotly || 'js/plotly-basic-2.24.1.min.js';
  plotlyLoadingPromise = loadScriptOnce(src).then(function () {
    if (typeof Plotly === 'undefined') throw new Error('Plotly missing after load');
    return window.Plotly;
  });
  return plotlyLoadingPromise;
}

function ensureKatexRendered() {
  const overlay = byId('theory-overlay');
  if (!overlay || katexRendered) return Promise.resolve();
  if (katexLoadingPromise) return katexLoadingPromise;
  if (!ASSETS.katexCss || !ASSETS.katexJs) return Promise.resolve();

  katexLoadingPromise = Promise.all([
    loadCssOnce(ASSETS.katexCss),
    loadScriptOnce(ASSETS.katexJs)
  ])
    .then(function () { return loadScriptOnce(ASSETS.katexAutoRender); })
    .then(function () {
      if (typeof renderMathInElement === 'function') {
        renderMathInElement(overlay, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$',  right: '$',  display: false },
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

// ═════════════════════════════════════════════════════════════
// UI INIT
// ═════════════════════════════════════════════════════════════
function syncStateFromSliders() {
  SLIDER_DEFS.forEach(function (s) {
    const el = byId(s.id);
    if (!el) return;
    const v = s.parse(el.value);
    if (!isNaN(v)) state[s.key] = v;
  });
}

function clampToLimits(key, v) {
  if (key === 'Z')   return Math.min(LIMITS.Z.max,   Math.max(LIMITS.Z.min,   v));
  if (key === 'EAR') return Math.min(LIMITS.EAR.max, Math.max(LIMITS.EAR.min, v));
  if (key === 'Pmin' || key === 'Pmax')
                     return Math.min(LIMITS.PD.max,  Math.max(LIMITS.PD.min,  v));
  if (key === 'Re')  return Math.min(LIMITS.Re.max,  Math.max(LIMITS.Re.min,  v));
  return v;
}

function validateStateCombo() {
  if (isInvalidCombo(state.Z, state.EAR)) {
    showInputWarning(
      'ترکیب نامعتبر: با ' + state.Z + ' پره، نسبت سطح (AE/AO) باید حداقل 0.45 باشد ' +
      '(در غیر این صورت پره‌ها از نظر هندسی روی هم می‌افتند).'
    );
    return false;
  }
  showInputWarning(null);
  return true;
}

function initSliders() {
  SLIDER_DEFS.forEach(function (s) {
    const el = byId(s.id);
    const disp = byId(s.disp);
    if (!el) return;

    if (disp) disp.textContent = s.fmt(state[s.key]);

    el.addEventListener('input', function () {
      let v = s.parse(el.value);
      if (isNaN(v)) return;
      v = clampToLimits(s.key, v);

      // Enforce Pmin <= Pmax
      if (s.key === 'Pmin' && v > state.Pmax) {
        state.Pmax = v;
        const pmaxEl = byId('param-pmax');
        const pmaxDisp = byId('val-pmax');
        if (pmaxEl) pmaxEl.value = v;
        if (pmaxDisp) pmaxDisp.textContent = v.toFixed(2);
      } else if (s.key === 'Pmax' && v < state.Pmin) {
        state.Pmin = v;
        const pminEl = byId('param-pmin');
        const pminDisp = byId('val-pmin');
        if (pminEl) pminEl.value = v;
        if (pminDisp) pminDisp.textContent = v.toFixed(2);
      }

      state[s.key] = v;
      if (disp) disp.textContent = s.fmt(v);

      updateHUD();
      validateStateCombo();

      // Geometry-affecting sliders → rebuild propeller
      if (s.key === 'Z' || s.key === 'EAR' || s.key === 'Pmin' || s.key === 'Pmax') {
        generatePropellerGeometry();
      }

      scheduleRecompute();
    });
  });

  validateStateCombo();
}

function scheduleRecompute() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(recompute, DEBOUNCE_MS);
}

function initViewSwitcher() {
  const btnCad   = byId('toggle-cad');
  const btnPlots = byId('toggle-plots');
  const btnTable = byId('toggle-table');
  const panelCad   = document.querySelector('.visualizer-panel');
  const panelPlots = document.querySelector('.chart-panel');
  const panelTable = document.querySelector('.table-panel');

  if (!btnCad || !btnPlots || !panelCad || !panelPlots) return;

  function switchView(v) {
    currentView = v;
    panelCad.classList.toggle('is-hidden',   v !== 'cad');
    panelPlots.classList.toggle('is-hidden', v !== 'plots');
    if (panelTable) panelTable.classList.toggle('is-hidden', v !== 'table');

    btnCad.classList.toggle('active-view',   v === 'cad');
    btnPlots.classList.toggle('active-view', v === 'plots');
    if (btnTable) btnTable.classList.toggle('active-view', v === 'table');

    if (v === 'plots') {
      renderPlot();
    } else if (v === 'table') {
      renderDataTable();
    } else {
      onWindowResize();
    }
  }

  btnCad.addEventListener('click',   function () { switchView('cad'); });
  btnPlots.addEventListener('click', function () { switchView('plots'); });
  if (btnTable) btnTable.addEventListener('click', function () { switchView('table'); });

  on('chart-metric-filter', 'change', function (e) {
    chartMode = e.target.value;
    if (currentView === 'plots') renderPlot();
  });
}

function initToolbarEvents() {
  on('btn-zoom-in',  'click', function () {
    if (!camera || !controls) return;
    camera.position.multiplyScalar(0.85);
    controls.update();
  });

  on('btn-zoom-out', 'click', function () {
    if (!camera || !controls) return;
    camera.position.multiplyScalar(1.18);
    controls.update();
  });

  on('btn-reset-view', 'click', function () {
    if (!camera || !controls || !propellerGroup) return;
    camera.position.set(3.5, 1.5, 3.5);
    controls.target.set(0, 0, 0);
    propellerGroup.rotation.set(0, 0, 0);
    controls.update();
  });

  on('btn-toggle-mesh', 'click', function () {
    isWireframe = !isWireframe;
    generatePropellerGeometry();
  });

  on('btn-download-img', 'click', function () {
    if (!renderer) return;
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'B_Series_Propeller_View.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  on('btn-export-csv', 'click', exportCSV);
}

function initTheoryModalEvents() {
  const overlay = byId('theory-overlay');
  const open  = byId('btn-open-theory');
  const close = byId('btn-close-theory');
  const start = byId('btn-start-solving');

  if (open && overlay) {
    open.addEventListener('click', function () {
      overlay.classList.add('active');
      ensureKatexRendered();
    });
  }
  if (close && overlay) close.addEventListener('click', function () { overlay.classList.remove('active'); });
  if (start && overlay) start.addEventListener('click', function () { overlay.classList.remove('active'); });
}

function updateHUD() {
  setText('hud-blades', state.Z);
  setText('hud-dar',    state.EAR.toFixed(2));
  setText('live-blade-count', state.Z);
  setText('live-dar',   state.EAR.toFixed(2));
}

// ═════════════════════════════════════════════════════════════
// SOLVER — client-side polynomial regression
// ═════════════════════════════════════════════════════════════
function baseWageningen(J, PoD, EAR, Z) {
  let Kt = 0, Kq = 0;

  for (let i = 0; i < COEFFS.length; i++) {
    const t = COEFFS[i];
    Kq += t[0] * Math.pow(J, t[1]) * Math.pow(PoD, t[2]) * Math.pow(EAR, t[3]) * Math.pow(Z, t[4]);
    Kt += t[5] * Math.pow(J, t[6]) * Math.pow(PoD, t[7]) * Math.pow(EAR, t[8]) * Math.pow(Z, t[9]);
  }
  return { Kt: Kt, Kq: Kq };
}

function reynoldsCorrection(J, PoD, EAR, Z, Re) {
  if (Re <= 2000000) return { dKt: 0, dKq: 0 };
  const lg  = Math.log10(Re) - 0.301;
  const lg2 = lg * lg;

  const dKt = -0.000353485
    - 0.00333758 * EAR * J * J
    - 0.00478125 * EAR * PoD * J
    + 0.000257792 * lg2 * EAR * J * J
    + 0.0000643192 * lg * Math.pow(PoD, 6) * J * J
    - 0.0000110636 * lg2 * Math.pow(PoD, 6) * J * J
    - 0.0000276305 * lg2 * Z * EAR * J * J
    + 0.00009545   * lg  * Z * EAR * PoD * J
    + 0.0000032049 * lg  * Z * Z * EAR * Math.pow(PoD, 3) * J;

  const dKq = -0.000561412
    + 0.00696898 * PoD
    - 0.0000666654 * Z * Math.pow(PoD, 6)
    + 0.0160818 * EAR * EAR
    - 0.000938091 * lg  * PoD
    - 0.00059593  * lg  * PoD * PoD
    + 0.0000782099 * lg2 * PoD * PoD
    + 0.0000052199 * lg  * Z * EAR * J * J
    - 0.00000088528* lg2 * Z * EAR * PoD * J
    + 0.0000230171 * lg  * Z * Math.pow(PoD, 6)
    - 0.0000184341 * lg2 * Z * Math.pow(PoD, 6)
    - 0.00400252   * lg  * EAR * EAR
    + 0.000220915  * lg2 * EAR * EAR;

  return { dKt: dKt, dKq: dKq };
}

function evalPoint(J, PoD, EAR, Z, Re) {
  const b = baseWageningen(J, PoD, EAR, Z);
  const c = reynoldsCorrection(J, PoD, EAR, Z, Re);
  const Kt = b.Kt + c.dKt;
  const Kq = b.Kq + c.dKq;
  const eta = (Kq > 0 && J > 0) ? (J * Kt) / (2 * Math.PI * Kq) : 0;
  return { Kt: Kt, Kq: Kq, eta: eta };
}

function computeTelemetry() {
  const avgP = (state.Pmin + state.Pmax) / 2;
  let maxEta = 0, optJ = 0, optKt = 0;

  for (let i = 1; i <= TELEM_POINTS; i++) {
    const J = (i / TELEM_POINTS) * J_MAX;
    const r = evalPoint(J, avgP, state.EAR, state.Z, state.Re);
    // Stop once we pass the physically valid range (thrust/torque gone negative)
    if (r.Kt <= 0 || r.Kq <= 0) break;
    if (r.eta > maxEta && r.eta <= 0.88) {
      maxEta = r.eta;
      optJ   = J;
      optKt  = r.Kt;
    }
  }
  return { J: optJ, Kt: optKt, eta: maxEta };
}

/**
 * Build one curve, truncating it at the first point where Kt or Kq
 * becomes non-positive (i.e. leaves the physically/regression-valid
 * range). This is the fix for the "cliff" artifact: previously the
 * loop kept evaluating all the way to J_MAX and force-zeroed eta once
 * Kq crossed zero, producing a sudden vertical drop instead of simply
 * ending the curve where it stops being meaningful.
 */
function computeSingleCurve(pitch) {
  const J = [], Kt = [], Kq = [], Kq10 = [], eta = [];

  for (let i = 0; i <= CURVE_POINTS; i++) {
    const j = (i / CURVE_POINTS) * J_MAX;
    const r = evalPoint(j, pitch, state.EAR, state.Z, state.Re);

    if (i > 0 && (r.Kt <= 0 || r.Kq <= 0)) {
      // Interpolate one closing point at the zero-crossing so the
      // line ends cleanly at Kt=0 (or Kq=0) instead of stopping mid-air.
      break;
    }

    const etaClamp = Math.max(0, Math.min(1, r.eta));
    J.push(j);
    Kt.push(r.Kt);
    Kq.push(r.Kq);
    Kq10.push(r.Kq * 10);
    eta.push(etaClamp);
  }

  return { pitch: pitch, J: J, Kt: Kt, Kq: Kq, Kq10: Kq10, eta: eta };
}

function computeCurves() {
  const pitchSteps = [];
  for (let p = state.Pmin; p <= state.Pmax + 1e-6; p += 0.15) {
    pitchSteps.push(parseFloat(p.toFixed(2)));
  }
  if (!pitchSteps.length) pitchSteps.push(state.Pmin);

  return pitchSteps.map(computeSingleCurve);
}

function hashState() {
  return state.Z + '|' + state.EAR.toFixed(3) + '|' +
         state.Pmin.toFixed(3) + '|' + state.Pmax.toFixed(3) + '|' + state.Re;
}

function recompute() {
  const key = hashState();

  if (solveCache.has(key)) {
    lastSolve = solveCache.get(key);
  } else {
    setStatus('loading', 'COMPUTING');
    lastSolve = {
      telem:  computeTelemetry(),
      curves: computeCurves()
    };
    if (solveCache.size > 30) {
      solveCache.delete(solveCache.keys().next().value);
    }
    solveCache.set(key, lastSolve);
  }

  applyTelemetry(lastSolve.telem);
  setStatus('ok', 'CLIENT-SIDE SOLVER READY');

  if (currentView === 'plots') renderPlot();
  if (currentView === 'table') renderDataTable();
}

function applyTelemetry(t) {
  setText('out-j',   t.J.toFixed(3));
  setText('out-kt',  t.Kt.toFixed(3));
  setText('out-eff', (t.eta * 100).toFixed(1) + '%');
}

// ═════════════════════════════════════════════════════════════
// PLOTLY
// ═════════════════════════════════════════════════════════════
const COLORS_KT  = ['#ef4444', '#f87171', '#b91c1c', '#fca5a5', '#fecaca'];
const COLORS_KQ  = ['#22c55e', '#4ade80', '#15803d', '#86efac', '#bbf7d0'];
const COLORS_ETA = ['#38bdf8', '#60a5fa', '#1d4ed8', '#93c5fd', '#bae6fd'];

function makeBaseLayout() {
  return {
    paper_bgcolor: '#060d18',
    plot_bgcolor:  '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 55, r: 25, t: 30, b: 50 },
    xaxis: {
      title: 'Advance Coefficient (J)',
      gridcolor: '#1e293b', linecolor: '#334155',
      range: [0, J_MAX]
    },
    yaxis: {
      title: 'Hydrodynamic Output',
      gridcolor: '#1e293b', linecolor: '#334155',
      range: [0, 1.4]
    },
    legend: {
      font: { size: 9 },
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
    target.innerHTML = '<div style="color:#94a3b8;font-family:monospace;font-size:12px;padding:2rem;text-align:center">Loading plot engine…</div>';
    ensurePlotly()
      .then(function () { if (currentView === 'plots') renderPlot(); })
      .catch(function (err) {
        console.error(err);
        target.innerHTML = '<div style="color:#ef4444;padding:2rem;text-align:center">Plot engine failed to load.</div>';
      });
    return;
  }

  if (!lastSolve) return;

  const traces = [];
  lastSolve.curves.forEach(function (c, idx) {
    const ci = idx % COLORS_KT.length;

    if (chartMode === 'all' || chartMode === 'kt') {
      traces.push({
        x: c.J, y: c.Kt, mode: 'lines', type: 'scatter',
        name: 'K_T (P/D=' + c.pitch + ')',
        line: { color: COLORS_KT[ci], width: 2 }
      });
    }
    if (chartMode === 'all' || chartMode === 'kq') {
      traces.push({
        x: c.J, y: c.Kq10, mode: 'lines', type: 'scatter',
        name: '10·K_Q (P/D=' + c.pitch + ')',
        line: { color: COLORS_KQ[ci], width: 1.6, dash: 'dash' }
      });
    }
    if (chartMode === 'all' || chartMode === 'eta') {
      traces.push({
        x: c.J, y: c.eta, mode: 'lines', type: 'scatter',
        name: 'η₀ (P/D=' + c.pitch + ')',
        line: { color: COLORS_ETA[ci], width: 2.5 }
      });
    }
  });

  Plotly.react(target, traces, makeBaseLayout(), { displaylogo: false, responsive: true });
}

// ═════════════════════════════════════════════════════════════
// DATA TABLE (mirrors the zigzag "Time Series" table view)
// ═════════════════════════════════════════════════════════════
function renderDataTable() {
  const target = byId('table-target');
  if (!target) return;

  if (!lastSolve) {
    target.innerHTML = '<div style="color:#94a3b8;font-family:monospace;font-size:12px;padding:2rem;text-align:center">No data yet.</div>';
    return;
  }

  const t = lastSolve.telem;

  let html = '';
  html += '<div class="table-metrics-block">';
  html += '  <div class="table-metrics-title">OPTIMUM PEAK METRICS</div>';
  html += '  <table class="data-metrics-table">';
  html += '    <thead><tr><th>METRIC</th><th>VALUE</th></tr></thead>';
  html += '    <tbody>';
  html += '      <tr><td>Advance Coefficient (J)</td><td>' + t.J.toFixed(4) + '</td></tr>';
  html += '      <tr><td>Thrust Coefficient (K<sub>T</sub>)</td><td>' + t.Kt.toFixed(4) + '</td></tr>';
  html += '      <tr><td>Max Open-Water Efficiency (η<sub>0</sub>)</td><td>' + (t.eta * 100).toFixed(2) + '%</td></tr>';
  html += '    </tbody>';
  html += '  </table>';
  html += '</div>';

  let totalPoints = 0;
  lastSolve.curves.forEach(function (c) { totalPoints += c.J.length; });

  html += '<div class="table-series-block">';
  html += '  <div class="table-metrics-title">OPEN-WATER CURVE DATA (' + totalPoints + ' SAMPLES, ' + lastSolve.curves.length + ' CURVES)</div>';
  html += '  <div class="data-table-scroll">';
  html += '  <table class="data-series-table">';
  html += '    <thead><tr>';
  html += '      <th>P/D</th><th>J</th><th>K<sub>T</sub></th><th>10·K<sub>Q</sub></th><th>η<sub>0</sub></th>';
  html += '    </tr></thead>';
  html += '    <tbody>';

  lastSolve.curves.forEach(function (c) {
    for (let i = 0; i < c.J.length; i++) {
      html += '<tr>';
      html += '<td>' + c.pitch.toFixed(2) + '</td>';
      html += '<td>' + c.J[i].toFixed(3) + '</td>';
      html += '<td>' + c.Kt[i].toFixed(5) + '</td>';
      html += '<td>' + c.Kq10[i].toFixed(5) + '</td>';
      html += '<td>' + c.eta[i].toFixed(5) + '</td>';
      html += '</tr>';
    }
  });

  html += '    </tbody>';
  html += '  </table>';
  html += '  </div>';
  html += '</div>';

  target.innerHTML = html;
}

// ═════════════════════════════════════════════════════════════
// CSV EXPORT
// ═════════════════════════════════════════════════════════════
function exportCSV() {
  if (!lastSolve) return;

  const t = lastSolve.telem;
  let csv = 'NavalAI — Wageningen B-Series Open-Water Report\n\n';
  csv += 'INPUTS\n';
  csv += 'Blade Count (Z),' + state.Z + '\n';
  csv += 'Expanded Area Ratio (EAR),' + state.EAR.toFixed(3) + '\n';
  csv += 'Pitch Ratio Min (P/D_min),' + state.Pmin.toFixed(3) + '\n';
  csv += 'Pitch Ratio Max (P/D_max),' + state.Pmax.toFixed(3) + '\n';
  csv += 'Reynolds Number (Re),' + state.Re + '\n\n';

  csv += 'OPTIMUM PEAK\n';
  csv += 'Optimum J,' + t.J.toFixed(4) + '\n';
  csv += 'K_T at Peak,' + t.Kt.toFixed(4) + '\n';
  csv += 'Max Efficiency (%),' + (t.eta * 100).toFixed(2) + '\n\n';

  csv += 'OPEN-WATER CURVES\n';
  csv += 'PoD,J,K_T,10*K_Q,eta_0\n';
  lastSolve.curves.forEach(function (c) {
    for (let i = 0; i < c.J.length; i++) {
      csv += [
        c.pitch,
        c.J[i].toFixed(4),
        c.Kt[i].toFixed(5),
        c.Kq10[i].toFixed(5),
        c.eta[i].toFixed(5)
      ].join(',') + '\n';
    }
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'B_Series_OpenWater_Report.csv';
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
  if (!container) return;

  const w = Math.max(1, container.clientWidth);
  const h = Math.max(1, container.clientHeight);

  clock = new THREE.Clock();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060d18);
  scene.fog = new THREE.FogExp2(0x060d18, 0.04);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(3.5, 1.5, 3.5);

  renderer = new THREE.WebGLRenderer({
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = 15;
  controls.minDistance = 1.5;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0x0f172a, 2.0));

  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(6, 10, 4);
  scene.add(sun);

  const rim = new THREE.DirectionalLight(0xc8a84b, 2.0);
  rim.position.set(-6, -2, -4);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0x06b6d4, 1.5);
  fill.position.set(0, 5, -5);
  scene.add(fill);

  propellerGroup = new THREE.Group();
  bladeGroup     = new THREE.Group();
  propellerGroup.add(bladeGroup);
  scene.add(propellerGroup);

  generatePropellerGeometry();
  initFlowParticles();

  window.addEventListener('resize', onWindowResize, { passive: true });

  animate();
}

function generatePropellerGeometry() {
  if (!bladeGroup || typeof THREE === 'undefined') return;

  // Cleanup old blades
  while (bladeGroup.children.length) {
    const c = bladeGroup.children[0];
    if (c.geometry) c.geometry.dispose();
    bladeGroup.remove(c);
  }
  if (hubMesh) {
    if (hubMesh.geometry) hubMesh.geometry.dispose();
    propellerGroup.remove(hubMesh);
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0xc8a84b,
    emissive: 0x2e240c,
    roughness: 0.20,
    metalness: 0.85,
    wireframe: isWireframe,
    side: THREE.DoubleSide
  });

  // Hub
  const hubR = 0.18, hubL = 0.65;
  const hubGeo = new THREE.CylinderGeometry(hubR * 0.5, hubR * 1.1, hubL, 24);
  hubGeo.rotateX(Math.PI / 2);
  hubMesh = new THREE.Mesh(hubGeo, mat);
  propellerGroup.add(hubMesh);

  // Blades
  const darMod = state.EAR / 0.55;
  const step   = (2 * Math.PI) / state.Z;
  const RES    = 10;
  const nStations = RADIAL_STATIONS.length;

  for (let b = 0; b < state.Z; b++) {
    const geom = new THREE.BufferGeometry();
    const verts = [];
    const idx   = [];

    for (let s = 0; s < nStations; s++) {
      const r     = RADIAL_STATIONS[s];
      const chord = CHORD_FACTORS[s] * darMod;
      const thick = THICK_FACTORS[s];
      const PoD   = state.Pmin + (state.Pmax - state.Pmin) * ((r - 0.2) / 0.8);
      const pitchA = Math.atan(PoD / (2 * Math.PI * r));
      const cosP = Math.cos(pitchA), sinP = Math.sin(pitchA);

      for (let p = 0; p <= RES; p++) {
        const tI = p / RES;
        const cp = (tI - 0.35) * chord;
        const tf = Math.sin(tI * Math.PI) * thick;
        const x  = cp * cosP - tf * 0.15 * sinP;
        const y  = r;
        const z  = cp * sinP + tf * 0.85 * cosP;
        verts.push(x, y, z);
      }
    }

    const pps = RES + 1;
    for (let i = 0; i < nStations - 1; i++) {
      for (let j = 0; j < pps - 1; j++) {
        const a = i * pps + j;
        const c = i * pps + (j + 1);
        const d = (i + 1) * pps + j;
        const e = (i + 1) * pps + (j + 1);
        idx.push(a, c, d, c, e, d);
      }
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();

    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.z = b * step;
    bladeGroup.add(mesh);
  }
}

function initFlowParticles() {
  if (flowParticles) {
    scene.remove(flowParticles);
    if (flowParticles.geometry) flowParticles.geometry.dispose();
    if (flowParticles.material) flowParticles.material.dispose();
  }

  particleGeometry  = new THREE.BufferGeometry();
  particlePositions = new Float32Array(PARTICLE_COUNT * 3);
  particleLifetimes = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    resetParticle(i);
    particlePositions[i * 3 + 2] = (Math.random() * 6) - 3;
  }

  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

  const mat = new THREE.PointsMaterial({
    color: 0x38bdf8,
    size: 0.04,
    transparent: true,
    opacity: 0.65,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  flowParticles = new THREE.Points(particleGeometry, mat);
  scene.add(flowParticles);
}

function resetParticle(i) {
  const r = 0.1 + Math.random() * 1.1;
  const a = Math.random() * Math.PI * 2;
  particlePositions[i * 3]     = Math.cos(a) * r;
  particlePositions[i * 3 + 1] = Math.sin(a) * r;
  particlePositions[i * 3 + 2] = -3.0;
  particleLifetimes[i] = 0;
}

function updateFlowParticles() {
  if (!flowParticles) return;
  const pos = flowParticles.geometry.attributes.position.array;
  const baseV = 0.02 + (state.Re / 9000000) * 0.06;
  const avgP  = (state.Pmin + state.Pmax) / 2;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const rad = Math.sqrt(x * x + y * y);
    let vx = 0, vy = 0, vz = baseV;

    if (z >= -0.2 && z <= 2.5 && rad <= 1.0) {
      const tw = (0.04 + avgP * 0.03) * (1.0 / (rad + 0.15));
      const acc = 1.3 + avgP * 0.4;
      vx = -y * tw;
      vy =  x * tw;
      vz = baseV * acc;
      const contract = 1.0 - 0.12 * (1.0 - Math.exp(-z));
      pos[i * 3]     *= contract;
      pos[i * 3 + 1] *= contract;
    }

    pos[i * 3]     += vx;
    pos[i * 3 + 1] += vy;
    pos[i * 3 + 2] += vz;
    particleLifetimes[i] += 1;

    if (pos[i * 3 + 2] > 3.0 || particleLifetimes[i] > 250) resetParticle(i);
  }
  flowParticles.geometry.attributes.position.needsUpdate = true;
}

function animate() {
  requestAnimationFrame(animate);
  if (!clock) return;
  if (document.hidden || currentView !== 'cad') return;

  const dt = Math.min(clock.getDelta(), 0.1);
  frameDelta += dt;

  if (controls) controls.update();

  if (frameDelta >= FRAME_INTERVAL) {
    const rot = 0.005 + (state.Re / 9000000) * 0.025;
    if (bladeGroup) bladeGroup.rotation.z += rot * (frameDelta / FRAME_INTERVAL);
    updateFlowParticles();
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