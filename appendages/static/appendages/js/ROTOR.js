/**
 * ROTOR.js
 * NavalAI — Magnus Rotor Simulator
 *
 * Fully-featured 3-Tab System:
 *   - 3D CAD Model (Three.js)
 *   - Analytical Plots (Chart.js)
 *   - Data Table (dynamic HTML)
 *
 * Optimized:
 *   - FPS throttling & auto-pause on hidden tab
 *   - Chart instance disposal on refresh
 *   - Live sync between all three views
 */

'use strict';

// ─────────────────────────────────────────────
// GLOBAL CONFIG
// ─────────────────────────────────────────────
const TARGET_FPS = 45;
const FRAME_INTERVAL = 1.0 / TARGET_FPS;
const PARTICLE_COUNT = 800;
const AIR_KINEMATIC_VISCOSITY = 1.511e-5;
const AIR_DENSITY = 1.225;
const SPIN_RATIO = 2.0;

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let state = {
  length: 3.73,
  height: 1.00,
  reynolds: 180000,
  activeView: 'model',
  computed: {
    freeStream: 0,
    tangential: 0,
    cl: 0,
    cd: 0,
    lift: 0,
    drag: 0,
    circulation: 0,
    strouhal: 0.21,
    efficiency: 0,
    dynamicPressure: 0,
    surfaceArea: 0
  }
};

// ─────────────────────────────────────────────
// THREE.JS OBJECTS
// ─────────────────────────────────────────────
let scene, camera, renderer, controls;
let clock = null;
let rotorMesh, wireframeMesh;
let airParticlesSystem;
let particleInitialX, particleYOffset, particleZOffset;
let frameDelta = 0;
let isAnimating = true;

// ─────────────────────────────────────────────
// CHART.JS INSTANCES
// ─────────────────────────────────────────────
let chartLiftDrag = null;
let chartPressure = null;
let chartEfficiency = null;
let chartCirculation = null;
let chartWake = null;
let chartsInitialized = false;


// ═════════════════════════════════════════════
// DOMContentLoaded — MAIN INIT
// ═════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', function () {
  initSliders();
  initCollapsibleSections();
  initTheoryModalEvents();
  initToolbarEvents();
  initViewTabs();
  initTableToolbar();

  if (typeof THREE === 'undefined') {
    setStatus('err', 'THREE.JS MISSING');
    return;
  }

  init3D();
  calculatePhysicsTelemetry();
  updateHUD();

  // Build initial data table
  updateDataTable();
  updateTimestamp();

  setStatus('ok', 'READY');
});


// ═════════════════════════════════════════════
// DOM HELPERS
// ═════════════════════════════════════════════
function byId(id) { return document.getElementById(id); }

function on(id, evt, fn) {
  const el = byId(id);
  if (el) el.addEventListener(evt, fn);
}

function setText(id, text) {
  const el = byId(id);
  if (el) el.textContent = text;
}


// ═════════════════════════════════════════════
// TAB SWITCHING SYSTEM
// ═════════════════════════════════════════════
function initViewTabs() {
  const tabs = document.querySelectorAll('.view-tab-btn');
  const views = document.querySelectorAll('.viewport-container');

  const toolbarModel = byId('toolbar-model');
  const toolbarPlots = byId('toolbar-plots');
  const toolbarTable = byId('toolbar-table');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view;

      tabs.forEach(t => t.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));

      tab.classList.add('active');
      const targetView = byId(`view-${view}`);
      if (targetView) targetView.classList.add('active');

      // Hide all secondary toolbars
      if (toolbarModel) toolbarModel.style.display = 'none';
      if (toolbarPlots) toolbarPlots.style.display = 'none';
      if (toolbarTable) toolbarTable.style.display = 'none';

      // Show contextual toolbar
      state.activeView = view;

      if (view === 'model') {
        if (toolbarModel) toolbarModel.style.display = 'flex';
        isAnimating = true;
        // Trigger resize because canvas might have been hidden
        setTimeout(onWindowResize, 50);
      } else if (view === 'plots') {
        if (toolbarPlots) toolbarPlots.style.display = 'flex';
        isAnimating = false;
        if (!chartsInitialized) {
          initializePlots();
          chartsInitialized = true;
        } else {
          updateAllCharts();
        }
      } else if (view === 'table') {
        if (toolbarTable) toolbarTable.style.display = 'flex';
        isAnimating = false;
        updateDataTable();
        updateTimestamp();
      }
    });
  });
}


// ═════════════════════════════════════════════
// SLIDERS INIT
// ═════════════════════════════════════════════
function initSliders() {
  const lenSlider = byId('slider-length');
  const hgtSlider = byId('slider-height');
  const velSlider = byId('slider-velocity');

  if (lenSlider) {
    state.length = parseFloat(lenSlider.value) || state.length;
    setText('val-length', state.length.toFixed(2) + ' m');
    lenSlider.addEventListener('input', function () {
      const v = parseFloat(this.value);
      if (isNaN(v)) return;
      state.length = v;
      setText('val-length', v.toFixed(2) + ' m');
      mutateRotorGeometry();
      calculatePhysicsTelemetry();
      updateHUD();
      syncAllViews();
    });
  }

  if (hgtSlider) {
    state.height = parseFloat(hgtSlider.value) || state.height;
    setText('val-height', state.height.toFixed(2) + ' m');
    hgtSlider.addEventListener('input', function () {
      const v = parseFloat(this.value);
      if (isNaN(v)) return;
      state.height = v;
      setText('val-height', v.toFixed(2) + ' m');
      mutateRotorGeometry();
      calculatePhysicsTelemetry();
      updateHUD();
      syncAllViews();
    });
  }

  if (velSlider) {
    const logVal = parseFloat(velSlider.value);
    state.reynolds = Math.round(Math.pow(10, logVal));
    setText('val-velocity', formatReynolds(state.reynolds));
    velSlider.addEventListener('input', function () {
      const logV = parseFloat(this.value);
      if (isNaN(logV)) return;
      state.reynolds = Math.round(Math.pow(10, logV));
      setText('val-velocity', formatReynolds(state.reynolds));
      calculatePhysicsTelemetry();
      syncAllViews();
    });
  }
}

function formatReynolds(re) {
  return re >= 1000000
    ? (re / 1000000).toFixed(2) + '×10⁶'
    : (re / 1000).toFixed(0) + '×10³';
}


// ═════════════════════════════════════════════
// SYNC ALL VIEWS ON PARAMETER CHANGE
// ═════════════════════════════════════════════
function syncAllViews() {
  if (state.activeView === 'plots' && chartsInitialized) {
    updateAllCharts();
  }
  if (state.activeView === 'table') {
    updateDataTable();
    updateTimestamp();
  }
}


// ═════════════════════════════════════════════
// COLLAPSIBLE SECTIONS
// ═════════════════════════════════════════════
function initCollapsibleSections() {
  document.querySelectorAll('.section-label--clickable').forEach(function (lab) {
    lab.addEventListener('click', function () {
      const section = lab.closest('.input-section--collapsible');
      if (section) section.classList.toggle('collapsed');
    });
  });
}


// ═════════════════════════════════════════════
// THEORY MODAL
// ═════════════════════════════════════════════
function initTheoryModalEvents() {
  const overlay = byId('theory-overlay');
  const open  = byId('btn-open-theory');
  const close = byId('btn-close-theory');
  const start = byId('btn-start-sim');

  if (open && overlay)  open.addEventListener('click', () => overlay.classList.add('active'));
  if (close && overlay) close.addEventListener('click', () => overlay.classList.remove('active'));
  if (start && overlay) start.addEventListener('click', () => overlay.classList.remove('active'));
}


// ═════════════════════════════════════════════
// TOOLBAR EVENTS
// ═════════════════════════════════════════════
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

  on('btn-reset-cam', 'click', function () {
    if (!camera || !controls) return;
    camera.position.set(0, 2, 12);
    controls.target.set(0, 0, 0);
    controls.update();
  });

  on('btn-download-img', 'click', function () {
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const a = document.createElement('a');
    a.download = 'NavalAI_Rotor_' + state.length.toFixed(2) + 'x' + state.height.toFixed(2) + '.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  });

  on('btn-refresh-plots', 'click', function () {
    updateAllCharts();
  });

  on('btn-download-plots', 'click', function () {
    const charts = [chartLiftDrag, chartPressure, chartEfficiency, chartCirculation, chartWake];
    charts.forEach((c, i) => {
      if (!c) return;
      const a = document.createElement('a');
      a.href = c.toBase64Image();
      a.download = `Rotor_Chart_${i+1}.png`;
      a.click();
    });
  });
}


// ═════════════════════════════════════════════
// TABLE TOOLBAR
// ═════════════════════════════════════════════
function initTableToolbar() {
  on('btn-export-csv',  'click', exportCSV);
  on('btn-copy-table',  'click', copyTableToClipboard);
  on('btn-print-table', 'click', function () { window.print(); });
}


// ═════════════════════════════════════════════
// HUD UPDATE
// ═════════════════════════════════════════════
function updateHUD() {
  const aspect = (state.length / state.height).toFixed(2);
  setText('val-aspect-ratio', aspect);
}

function setStatus(mode, text) {
  const txt = byId('status-text');
  if (txt) {
    txt.textContent = text;
    txt.className = 'status-pill ' + mode;
  }
}


// ═════════════════════════════════════════════
// CSV EXPORT
// ═════════════════════════════════════════════
function exportCSV() {
  const c = state.computed;
  const regime = getFlowRegime();
  const aspect = (state.length / state.height).toFixed(3);

  let csv = 'NavalAI — Magnus Rotor Aerodynamics Report\n';
  csv += 'Generated,' + new Date().toISOString() + '\n\n';

  csv += 'GEOMETRY\n';
  csv += 'Cylinder Length,'   + state.length + ',m\n';
  csv += 'Cylinder Diameter,' + state.height + ',m\n';
  csv += 'Aspect Ratio (L/H),'+ aspect + ',-\n';
  csv += 'Surface Area,'      + c.surfaceArea.toFixed(3) + ',m^2\n\n';

  csv += 'FLOW\n';
  csv += 'Reynolds Number,'     + state.reynolds + ',-\n';
  csv += 'Free Stream Velocity,'+ c.freeStream.toFixed(3) + ',m/s\n';
  csv += 'Spin Ratio (alpha),'  + SPIN_RATIO + ',-\n';
  csv += 'Regime,'              + regime.label + '\n';
  csv += 'Dynamic Pressure,'    + c.dynamicPressure.toFixed(2) + ',Pa\n\n';

  csv += 'AERODYNAMIC RESULTS\n';
  csv += 'Tangential Velocity,' + c.tangential.toFixed(3) + ',m/s\n';
  csv += 'Circulation Strength,'+ c.circulation.toFixed(3) + ',m^2/s\n';
  csv += 'Lift Coefficient (CL),'+ c.cl.toFixed(4) + ',-\n';
  csv += 'Drag Coefficient (CD),'+ c.cd.toFixed(4) + ',-\n';
  csv += 'Lift Force,'          + c.lift.toFixed(3) + ',kN\n';
  csv += 'Drag Force,'          + c.drag.toFixed(3) + ',kN\n';
  csv += 'L/D Efficiency,'      + c.efficiency.toFixed(3) + ',-\n';

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'Rotor_Aerodynamics_Report.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function copyTableToClipboard() {
  const tables = document.querySelectorAll('#view-table .data-table');
  let txt = '';
  tables.forEach(tbl => {
    tbl.querySelectorAll('tr').forEach(tr => {
      const cells = tr.querySelectorAll('th, td');
      const row = [];
      cells.forEach(c => row.push(c.textContent.trim()));
      txt += row.join('\t') + '\n';
    });
    txt += '\n';
  });

  if (navigator.clipboard) {
    navigator.clipboard.writeText(txt).then(
      () => alert('Table copied to clipboard!'),
      () => alert('Copy failed.')
    );
  }
}


// ═════════════════════════════════════════════
// PHYSICS CALCULATIONS
// ═════════════════════════════════════════════
function calculatePhysicsTelemetry() {
  const freeStream = (state.reynolds * AIR_KINEMATIC_VISCOSITY) / state.height;
  const tangential = freeStream * SPIN_RATIO;

  const CL = Math.PI * SPIN_RATIO;
  const CD = 1.2 + (0.4 * Math.pow(SPIN_RATIO, 1.4));

  const projArea = state.height * state.length;
  const q = 0.5 * AIR_DENSITY * freeStream * freeStream;

  const liftKn = (q * projArea * CL) / 1000;
  const dragKn = (q * projArea * CD) / 1000;

  const circulation = 2 * Math.PI * (state.height / 2) * tangential;
  const efficiency = liftKn / Math.max(dragKn, 0.001);
  const surfaceArea = Math.PI * state.height * state.length;

  state.computed = {
    freeStream, tangential, cl: CL, cd: CD,
    lift: liftKn, drag: dragKn, circulation,
    strouhal: 0.21, efficiency, dynamicPressure: q, surfaceArea
  };

  setText('out-tangential', tangential.toFixed(1) + ' m/s');
  setText('out-freestream', freeStream.toFixed(2) + ' m/s');
  setText('out-lift',       liftKn.toFixed(2) + ' kN');
  setText('out-drag',       dragKn.toFixed(2) + ' kN');
  setText('out-efficiency', efficiency.toFixed(2));

  updateFlowRegimeDisplay(getFlowRegime());
}


// ═════════════════════════════════════════════
// FLOW REGIME
// ═════════════════════════════════════════════
function getFlowRegime() {
  if (state.reynolds < 200000) {
    return {
      label: 'LAMINAR', color: '#4ed0e1',
      description: 'Smooth, ordered flow — low mixing, low drag coefficient',
      intensity: 0.0
    };
  } else if (state.reynolds < 500000) {
    return {
      label: 'TRANSITIONAL', color: '#f0c040',
      description: 'Mixed regime — unstable boundary layer, rising drag',
      intensity: 0.5
    };
  }
  return {
    label: 'TURBULENT', color: '#fb7185',
    description: 'Chaotic flow — high drag, strong mixing, vortex shedding',
    intensity: 1.0
  };
}

function updateFlowRegimeDisplay(regime) {
  const el = byId('out-flow-regime');
  if (el) { el.textContent = regime.label; el.style.color = regime.color; }

  const badge = byId('regime-badge');
  if (badge) { badge.textContent = '● ' + regime.label; badge.style.color = regime.color; }

  const desc = byId('regime-desc');
  if (desc) desc.textContent = regime.description;

  const reVal = byId('regime-re-val');
  if (reVal) reVal.textContent = formatReynolds(state.reynolds);

  const barFill = byId('regime-bar-fill');
  if (barFill) {
    const logMin = Math.log10(1000);
    const logMax = Math.log10(10000000);
    const logRe  = Math.log10(Math.max(1000, state.reynolds));
    const pct    = ((logRe - logMin) / (logMax - logMin)) * 100;
    barFill.style.left = Math.min(98, Math.max(2, pct)) + '%';
  }

  setText('table-regime', regime.label);
}


// ═════════════════════════════════════════════
// DATA TABLE BUILDER
// ═════════════════════════════════════════════
function updateDataTable() {
  const c = state.computed;
  const aspect = (state.length / state.height).toFixed(3);

  const geometryRows = [
    { param: 'Cylinder Length', sym: 'L', val: state.length.toFixed(3), unit: 'm' },
    { param: 'Cylinder Diameter', sym: 'H', val: state.height.toFixed(3), unit: 'm' },
    { param: 'Aspect Ratio', sym: 'L/H', val: aspect, unit: '-' },
    { param: 'Surface Area', sym: 'A_s', val: c.surfaceArea.toFixed(3), unit: 'm²' },
    { param: 'Projected Area', sym: 'A_p', val: (state.height * state.length).toFixed(3), unit: 'm²' }
  ];

  const flowRows = [
    { param: 'Reynolds Number', sym: 'Re', val: formatReynolds(state.reynolds), unit: '-' },
    { param: 'Free Stream Velocity', sym: 'V∞', val: c.freeStream.toFixed(3), unit: 'm/s' },
    { param: 'Spin Ratio', sym: 'α', val: SPIN_RATIO.toFixed(2), unit: '-' },
    { param: 'Dynamic Pressure', sym: 'q', val: c.dynamicPressure.toFixed(2), unit: 'Pa' },
    { param: 'Air Density', sym: 'ρ', val: AIR_DENSITY.toFixed(3), unit: 'kg/m³' },
    { param: 'Kinematic Viscosity', sym: 'ν', val: '1.511×10⁻⁵', unit: 'm²/s' },
    { param: 'Flow Regime', sym: '-', val: getFlowRegime().label, unit: '-' }
  ];

  const resultsRows = [
    { param: 'Tangential Velocity', sym: 'V_θ', val: c.tangential.toFixed(3), unit: 'm/s' },
    { param: 'Circulation Strength', sym: 'Γ', val: c.circulation.toFixed(3), unit: 'm²/s' },
    { param: 'Lift Coefficient', sym: 'C_L', val: c.cl.toFixed(4), unit: '-' },
    { param: 'Drag Coefficient', sym: 'C_D', val: c.cd.toFixed(4), unit: '-' },
    { param: 'Lift Force', sym: 'F_L', val: c.lift.toFixed(3), unit: 'kN' },
    { param: 'Drag Force', sym: 'F_D', val: c.drag.toFixed(3), unit: 'kN' },
    { param: 'L/D Efficiency', sym: 'η', val: c.efficiency.toFixed(3), unit: '-' },
    { param: 'Strouhal Number', sym: 'St', val: c.strouhal.toFixed(3), unit: '-' }
  ];

  renderTableRows('table-body-geometry', geometryRows);
  renderTableRows('table-body-flow', flowRows);
  renderTableRows('table-body-results', resultsRows);

  // Update summary cards
  setText('summary-lift', c.lift.toFixed(2));
  setText('summary-drag', c.drag.toFixed(2));
  setText('summary-ld', c.efficiency.toFixed(2));
  setText('summary-re', formatReynolds(state.reynolds));
}

function renderTableRows(tbodyId, rows) {
  const tbody = byId(tbodyId);
  if (!tbody) return;
  let html = '';
  rows.forEach(r => {
    html += `<tr>
      <td>${r.param}</td>
      <td class="sym-col">${r.sym}</td>
      <td class="val-col">${r.val}</td>
      <td class="unit-col">${r.unit}</td>
    </tr>`;
  });
  tbody.innerHTML = html;
}

function updateTimestamp() {
  const now = new Date();
  const t = now.toLocaleString();
  setText('table-timestamp', t);
}


// ═════════════════════════════════════════════
// CHART.JS INITIALIZATION
// ═════════════════════════════════════════════
function initializePlots() {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded');
    return;
  }

  const gridColor = 'rgba(200, 168, 75, 0.10)';
  const textColor = '#94a3b8';
  const titleColor = '#e2e8f0';

  Chart.defaults.color = textColor;
  Chart.defaults.font.family = 'monospace';

  // Chart 1: Lift & Drag bar
  const ctxLD = byId('chart-lift-drag');
  if (ctxLD) {
    chartLiftDrag = new Chart(ctxLD, {
      type: 'bar',
      data: {
        labels: ['Lift (kN)', 'Drag (kN)'],
        datasets: [{
          label: 'Force',
          data: [state.computed.lift, state.computed.drag],
          backgroundColor: ['rgba(78, 208, 225, 0.75)', 'rgba(251, 113, 133, 0.75)'],
          borderColor: ['#4ed0e1', '#fb7185'],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#0a1628', borderColor: '#c8a84b', borderWidth: 1 }
        },
        scales: {
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } },
          x: { grid: { color: gridColor }, ticks: { color: textColor } }
        }
      }
    });
  }

  // Chart 2: Pressure Distribution
  const ctxP = byId('chart-pressure');
  if (ctxP) {
    const { labels, data } = computePressureCurve();
    chartPressure = new Chart(ctxP, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Cp',
          data,
          fill: true,
          backgroundColor: 'rgba(200, 168, 75, 0.10)',
          borderColor: '#c8a84b',
          tension: 0.4,
          pointRadius: 2,
          pointBackgroundColor: '#c8a84b'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          y: { title: { display: true, text: 'Cp', color: titleColor },
               grid: { color: gridColor }, ticks: { color: textColor } },
          x: { title: { display: true, text: 'θ (degrees)', color: titleColor },
               grid: { color: gridColor }, ticks: { color: textColor } }
        }
      }
    });
  }

  // Chart 3: Efficiency curve
  const ctxE = byId('chart-efficiency');
  if (ctxE) {
    const { labels, data, markerData } = computeEfficiencyCurve();
    chartEfficiency = new Chart(ctxE, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'L/D Ratio',
            data,
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34, 197, 94, 0.10)',
            fill: true,
            tension: 0.4,
            pointRadius: 0
          },
          {
            label: 'Current State',
            data: markerData,
            pointBackgroundColor: '#fff',
            pointBorderColor: '#ef4444',
            pointBorderWidth: 3,
            pointRadius: 8,
            showLine: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          y: { title: { display: true, text: 'Efficiency (L/D)', color: titleColor },
               grid: { color: gridColor }, ticks: { color: textColor } },
          x: { title: { display: true, text: 'Reynolds Number', color: titleColor },
               grid: { color: gridColor },
               ticks: { color: textColor, maxRotation: 45, autoSkip: true, maxTicksLimit: 8 } }
        }
      }
    });
  }

  // Chart 4: Circulation strength
  const ctxC = byId('chart-circulation');
  if (ctxC) {
    chartCirculation = new Chart(ctxC, {
      type: 'bar',
      data: {
        labels: ['Γ (m²/s)'],
        datasets: [{
          label: 'Circulation',
          data: [state.computed.circulation],
          backgroundColor: 'rgba(167, 139, 250, 0.75)',
          borderColor: '#a78bfa',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } },
          x: { grid: { color: gridColor }, ticks: { color: textColor } }
        }
      }
    });
  }

  // Chart 5: Wake vortex frequency
  const ctxW = byId('chart-wake');
  if (ctxW) {
    const { labels, data } = computeWakeCurve();
    chartWake = new Chart(ctxW, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Vortex Frequency (Hz)',
          data,
          borderColor: '#fb7185',
          backgroundColor: 'rgba(251, 113, 133, 0.10)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: '#fb7185'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          y: { title: { display: true, text: 'f (Hz)', color: titleColor },
               grid: { color: gridColor }, ticks: { color: textColor } },
          x: { title: { display: true, text: 'V∞ (m/s)', color: titleColor },
               grid: { color: gridColor }, ticks: { color: textColor } }
        }
      }
    });
  }

  setText('plot-re-1', formatReynolds(state.reynolds));
}


// ═════════════════════════════════════════════
// CHART DATA COMPUTATIONS
// ═════════════════════════════════════════════
function computePressureCurve() {
  const labels = [];
  const data = [];
  for (let deg = -180; deg <= 180; deg += 15) {
    labels.push(deg + '°');
    const rad = (deg * Math.PI) / 180;
    // Potential flow Cp with spin/Magnus modification
    const spinMod = 2 * SPIN_RATIO * Math.sin(rad);
    const cp = 1 - Math.pow(2 * Math.sin(rad) + spinMod, 2);
    data.push(parseFloat(cp.toFixed(3)));
  }
  return { labels, data };
}

function computeEfficiencyCurve() {
  const labels = [];
  const data = [];
  const markerData = [];
  const currentReLog = Math.log10(state.reynolds);

  for (let exp = 3.0; exp <= 7.0; exp += 0.2) {
    const re = Math.pow(10, exp);
    labels.push(formatReynolds(re));

    // Base efficiency
    let eff = (Math.PI * SPIN_RATIO) / (1.2 + 0.4 * Math.pow(SPIN_RATIO, 1.4));

    // Regime penalty
    if (re > 500000) eff *= 0.85;
    else if (re > 200000) eff *= 0.94;

    data.push(parseFloat(eff.toFixed(3)));

    // Add marker at current Re
    if (Math.abs(exp - currentReLog) < 0.1) {
      markerData.push(parseFloat(eff.toFixed(3)));
    } else {
      markerData.push(null);
    }
  }
  return { labels, data, markerData };
}

function computeWakeCurve() {
  const labels = [];
  const data = [];
  const D = state.height;
  const St = 0.21;

  for (let v = 1; v <= 30; v += 2) {
    labels.push(v.toFixed(0));
    const f = (St * v) / D;
    data.push(parseFloat(f.toFixed(3)));
  }
  return { labels, data };
}


// ═════════════════════════════════════════════
// UPDATE ALL CHARTS
// ═════════════════════════════════════════════
function updateAllCharts() {
  if (!chartsInitialized) return;

  if (chartLiftDrag) {
    chartLiftDrag.data.datasets[0].data = [state.computed.lift, state.computed.drag];
    chartLiftDrag.update('none');
  }

  if (chartPressure) {
    const { data } = computePressureCurve();
    chartPressure.data.datasets[0].data = data;
    chartPressure.update('none');
  }

  if (chartEfficiency) {
    const { data, markerData } = computeEfficiencyCurve();
    chartEfficiency.data.datasets[0].data = data;
    chartEfficiency.data.datasets[1].data = markerData;
    chartEfficiency.update('none');
  }

  if (chartCirculation) {
    chartCirculation.data.datasets[0].data = [state.computed.circulation];
    chartCirculation.update('none');
  }

  if (chartWake) {
    const { data } = computeWakeCurve();
    chartWake.data.datasets[0].data = data;
    chartWake.update('none');
  }

  setText('plot-re-1', formatReynolds(state.reynolds));
}


// ═════════════════════════════════════════════
// THREE.JS SCENE INIT
// ═════════════════════════════════════════════
function init3D() {
  const container = byId('canvas-3d-target');
  if (!container) {
    console.error('#canvas-3d-target not found');
    return;
  }

  clock = new THREE.Clock();
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 500;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x060d18);
  scene.fog = new THREE.FogExp2(0x060d18, 0.025);

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(0, 2, 12);

  renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  container.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = 28;
  controls.minDistance = 3;
  controls.rotateSpeed = 0.4;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.6;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0x0a1628, 1.5));

  const keyLight = new THREE.DirectionalLight(0x00ffcc, 1.8);
  keyLight.position.set(-8, 6, 4);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xc8a84b, 2.5);
  fillLight.position.set(5, 8, 5);
  scene.add(fillLight);

  const backLight = new THREE.DirectionalLight(0x4488ff, 1.0);
  backLight.position.set(0, -5, -5);
  scene.add(backLight);

  buildRotorObject();
  buildFlowField();

  window.addEventListener('resize', onWindowResize, { passive: true });
  animate();
}

function buildRotorObject() {
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 48);
  const material = new THREE.MeshStandardMaterial({
    color: 0x112240, emissive: 0x071120,
    roughness: 0.15, metalness: 0.85,
    transparent: true, opacity: 0.85
  });
  rotorMesh = new THREE.Mesh(geometry, material);

  const wireframeGeo = new THREE.WireframeGeometry(geometry);
  const wireframeMat = new THREE.LineBasicMaterial({
    color: 0xe8c96a, linewidth: 1,
    transparent: true, opacity: 0.5
  });
  wireframeMesh = new THREE.LineSegments(wireframeGeo, wireframeMat);

  rotorMesh.add(wireframeMesh);
  rotorMesh.position.set(-1, 0, 0);
  scene.add(rotorMesh);
  mutateRotorGeometry();
}

function buildFlowField() {
  const geometry  = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors    = new Float32Array(PARTICLE_COUNT * 3);

  particleInitialX = new Float32Array(PARTICLE_COUNT);
  particleYOffset  = new Float32Array(PARTICLE_COUNT);
  particleZOffset  = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const x = (Math.random() * 20) - 10;
    const y = (Math.random() * 8)  - 4;
    const z = (Math.random() * 4)  - 2;

    positions[i * 3]     = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    particleInitialX[i] = x;
    particleYOffset[i]  = y;
    particleZOffset[i]  = z;

    colors[i * 3]     = 0.0;
    colors[i * 3 + 1] = 0.75;
    colors[i * 3 + 2] = 1.0;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

  const material = new THREE.PointsMaterial({
    size: 0.18, vertexColors: true,
    transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, sizeAttenuation: true
  });

  airParticlesSystem = new THREE.Points(geometry, material);
  scene.add(airParticlesSystem);
}

function mutateRotorGeometry() {
  if (!rotorMesh) return;
  const radiusFactor = state.height / 2;
  rotorMesh.scale.set(radiusFactor, state.length, radiusFactor);
  updateHUD();
}


// ═════════════════════════════════════════════
// ANIMATION LOOP
// ═════════════════════════════════════════════
function animate() {
  requestAnimationFrame(animate);

  if (!clock) return;
  if (document.hidden) return;
  if (!isAnimating) return;

  const dt = Math.min(clock.getDelta(), 0.1);
  if (controls) controls.update();

  frameDelta += dt;
  if (frameDelta < FRAME_INTERVAL) {
    if (renderer && scene && camera) renderer.render(scene, camera);
    return;
  }

  const stepDt = frameDelta;
  frameDelta = frameDelta % FRAME_INTERVAL;

  if (rotorMesh) rotorMesh.rotation.y += 0.012 * (stepDt * TARGET_FPS);
  if (airParticlesSystem) updateParticles(stepDt);
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function updateParticles(stepDt) {
  const positions = airParticlesSystem.geometry.attributes.position.array;
  const colors    = airParticlesSystem.geometry.attributes.color.array;
  const radius    = (state.height / 2) * (rotorMesh ? rotorMesh.scale.x : 0.5);
  const regime    = getFlowRegime();
  const deflection = Math.min(1.2, 0.2 + (Math.log10(state.reynolds) * 0.12));
  const flowSpeed  = (0.04 + (Math.log10(state.reynolds) * 0.012)) * (stepDt * TARGET_FPS);
  const cylX = -1.0;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const pIdx = i * 3;

    positions[pIdx] += flowSpeed;
    const currentX = positions[pIdx];
    const baseY    = particleYOffset[i];
    const baseZ    = particleZOffset[i];

    if (currentX > 10) {
      positions[pIdx]     = -10;
      positions[pIdx + 1] = baseY;
      positions[pIdx + 2] = baseZ;
      colors[pIdx]        = 0.0;
      colors[pIdx + 1]    = 0.75;
      colors[pIdx + 2]    = 1.0;
      continue;
    }

    const cx = currentX - cylX;
    const cy = positions[pIdx + 1];
    const distXY = Math.sqrt(cx * cx + cy * cy);
    const cylRadius = radius * 1.1;

    if (distXY > 0.05 && distXY < 6.0 && distXY > cylRadius * 0.85) {
      const potentialFactor = (cylRadius * cylRadius) / (distXY * distXY);
      const magnusDeflection = deflection
        * (1.0 - Math.min(1.0, distXY / 4.0))
        * (cylRadius / distXY);

      if (currentX > -4.5 && currentX < 3.5) {
        positions[pIdx + 1] = baseY * (1.0 + potentialFactor * 0.6)
          + (magnusDeflection * Math.sin(cx * 0.5) * 1.4);

        if (regime.intensity > 0) {
          positions[pIdx + 2] = baseZ
            + (regime.intensity * 0.1 * Math.sin(currentX * 3.0 + i * 0.1));
        }

        if (cx < 0) {
          colors[pIdx]     = 1.0;
          colors[pIdx + 1] = 0.55;
          colors[pIdx + 2] = 0.05;
        } else {
          colors[pIdx]     = 0.35;
          colors[pIdx + 1] = 0.1;
          colors[pIdx + 2] = 1.0;
        }
      }
    }
  }

  airParticlesSystem.geometry.attributes.position.needsUpdate = true;
  airParticlesSystem.geometry.attributes.color.needsUpdate    = true;
}

function onWindowResize() {
  const c = byId('canvas-3d-target');
  if (!c || !renderer || !camera) return;
  if (!c.clientWidth || !c.clientHeight) return;
  camera.aspect = c.clientWidth / c.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(c.clientWidth, c.clientHeight);
}