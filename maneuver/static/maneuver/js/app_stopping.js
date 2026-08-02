'use strict';

const ASSETS = window.NAVALAI_ASSETS || {};
const API_URL = ASSETS.stoppingApi || '/api/v1/maneuvering/stopping/';

const ANIM_DURATION = 5.0;
const DEBOUNCE_MS = 350;
const MAX_PLOT_POINTS = 1500;
const MAX_RETURN_POINTS = 9000;
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;

const SERIES_KEYS = [
  't_series',
  'U_series',
  'x_series',
  'y_series',
  'psi_series',
  'thrust_series'
];

const SLIDER_DEFS = [
  { id: 'sl-U0',   key: 'U0',                     disp: 'val-U0',   fmt: v => v.toFixed(2) + ' m/s' },
  { id: 'sl-tred', key: 'thrust_reduction_time',  disp: 'val-tred', fmt: v => v.toFixed(0) + ' s' },
  { id: 'sl-Trev', key: 'reverse_thrust',         disp: 'val-Trev', fmt: v => v.toFixed(2) },
  { id: 'sl-T',    key: 'T',                      disp: 'val-T',    fmt: v => v.toFixed(0) + ' s' }
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

const IMO_LIMIT_L = 15.0;
const EXCELLENT_THRESHOLD_L = 7.5;

const COLOR_P1 = '#f97316';
const COLOR_P2 = '#fb7185';
const COLOR_IMO = '#22c55e';

let state = {
  U0: 7.7175,
  thrust_reduction_time: 20.0,
  reverse_thrust: -0.4,
  T: 700.0
};

let simCache = null;
let phaseTransIdx = -1;
let responseCache = new Map();
let currentView = 'cad';
let isPlaying = true;

let scene, camera, renderer, controls;
let clock = null;

let waterPlane, waterGeometry;
let shipModel, trajLineP1, trajLineP2;
let trajGeomP1, trajGeomP2;
let startMarker, finalMarker, imoLine;

let animElapsed = 0;
let frameDelta = 0;
let lastWaterUpdate = 0;
let debounceTimer = null;

let activeFetchController = null;
let requestSeq = 0;

const assetPromises = new Map();
let plotlyLoadingPromise = null;

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
    setStatus('ready', 'READY');
  }

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

function byId(id) {
  return document.getElementById(id);
}

function on(id, evt, fn) {
  const el = byId(id);
  if (el) el.addEventListener(evt, fn);
}

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
      const pt = byId('plot-target');
      if (pt && typeof Plotly !== 'undefined') {
        Plotly.Plots.resize(pt);
      }
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
    a.download = 'NavalAI_Stopping.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-export-curve-csv', 'click', exportCSV);
  on('btn-export-full-csv', 'click', exportCSV);
}

function updateHUD() {
  const h0 = byId('hud-U0');
  const htr = byId('hud-Trev');

  if (h0) h0.textContent = state.U0.toFixed(2);
  if (htr) htr.textContent = state.reverse_thrust.toFixed(2);
}

function setStatus(mode, text) {
  const dot = byId('status-dot');
  const txt = byId('status-text');

  if (dot) dot.className = 'status-dot ' + (mode === 'ready' ? 'ok' : mode);
  if (txt) txt.textContent = text;
}

function readPayload() {
  const payload = {
    U0: state.U0,
    T: state.T,
    thrust_reduction_time: state.thrust_reduction_time,
    reverse_thrust: state.reverse_thrust,
    // Backend requires EXACTLY 7 elements (u, v, r, x, y, psi, delta).
    // Sending only 6 causes an HTTP 400 from _parse_x_initial() in views.py.
    x_initial: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
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

    if (!resp.ok) {
      let detail = '';
      try {
        const errJson = await resp.json();
        detail = errJson && errJson.message ? errJson.message : '';
        if (!detail && errJson && errJson.errors) detail = JSON.stringify(errJson.errors);
      } catch (_) { /* response wasn't JSON */ }

      throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail : ''));
    }

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
    rebuildTrajectory();

    if (currentView === 'plots') renderPlot();
    if (currentView === 'table') renderTables();

  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seq !== requestSeq) return;

    console.error('NavalAI Stopping simulation error:', err);

    setStatus('err', 'ERROR');

    ['t-dist', 't-dist-L', 't-time', 't-dev', 't-ufinal', 't-quality'].forEach(function (id) {
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

    SERIES_KEYS.forEach(function (k) {
      decoded[k] = decodeFloat32Base64(ts[k] || '');
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

function updateTelemetry() {
  if (!simCache) return;

  const m = simCache.metrics || {};
  const ts = simCache.time_series || {};
  const meta = simCache.series_meta || {};
  const L = parseFloat(byId('c-L')?.value) || 160.93;

  function setT(id, val) {
    const el = byId(id);
    if (!el) return;
    el.classList.remove('error-state');
    el.textContent = val;
  }

  function fmt(v, suffix) {
    return (v === null || v === undefined || isNaN(v)) ? '— ' + suffix : Number(v).toFixed(2) + ' ' + suffix;
  }

  const returnedSamples = ts.t_series ? ts.t_series.length : 0;
  const solverSamples = meta.sample_count_solver || returnedSamples;

  setT('t-dist', fmt(m.stopping_distance_m, 'm'));
  setT('t-time', fmt(m.time_to_stop_s, 's'));
  setT('t-dev', fmt(m.max_deviation_y_m, 'm'));
  setT('t-ufinal', fmt(m.final_velocity, 'm/s'));

  if (solverSamples && solverSamples !== returnedSamples) {
    setT('t-samples', returnedSamples + ' / ' + solverSamples);
  } else {
    setT('t-samples', returnedSamples ? String(returnedSamples) : '—');
  }

  if (m.stopping_distance_m == null || isNaN(m.stopping_distance_m) || !L) {
    setT('t-dist-L', '—');
    setT('t-quality', '—');
    return;
  }

  const distOverL = m.stopping_distance_m / L;
  setT('t-dist-L', distOverL.toFixed(2) + ' L');

  let verdict, cls;
  if (distOverL <= EXCELLENT_THRESHOLD_L) {
    verdict = '✓ WITHIN LIMIT (< 7.5 L)';
    cls = 'excellent';
  } else if (distOverL <= IMO_LIMIT_L) {
    verdict = '~ WITHIN IMO LIMIT (15 L)';
    cls = 'acceptable';
  } else {
    verdict = '✗ EXCEEDS IMO 15 L LIMIT';
    cls = 'poor';
  }

  const q = byId('t-quality');
  if (q) {
    q.className = 'telemetry-val quality-val ' + cls;
    q.textContent = verdict;
  }
}

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
    hovermode: 'closest'
  };
}

function findPhaseTransitionIndex() {
  if (!simCache) return -1;

  const ts = simCache.time_series;
  if (!ts || !ts.thrust_series) return -1;

  const arr = ts.thrust_series;

  for (let i = 1; i < arr.length; i++) {
    if (arr[i - 1] > 0 && arr[i] <= 0) return i;
  }

  const tArr = ts.t_series || [];
  const tred = state.thrust_reduction_time;

  for (let i = 0; i < tArr.length; i++) {
    if (tArr[i] >= tred) return i;
  }

  return Math.floor(arr.length / 4);
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
  const mode = byId('plot-selector') ? byId('plot-selector').value : 'speed';
  const L = parseFloat(byId('c-L')?.value) || 160.93;
  const k = phaseTransIdx > 0 ? phaseTransIdx : Math.floor(ts.t_series.length / 4);

  let traces = [];

  if (mode === 'speed') {
    const sampled = subsampleSeries([ts.t_series, ts.U_series], MAX_PLOT_POINTS);

    traces = [
      {
        x: sampled[0].slice(0, k + 1),
        y: sampled[1].slice(0, k + 1),
        mode: 'lines',
        name: 'Phase 1 — reducing',
        line: { color: COLOR_P1, width: 2.4 }
      },
      {
        x: sampled[0].slice(k),
        y: sampled[1].slice(k),
        mode: 'lines',
        name: 'Phase 2 — astern',
        line: { color: COLOR_P2, width: 2.4 }
      }
    ];

    layout.title = { text: 'Speed Decay U(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'U [m/s]';

    if (phaseTransIdx > 0) {
      layout.shapes = [{
        type: 'line',
        x0: ts.t_series[k], x1: ts.t_series[k],
        yref: 'paper', y0: 0, y1: 1,
        line: { color: COLOR_P2, width: 1.5, dash: 'dash' }
      }];
      layout.annotations = [{
        x: ts.t_series[k],
        xref: 'x',
        y: 1,
        yref: 'paper',
        text: ' Full Astern',
        showarrow: false,
        font: { color: COLOR_P2, size: 10 },
        yanchor: 'bottom',
        xanchor: 'left'
      }];
    }
  }

  else if (mode === 'trajectory') {
    const sampled = subsampleSeries([ts.x_series, ts.y_series], MAX_PLOT_POINTS);
    const xs = sampled[0];
    const ys = sampled[1];

    traces = [
      {
        x: xs.slice(0, k + 1),
        y: ys.slice(0, k + 1),
        mode: 'lines',
        name: 'Phase 1 — reducing',
        line: { color: COLOR_P1, width: 2.4 }
      },
      {
        x: xs.slice(k),
        y: ys.slice(k),
        mode: 'lines',
        name: 'Phase 2 — astern',
        line: { color: COLOR_P2, width: 2.4 }
      },
      {
        x: [0],
        y: [0],
        mode: 'markers',
        name: 'Start',
        marker: { color: '#22c55e', size: 12, symbol: 'circle', line: { color: '#fff', width: 1 } }
      },
      {
        x: [ts.x_series[ts.x_series.length - 1]],
        y: [ts.y_series[ts.y_series.length - 1]],
        mode: 'markers',
        name: 'Final position',
        marker: { color: COLOR_P2, size: 10, symbol: 'circle', line: { color: '#fff', width: 1 } }
      }
    ];

    layout.title = { text: 'Stopping Trajectory (x – y)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 'x [m]';
    layout.yaxis.title = 'y [m]';
    layout.yaxis.scaleanchor = 'x';

    layout.shapes = [{
      type: 'line',
      x0: IMO_LIMIT_L * L,
      x1: IMO_LIMIT_L * L,
      yref: 'paper',
      y0: 0,
      y1: 1,
      line: { color: COLOR_IMO, width: 1.5, dash: 'dash' }
    }];
    layout.annotations = [{
      x: IMO_LIMIT_L * L,
      xref: 'x',
      y: 1,
      yref: 'paper',
      text: ' IMO limit (15 L)',
      showarrow: false,
      font: { color: COLOR_IMO, size: 10 },
      yanchor: 'bottom',
      xanchor: 'left'
    }];
  }

  else if (mode === 'thrust') {
    const sampled = subsampleSeries([ts.t_series, ts.thrust_series], MAX_PLOT_POINTS);

    traces = [
      {
        x: sampled[0].slice(0, k + 1),
        y: sampled[1].slice(0, k + 1),
        mode: 'lines',
        name: 'Phase 1 — reducing',
        line: { color: COLOR_P1, width: 2.4 }
      },
      {
        x: sampled[0].slice(k),
        y: sampled[1].slice(k),
        mode: 'lines',
        name: 'Phase 2 — astern',
        line: { color: COLOR_P2, width: 2.4 }
      }
    ];

    layout.title = { text: 'Thrust Schedule T(t)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'T / T_rated';

    layout.shapes = [{
      type: 'line',
      x0: 0,
      x1: ts.t_series[ts.t_series.length - 1],
      y0: 0,
      y1: 0,
      line: { color: '#475569', width: 1.2, dash: 'dot' }
    }];
  }

  else if (mode === 'heading') {
    const sampled = subsampleSeries([ts.t_series, ts.psi_series], MAX_PLOT_POINTS);

    traces = [{
      x: sampled[0],
      y: sampled[1],
      mode: 'lines',
      name: 'ψ(t)',
      line: { color: COLOR_P1, width: 2.2 }
    }];

    layout.title = { text: 'Heading Drift ψ(t)  (rudder fixed at 0°)', font: { size: 13, color: '#94a3b8' } };
    layout.xaxis.title = 't [s]';
    layout.yaxis.title = 'ψ [deg]';
  }

  Plotly.react(target, traces, layout, config);
}

function renderTables() {
  const target = byId('table-target');
  if (!target) return;

  if (!simCache) {
    target.innerHTML = '<div class="data-table-empty">Awaiting simulation data — click Run Simulation.</div>';
    return;
  }

  const ts = simCache.time_series;
  const meta = simCache.series_meta || {};
  const m = simCache.metrics || {};
  const n = ts.t_series.length;
  const L = parseFloat(byId('c-L')?.value) || 160.93;
  const step = Math.max(1, Math.floor(n / 300));
  const k = phaseTransIdx > 0 ? phaseTransIdx : Math.floor(n / 4);

  function phaseOf(i) {
    return i < k ? 1 : 2;
  }

  let rows = '';
  for (let i = 0; i < n; i += step) {
    const ph = phaseOf(i);
    rows +=
      '<tr class="phase-' + ph + '">' +
        '<td>' + Number(ts.t_series[i]).toFixed(2) + '</td>' +
        '<td>' + Number(ts.U_series[i]).toFixed(4) + '</td>' +
        '<td>' + Number(ts.x_series[i]).toFixed(2) + '</td>' +
        '<td>' + Number(ts.y_series[i]).toFixed(2) + '</td>' +
        '<td>' + Number(ts.psi_series[i]).toFixed(3) + '</td>' +
        '<td>' + Number(ts.thrust_series[i]).toFixed(4) + '</td>' +
        '<td>' + ph + '</td>' +
      '</tr>';
  }

  const distOverL = (m.stopping_distance_m != null && L > 0) ? m.stopping_distance_m / L : null;
  let verdict;
  if (distOverL === null || isNaN(distOverL)) {
    verdict = '—';
  } else if (distOverL <= EXCELLENT_THRESHOLD_L) {
    verdict = '✓ Within limit (< 7.5 L)';
  } else if (distOverL <= IMO_LIMIT_L) {
    verdict = '~ Within IMO limit (15 L)';
  } else {
    verdict = '✗ Exceeds IMO 15 L limit';
  }

  function fmt(v, unit) {
    return (v === null || v === undefined || isNaN(v)) ? '—' : Number(v).toFixed(3) + ' ' + unit;
  }

  const sampleText = meta.sample_count_solver && meta.sample_count_solver !== n
    ? n + ' returned / ' + meta.sample_count_solver + ' solver samples'
    : n + ' samples';

  target.innerHTML =
    '<div class="tbl-block" style="margin-bottom:1rem;">' +
      '<div class="tbl-title">Crash-Stop Summary</div>' +
      '<table class="data-table"><thead><tr><th>Quantity</th><th>Value</th></tr></thead><tbody>' +
        '<tr><td>Stopping distance (head-reach)</td><td>' + fmt(m.stopping_distance_m, 'm') + '</td></tr>' +
        '<tr><td>Stopping distance / Ship length L</td><td>' + (distOverL == null ? '—' : distOverL.toFixed(3) + ' L') + '</td></tr>' +
        '<tr><td>Time to stop</td><td>' + fmt(m.time_to_stop_s, 's') + '</td></tr>' +
        '<tr><td>Max lateral deviation |Δy|</td><td>' + fmt(m.max_deviation_y_m, 'm') + '</td></tr>' +
        '<tr><td>Residual speed U_final</td><td>' + fmt(m.final_velocity, 'm/s') + '</td></tr>' +
        '<tr><td>IMO verdict (15 L limit)</td><td>' + verdict + '</td></tr>' +
        '<tr><td>Samples</td><td>' + n + '</td></tr>' +
      '</tbody></table>' +
    '</div>' +
    '<div class="tbl-block">' +
      '<div class="tbl-title">Time Series (' + sampleText + ', displayed every ' + step + ')</div>' +
      '<table class="data-table"><thead><tr>' +
        '<th>t [s]</th><th>U [m/s]</th><th>x [m]</th><th>y [m]</th>' +
        '<th>ψ [°]</th><th>T_factor</th><th>Ph</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '</div>';
}

function exportCSV() {
  if (!simCache) {
    console.warn('No data yet — run solver first.');
    return;
  }

  const ts = simCache.time_series;
  const m = simCache.metrics || {};
  const meta = simCache.series_meta || {};
  const k = phaseTransIdx > 0 ? phaseTransIdx : Math.floor(ts.t_series.length / 4);

  function phaseOf(i) {
    return i < k ? 1 : 2;
  }

  let csv = 'NavalAI - Ship Stopping (Crash Astern) Report\n\n';

  csv += 'INPUTS\n';
  csv += 'U0,' + state.U0 + ',m/s\n';
  csv += 'thrust_reduction_time,' + state.thrust_reduction_time + ',s\n';
  csv += 'reverse_thrust,' + state.reverse_thrust + '\n';
  csv += 'T,' + state.T + ',s\n\n';

  csv += 'SERIES META\n';
  csv += 'Returned samples,' + ts.t_series.length + '\n';
  csv += 'Solver samples,' + (meta.sample_count_solver || ts.t_series.length) + '\n';
  csv += 'Output stride,' + (meta.output_stride || 1) + '\n\n';

  csv += 'STOPPING METRICS\n';
  csv += 'stopping_distance_m,' + (m.stopping_distance_m ?? '') + '\n';
  csv += 'time_to_stop_s,' + (m.time_to_stop_s ?? '') + '\n';
  csv += 'max_deviation_y_m,' + (m.max_deviation_y_m ?? '') + '\n';
  csv += 'final_velocity_ms,' + (m.final_velocity ?? '') + '\n\n';

  csv += 'TIME SERIES\nt_s,U_ms,x_m,y_m,psi_deg,thrust_factor,phase\n';

  for (let i = 0; i < ts.t_series.length; i++) {
    csv += [
      Number(ts.t_series[i]).toFixed(3),
      Number(ts.U_series[i]).toFixed(4),
      Number(ts.x_series[i]).toFixed(4),
      Number(ts.y_series[i]).toFixed(4),
      Number(ts.psi_series[i]).toFixed(4),
      Number(ts.thrust_series[i]).toFixed(5),
      phaseOf(i)
    ].join(',') + '\n';
  }

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'ShipStopping_Report.csv';

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

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

  const sun = new THREE.DirectionalLight(0xfff5df, 1.3);
  sun.position.set(400, 800, 300);
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x4ed0e1, 0.6);
  fill.position.set(-200, -400, -200);
  scene.add(fill);

  waterGeometry = new THREE.PlaneGeometry(30000, 30000, 12, 12);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d4d62,
    roughness: 0.15,
    metalness: 0.25,
    flatShading: true,
    transparent: true,
    opacity: 0.58,
    side: THREE.DoubleSide
  });

  waterPlane = new THREE.Mesh(waterGeometry, waterMat);
  waterPlane.rotation.x = -Math.PI / 2;
  scene.add(waterPlane);

  buildShipModel();

  window.addEventListener('resize', onWindowResize, { passive: true });

  animate();
}

function buildShipModel() {
  if (!scene || typeof THREE === 'undefined') return;

  shipModel = new THREE.Group();

  const inputL = byId('c-L');
  const L = inputL ? (parseFloat(inputL.value) || 30) : 30;
  const B = L / 8;
  const H = L / 14;

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

  const hGeo = new THREE.BoxGeometry(L, H, B, 18, 1, 6);
  const hp = hGeo.attributes.position;

  for (let i = 0; i < hp.count; i++) {
    const x = hp.getX(i);
    const z = hp.getZ(i);
    const nx = x / (L / 2);

    if (nx > 0.55) {
      const t = (nx - 0.55) / 0.45;
      hp.setZ(i, z * Math.pow(1 - t, 1.5));
    }
  }

  hGeo.computeVertexNormals();

  const hull = new THREE.Mesh(hGeo, hullMat);
  hull.position.y = H * 0.1;
  shipModel.add(hull);

  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.99, H * 0.07, B * 1.01),
    trimMat
  );
  trim.position.y = -H * 0.42;
  shipModel.add(trim);

  const acc = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.18, H * 0.8, B * 0.7),
    accMat
  );
  acc.position.set(-L * 0.15, H * 0.7, 0);
  shipModel.add(acc);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(B * 0.15, L * 0.10, 10),
    trimMat
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(L * 0.55, H * 0.5, 0);
  shipModel.add(nose);

  scene.add(shipModel);
}

function computeTrajectorySpan(xs, ys) {
  let xMin = xs[0], xMax = xs[0], yMin = ys[0], yMax = ys[0];

  for (let i = 1; i < xs.length; i++) {
    if (xs[i] < xMin) xMin = xs[i];
    if (xs[i] > xMax) xMax = xs[i];

    if (ys[i] < yMin) yMin = ys[i];
    if (ys[i] > yMax) yMax = ys[i];
  }

  return Math.max(xMax - xMin, yMax - yMin, 50);
}

function frameToTrajectory(ts) {
  if (!ts || !ts.x_series || !ts.x_series.length || !controls || !camera) return;

  const xs = ts.x_series;
  const ys = ts.y_series;

  let xMin = xs[0], xMax = xs[0], yMin = ys[0], yMax = ys[0];

  for (let i = 1; i < xs.length; i++) {
    if (xs[i] < xMin) xMin = xs[i];
    if (xs[i] > xMax) xMax = xs[i];
    if (ys[i] < yMin) yMin = ys[i];
    if (ys[i] > yMax) yMax = ys[i];
  }

  const cx = (xMin + xMax) / 2;
  const cz = (yMin + yMax) / 2;

  const spanX = Math.max(100, xMax - xMin);
  const spanY = Math.max(100, yMax - yMin);
  const span = Math.max(spanX, spanY) * 1.3;

  controls.target.set(cx, 0, cz);
  camera.position.set(cx - span * 0.15, span * 0.75, cz + span * 0.95);
  controls.update();
}

function rebuildShipForScale() {
  if (!simCache || !scene || typeof THREE === 'undefined') return;

  const xs = simCache.time_series.x_series;
  const ys = simCache.time_series.y_series;
  const span = computeTrajectorySpan(xs, ys);
  const shipL = Math.max(12, Math.min(span * 0.04, 180));

  if (shipModel) {
    scene.remove(shipModel);
    disposeThreeObject(shipModel);
    shipModel = null;
  }

  shipModel = new THREE.Group();

  const L = shipL;
  const B = shipL / 3;
  const H = shipL / 3.5;

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
  shipModel.add(hull);

  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.99, H * 0.10, B * 1.02),
    trimMat
  );
  trim.position.y = -H * 0.35;
  shipModel.add(trim);

  const acc = new THREE.Mesh(
    new THREE.BoxGeometry(L * 0.22, H * 0.9, B * 0.7),
    accMat
  );
  acc.position.set(-L * 0.15, H * 0.65, 0);
  shipModel.add(acc);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(B * 0.18, L * 0.12, 10),
    trimMat
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(L * 0.56, H * 0.4, 0);
  shipModel.add(nose);

  scene.add(shipModel);
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

function rebuildTrajectory() {
  if (!simCache || !scene || typeof THREE === 'undefined') return;

  const ts = simCache.time_series;
  const xs = ts.x_series;
  const ys = ts.y_series;
  const n = xs.length;

  if (!n) return;

  if (trajLineP1) {
    scene.remove(trajLineP1);
    disposeThreeObject(trajLineP1);
    trajLineP1 = null;
    trajGeomP1 = null;
  }

  if (trajLineP2) {
    scene.remove(trajLineP2);
    disposeThreeObject(trajLineP2);
    trajLineP2 = null;
    trajGeomP2 = null;
  }

  if (startMarker) {
    scene.remove(startMarker);
    disposeThreeObject(startMarker);
    startMarker = null;
  }

  if (finalMarker) {
    scene.remove(finalMarker);
    disposeThreeObject(finalMarker);
    finalMarker = null;
  }

  if (imoLine) {
    scene.remove(imoLine);
    disposeThreeObject(imoLine);
    imoLine = null;
  }

  const positionsP1 = new Float32Array(n * 3);
  const positionsP2 = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    positionsP1[i * 3] = xs[i];
    positionsP1[i * 3 + 1] = 0.5;
    positionsP1[i * 3 + 2] = ys[i];

    positionsP2[i * 3] = xs[i];
    positionsP2[i * 3 + 1] = 0.5;
    positionsP2[i * 3 + 2] = ys[i];
  }

  trajGeomP1 = new THREE.BufferGeometry();
  trajGeomP1.setAttribute('position', new THREE.BufferAttribute(positionsP1, 3));
  trajGeomP1.setDrawRange(0, 0);

  trajGeomP2 = new THREE.BufferGeometry();
  trajGeomP2.setAttribute('position', new THREE.BufferAttribute(positionsP2, 3));
  trajGeomP2.setDrawRange(0, 0);

  trajLineP1 = new THREE.Line(
    trajGeomP1,
    new THREE.LineBasicMaterial({ color: 0xf97316, linewidth: 2 })
  );

  trajLineP2 = new THREE.Line(
    trajGeomP2,
    new THREE.LineBasicMaterial({ color: 0xfb7185, linewidth: 2 })
  );

  scene.add(trajLineP1);
  scene.add(trajLineP2);

  const markSize = Math.max(8, Math.min(40, computeTrajectorySpan(xs, ys) * 0.012));

  startMarker = new THREE.Mesh(
    new THREE.SphereGeometry(markSize, 10, 8),
    new THREE.MeshStandardMaterial({
      color: 0x22c55e,
      emissive: 0x22c55e,
      emissiveIntensity: 0.55
    })
  );
  startMarker.position.set(xs[0], 1, ys[0]);
  scene.add(startMarker);

  finalMarker = new THREE.Mesh(
    new THREE.SphereGeometry(markSize, 10, 8),
    new THREE.MeshStandardMaterial({
      color: 0xfb7185,
      emissive: 0xfb7185,
      emissiveIntensity: 0.55
    })
  );
  finalMarker.position.set(xs[n - 1], 1, ys[n - 1]);
  scene.add(finalMarker);

  const L = parseFloat(byId('c-L')?.value) || 160.93;
  const imoX = IMO_LIMIT_L * L;
  const spread = Math.max(computeTrajectorySpan(xs, ys) * 0.25, 200);
  const imoPts = new Float32Array([imoX, 1.5, -spread, imoX, 1.5, spread]);
  const imoGeom = new THREE.BufferGeometry();
  imoGeom.setAttribute('position', new THREE.BufferAttribute(imoPts, 3));
  const imoMat = new THREE.LineDashedMaterial({
    color: 0x22c55e,
    dashSize: markSize * 0.5,
    gapSize: markSize * 0.3
  });

  imoLine = new THREE.Line(imoGeom, imoMat);
  imoLine.computeLineDistances();
  scene.add(imoLine);

  rebuildShipForScale();
  frameToTrajectory(ts);

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
          Math.sin(u * 0.004 + t * 1.3) * 5.0 +
          Math.cos(v * 0.0035 + t * 1.0) * 4.0 +
          Math.sin((u + v) * 0.007 + t * 1.7) * 1.5;

      p.setZ(i, z);
    }

    waterGeometry.attributes.position.needsUpdate = true;
    lastWaterUpdate = t;
  }

  frameDelta += dt;

  if (frameDelta >= FRAME_INTERVAL) {
    if (simCache && shipModel && trajGeomP1 && trajGeomP2) {
      if (isPlaying) animElapsed = (animElapsed + frameDelta) % ANIM_DURATION;

      const ts = simCache.time_series;
      const n = ts.x_series.length;

      const phase = animElapsed / ANIM_DURATION;
      const fIdx = phase * (n - 1);
      const i0 = Math.floor(fIdx);
      const i1 = Math.min(n - 1, i0 + 1);
      const frac = fIdx - i0;

      const x = ts.x_series[i0] * (1 - frac) + ts.x_series[i1] * frac;
      const y = ts.y_series[i0] * (1 - frac) + ts.y_series[i1] * frac;

      let p0 = ts.psi_series[i0];
      let p1v = ts.psi_series[i1];
      let dp = p1v - p0;

      if (dp > 180) dp -= 360;
      if (dp < -180) dp += 360;

      const psiDeg = p0 + dp * frac;

      shipModel.position.set(x, Math.sin(t * 1.5) * 0.6, y);
      shipModel.rotation.y = -psiDeg * Math.PI / 180;

      const k = phaseTransIdx > 0 && phaseTransIdx < n ? phaseTransIdx : Math.floor(n / 4);

      if (trajGeomP1) {
        const endP1 = Math.max(0, Math.min(i0, k)) + 1;
        trajGeomP1.setDrawRange(0, endP1);
      }

      if (trajGeomP2) {
        if (i0 > k) trajGeomP2.setDrawRange(0, i0 - k + 1);
        else trajGeomP2.setDrawRange(0, 0);
      }

      const animHud = byId('hud-anim');
      const phaseHud = byId('hud-phase');

      if (animHud) animHud.textContent = animElapsed.toFixed(2) + ' s';
      if (phaseHud) phaseHud.textContent = i0 < k ? 'PHASE 1 — REDUCING' : 'PHASE 2 — FULL ASTERN';
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