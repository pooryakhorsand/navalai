/**
 * app_hollenbach.js
 * NavalAI — Hollenbach Resistance Solver (Optimized 2025)
 *
 * Optimized for:
 * - Lazy Plotly + KaTeX loading
 * - Response caching with stable hash
 * - Request aborting (AbortController)
 * - Debounced updates
 * - Low CPU 3D animation
 * - Consistent architecture with Turning Circle
 *
 * NOTE: buildHull()/frameCamera()/animate() restored to the full
 * procedural bulk-carrier hull model (bow/stern shaping, containers,
 * accommodation block, funnel, bulbous bow, appendages) instead of
 * the placeholder box-extrusion hull.
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.hollenbachApi || '/hollenbach/';

const DEBOUNCE_MS = 180;
const TARGET_FPS = 40;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;
const MAX_PLOT_POINTS = 180;

/* Default wetted areas (m²) per appendage type — used when a checkbox
   is enabled and no explicit area has been set yet. */
const APP_DEFAULT_AREAS = {
  behind_skeg: 12, behind_stern: 10, twin: 8, keel: 20, shaft: 15,
  strut: 6, bracket: 5, fin: 8, dome: 18, hull: 10,
};

let state = {
  LPP: 162.4, LWL: 167.21, LOS: 172.90,
  B: 24.8, T: 9.6, V: 28201,
  AVS: 508.8, dTH: 1.2, D: 6.693,
  Vl: 14.0, Vh: 20.0,
  // appendages will be populated from DOM
};

let resCache = null;       // holds data.results
let warnCache = [];        // holds data.warnings
let responseCache = new Map();
let debounceTimer = null;
let activeFetchController = null;
let requestSeq = 0;

let currentView = 'cad';
let curveFilter = 'all';
let isWireframe = false;

let scene, camera, renderer, controls, clock;
let hullGroup, waterGeometry, waterMesh;
let lastWaterUpdate = 0;
let waveAmp = 1.6;

let plotlyLoadingPromise = null;
let katexLoadingPromise = null;
let katexRendered = false;

const assetPromises = new Map();

/* ─────────────────────────────────────────────────────────────
   DOM Ready
───────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
  initSliders();
  initAppendageCheckboxes();
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

  // Initial load
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(() => runSolver(), { timeout: 600 });
  } else {
    setTimeout(runSolver, 10);
  }
});

/* ─────────────────────────────────────────────────────────────
   Lazy Asset Loaders (same as Turning)
───────────────────────────────────────────────────────────── */
function loadScriptOnce(src) {
  const key = 'script:' + src;
  if (assetPromises.has(key)) return assetPromises.get(key);

  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
  assetPromises.set(key, p);
  return p;
}

function loadCssOnce(href) {
  const key = 'css:' + href;
  if (assetPromises.has(key)) return assetPromises.get(key);

  const p = new Promise((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => resolve();
    l.onerror = () => reject(new Error('Failed to load ' + href));
    document.head.appendChild(l);
  });
  assetPromises.set(key, p);
  return p;
}

function ensurePlotly() {
  if (typeof Plotly !== 'undefined') return Promise.resolve();
  if (plotlyLoadingPromise) return plotlyLoadingPromise;

  const src = ASSETS.plotly || '/static/core/js/plotly-basic-2.24.1.min.js';
  plotlyLoadingPromise = loadScriptOnce(src);
  return plotlyLoadingPromise;
}

function ensureKatexRendered() {
  const overlay = document.getElementById('theory-overlay');
  if (!overlay || katexRendered) return Promise.resolve();
  if (katexLoadingPromise) return katexLoadingPromise;

  katexLoadingPromise = Promise.all([
    loadCssOnce(ASSETS.katexCss),
    loadScriptOnce(ASSETS.katexJs)
  ])
    .then(() => loadScriptOnce(ASSETS.katexAutoRender))
    .then(() => {
      if (typeof renderMathInElement === 'function') {
        renderMathInElement(overlay, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false
        });
      }
      katexRendered = true;
    })
    .catch(err => console.warn('KaTeX load failed:', err));

  return katexLoadingPromise;
}

/* ─────────────────────────────────────────────────────────────
   UI Initialization
───────────────────────────────────────────────────────────── */
function initSliders() {
  const defs = [
    { id: 'sl-lpp', key: 'LPP', disp: 'val-lpp', fmt: v => v.toFixed(1) + ' m' },
    { id: 'sl-lwl', key: 'LWL', disp: 'val-lwl', fmt: v => v.toFixed(1) + ' m' },
    { id: 'sl-los', key: 'LOS', disp: 'val-los', fmt: v => v.toFixed(1) + ' m' },
    { id: 'sl-beam', key: 'B', disp: 'val-beam', fmt: v => v.toFixed(1) + ' m' },
    { id: 'sl-t', key: 'T', disp: 'val-t', fmt: v => v.toFixed(1) + ' m' },
    { id: 'sl-v', key: 'V', disp: 'val-v', fmt: v => Math.round(v) + ' m³' },
    { id: 'sl-avs', key: 'AVS', disp: 'val-avs', fmt: v => v.toFixed(0) + ' m²' },
    { id: 'sl-dth', key: 'dTH', disp: 'val-dth', fmt: v => v.toFixed(2) + ' m' },
    { id: 'sl-d', key: 'D', disp: 'val-d', fmt: v => v.toFixed(3) + ' m' },
    { id: 'sl-vl', key: 'Vl', disp: 'val-vl', fmt: v => v.toFixed(1) + ' kn' },
    { id: 'sl-vh', key: 'Vh', disp: 'val-vh', fmt: v => v.toFixed(1) + ' kn' },
  ];

  defs.forEach(s => {
    const el = document.getElementById(s.id);
    const disp = document.getElementById(s.disp);
    if (!el) return;

    const initial = parseFloat(el.value);
    if (!isNaN(initial)) state[s.key] = initial;
    if (disp) disp.textContent = s.fmt(initial);

    el.addEventListener('input', () => {
      state[s.key] = parseFloat(el.value);
      if (disp) disp.textContent = s.fmt(state[s.key]);
      updateHUD();
      buildHull();
      scheduleDebouncedRun();
    });
  });
}

function initAppendageCheckboxes() {
  document.querySelectorAll('.app-check').forEach(cb => {
    cb.addEventListener('change', function () {
      const areaId = this.dataset.areaId;
      const appKey = this.dataset.appendage;
      const k2 = parseFloat(this.dataset.k2);
      const valEl = this.closest('.appendage-row').querySelector('.app-val');

      if (this.checked) {
        state[appKey] = k2;
        state[areaId] = APP_DEFAULT_AREAS[appKey] || 10;
        valEl.textContent = `k₂=${k2.toFixed(1)}`;
      } else {
        state[appKey] = 0;
        state[areaId] = 0;
        valEl.textContent = '—';
      }
      buildHull();
      scheduleDebouncedRun();
    });
  });
}

function initCollapsibleSections() {
  document.querySelectorAll('.section-label--clickable').forEach(label => {
    label.addEventListener('click', () => {
      label.closest('.input-section--collapsible').classList.toggle('collapsed');
    });
  });
}

function initTheoryModalEvents() {
  const overlay = document.getElementById('theory-overlay');
  const openBtn = document.getElementById('btn-open-theory');
  const closeBtn = document.getElementById('btn-close-theory');
  const startBtn = document.getElementById('btn-start-sim');

  openBtn?.addEventListener('click', () => {
    overlay.classList.add('active');
    ensureKatexRendered();
  });

  closeBtn?.addEventListener('click', () => overlay.classList.remove('active'));
  startBtn?.addEventListener('click', () => overlay.classList.remove('active'));
}

function initViewSwitcher() {
  const buttons = {
    cad: document.getElementById('toggle-cad'),
    plots: document.getElementById('toggle-plots'),
    table: document.getElementById('toggle-table')
  };

  const panels = {
    cad: document.querySelector('.visualizer-panel'),
    plots: document.querySelector('.chart-panel'),
    table: document.querySelector('.table-panel')
  };

  const switchTo = (view) => {
    currentView = view;
    Object.keys(panels).forEach(v => {
      panels[v].classList.toggle('is-hidden', v !== view);
      buttons[v].classList.toggle('active-view', v === view);
    });

    if (view === 'plots') renderPlot();
    if (view === 'table') renderTables();
    if (view === 'cad') onWindowResize();
  };

  Object.keys(buttons).forEach(key => {
    buttons[key]?.addEventListener('click', () => switchTo(key));
  });

  document.getElementById('curve-filter')?.addEventListener('change', e => {
    curveFilter = e.target.value;
    if (currentView === 'plots') renderPlot();
  });
}

function initToolbarEvents() {
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    camera.position.multiplyScalar(0.82); controls.update();
  });
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    camera.position.multiplyScalar(1.22); controls.update();
  });
  document.getElementById('btn-reset-view')?.addEventListener('click', () => frameCamera(state.LPP));
  document.getElementById('btn-wireframe')?.addEventListener('click', () => {
    isWireframe = !isWireframe;
    buildHull();
  });
  document.getElementById('btn-download-img')?.addEventListener('click', downloadImage);
  document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
  document.getElementById('btn-export-curve-csv')?.addEventListener('click', exportCSV);
  document.getElementById('btn-export-full-csv')?.addEventListener('click', exportCSV);
}

/* ─────────────────────────────────────────────────────────────
   Status & HUD
───────────────────────────────────────────────────────────── */
function setStatus(mode, text) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  if (dot) dot.className = `status-dot ${mode}`;
  if (txt) txt.textContent = text;
}

function updateHUD() {
  const lb = (state.LPP / state.B).toFixed(2);
  const cb = (state.V / (state.B * state.T * state.LPP)).toFixed(3);
  document.getElementById('val-aspect').textContent = lb;
  document.getElementById('hud-lb').textContent = lb;
  document.getElementById('hud-cb').textContent = cb;
}

function updateWarningBanner() {
  const banner = document.getElementById('warn-banner');
  if (!banner) return;

  if (!warnCache || warnCache.length === 0) {
    banner.classList.remove('visible');
    banner.textContent = '';
    return;
  }

  banner.textContent = '⚠ ' + warnCache.join(' · ');
  banner.classList.add('visible');
}

/* ─────────────────────────────────────────────────────────────
   Solver + Caching
───────────────────────────────────────────────────────────── */
function readPayload() {
  return {
    LPP: state.LPP, LWL: state.LWL, LOS: state.LOS,
    B: state.B, T: state.T, V: state.V,
    AVS: state.AVS, dTH: state.dTH, D: state.D,
    Vl: state.Vl, Vh: state.Vh,
    ...Object.fromEntries(
      Object.keys(state).filter(k => k.includes('_area') || k.includes('behind') || k.includes('keel') || k.includes('shaft'))
        .map(k => [k, state[k]])
    )
  };
}

function stableHash(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function scheduleDebouncedRun() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSolver, DEBOUNCE_MS);
}

async function runSolver() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const payload = readPayload();
  const cacheKey = stableHash(payload);
  const seq = ++requestSeq;

  if (activeFetchController) activeFetchController.abort();
  if (responseCache.has(cacheKey)) {
    const cachedEntry = responseCache.get(cacheKey);
    resCache = cachedEntry.results;
    warnCache = cachedEntry.warnings || [];
    setStatus('ok', 'READY (cached)');
    updateTelemetry();
    updateWarningBanner();
    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();
    return;
  }

  setStatus('loading', 'COMPUTING');
  const loadingEl = document.getElementById('loading-overlay');
  if (loadingEl) loadingEl.classList.add('active');

  const controller = new AbortController();
  activeFetchController = controller;

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const json = await resp.json();
    if (!json.success) throw new Error(json.message || 'Solver error');

    if (seq !== requestSeq) return;

    // Backend envelope: { success, data: { inputs, results, warnings }, message }
    const payloadData = json.data || {};
    resCache = payloadData.results || null;
    warnCache = payloadData.warnings || [];

    if (!resCache || !Array.isArray(resCache.speeds_knots)) {
      throw new Error('Unexpected response shape from solver API.');
    }

    if (responseCache.size > 15) responseCache.delete(responseCache.keys().next().value);
    responseCache.set(cacheKey, { results: resCache, warnings: warnCache });

    setStatus('ok', 'READY');
    updateTelemetry();
    updateWarningBanner();
    buildHull(); // rebuild with new dimensions

    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();

  } catch (err) {
    if (err.name === 'AbortError') return;
    if (seq !== requestSeq) return;

    console.error(err);
    setStatus('err', 'ERROR');
  } finally {
    if (seq === requestSeq) {
      if (loadingEl) loadingEl.classList.remove('active');
      activeFetchController = null;
    }
  }
}

/* ─────────────────────────────────────────────────────────────
   Telemetry, Plot, Table, Export (updated to new structure)
───────────────────────────────────────────────────────────── */
function updateTelemetry() {
  if (!resCache || !Array.isArray(resCache.speeds_knots)) return;
  const d = resCache;
  const i = d.speeds_knots.length - 1;

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('error-state');
      el.textContent = val;
    }
  };

  const kn = v => (v / 1000).toFixed(2) + ' kN';

  set('t-rt-mean', kn(d.RT_mean_N[i]));
  set('t-rt-min', kn(d.RT_min_N[i]));
  set('t-rf', kn(d.R_friction_mean_N[i]));
  set('t-rw', kn(d.R_wave_mean_N[i]));
  set('t-rapp', kn(d.R_appendage_mean_N[i]));
  set('t-cb', d.CB.toFixed(3));
  set('t-sd', d.Wetted_Surface_Sd.toFixed(1) + ' m²');
  set('t-k2', d.k2_effective.toFixed(3));
  set('t-fn', d.speeds_knots[i].toFixed(1) + ' kn');
}

function renderPlot() {
  const target = document.getElementById('plot-target');
  if (!target) return;

  if (typeof Plotly === 'undefined') {
    ensurePlotly().then(() => renderPlot());
    return;
  }

  if (!resCache || !Array.isArray(resCache.speeds_knots)) {
    Plotly.newPlot(target, [], { title: { text: 'No data yet' } }, { responsive: true });
    return;
  }

  const d = resCache;
  const spd = d.speeds_knots;
  const toKN = arr => arr.map(v => v / 1000);

  const seriesDef = [
    { key: 'mean', name: 'Rt Mean', color: '#22c55e', width: 3, dash: 'solid', y: toKN(d.RT_mean_N) },
    { key: 'min', name: 'Rt Min', color: '#38c9d8', width: 3, dash: 'dash', y: toKN(d.RT_min_N) },
    { key: 'friction', name: 'Rf', color: '#f59e0b', width: 1.8, dash: 'solid', y: toKN(d.R_friction_mean_N) },
    { key: 'wave', name: 'Rw', color: '#a78bfa', width: 1.8, dash: 'dash', y: toKN(d.R_wave_mean_N) },
    { key: 'appendage', name: 'Rapp', color: '#fb7185', width: 1.6, dash: 'dot', y: toKN(d.R_appendage_mean_N) },
  ];

  const traces = seriesDef
    .filter(s => curveFilter === 'all' || curveFilter === s.key)
    .map(s => ({
      x: spd,
      y: s.y,
      mode: 'lines',
      name: s.name,
      line: { color: s.color, width: s.width, dash: s.dash }
    }));

  const layout = {
    paper_bgcolor: '#060d18',
    plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 60, r: 30, t: 30, b: 60 },
    xaxis: { title: 'Speed (knots)', gridcolor: '#1e293b' },
    yaxis: { title: 'Resistance (kN)', gridcolor: '#1e293b', rangemode: 'tozero' },
    legend: { bgcolor: 'rgba(6,13,24,0.85)', bordercolor: '#334155' },
    hovermode: 'x unified'
  };

  Plotly.newPlot(target, traces, layout, { responsive: true, displaylogo: false });
}

function renderTables() {
  const target = document.getElementById('table-target');
  if (!target) return;

  if (!resCache || !Array.isArray(resCache.speeds_knots)) {
    target.innerHTML = '<div class="data-table-empty">Awaiting solver data — click Run Simulation.</div>';
    return;
  }

  const d = resCache;
  const n = d.speeds_knots.length;

  let rows = '';
  for (let i = 0; i < n; i++) {
    rows += `<tr>
      <td>${d.speeds_knots[i].toFixed(1)}</td>
      <td>${(d.RT_mean_N[i] / 1000).toFixed(2)}</td>
      <td class="col-min">${(d.RT_min_N[i] / 1000).toFixed(2)}</td>
      <td>${(d.R_friction_mean_N[i] / 1000).toFixed(2)}</td>
      <td>${(d.R_wave_mean_N[i] / 1000).toFixed(2)}</td>
      <td>${(d.R_appendage_mean_N[i] / 1000).toFixed(2)}</td>
    </tr>`;
  }

  target.innerHTML = `
    <div class="tbl-block">
      <div class="tbl-title">Full Resistance Matrix (CB = ${d.CB.toFixed(3)}, Sd = ${d.Wetted_Surface_Sd.toFixed(1)} m²)</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Speed (kn)</th>
            <th>Rt Mean (kN)</th>
            <th>Rt Min (kN)</th>
            <th>Rf (kN)</th>
            <th>Rw (kN)</th>
            <th>Rapp (kN)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function exportCSV() {
  if (!resCache || !Array.isArray(resCache.speeds_knots)) return;
  const d = resCache;
  const n = d.speeds_knots.length;

  let csv = 'Speed_kn,RT_mean_kN,RT_min_kN,R_friction_kN,R_wave_kN,R_appendage_kN\n';
  for (let i = 0; i < n; i++) {
    csv += [
      d.speeds_knots[i].toFixed(2),
      (d.RT_mean_N[i] / 1000).toFixed(3),
      (d.RT_min_N[i] / 1000).toFixed(3),
      (d.R_friction_mean_N[i] / 1000).toFixed(3),
      (d.R_wave_mean_N[i] / 1000).toFixed(3),
      (d.R_appendage_mean_N[i] / 1000).toFixed(3),
    ].join(',') + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Hollenbach_L${state.LPP.toFixed(0)}m_resistance.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ─────────────────────────────────────────────────────────────
   THREE.JS — SCENE SETUP
───────────────────────────────────────────────────────────── */
function init3D() {
  const container = document.getElementById('canvas-3d-target');
  clock = new THREE.Clock();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x071825);
  scene.fog = new THREE.FogExp2(0x071825, 0.0007);

  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.5, 8000);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Lighting
  scene.add(new THREE.AmbientLight(0x2a3f60, 0.85));

  const sun = new THREE.DirectionalLight(0xfff5df, 1.4);
  sun.position.set(400, 520, 240);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x38c9d8, 0.65);
  fill.position.set(-150, -200, -100);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xc8a84b, 0.35);
  rim.position.set(0, 320, -420);
  scene.add(rim);

  // Ocean plane
  waterGeometry = new THREE.PlaneGeometry(2400, 2400, 128, 128);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1a5f7a, roughness: 0.06, metalness: 0.6,
    flatShading: true, transparent: true, opacity: 0.58, side: THREE.DoubleSide
  });
  waterMesh = new THREE.Mesh(waterGeometry, waterMat);
  waterMesh.rotation.x = -Math.PI / 2;
  scene.add(waterMesh);

  hullGroup = new THREE.Group();
  scene.add(hullGroup);

  buildHull();
  frameCamera(state.LPP);

  window.addEventListener('resize', onWindowResize);
  animate();
}

function frameCamera(L) {
  if (!camera || !controls) return;
  camera.position.set(L * 0.78, L * 0.40, L * 1.08);
  controls.target.set(0, state.T * 0.35, 0);
  controls.update();
}

/* ─────────────────────────────────────────────────────────────
   THREE.JS — PROCEDURAL BULK CARRIER / GENERAL CARGO HULL
   (restored full model — bow/stern shaping, boot-top, deck,
   container stacks, forecastle, accommodation block, funnel,
   bulbous bow, and appendage geometry)
───────────────────────────────────────────────────────────── */
function buildHull() {
  if (!hullGroup) return;

  // Clear previous hull
  while (hullGroup.children.length > 0) {
    const child = hullGroup.children[0];
    disposeThreeObject(child);
    hullGroup.remove(child);
  }

  const L = state.LPP;
  const B = state.B;
  const T = state.T;
  const CB = Math.min(0.92, Math.max(0.40, state.V / (B * T * L)));

  waveAmp = Math.max(0.5, L * 0.011);

  // material factory
  function M(col, r, m) {
    return new THREE.MeshStandardMaterial({
      color: col, roughness: r, metalness: m, wireframe: isWireframe,
    });
  }
  function Mtrans(col, emissive, r, m, op) {
    return new THREE.MeshStandardMaterial({
      color: col, emissive: emissive,
      roughness: r, metalness: m,
      transparent: true, opacity: op,
      wireframe: isWireframe,
    });
  }

  const mHull = M(0x1a2e44, 0.40, 0.55);
  const mBoot = M(0xc8a84b, 0.08, 0.95);
  const mDeck = M(0x2a3340, 0.65, 0.10);
  const mAcc = M(0xdedbd3, 0.30, 0.08);
  const mGlass = Mtrans(0x081420, 0x0a1e30, 0.04, 1.0, 0.88);
  const mFunnel = M(0x2a3340, 0.40, 0.55);
  const mFband = M(0xb23b3b, 0.40, 0.30);
  const mDark = M(0x0e1820, 0.50, 0.45);
  const mBulb = M(0x101e2c, 0.25, 0.70);

  const hH = T * 1.60;           // total hull height above keel
  const deckY = hH - T;          // deck height above waterline (y=0)

  /* ── MAIN HULL BODY ─────────────────────────────────────────── */
  const hGeo = new THREE.BoxGeometry(L, hH, B, 90, 22, 40);
  const hp = hGeo.attributes.position;

  for (let i = 0; i < hp.count; i++) {
    let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    const nx = x / (L / 2);
    const ny = y / (hH / 2);

    // BOW — bluffer entry typical for bulk/cargo, clean stem
    if (nx > 0.42) {
      const t = (nx - 0.42) / 0.58;
      z *= Math.pow(1 - t, 1.5 - CB * 0.4);
      if (ny > 0.1) x += t * ny * L * 0.018; // flare
    }

    // KEEL rounding (bilge radius)
    if (ny < 0) z *= Math.pow(1 + ny, 0.52 + (1 - CB) * 0.55);

    // STERN — rounded / counter form
    if (nx < -0.42) {
      const t = Math.abs(nx + 0.42) / 0.58;
      if (ny > -0.15) x -= t * L * 0.045;
      z *= (1 - t * 0.28);
    }

    hp.setXYZ(i, x, y, z);
  }
  hGeo.computeVertexNormals();

  const hull = new THREE.Mesh(hGeo, mHull);
  hull.position.y = hH / 2 - T;
  hullGroup.add(hull);

  // Boot-top stripe at waterline
  const boot = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.993, T * 0.072, B * 1.006), mBoot
  );
  boot.position.y = 0;
  hullGroup.add(boot);

  // Main deck
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.97, T * 0.055, B * 0.94), mDeck
  );
  deck.position.y = deckY + T * 0.027;
  hullGroup.add(deck);

  /* ── CONTAINER CARGO ZONE ────────────────────────────────────── */
  const CONTAINER_COLORS = [
    0xb23b3b, 0x2f6fb0, 0x3f9e57, 0x8a8f96,
    0xd08a2a, 0x7a5fb0, 0xc9a227, 0x2f8f8f, 0xa84b4b,
  ];

  const cargoX0 = -L * 0.32;
  const cargoX1 = L * 0.36;
  const cargoL = cargoX1 - cargoX0;
  const cargoZw = B * 0.82;

  const nBays = Math.max(4, Math.min(22, Math.floor(cargoL / 13)));
  const nRows = Math.max(2, Math.min(11, Math.floor(cargoZw / 2.6)));
  const bayPitch = cargoL / nBays;
  const rowPitch = cargoZw / nRows;
  const cHeight = 2.59; // ISO container height
  const deckBaseY = deckY + T * 0.082;

  for (let bay = 0; bay < nBays; bay++) {
    const fxN = bay / Math.max(1, nBays - 1);
    const lengthwise = 1 - Math.pow((fxN - 0.5) * 1.7, 2);

    for (let row = 0; row < nRows; row++) {
      // occasional loading gap
      if ((bay * 3 + row * 7) % 17 === 0) continue;

      const widthwise = 1 - Math.abs((row / Math.max(1, nRows - 1)) - 0.5) * 0.7;
      let tiers = Math.round(
        2 + lengthwise * 4 * widthwise +
        (Math.sin(bay * 1.7 + row * 0.9) > 0.55 ? 1 : 0)
      );
      tiers = Math.max(1, Math.min(7, tiers));

      const w = bayPitch * 0.86;
      const dpt = rowPitch * 0.86;
      const h = tiers * cHeight;

      const stack = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, dpt),
        M(CONTAINER_COLORS[(bay * 5 + row * 3) % CONTAINER_COLORS.length], 0.6, 0.05)
      );
      stack.position.set(
        cargoX0 + (bay + 0.5) * bayPitch,
        deckBaseY + h / 2,
        -cargoZw / 2 + (row + 0.5) * rowPitch
      );
      hullGroup.add(stack);
    }
  }

  /* ── FORECASTLE ──────────────────────────────────────────────── */
  const fcL = L * 0.08;
  const fcH = T * 0.52;
  const fc = new THREE.Mesh(
    new THREE.BoxGeometry(fcL, fcH, B * 0.65), mHull
  );
  fc.position.set(cargoX1 + fcL * 0.65, deckY + fcH / 2, 0);
  hullGroup.add(fc);

  // anchor windlass drum
  const wl = new THREE.Mesh(
    new THREE.CylinderGeometry(B * 0.04, B * 0.04, B * 0.14, 12), mDark
  );
  wl.rotation.z = Math.PI / 2;
  wl.position.set(cargoX1 + fcL * 0.7, deckY + fcH + B * 0.058, 0);
  hullGroup.add(wl);

  /* ── AFT ACCOMMODATION BLOCK ──────────────────────────────────── */
  const accL = L * 0.09;
  const accB = B * 0.78;
  const accH = T * 4.8;
  const accX = cargoX0 - accL * 0.72;

  const acc = new THREE.Mesh(
    new THREE.BoxGeometry(accL, accH, accB), mAcc
  );
  acc.position.set(accX, deckY + accH / 2, 0);
  hullGroup.add(acc);

  // bridge window band
  const wb = new THREE.Mesh(
    new THREE.BoxGeometry(accL * 0.92, accH * 0.12, accB * 1.02), mGlass
  );
  wb.position.set(accX + accL * 0.05, deckY + accH * 0.87, 0);
  hullGroup.add(wb);

  // wing bridge wings
  [-1, 1].forEach(function (s) {
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(accL * 0.5, T * 0.06, B * 0.15), mAcc
    );
    wing.position.set(accX + accL * 0.05, deckY + accH * 0.83, s * (accB / 2 + B * 0.075));
    hullGroup.add(wing);
  });

  /* ── FUNNEL ──────────────────────────────────────────────────── */
  const fnR = B * 0.065;
  const fnH = T * 3.0;
  const fnX = accX - accL * 0.82;

  const funnel = new THREE.Mesh(
    new THREE.CylinderGeometry(fnR * 0.78, fnR, fnH, 20), mFunnel
  );
  funnel.position.set(fnX, deckY + fnH / 2, 0);
  hullGroup.add(funnel);

  // colour band
  const fb = new THREE.Mesh(
    new THREE.CylinderGeometry(fnR * 0.80, fnR * 0.90, fnH * 0.26, 20), mFband
  );
  fb.position.set(fnX, deckY + fnH * 0.63, 0);
  hullGroup.add(fb);

  // top cap
  const fcap = new THREE.Mesh(
    new THREE.CylinderGeometry(fnR * 0.50, fnR * 0.78, fnH * 0.12, 20), mDark
  );
  fcap.position.set(fnX, deckY + fnH * 0.97, 0);
  hullGroup.add(fcap);

  /* ── BULBOUS BOW ─────────────────────────────────────────────── */
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(B * 0.11, 18, 14), mBulb);
  bulb.scale.set(1.7, 1.0, 0.9);
  bulb.position.set(L / 2 + B * 0.06, -T * 0.42, 0);
  hullGroup.add(bulb);

  /* ── APPENDAGE: RUDDER ───────────────────────────────────────── */
  if (state.behind_skeg || state.behind_stern || state.twin) {
    const rud = new THREE.Mesh(
      new THREE.BoxGeometry(L * 0.025, T * 0.88, B * 0.014), mDark
    );
    rud.position.set(-L * 0.49, -T * 0.38, 0);
    hullGroup.add(rud);
  }

  /* ── APPENDAGE: BILGE KEELS ──────────────────────────────────── */
  if (state.keel > 0) {
    const kg = new THREE.BoxGeometry(L * 0.42, T * 0.035, B * 0.024);
    [-1, 1].forEach(function (s) {
      const k = new THREE.Mesh(kg, mDark);
      k.position.set(0, -T * 0.70, s * B * 0.50);
      hullGroup.add(k);
    });
  }

  /* ── APPENDAGE: SHAFT LINES ──────────────────────────────────── */
  if (state.shaft > 0) {
    const sg = new THREE.CylinderGeometry(B * 0.013, B * 0.013, L * 0.28, 10);
    const s1 = new THREE.Mesh(sg, mDark);
    s1.rotation.z = Math.PI / 2;
    s1.position.set(-L * 0.30, -T * 0.78, state.twin ? B * 0.20 : 0);
    hullGroup.add(s1);
    if (state.twin) {
      const s2 = s1.clone();
      s2.position.z = -B * 0.20;
      hullGroup.add(s2);
    }
  }

  // update HUD aspect ratio (kept in sync with updateHUD too)
  const aspectEl = document.getElementById('val-aspect');
  if (aspectEl) aspectEl.textContent = (L / B).toFixed(2);
}

function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  clock.getDelta(); // keep internal delta clock ticking

  if (controls) controls.update();

  // animated water surface
  if (waterGeometry && (t - lastWaterUpdate) > 0.045) {
    const p = waterGeometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i), v = p.getY(i);
      const z =
        Math.sin(u * 0.042 + t * 1.5) * waveAmp +
        Math.cos(v * 0.036 + t * 1.2) * waveAmp * 0.75 +
        Math.sin((u + v) * 0.078 + t * 2.2) * waveAmp * 0.32;
      p.setZ(i, z);
    }
    waterGeometry.computeVertexNormals();
    p.needsUpdate = true;
    lastWaterUpdate = t;
  }

  // gentle ship motion
  if (hullGroup) {
    hullGroup.position.y = Math.sin(t * 1.40) * waveAmp * 0.38 - 0.1;
    hullGroup.rotation.z = Math.cos(t * 1.50) * 0.013;
    hullGroup.rotation.x = Math.sin(t * 1.00) * 0.007;
  }

  if (renderer && scene && camera) renderer.render(scene, camera);
}

function onWindowResize() {
  const c = document.getElementById('canvas-3d-target');
  if (!c || !camera || !renderer) return;
  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(c.clientWidth, c.clientHeight);
}

function downloadImage() {
  renderer.render(scene, camera);
  const link = document.createElement('a');
  link.download = `Hollenbach_L${state.LPP.toFixed(0)}m.png`;
  link.href = renderer.domElement.toDataURL('image/png');
  link.click();
}

/* Final helper */
function disposeThreeObject(obj) {
  if (!obj) return;
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose?.());
      else o.material.dispose?.();
    }
  });
}