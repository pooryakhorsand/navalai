/**
 * app_holtrop.js
 * NavalAI — Holtrop & Mennen Ship resistance Solver
 */

'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.holtropApi || '/holtrop/';

const DEBOUNCE_MS = 220;
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;
const MAX_PLOT_POINTS = 1200;

const APP_DEFAULT_AREAS = {
  behind_skeg: 12,
  behind_stern: 10,
  twin: 8,
  skeg: 9,
  keel: 20,
  shaft: 15,
  strut: 6,
  bracket: 5,
  fin: 8,
  dome: 18,
  hull: 10
};

const CONTAINER_COLORS = [
  0xb23b3b, 0x2f6fb0, 0x3f9e57, 0x8a8f96,
  0xd08a2a, 0x7a5fb0, 0xc9a227, 0x2f8f8f, 0xa84b4b
];

const SLIDER_DEFS = [
  { id: 'sl-wl',   key: 'wl',   disp: 'val-wl',   fmt: v => v.toFixed(1) + ' m' },
  { id: 'sl-beam', key: 'beam', disp: 'val-beam', fmt: v => v.toFixed(1) + ' m' },
  { id: 'sl-df',   key: 'df',   disp: 'val-df',   fmt: v => v.toFixed(1) + ' m' },
  { id: 'sl-da',   key: 'da',   disp: 'val-da',   fmt: v => v.toFixed(1) + ' m' },
  { id: 'sl-lcb',  key: 'lcb',  disp: 'val-lcb',  fmt: v => v.toFixed(1) + ' %' },
  { id: 'sl-cb',   key: 'cb',   disp: 'val-cb',   fmt: v => v.toFixed(3) },
  { id: 'sl-cm',   key: 'cm',   disp: 'val-cm',   fmt: v => v.toFixed(3) },
  { id: 'sl-cwl',  key: 'cwl',  disp: 'val-cwl',  fmt: v => v.toFixed(3) }
];

let state = {
  wl: 150,
  beam: 25,
  df: 8.5,
  da: 9.0,
  lcb: -2.5,
  cb: 0.65,
  cm: 0.96,
  cwl: 0.82,

  bulbous: 0,
  transom: 0,
  aft_body: 0,

  dome: 0, dome_area: 0,
  keel: 0, keel_area: 0,
  behind_skeg: 0, behind_skeg_area: 0,
  behind_stern: 0, behind_stern_area: 0,
  twin: 0, twin_area: 0,
  bracket: 0, bracket_area: 0,
  skeg: 0, skeg_area: 0,
  strut: 0, strut_area: 0,
  hull: 0, hull_area: 0,
  shaft: 0, shaft_area: 0,
  fin: 0, fin_area: 0
};

let resCache = null;
let responseCache = new Map();

let currentView = 'cad';
let curveFilter = 'all';
let isWireframe = false;

let debounceTimer = null;
let activeFetchController = null;
let requestSeq = 0;

let scene, camera, renderer, controls, clock;
let hullGroup, waterPlane, waterGeometry;
let frameDelta = 0;
let lastWaterUpdate = 0;
let waveAmp = 1.6;

let plotlyLoadingPromise = null;
const assetPromises = new Map();

document.addEventListener('DOMContentLoaded', function () {
  initSliders();
  initTheoryModalEvents();
  initViewSwitcher();
  initToolbarEvents();
  initConfigButtons();
  initAppendageRows();
  initAppendageCollapse();

  if (typeof THREE === 'undefined') {
    setStatus('err', 'THREE.JS MISSING');
    return;
  }

  init3D();
  renderHullShape();
  updateHUD();
  setStatus('ready', 'READY');

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(function () {
      runSolver();
    }, { timeout: 650 });
  } else {
    setTimeout(function () {
      runSolver();
    }, 0);
  }
});

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────
function byId(id) {
  return document.getElementById(id);
}

function on(id, evt, fn) {
  const el = byId(id);
  if (el) el.addEventListener(evt, fn);
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

      renderHullShape();
      updateHUD();
      scheduleDebouncedRun();
    });
  });
}

// FIX #1: bind on [data-toggle-group] / [data-toggle-value] and [data-aft]
function initConfigButtons() {
  document.querySelectorAll('[data-toggle-group]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const key = btn.getAttribute('data-toggle-group');
      const val = parseInt(btn.getAttribute('data-toggle-value'), 10) || 0;

      state[key] = val;

      document.querySelectorAll('[data-toggle-group="' + key + '"]').forEach(function (peer) {
        const peerVal = parseInt(peer.getAttribute('data-toggle-value'), 10) || 0;
        peer.classList.toggle('active', peerVal === val);
      });

      renderHullShape();
      updateHUD();
      scheduleDebouncedRun();
    });
  });

  document.querySelectorAll('[data-aft]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const val = parseInt(btn.getAttribute('data-aft'), 10) || 0;
      state.aft_body = val;

      document.querySelectorAll('[data-aft]').forEach(function (peer) {
        const peerVal = parseInt(peer.getAttribute('data-aft'), 10) || 0;
        peer.classList.toggle('active', peerVal === val);
      });

      renderHullShape();
      updateHUD();
      scheduleDebouncedRun();
    });
  });
}

// FIX #2: read data-app-key / data-app-area / data-app-factor from the row
function initAppendageRows() {
  document.querySelectorAll('.appendage-row').forEach(function (row) {
    const cb = row.querySelector('.app-check');
    if (!cb) return;

    const key = row.getAttribute('data-app-key');
    const areaKey = row.getAttribute('data-app-area');
    const factor = parseFloat(row.getAttribute('data-app-factor') || '0');

    if (!key || !areaKey) return; // skip malformed rows instead of silently failing

    cb.addEventListener('change', function () {
      const vs = row.querySelector('.app-val');

      if (cb.checked) {
        row.classList.add('enabled');
        state[key] = factor;
        state[areaKey] = APP_DEFAULT_AREAS[key] || 10;
        if (vs) vs.textContent = 'k₂=' + factor.toFixed(1);
      } else {
        row.classList.remove('enabled');
        state[key] = 0;
        state[areaKey] = 0;
        if (vs) vs.textContent = '—';
      }

      renderHullShape();
      updateHUD();
      scheduleDebouncedRun();
    });
  });
}

function initAppendageCollapse() {
  document.querySelectorAll('[data-toggle]').forEach(function (label) {
    label.addEventListener('click', function () {
      const targetId = label.getAttribute('data-toggle');
      const target = byId(targetId);
      if (!target) return;
      target.classList.toggle('collapsed');
      label.classList.toggle('collapsed');
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
  const open = byId('btn-open-theory');
  const close = byId('btn-close-theory');
  const start = byId('btn-start-sim');

  if (open && overlay) {
    open.addEventListener('click', function () {
      overlay.classList.add('active');
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

  const filter = byId('curve-filter');
  if (filter) {
    filter.addEventListener('change', function (e) {
      curveFilter = e.target.value;
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
    frameCamera(state.wl);
  });

  on('btn-wireframe', 'click', function () {
    isWireframe = !isWireframe;
    renderHullShape();
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;

    renderer.render(scene, camera);

    const a = document.createElement('a');
    a.download = 'NavalAI_Holtrop_Container_' + state.wl + 'm.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-run', 'click', function () {
    runSolver();
  });

  on('btn-export-curve-csv', 'click', exportCSV);
  on('btn-export-full-csv', 'click', exportCSV);
  on('btn-export-csv', 'click', exportCSV);
}

function updateHUD() {
  const lb = state.beam ? (state.wl / state.beam) : 0;
  const valAspect = byId('val-aspect');
  const hudLb = byId('hud-lb');
  const hudCb = byId('hud-cb');

  if (valAspect) valAspect.textContent = lb.toFixed(2);
  if (hudLb) hudLb.textContent = lb.toFixed(2);
  if (hudCb) hudCb.textContent = state.cb.toFixed(3);
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
function buildPayload() {
  return {
    wl: state.wl,
    beam: state.beam,
    df: state.df,
    da: state.da,
    lcb: state.lcb,
    cb: state.cb,
    cm: state.cm,
    cwl: state.cwl,

    bulbous: state.bulbous,
    transom: state.transom,
    aft_body: state.aft_body,

    dome: state.dome,
    dome_area: state.dome_area,
    keel: state.keel,
    keel_area: state.keel_area,
    behind_skeg: state.behind_skeg,
    behind_skeg_area: state.behind_skeg_area,
    behind_stern: state.behind_stern,
    behind_stern_area: state.behind_stern_area,
    twin: state.twin,
    twin_area: state.twin_area,
    bracket: state.bracket,
    bracket_area: state.bracket_area,
    skeg: state.skeg,
    skeg_area: state.skeg_area,
    strut: state.strut,
    strut_area: state.strut_area,
    hull: state.hull,
    hull_area: state.hull_area,
    shaft: state.shaft,
    shaft_area: state.shaft_area,
    fin: state.fin,
    fin_area: state.fin_area
  };
}

async function runSolver() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  const payload = buildPayload();
  const key = hashPayload(payload);
  const seq = ++requestSeq;

  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }

  if (responseCache.has(key)) {
    resCache = responseCache.get(key);
    setStatus('ok', 'READY (cached)');
    updateTelemetry();

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

    // json.data.series holds the arrays; already unit-normalized to kN by the backend
    resCache = normalizeResistanceData(json.data ? json.data.series : null);

    if (responseCache.size > 20) {
      responseCache.delete(responseCache.keys().next().value);
    }
    responseCache.set(key, resCache);

    setStatus('ok', 'READY');
    updateTelemetry();

    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();

  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq !== requestSeq) return;

    console.error('NavalAI Holtrop solver error:', err);
    setStatus('err', 'ERROR');

    ['t-rf', 't-rw', 't-rapp', 't-rb', 't-rtr', 't-rt', 't-fn'].forEach(function (id) {
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
        runBtn.textContent = '▶ Run Solver';
      }

      if (load) load.classList.remove('active');
      activeFetchController = null;
    }
  }
}

function normalizeResistanceData(data) {
  return data || null;
}

// ─────────────────────────────────────────────────────────────
// Telemetry
//
// FIX #3: the backend (_build_series_payload in views.py) already converts
// friction / wave / appendage / bulbous / transom resistance from N to kN,
// and total_resistance is already in kN from the engine. So here we display
// values AS-IS — no extra "/ 1000" division.
// ─────────────────────────────────────────────────────────────
function updateTelemetry() {
  if (!resCache) return;

  const d = resCache;
  const fn = d.froude_numbers || [];
  const rf = d.friction_resistance || [];
  const rw = d.wave_resistance || [];
  const rapp = d.appendage_resistance || [];
  const rb = d.bulbous_bow_resistance || [];
  const rtr = d.transom_stern_resistance || [];
  const rt = d.total_resistance || [];

  const n = fn.length;
  if (!n) return;

  let mi = 0;
  for (let i = 1; i < n; i++) {
    if (fn[i] > fn[mi]) mi = i;
  }

  function kn(v) {
    return (v == null || isNaN(v)) ? '— kN' : v.toFixed(2) + ' kN';
  }

  function setT(id, val) {
    const el = byId(id);
    if (!el) return;
    el.classList.remove('error-state');
    el.textContent = val;
  }

  setT('t-rf', kn(rf[mi]));
  setT('t-rw', kn(rw[mi]));
  setT('t-rapp', kn(rapp[mi]));
  setT('t-rb', kn(rb[mi]));
  setT('t-rtr', kn(rtr[mi]));
  setT('t-fn', fn[mi].toFixed(3));
  setT('t-rt', kn(rt[mi]));

  const valFroude = byId('val-froude');
  if (valFroude) valFroude.textContent = fn[mi].toFixed(3);
}

// ─────────────────────────────────────────────────────────────
// Plotly
// ─────────────────────────────────────────────────────────────
function subsamplePair(x, y, maxPoints) {
  if (!x || !y || x.length <= maxPoints) return [x, y];

  const step = Math.ceil(x.length / maxPoints);
  const xs = [];
  const ys = [];

  for (let i = 0; i < x.length; i += step) {
    xs.push(x[i]);
    ys.push(y[i]);
  }

  if ((x.length - 1) % step !== 0) {
    xs.push(x[x.length - 1]);
    ys.push(y[y.length - 1]);
  }

  return [xs, ys];
}

function makeBaseLayout() {
  return {
    paper_bgcolor: '#060d18',
    plot_bgcolor: '#060d18',
    font: { color: '#94a3b8', size: 11 },
    margin: { l: 65, r: 25, t: 24, b: 52 },
    xaxis: {
      title: 'Froude Number (Fn)',
      gridcolor: '#1e293b',
      linecolor: '#334155'
    },
    yaxis: {
      title: 'resistance (kN)',
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

  if (!resCache) {
    Plotly.react(target, [], Object.assign(layout, {
      annotations: [{
        text: 'Awaiting solver data — adjust geometry or run solver',
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

  const d = resCache;
  const fn = d.froude_numbers || [];

  // Data is already in kN — no conversion needed here.
  const SERIES = [
    { key: 'total',     name: 'Rt — Total',       color: '#22c55e', w: 2.6, dash: 'solid',   data: d.total_resistance || [] },
    { key: 'friction',  name: 'Rf — Frictional',  color: '#38bdf8', w: 2.0, dash: 'solid',   data: d.friction_resistance || [] },
    { key: 'wave',      name: 'Rw — Wave',        color: '#f59e0b', w: 2.0, dash: 'dash',    data: d.wave_resistance || [] },
    { key: 'appendage', name: 'Rapp — Appendage', color: '#a78bfa', w: 1.5, dash: 'dot',     data: d.appendage_resistance || [] },
    { key: 'bulbous',   name: 'Rb — Bulbous',     color: '#fb7185', w: 1.5, dash: 'dashdot', data: d.bulbous_bow_resistance || [] },
    { key: 'transom',   name: 'Rtr — Transom',    color: '#4ed0e1', w: 1.5, dash: 'dot',     data: d.transom_stern_resistance || [] }
  ];

  const traces = SERIES
    .filter(function (s) {
      return curveFilter === 'all' || curveFilter === s.key;
    })
    .map(function (s) {
      const sampled = subsamplePair(fn, s.data, MAX_PLOT_POINTS);
      return {
        x: sampled[0],
        y: sampled[1],
        mode: 'lines',
        type: 'scatter',
        name: s.name,
        line: { color: s.color, width: s.w, dash: s.dash }
      };
    });

  Plotly.react(target, traces, layout, config);
}

// ─────────────────────────────────────────────────────────────
// Tables / CSV
// ─────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTables() {
  const target = byId('table-target');
  if (!target) return;

  if (!resCache) {
    target.innerHTML = '<div class="data-table-empty">Awaiting solver data — adjust geometry or run solver.</div>';
    return;
  }

  const d = resCache;
  const aft = ['Pram w/ Gondola', 'V-Shaped', 'Normal Section', 'U-Shape / Hogner'];

  const cfg = [
    ['Waterline Length (L)', state.wl.toFixed(1), 'm'],
    ['Beam (B)', state.beam.toFixed(1), 'm'],
    ['Draft Forward (Tf)', state.df.toFixed(1), 'm'],
    ['Draft Aft (Ta)', state.da.toFixed(1), 'm'],
    ['L / B Ratio', (state.wl / state.beam).toFixed(2), '—'],
    ['LCB', state.lcb.toFixed(1), '%'],
    ['Block Coefficient (Cb)', state.cb.toFixed(3), '—'],
    ['Midship Coefficient (Cm)', state.cm.toFixed(3), '—'],
    ['Waterplane Coeff. (Cwl)', state.cwl.toFixed(3), '—'],
    ['Bulbous Bow', state.bulbous ? 'Yes' : 'No', '—'],
    ['Transom Stern', state.transom ? 'Yes' : 'No', '—'],
    ['Afterbody Form', aft[state.aft_body], '—']
  ];

  const cfgHtml = cfg.map(function (r) {
    return '<tr><td>' + escHtml(r[0]) + '</td><td>' + escHtml(r[1]) +
      '</td><td style="color:var(--muted);font-size:10px">' + escHtml(r[2]) + '</td></tr>';
  }).join('');

  const fn = d.froude_numbers || [];
  const n = fn.length;

  // Values already in kN — display directly, 3 decimals.
  function kn(v) {
    return (v == null || isNaN(v)) ? '—' : v.toFixed(3);
  }

  let rows = '';
  for (let i = 0; i < n; i++) {
    rows += '<tr>' +
      '<td>' + fn[i].toFixed(3) + '</td>' +
      '<td>' + kn(d.total_resistance[i]) + '</td>' +
      '<td>' + kn(d.friction_resistance[i]) + '</td>' +
      '<td>' + kn(d.wave_resistance[i]) + '</td>' +
      '<td>' + kn(d.appendage_resistance[i]) + '</td>' +
      '<td>' + kn(d.bulbous_bow_resistance[i]) + '</td>' +
      '<td>' + kn(d.transom_stern_resistance[i]) + '</td>' +
    '</tr>';
  }

  target.innerHTML =
    '<div class="tbl-block" style="margin-bottom:1rem;">' +
      '<div class="tbl-title">Hull Configuration</div>' +
      '<table class="data-table">' +
        '<thead><tr><th>Parameter</th><th>Value</th><th>Unit</th></tr></thead>' +
        '<tbody>' + cfgHtml + '</tbody>' +
      '</table>' +
    '</div>' +
    '<div class="tbl-block">' +
      '<div class="tbl-title">resistance Matrix vs Froude (kN)</div>' +
      '<table class="data-table">' +
        '<thead><tr><th>Fn</th><th>Rt</th><th>Rf</th><th>Rw</th><th>Rapp</th><th>Rb</th><th>Rtr</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
}

function exportCSV() {
  if (!resCache) {
    console.warn('No data yet — run solver first.');
    return;
  }

  const d = resCache;
  const aft = ['Pram w/ Gondola', 'V-Shaped', 'Normal Section', 'U-Shape / Hogner'];

  let csv = 'NavalAI - Holtrop & Mennen resistance Report\n\n';
  csv += 'HULL CONFIGURATION\n';
  csv += 'Parameter,Value,Unit\n';
  csv += 'Waterline Length,' + state.wl + ',m\n';
  csv += 'Beam,' + state.beam + ',m\n';
  csv += 'Draft Forward,' + state.df + ',m\n';
  csv += 'Draft Aft,' + state.da + ',m\n';
  csv += 'LCB,' + state.lcb + ',%\n';
  csv += 'Block Coefficient,' + state.cb + ',-\n';
  csv += 'Midship Coefficient,' + state.cm + ',-\n';
  csv += 'Waterplane Coefficient,' + state.cwl + ',-\n';
  csv += 'Bulbous Bow,' + (state.bulbous ? 'Yes' : 'No') + ',-\n';
  csv += 'Transom Stern,' + (state.transom ? 'Yes' : 'No') + ',-\n';
  csv += 'Afterbody Form,' + aft[state.aft_body] + ',-\n\n';

  csv += 'RESISTANCE MATRIX (kN)\n';
  csv += 'Froude_Number,Rt,Rf,Rw,Rapp,Rb,Rtr\n';

  const fn = d.froude_numbers || [];
  for (let i = 0; i < fn.length; i++) {
    csv += [
      fn[i].toFixed(3),
      d.total_resistance[i].toFixed(3),
      d.friction_resistance[i].toFixed(3),
      d.wave_resistance[i].toFixed(3),
      d.appendage_resistance[i].toFixed(3),
      d.bulbous_bow_resistance[i].toFixed(3),
      d.transom_stern_resistance[i].toFixed(3)
    ].join(',') + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'Holtrop_Report_L' + state.wl + 'm.csv';

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

// ═════════════════════════════════════════════════════════════
// THREE.JS
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
    6000
  );

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

  scene.add(new THREE.AmbientLight(0x3a4b6e, 0.7));

  const sun = new THREE.DirectionalLight(0xfff5df, 1.25);
  sun.position.set(300, 450, 200);
  scene.add(sun);

  const under = new THREE.DirectionalLight(0x4ed0e1, 0.45);
  under.position.set(-100, -300, -100);
  scene.add(under);

  waterGeometry = new THREE.PlaneGeometry(1600, 1600, 28, 28);

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x1d4d62,
    roughness: 0.18,
    metalness: 0.28,
    flatShading: true,
    transparent: true,
    opacity: 0.58,
    side: THREE.DoubleSide
  });

  waterPlane = new THREE.Mesh(waterGeometry, waterMaterial);
  waterPlane.rotation.x = -Math.PI / 2;
  scene.add(waterPlane);

  hullGroup = new THREE.Group();
  scene.add(hullGroup);

  frameCamera(state.wl);

  window.addEventListener('resize', onWindowResize, { passive: true });

  animate();
}

function frameCamera(L) {
  if (!camera || !controls) return;

  const T = (state.df + state.da) / 2;
  camera.position.set(L * 0.75, L * 0.42, L * 1.05);
  controls.target.set(0, T * 0.4, 0);
  controls.update();
}

function renderHullShape() {
  if (!hullGroup || typeof THREE === 'undefined') return;

  clearThreeGroup(hullGroup);

  const L = state.wl;
  const B = state.beam;
  const T = (state.df + state.da) / 2;
  const CB = state.cb;
  const lcb = (state.lcb / 100) * L;

  waveAmp = Math.max(0.5, L * 0.012);

  const body = new THREE.Group();
  body.position.x = lcb;
  hullGroup.add(body);

  function M(c, r, m) {
    return new THREE.MeshStandardMaterial({
      color: c,
      roughness: r,
      metalness: m,
      wireframe: isWireframe
    });
  }

  const mHull   = M(0x1f3346, 0.45, 0.45);
  const mBoot   = M(0xc8a84b, 0.10, 0.95);
  const mHatch  = M(0x2a3340, 0.7, 0.15);
  const mAcc    = M(0xe6e3da, 0.35, 0.05);
  const mFunnel = M(0x33414f, 0.4, 0.5);
  const mFband  = M(0xb23b3b, 0.4, 0.3);
  const mDark   = M(0x16202c, 0.5, 0.4);
  const mBulb   = M(0x16202c, 0.3, 0.6);

  const mGlass = new THREE.MeshStandardMaterial({
    color: 0x0c1320,
    emissive: 0x16202e,
    roughness: 0.05,
    metalness: 1.0,
    transparent: true,
    opacity: 0.85,
    wireframe: isWireframe
  });

  const hH = T * 1.55;
  const deckTopY = hH - T;

  const hGeo = new THREE.BoxGeometry(L, hH, B, 54, 12, 24);
  const hp = hGeo.attributes.position;

  for (let i = 0; i < hp.count; i++) {
    let x = hp.getX(i);
    let y = hp.getY(i);
    let z = hp.getZ(i);

    const nx = x / (L / 2);
    const ny = y / (hH / 2);

    if (nx > 0.55) {
      const t = (nx - 0.55) / 0.45;
      z *= Math.pow(1 - t, 1.7 - CB * 0.5);
      if (ny > 0) x += t * ny * (L * 0.02);
    }

    if (ny < 0) {
      z *= Math.pow(1 + ny, 0.55 + (1 - CB) * 0.6);
    }

    if (nx < -0.5) {
      const t = Math.abs(nx + 0.5) / 0.5;
      if (state.transom) {
        z *= (1 - t * 0.10);
      } else {
        if (ny > -0.2) x -= t * (L * 0.06);
        z *= (1 - t * 0.30);
      }
    }

    hp.setXYZ(i, x, y, z);
  }

  hGeo.computeVertexNormals();

  const hull = new THREE.Mesh(hGeo, mHull);
  hull.position.y = hH / 2 - T;
  body.add(hull);

  const boot = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.995, T * 0.07, B * 1.004),
    mBoot
  );
  boot.position.y = 0;
  body.add(boot);

  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.97, T * 0.06, B * 0.95),
    mHatch
  );
  deck.position.y = deckTopY + T * 0.03;
  body.add(deck);

  const cargoXmin = -L * 0.30;
  const cargoXmax =  L * 0.36;
  const cargoLen  = cargoXmax - cargoXmin;
  const cargoZ    = B * 0.80;

  const nBays = Math.max(3, Math.min(22, Math.floor(cargoLen / 13)));
  const nRows = Math.max(2, Math.min(11, Math.floor(cargoZ / 2.6)));
  const bayPitch = cargoLen / nBays;
  const rowPitch = cargoZ / nRows;
  const cHeight = 2.59;
  const deckBaseY = deckTopY + T * 0.06;

  for (let bay = 0; bay < nBays; bay++) {
    const fxN = bay / Math.max(1, nBays - 1);
    const lengthwise = 1 - Math.pow((fxN - 0.5) * 1.7, 2);

    for (let row = 0; row < nRows; row++) {
      if ((bay * 3 + row * 7) % 17 === 0) continue;

      const widthwise = 1 - Math.abs((row / Math.max(1, nRows - 1)) - 0.5) * 0.7;
      let tiers = Math.round(2 + lengthwise * 4 * widthwise + (Math.sin(bay * 1.7 + row * 0.9) > 0.55 ? 1 : 0));
      tiers = Math.max(1, Math.min(7, tiers));

      const w = bayPitch * 0.86;
      const dpt = rowPitch * 0.86;
      const h = tiers * cHeight;

      const stack = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, dpt),
        M(CONTAINER_COLORS[(bay * 5 + row * 3) % CONTAINER_COLORS.length], 0.6, 0.05)
      );

      stack.position.set(
        cargoXmin + (bay + 0.5) * bayPitch,
        deckBaseY + h / 2,
        -cargoZ / 2 + (row + 0.5) * rowPitch
      );

      body.add(stack);
    }
  }

  const fcL = L * 0.07;
  const fcH = T * 0.5;

  const fc = new THREE.Mesh(
    new THREE.BoxGeometry(fcL, fcH, B * 0.62),
    mHull
  );
  fc.position.set(cargoXmax + fcL * 0.7, deckTopY + fcH / 2, 0);
  body.add(fc);

  const accL = L * 0.085;
  const accB = B * 0.78;
  const accH = cHeight * 6;
  const accX = cargoXmin - accL * 0.65;

  const acc = new THREE.Mesh(
    new THREE.BoxGeometry(accL, accH, accB),
    mAcc
  );
  acc.position.set(accX, deckTopY + accH / 2, 0);
  body.add(acc);

  const winBand = new THREE.Mesh(
    new THREE.BoxGeometry(accL * 0.9, accH * 0.13, accB * 1.02),
    mGlass
  );
  winBand.position.set(accX + accL * 0.06, deckTopY + accH * 0.86, 0);
  body.add(winBand);

  const fnR = B * 0.07;
  const fnH = cHeight * 3.2;
  const fnX = accX - accL * 0.75;

  const funnel = new THREE.Mesh(
    new THREE.CylinderGeometry(fnR * 0.8, fnR, fnH, 18),
    mFunnel
  );
  funnel.position.set(fnX, deckTopY + fnH / 2, 0);
  body.add(funnel);

  const fband = new THREE.Mesh(
    new THREE.CylinderGeometry(fnR * 0.82, fnR * 0.92, fnH * 0.28, 18),
    mFband
  );
  fband.position.set(fnX, deckTopY + fnH * 0.62, 0);
  body.add(fband);

  if (state.bulbous) {
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(B * 0.10, 16, 12),
      mBulb
    );
    bulb.scale.set(1.6, 1.0, 1.0);
    bulb.position.set(L / 2 + B * 0.05, -T * 0.45, 0);
    body.add(bulb);
  }

  if (state.behind_skeg || state.behind_stern || state.twin) {
    const rud = new THREE.Mesh(
      new THREE.BoxGeometry(L * 0.03, T * 0.9, B * 0.015),
      mDark
    );
    rud.position.set(-L * 0.49, -T * 0.4, 0);
    body.add(rud);
  }

  if (state.keel > 0) {
    const kg = new THREE.BoxGeometry(L * 0.4, T * 0.04, B * 0.03);

    const k1 = new THREE.Mesh(kg, mDark);
    k1.position.set(0, -T * 0.7, B * 0.5);
    body.add(k1);

    const k2 = new THREE.Mesh(kg, mDark);
    k2.position.set(0, -T * 0.7, -B * 0.5);
    body.add(k2);
  }

  if (state.shaft > 0) {
    const sg = new THREE.CylinderGeometry(B * 0.012, B * 0.012, L * 0.3, 10);

    const s1 = new THREE.Mesh(sg, mDark);
    s1.rotation.z = Math.PI / 2;
    s1.position.set(-L * 0.32, -T * 0.8, state.twin ? B * 0.2 : 0);
    body.add(s1);

    if (state.twin) {
      const s2 = s1.clone();
      s2.position.z = -B * 0.2;
      body.add(s2);
    }
  }

  const valAspect = byId('val-aspect');
  if (valAspect) valAspect.textContent = (L / B).toFixed(2);
}

function clearThreeGroup(group) {
  if (!group) return;

  while (group.children.length) {
    const obj = group.children[0];
    disposeThreeObject(obj);
    group.remove(obj);
  }
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
          Math.sin(u * 0.045 + t * 1.6) * waveAmp
        + Math.cos(v * 0.038 + t * 1.3) * waveAmp * 0.8
        + Math.sin((u + v) * 0.085 + t * 2.4) * waveAmp * 0.35;

      p.setZ(i, z);
    }

    waterGeometry.attributes.position.needsUpdate = true;
    lastWaterUpdate = t;
  }

  frameDelta += dt;

  if (frameDelta >= FRAME_INTERVAL) {
    if (hullGroup) {
      hullGroup.position.y = Math.sin(t * 1.5) * waveAmp * 0.4 - 0.1;
      hullGroup.rotation.z = Math.cos(t * 1.6) * 0.015;
      hullGroup.rotation.x = Math.sin(t * 1.05) * 0.008;
    }

    frameDelta = frameDelta % FRAME_INTERVAL;
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function onWindowResize() {
  const c = byId('canvas-3d-target');
  if (!c || !renderer || !camera) return;
  if (!c.clientWidth || !c.clientHeight) return;

  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(c.clientWidth, c.clientHeight);
}