/**
 * app_yacht.js
 * NavalAI — Yacht Resistance Predictor
 *
 * Optimized for:
 * - lazy Plotly loading
 * - lazy KaTeX loading
 * - request aborting / frontend cache
 * - low CPU 3D animation
 * - same architecture as app_turning.js
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.yachtApi || '/yacht/';

const DEBOUNCE_MS = 120;
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;
const MAX_CACHE = 24;

const RHO = 1025;
const G = 9.81;

const SLIDER_DEFS = [
  { id: 'slider-length', key: 'L',    disp: 'val-length', fmt: v => v.toFixed(2) + ' m' },
  { id: 'slider-beam',   key: 'B',    disp: 'val-beam',   fmt: v => v.toFixed(2) + ' m' },
  { id: 'slider-draft',  key: 'T',    disp: 'val-draft',  fmt: v => v.toFixed(2) + ' m' },
  { id: 'slider-lcb',    key: 'LCB',  disp: 'val-lcb',    fmt: v => v.toFixed(1) + ' %' },
  { id: 'slider-cp',     key: 'CP',   disp: 'val-cp',     fmt: v => v.toFixed(2) },
  { id: 'slider-nabla',  key: 'Nabla',disp: 'val-nabla',  fmt: v => v.toFixed(2) + ' m³' }
];

const HULL_PARAM_SPEC = [
  { key: '__L',    label: 'Length on Waterline (L_WL)',        unit: 'm',  decimals: 2, source: 'input' },
  { key: '__B',    label: 'Beam Max Waterline (B_WL)',         unit: 'm',  decimals: 2, source: 'input' },
  { key: '__T',    label: 'Draft Canoe Body (T_c)',            unit: 'm',  decimals: 2, source: 'input' },
  { key: '__DISP', label: 'Displacement (∇)',                  unit: 'm³', decimals: 3, source: 'input' },
  { key: '__PC',   label: 'Prismatic Coefficient (Pc)',        unit: '-',  decimals: 4, source: 'input' },
  { key: '__LCB',  label: 'Long. Centre of Buoyancy (LCB)',    unit: '%',  decimals: 3, source: 'input' },
  { key: 'CB',     label: 'Block Coefficient (CB)',            unit: '-',  decimals: 4 },
  { key: 'CM',     label: 'Midship Coefficient (CM)',          unit: '-',  decimals: 4 },
  { key: 'Cwp',    label: 'Waterplane Coefficient (Cwp)',      unit: '-',  decimals: 4 },
  { key: 'Cvp',    label: 'Vertical Prismatic (Cvp)',          unit: '-',  decimals: 4 },
  { key: 'S',      label: 'Wetted Surface (S)',                unit: 'm²', decimals: 3 },
  { key: 'D',      label: 'Depth (D)',                         unit: 'm',  decimals: 3 },
  { key: 'Bmax',   label: 'Max Section Beam',                  unit: 'm',  decimals: 3 },
  { key: 'AM',     label: 'Midship Section Area (AM)',         unit: 'm²', decimals: 3 },
  { key: 'Ax',     label: 'Sectional Area (Ax)',               unit: 'm²', decimals: 3 },
  { key: 'Ay',     label: 'Waterplane Area (Ay)',              unit: 'm²', decimals: 3 },
  { key: 'LBP',    label: 'Length Between Perpendiculars',     unit: 'm',  decimals: 3 },
  { key: 'LCF',    label: 'Long. Centre of Flotation (LCF)',   unit: 'm',  decimals: 3 },
  { key: 'KMc',    label: 'KMc',                               unit: 'm',  decimals: 3 },
  { key: 'KM',     label: 'KM',                                unit: 'm',  decimals: 3 },
  { key: 'KB',     label: 'Centre of Buoyancy (KB)',           unit: 'm',  decimals: 3 },
  { key: 'KBc',    label: 'KBc',                               unit: 'm',  decimals: 3 },
  { key: 'BM',     label: 'Metacentric Radius (BM)',           unit: 'm',  decimals: 3 },
  { key: 'BmL',    label: 'Long. Metacentric Radius (BmL)',    unit: 'm',  decimals: 3 },
  { key: 'IT',     label: 'Transverse Moment of Inertia (IT)', unit: 'm⁴', decimals: 3 },
  { key: 'IL',     label: 'Long. Moment of Inertia (IL)',      unit: 'm⁴', decimals: 3 }
];

/* ── runtime state ── */
let state = { L: 10.0, B: 3.0, T: 0.85, LCB: -2.5, CP: 0.60, Nabla: 9.50 };

let resistanceCurveCache = null;
let derivedParamsCache = null;
let responseCache = new Map();

let currentView = 'cad';
let currentChartMode = 'all';
let isWireframe = false;

let scene, camera, renderer, controls;
let yachtGroup, waterPlane, waterGeometry;
let clock = null;

let frameDelta = 0;
let lastWaterUpdate = 0;
let debounceTimer = null;

let activeFetchController = null;
let requestSeq = 0;

const assetPromises = new Map();
let plotlyLoadingPromise = null;
let katexLoadingPromise = null;
let katexRendered = false;

/* ==========================================================================
   Boot
   ========================================================================== */
document.addEventListener('DOMContentLoaded', function () {
  initSliders();
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
  rebuildHullFromState();

  /* first solve after idle so first paint is free */
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(function () { runSolver(); }, { timeout: 650 });
  } else {
    setTimeout(function () { runSolver(); }, 0);
  }
});

/* ==========================================================================
   Small DOM helpers
   ========================================================================== */
function byId(id) {
  return document.getElementById(id);
}

function on(id, evt, fn) {
  const el = byId(id);
  if (el) el.addEventListener(evt, fn);
}

/* ==========================================================================
   Lazy asset loaders
   ========================================================================== */
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

/* ==========================================================================
   UI init
   ========================================================================== */
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
      rebuildHullFromState();
      scheduleDebouncedRun();
    });
  });
}

function scheduleDebouncedRun() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function () {
    runSolver();
  }, DEBOUNCE_MS);
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
  const btnCad   = byId('toggle-cad');
  const btnPlots = byId('toggle-plots');
  const btnTable = byId('toggle-table');

  const panelCad   = document.querySelector('.visualizer-panel');
  const panelPlots = document.querySelector('.chart-panel');
  const panelTable = document.querySelector('.table-panel');

  if (!btnCad || !btnPlots || !btnTable || !panelCad || !panelPlots || !panelTable) return;

  function switchView(v) {
    currentView = v;

    panelCad.classList.toggle('is-hidden',   v !== 'cad');
    panelPlots.classList.toggle('is-hidden', v !== 'plots');
    panelTable.classList.toggle('is-hidden', v !== 'table');

    btnCad.classList.toggle('active-view',   v === 'cad');
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

  btnCad.addEventListener('click',   function () { switchView('cad'); });
  btnPlots.addEventListener('click', function () { switchView('plots'); });
  btnTable.addEventListener('click', function () { switchView('table'); });

  const filter = byId('chart-metric-filter');
  if (filter) {
    filter.addEventListener('change', function (e) {
      currentChartMode = e.target.value || 'all';
      if (currentView === 'plots') renderPlot();
    });
  }
}

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

  on('btn-reset-view', 'click', function () {
    if (!camera || !controls) return;
    camera.position.set(16, 8, 20);
    controls.target.set(0, 0.5, 0);
    controls.update();
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.download = 'NavalAI_Yacht_Hydrodynamics.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-wireframe', 'click', function () {
    isWireframe = !isWireframe;
    if (!yachtGroup) return;
    yachtGroup.traverse(function (child) {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(function (m) { m.wireframe = isWireframe; });
        } else {
          child.material.wireframe = isWireframe;
        }
      }
    });
  });

  on('btn-export-csv', 'click', exportSnapshotCSV);
  on('btn-export-curve-csv', 'click', exportResistanceCurveCSV);
  on('btn-export-full-csv', 'click', exportFullReportCSV);
}

function updateHUD() {
  const aspect = byId('val-aspect');
  if (aspect && state.B) {
    aspect.textContent = (state.L / state.B).toFixed(2);
  }

  const hudLb = byId('hud-lb');
  if (hudLb && state.B) {
    hudLb.textContent = (state.L / state.B).toFixed(2);
  }

  const hudFn = byId('hud-fn');
  if (hudFn && resistanceCurveCache && resistanceCurveCache.froude.length) {
    let maxFn = resistanceCurveCache.froude[0];
    for (let i = 1; i < resistanceCurveCache.froude.length; i++) {
      if (resistanceCurveCache.froude[i] > maxFn) maxFn = resistanceCurveCache.froude[i];
    }
    hudFn.textContent = maxFn.toFixed(3);
  }
}

function setStatus(mode, text) {
  const dot = byId('status-dot');
  const txt = byId('status-text');
  if (dot) dot.className = 'status-dot ' + (mode === 'ready' ? 'ok' : mode);
  if (txt) txt.textContent = text;
}

function setLoading(active) {
  const load = byId('loading-overlay');
  if (load) load.classList.toggle('active', !!active);
}

/* ==========================================================================
   Derived hull geometry (local, zero network)
   ========================================================================== */
function computeDerivedHullParameters(L, B, T, displacement, Pc, lcb) {
  const D    = T + 1.15;
  const Bmax = 1.18 * B - 0.05;
  const S    = (1.97 + 0.171 * (B / T)) * Math.sqrt(displacement * L);
  const Ax   = -3.0330 + (-0.0252 * S) + (1.6418 * D) + (0.5131 * B) + (0.0534 * displacement);
  const Ay   = -4.9878 + ( 0.8215 * S) + (-4.9025 * Ax) + (3.4815 * B) + (0.3158 * displacement);
  const KMc  = 0.664 * T + 0.111 * (B * B) / T;
  const IT   = -27.1945 + 5.3954 * B + 1.0158 * Ay + 0.5732 * KMc;
  const IL   = -8.6839 + 11.4337 * Ay + 0.1161 * S - 0.3348 * IT - 39.6707 * B;
  const BM   = IT / displacement;
  const BmL  = IL / displacement;
  const KM   = 0.6264 + 0.6891 * KMc - 0.0185 * Ay - 0.0970 * B + 0.0396 * IT;
  const KB   = KM - BM;
  const KBc  = KMc - BmL;
  const LCF  = 0.64 * lcb - 1.84;
  const CB   = displacement / (L * B * D);
  const Cwp  = Ay / (L * B);
  const CM   = CB / Pc;
  const AM   = CM * B * T;
  const LBP  = displacement / (AM * Pc);
  const Cvp  = displacement / (Ay * T);

  return { D, Bmax, S, Ax, Ay, KMc, IT, IL, BM, BmL, KM, KB, KBc, LCF, CB, Cwp, CM, AM, LBP, Cvp };
}

function rebuildHullFromState() {
  const L = state.L;
  const B = state.B;
  const T = state.T;
  const LCB = state.LCB;
  const CP = state.CP;
  const Nabla = state.Nabla;

  let CB = Nabla / (L * B * T);
  CB = Math.max(0.30, Math.min(0.85, CB));

  derivedParamsCache = computeDerivedHullParameters(L, B, T, Nabla, CP, LCB);
  generateYachtStructure(L, B, T, CB, LCB);
  updateHUD();

  if (currentView === 'table') renderTables();
}

/* ==========================================================================
   Payload / API
   ========================================================================== */
function readPayload() {
  return {
    L: state.L,
    B: state.B,
    T: state.T,
    lcb: state.LCB,
    Pc: state.CP,
    displacement: state.Nabla
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

function hashPayload(payload) {
  return stableStringify(payload);
}

async function runSolver() {
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

  /* cache hit */
  if (responseCache.has(key)) {
    applyResistanceData(responseCache.get(key));
    setStatus('ok', 'READY (cached)');
    return;
  }

  setStatus('loading', 'COMPUTING');
  setLoading(true);

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
      // بخوان body رو حتی وقتی status ناموفقه، تا پیام واقعی خطا از بک‌اند رو ببینیم
      let backendMsg = 'HTTP ' + resp.status;
      try {
        const errJson = await resp.json();
        if (errJson && errJson.message) backendMsg = errJson.message;
      } catch (parseErr) {
        // body JSON نبود؛ همون HTTP status رو نگه دار
      }
      throw new Error(backendMsg);
    }

    const json = await resp.json();
    if (!json || !json.success) {
      throw new Error(json && json.message ? json.message : 'API failure');
    }

    if (seq !== requestSeq) return;

    const curve = normalizeResistancePayload(json.data);

    if (responseCache.size > MAX_CACHE) {
      responseCache.delete(responseCache.keys().next().value);
    }
    responseCache.set(key, curve);

    applyResistanceData(curve);
    setStatus('ok', 'READY');

  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq !== requestSeq) return;

    console.error('NavalAI Yacht solver error:', err);
    setStatus('err', 'ERROR');

    ['out-rf', 'out-rr', 'out-rt'].forEach(function (id) {
      const el = byId(id);
      if (el) {
        el.textContent = 'ERR';
        el.classList.add('error-state');
      }
    });

  } finally {
    if (seq === requestSeq) {
      setLoading(false);
      activeFetchController = null;
    }
  }
}

/**
 * Accepts any of these shapes:
 *   1) Already-normalized curve object: { froude, rf, rr, rt }
 *   2) Actual NavalAI backend shape:
 *        data.resistances = {
 *          froude_series, residuary_series, friction_series, total_series
 *        }
 *      (optionally base64-encoded if response_format === 'compact':
 *        { _format: 'f32-base64-v1', _length, froude_series: '<b64>', ... })
 *   3) Legacy shape: { results: { Froude_numbers, Friction_Resistance, ... } }
 */
function normalizeResistancePayload(data) {
  if (!data) return null;

  /* already normalized (from cache) */
  if (data.froude && data.rf && data.rr && data.rt) {
    return data;
  }

  /* actual backend shape: data.resistances.{froude_series,...} */
  if (data.resistances) {
    const r = data.resistances;

    if (r._format === 'f32-base64-v1') {
      return {
        froude: Array.from(decodeFloat32Base64(r.froude_series || '')),
        rf: Array.from(decodeFloat32Base64(r.friction_series || '')),
        rr: Array.from(decodeFloat32Base64(r.residuary_series || '')),
        rt: Array.from(decodeFloat32Base64(r.total_series || ''))
      };
    }

    const froudeArr = r.froude_series || [];
    const rfArr = r.friction_series || [];
    const rrArr = r.residuary_series || [];
    const rtArr = r.total_series || [];

    /* engine.py محاسبه رو با فرمول SI انجام می‌ده → خروجی نیوتنه، نه کیلونیوتن.
       اگه مقدار آخر Rt بزرگ‌تر از ۵۰ باشه، یعنی احتمالاً نیوتنه؛ تبدیل به kN می‌کنیم. */
    const scale = (rtArr.length && Math.abs(Number(rtArr[rtArr.length - 1])) > 50) ? 0.001 : 1;

    return {
      froude: froudeArr.slice(),
      rf: rfArr.map(function (v) { return Number(v) * scale; }),
      rr: rrArr.map(function (v) { return Number(v) * scale; }),
      rt: rtArr.map(function (v) { return Number(v) * scale; })
    };
  }

  /* legacy fallback shape */
  const results = data.results || data;
  const froude = results.Froude_numbers || results.froude || [];
  const rfRaw  = results.Friction_Resistance  || results.rf || [];
  const rrRaw  = results.Residuary_Resistance || results.rr || [];
  const rtRaw  = results.Total_Resistance     || results.rt || [];

  /* backend may return Newtons — convert to kN when magnitudes look like N */
  const scale = (rfRaw.length && Math.abs(rfRaw[rfRaw.length - 1]) > 50) ? 0.001 : 1;

  return {
    froude: froude.slice(),
    rf: rfRaw.map(function (v) { return Number(v) * scale; }),
    rr: rrRaw.map(function (v) { return Number(v) * scale; }),
    rt: rtRaw.map(function (v) { return Number(v) * scale; })
  };
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

function applyResistanceData(curve) {
  if (!curve || !curve.froude || !curve.froude.length) return;

  resistanceCurveCache = curve;

  let targetIdx = 0;
  let maxFroude = curve.froude[0];
  for (let i = 1; i < curve.froude.length; i++) {
    if (curve.froude[i] > maxFroude) {
      maxFroude = curve.froude[i];
      targetIdx = i;
    }
  }

  function setOut(id, val) {
    const el = byId(id);
    if (!el) return;
    el.classList.remove('error-state');
    el.textContent = Number(val).toFixed(4) + ' kN';
  }

  setOut('out-rf', curve.rf[targetIdx]);
  setOut('out-rr', curve.rr[targetIdx]);
  setOut('out-rt', curve.rt[targetIdx]);

  const valFroude = byId('val-froude');
  if (valFroude) valFroude.textContent = maxFroude.toFixed(3);

  updateHUD();

  if (currentView === 'plots') renderPlot();
  if (currentView === 'table') renderTables();
}

/* ==========================================================================
   Plotly
   ========================================================================== */
function makeBaseLayout() {
  return {
    paper_bgcolor: '#060d18',
    plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 60, r: 25, t: 20, b: 50 },
    xaxis: {
      title: 'Froude Number (Fn)',
      gridcolor: '#1e293b',
      linecolor: '#334155'
    },
    yaxis: {
      title: 'Resistance (kN)',
      gridcolor: '#1e293b',
      linecolor: '#334155',
      rangemode: 'tozero'
    },
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

  if (!resistanceCurveCache) {
    Plotly.react(target, [], Object.assign(layout, {
      annotations: [{
        text: 'Awaiting solver data — adjust hull parameters',
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

  const c = resistanceCurveCache;
  const traces = [];

  if (currentChartMode === 'all' || currentChartMode === 'rf') {
    traces.push({
      x: c.froude, y: c.rf, mode: 'lines', type: 'scatter',
      name: 'Rf — Frictional',
      line: { color: '#38bdf8', width: 2 }
    });
  }
  if (currentChartMode === 'all' || currentChartMode === 'rr') {
    traces.push({
      x: c.froude, y: c.rr, mode: 'lines', type: 'scatter',
      name: 'Rr — Residuary',
      line: { color: '#f59e0b', width: 2, dash: 'dash' }
    });
  }
  if (currentChartMode === 'all' || currentChartMode === 'rt') {
    traces.push({
      x: c.froude, y: c.rt, mode: 'lines', type: 'scatter',
      name: 'Rt — Total',
      line: { color: '#22c55e', width: 2.5 }
    });
  }

  Plotly.react(target, traces, layout, config);
}

/* ==========================================================================
   Tables / CSV
   ========================================================================== */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getHullParamValue(spec) {
  if (spec.source === 'input') {
    if (spec.key === '__L')    return state.L;
    if (spec.key === '__B')    return state.B;
    if (spec.key === '__T')    return state.T;
    if (spec.key === '__DISP') return state.Nabla;
    if (spec.key === '__PC')   return state.CP;
    if (spec.key === '__LCB')  return state.LCB;
    return null;
  }
  if (!derivedParamsCache) return null;
  const v = derivedParamsCache[spec.key];
  return (v === undefined || v === null) ? null : Number(v);
}

function renderTables() {
  const target = byId('table-target');
  if (!target) return;

  const haveResistance = !!(resistanceCurveCache && resistanceCurveCache.froude.length);
  const haveDerived = !!derivedParamsCache;

  if (!haveDerived && !haveResistance) {
    target.innerHTML = '<div class="data-table-empty">Awaiting solver data — adjust parameters to begin.</div>';
    return;
  }

  const paramRows = HULL_PARAM_SPEC.map(function (spec) {
    const val = getHullParamValue(spec);
    const rowClass = spec.source === 'input' ? 'row-input' : '';
    const valStr = (val === null || isNaN(val)) ? '—' : val.toFixed(spec.decimals);
    return (
      '<tr class="' + rowClass + '">' +
        '<td>' + escapeHtml(spec.label) + '</td>' +
        '<td class="col-numeric">' + valStr + '</td>' +
        '<td class="col-unit">' + escapeHtml(spec.unit) + '</td>' +
      '</tr>'
    );
  }).join('');

  const paramsTableHtml =
    '<div class="data-table-block">' +
      '<h3 class="data-table-title">Hull Parameters (Inputs + Derived)</h3>' +
      '<table class="data-table">' +
        '<thead><tr><th>Parameter</th><th style="text-align:right;">Value</th><th>Unit</th></tr></thead>' +
        '<tbody>' + paramRows + '</tbody>' +
      '</table>' +
    '</div>';

  let resistanceTableHtml;
  if (haveResistance) {
    const c = resistanceCurveCache;
    const rows = c.froude.map(function (fn, i) {
      return (
        '<tr>' +
          '<td class="col-numeric">' + Number(fn).toFixed(3) + '</td>' +
          '<td class="col-numeric">' + Number(c.rf[i]).toFixed(4) + '</td>' +
          '<td class="col-numeric">' + Number(c.rr[i]).toFixed(4) + '</td>' +
          '<td class="col-numeric">' + Number(c.rt[i]).toFixed(4) + '</td>' +
        '</tr>'
      );
    }).join('');

    resistanceTableHtml =
      '<div class="data-table-block">' +
        '<h3 class="data-table-title">Resistance Matrix vs Froude</h3>' +
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th style="text-align:right;">Fn</th>' +
            '<th style="text-align:right;">Rf (kN)</th>' +
            '<th style="text-align:right;">Rr (kN)</th>' +
            '<th style="text-align:right;">Rt (kN)</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>';
  } else {
    resistanceTableHtml =
      '<div class="data-table-block">' +
        '<h3 class="data-table-title">Resistance Matrix vs Froude</h3>' +
        '<div class="data-table-empty">Awaiting resistance data from API…</div>' +
      '</div>';
  }

  target.innerHTML =
    '<div class="data-tables-grid">' +
      paramsTableHtml +
      resistanceTableHtml +
    '</div>';
}

function downloadBlobCSV(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportSnapshotCSV() {
  const aspectEl = byId('val-aspect');
  const froudeEl = byId('val-froude');
  const rfEl = byId('out-rf');
  const rrEl = byId('out-rr');
  const rtEl = byId('out-rt');

  let csv = 'NavalAI Yacht Resistance Snapshot\n\n';
  csv += 'Parameter,Value,Unit\n';
  csv += 'Length on Waterline (L_WL),' + state.L + ',m\n';
  csv += 'Beam Max Waterline (B_WL),' + state.B + ',m\n';
  csv += 'Draft Canoe Body (T_c),' + state.T + ',m\n';
  csv += 'Longitudinal Center of Buoyancy (LCB),' + state.LCB + ',%\n';
  csv += 'Prismatic Coefficient (C_P),' + state.CP + ',-\n';
  csv += 'Volumetric Displacement (Nabla),' + state.Nabla + ',m³\n';
  csv += 'L/B Ratio,' + (aspectEl ? aspectEl.textContent : '') + ',-\n';
  csv += 'Froude Number,' + (froudeEl ? froudeEl.textContent : '') + ',-\n';
  csv += 'Frictional Resistance (Rf),' + stripUnit(rfEl) + ',kN\n';
  csv += 'Residuary Resistance (Rr),' + stripUnit(rrEl) + ',kN\n';
  csv += 'Total Hull Resistance (Rt),' + stripUnit(rtEl) + ',kN\n';

  downloadBlobCSV('Yacht_Resistance_Report_' + state.L + 'm.csv', csv);
}

function stripUnit(el) {
  if (!el) return '';
  return String(el.textContent || '').replace(/\s*kN\s*/i, '').trim();
}

function exportResistanceCurveCSV() {
  if (!resistanceCurveCache) {
    console.warn('No curve data cached yet — run the solver first.');
    return;
  }

  const c = resistanceCurveCache;
  let csv = 'Froude_Number,Rf_kN,Rr_kN,Rt_kN\n';
  for (let i = 0; i < c.froude.length; i++) {
    csv += c.froude[i] + ',' + c.rf[i] + ',' + c.rr[i] + ',' + c.rt[i] + '\n';
  }

  downloadBlobCSV('Yacht_Resistance_Curve_' + state.L + 'm.csv', csv);
}

function exportFullReportCSV() {
  if (!derivedParamsCache && !resistanceCurveCache) {
    console.warn('No data cached yet — run the solver first.');
    return;
  }

  let csv = 'NavalAI Yacht Resistance Predictor — Full Report\n\n';
  csv += 'HULL PARAMETERS\n';
  csv += 'Parameter,Value,Unit\n';

  HULL_PARAM_SPEC.forEach(function (spec) {
    const val = getHullParamValue(spec);
    const valStr = (val === null || isNaN(val)) ? '' : val.toFixed(spec.decimals);
    csv += '"' + spec.label + '",' + valStr + ',' + spec.unit + '\n';
  });

  csv += '\nRESISTANCE MATRIX\n';
  csv += 'Froude_Number,Rf_kN,Rr_kN,Rt_kN\n';

  if (resistanceCurveCache) {
    const c = resistanceCurveCache;
    for (let i = 0; i < c.froude.length; i++) {
      csv += c.froude[i] + ',' + c.rf[i] + ',' + c.rr[i] + ',' + c.rt[i] + '\n';
    }
  }

  downloadBlobCSV('Yacht_Full_Report_' + state.L + 'm.csv', csv);
}

/* ==========================================================================
   THREE.JS SCENE
   ========================================================================== */
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
    0.1,
    500
  );
  camera.position.set(16, 8, 20);

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
  controls.target.set(0, 0.5, 0);

  scene.add(new THREE.AmbientLight(0x3a4b6e, 0.7));

  const sun = new THREE.DirectionalLight(0xfff5df, 1.3);
  sun.position.set(30, 45, 20);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x4ed0e1, 0.6);
  fill.position.set(-10, -30, -10);
  scene.add(fill);

  /* lower water tessellation for CPU savings (was 60×60) */
  waterGeometry = new THREE.PlaneGeometry(60, 60, 24, 24);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x4ed0e1,
    roughness: 0.1,
    metalness: 0.5,
    flatShading: true,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide
  });
  waterPlane = new THREE.Mesh(waterGeometry, waterMat);
  waterPlane.rotation.x = -Math.PI / 2;
  scene.add(waterPlane);

  yachtGroup = new THREE.Group();
  scene.add(yachtGroup);

  window.addEventListener('resize', onWindowResize, { passive: true });
  animate();
}

function disposeMesh(obj) {
  if (!obj) return;
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) {
      obj.material.forEach(function (m) { if (m && m.dispose) m.dispose(); });
    } else if (obj.material.dispose) {
      obj.material.dispose();
    }
  }
}

function clearYachtGroup() {
  if (!yachtGroup) return;
  while (yachtGroup.children.length) {
    const obj = yachtGroup.children[0];
    yachtGroup.remove(obj);
    disposeMesh(obj);
  }
}

function generateYachtStructure(L, B, T, CB, LCB) {
  if (!yachtGroup || typeof THREE === 'undefined') return;

  clearYachtGroup();

  const hullMat = new THREE.MeshStandardMaterial({
    color: 0x005b66, roughness: 0.1, metalness: 0.7, wireframe: isWireframe
  });
  const superstructureMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.15, metalness: 0.1, wireframe: isWireframe
  });
  const deckMat = new THREE.MeshStandardMaterial({
    color: 0xd2b48c, roughness: 0.55, metalness: 0.0, wireframe: isWireframe
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: 0x1c120c, roughness: 0.05, metalness: 1.0,
    transparent: true, opacity: 0.85, wireframe: isWireframe
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xc8a84b, roughness: 0.15, metalness: 0.95, wireframe: isWireframe
  });

  const hullHeight = T * 1.3;
  /* slightly reduced segments vs original 64/16/32 — still smooth, less CPU */
  const hullGeo = new THREE.BoxGeometry(L, hullHeight, B, 48, 12, 24);
  const pos = hullGeo.attributes.position;
  const lcbShift = (LCB / 100) * L;

  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const nx = x / (L / 2);
    const ny = y / (hullHeight / 2);

    if (nx > 0.4) {
      const bowFactor = (nx - 0.4) / 0.6;
      const horizontalTaper = Math.pow(1.0 - bowFactor, 1.4 - (CB * 0.3));
      z *= horizontalTaper;
      if (ny > 0) x += (ny * 0.28) * bowFactor;
    }
    if (ny < 0) {
      const verticalFactor = (1.0 + ny);
      z *= Math.pow(verticalFactor, 0.65 + (1.0 - CB));
    }
    if (nx < -0.5) {
      const sternFactor = Math.abs(nx + 0.5) / 0.5;
      if (ny > -0.2) x -= sternFactor * (0.14 * L);
    }
    pos.setXYZ(i, x + lcbShift, y, z);
  }
  hullGeo.computeVertexNormals();

  const hullMesh = new THREE.Mesh(hullGeo, hullMat);
  hullMesh.position.y = (hullHeight / 2) - T;
  yachtGroup.add(hullMesh);

  const deckGeo = new THREE.BoxGeometry(L * 0.98, 0.04, B * 0.96, 24, 1, 12);
  const dPos = deckGeo.attributes.position;
  for (let i = 0; i < dPos.count; i++) {
    let x = dPos.getX(i);
    let z = dPos.getZ(i);
    const nx = x / (L / 2);
    if (nx > 0.4) z *= Math.pow(1.0 - (nx - 0.4) / 0.6, 1.3);
    dPos.setXYZ(i, x + lcbShift, dPos.getY(i), z);
  }
  deckGeo.computeVertexNormals();
  const deckMesh = new THREE.Mesh(deckGeo, deckMat);
  deckMesh.position.y = (hullHeight - T) + 0.02;
  yachtGroup.add(deckMesh);

  const cabL = L * 0.54;
  const cabB = B * 0.80;
  const cabH = hullHeight * 0.54;
  const cabinGeo = new THREE.BoxGeometry(cabL, cabH, cabB, 24, 6, 12);
  const cPos = cabinGeo.attributes.position;

  for (let i = 0; i < cPos.count; i++) {
    let x = cPos.getX(i);
    let y = cPos.getY(i);
    let z = cPos.getZ(i);
    const nx = x / (cabL / 2);
    const ny = y / (cabH / 2);

    if (nx > 0.0 && ny > -0.2) {
      const slope = (nx - 0.0) / 1.0;
      x -= slope * (cabL * 0.36) * (ny + 0.2);
    }
    if (nx < 0) z *= (1.0 - (Math.abs(nx) * 0.14));
    cPos.setXYZ(i, x + lcbShift, y, z);
  }
  cabinGeo.computeVertexNormals();
  const cabinMesh = new THREE.Mesh(cabinGeo, superstructureMat);
  cabinMesh.position.set(-L * 0.08 + lcbShift, (hullHeight - T) + (cabH / 2), 0);
  yachtGroup.add(cabinMesh);

  const winL = cabL * 0.48;
  const winB = cabB * 1.03;
  const winH = cabH * 0.44;
  const glassGeo = new THREE.BoxGeometry(winL, winH, winB, 12, 4, 6);
  const gPos = glassGeo.attributes.position;

  for (let i = 0; i < gPos.count; i++) {
    let x = gPos.getX(i);
    let y = gPos.getY(i);
    const nx = x / (winL / 2);
    const ny = y / (winH / 2);

    if (nx > -0.3 && ny > 0) {
      const slope = (nx + 0.3) / 1.3;
      x -= slope * (winL * 0.40);
    }
    gPos.setXYZ(i, x + lcbShift, y, gPos.getZ(i));
  }
  glassGeo.computeVertexNormals();
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  glassMesh.position.set((-L * 0.08) + (cabL * 0.16) + lcbShift, (hullHeight - T) + (cabH * 0.60), 0);
  yachtGroup.add(glassMesh);

  const trimGeo = new THREE.BoxGeometry(L * 0.99, 0.07, B * 1.01);
  const trimMesh = new THREE.Mesh(trimGeo, trimMat);
  trimMesh.position.set(lcbShift, (hullHeight - T) - 0.08, 0);
  yachtGroup.add(trimMesh);
}

function animate() {
  requestAnimationFrame(animate);

  if (!clock) return;

  const dt = Math.min(clock.getDelta(), 0.1);

  /* pause heavy work when tab hidden or CAD not visible */
  if (document.hidden || currentView !== 'cad') return;

  if (controls) controls.update();

  const t = clock.getElapsedTime();

  /* throttle water morph (~12.5 Hz) — big CPU win vs every frame */
  if (waterGeometry && (t - lastWaterUpdate) > 0.08) {
    const p = waterGeometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i);
      const v = p.getY(i);
      const z =
          Math.sin(u * 0.22 + t * 2.3) * 0.58
        + Math.cos(v * 0.18 + t * 1.9) * 0.46
        + Math.sin((u + v) * 0.55 + t * 3.4) * 0.16;
      p.setZ(i, z);
    }
    /* skip computeVertexNormals — flatShading does not need them */
    waterGeometry.attributes.position.needsUpdate = true;
    lastWaterUpdate = t;
  }

  frameDelta += dt;
  if (frameDelta >= FRAME_INTERVAL) {
    if (yachtGroup) {
      yachtGroup.position.y = Math.sin(t * 2.1) * 0.24 - 0.05;
      yachtGroup.rotation.z = Math.cos(t * 2.3) * 0.07 + 0.02;
      yachtGroup.rotation.x = Math.sin(t * 1.3) * 0.14;
      yachtGroup.rotation.y = Math.cos(t * 0.7) * 0.03;
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