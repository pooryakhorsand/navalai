/**
 * js/cylinder_code.js — Magnus Rotor Simulator
 * Core engineering logic including Three.js setup, physics telemetry,
 * adaptive fluid particle simulation, and layout controls.
 *
 * Wrapped in an IIFE so this file's `scene / camera / renderer / controls`
 * etc. don't collide with `yacht_cad.js`'s top-level `let` declarations when
 * both scripts are loaded on the homepage. Surface exposed at the bottom.
 */
(function () {
  'use strict';

  // Global App State Variables (now IIFE-scoped — won't collide with yacht_cad.js)
  let scene, camera, renderer, controls;
  let cylinderMesh, wireframeMesh;
  let airParticlesSystem;

  // Simulation Configuration Constants
  const PARTICLE_COUNT = 800;
  const particleInitialX = [];
  const particleYOffset = [];
  const particleZOffset = [];

  // Baseline Input Parameters
  let inputLength = 3.73;
  let inputHeight = 1.00;
  let inputReynolds = 180000;

  document.addEventListener('DOMContentLoaded', () => {
    init3DScene();
    setupInputInterceptors();
    setupToolbarControls();
    setupTheoryModalEvents();
    calculatePhysicsTelemetry();
    animateLoop();
  });

  /* ================================================================
     SCENE INITIALIZATION
  ================================================================ */
  function init3DScene() {
    // Idempotent guard — safe to call again from the homepage's window.load
    if (renderer) return;

    const container = document.getElementById('canvas-3d-target');
    if (!container) {
      console.error("Initialization Error: Target container '#canvas-3d-target' not found in DOM.");
      return;
    }

    const w = container.clientWidth  || container.offsetWidth  || 800;
    const h = container.clientHeight || container.offsetHeight || 500;

    // Scene & Environment Configuration
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060d18);
    scene.fog = new THREE.FogExp2(0x060d18, 0.025);

    // Camera Pipeline
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.set(0, 2, 12);

    // WebGL Renderer Core Context
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Viewport Control Constraints
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.dampingFactor = 0.0;
    controls.maxDistance = 28;
    controls.minDistance = 3;
    controls.rotateSpeed = 0.4;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.6;
    controls.target.set(0, 0, 0);

    // Lighting System Layout
    scene.add(new THREE.AmbientLight(0x0a1628, 1.5));

    const keyNeonBlue = new THREE.DirectionalLight(0x00ffcc, 1.8);
    keyNeonBlue.position.set(-8, 6, 4);
    scene.add(keyNeonBlue);

    const fillAmberGlow = new THREE.DirectionalLight(0xc8a84b, 2.5);
    fillAmberGlow.position.set(5, 8, 5);
    scene.add(fillAmberGlow);

    const backLight = new THREE.DirectionalLight(0x4488ff, 1.0);
    backLight.position.set(0, -5, -5);
    scene.add(backLight);

    // Structural Initialization
    buildCylinderObject();
    buildAirflowField();

    // Dynamic Window Reframing Event Hook
    window.addEventListener('resize', () => {
      const w2 = container.clientWidth  || 800;
      const h2 = container.clientHeight || 500;
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    });
  }

  /* ================================================================
     GEOMETRY BUILDERS
  ================================================================ */
  function buildCylinderObject() {
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 48);

    // Surface shader attributes
    const material = new THREE.MeshStandardMaterial({
      color: 0x112240,
      emissive: 0x071120,
      roughness: 0.15,
      metalness: 0.85,
      transparent: true,
      opacity: 0.85
    });

    cylinderMesh = new THREE.Mesh(geometry, material);

    // Blueprint overlay mesh
    const wireframeGeo = new THREE.WireframeGeometry(geometry);
    const wireframeMat = new THREE.LineBasicMaterial({
      color: 0xe8c96a,
      linewidth: 1,
      transparent: true,
      opacity: 0.5
    });
    wireframeMesh = new THREE.LineSegments(wireframeGeo, wireframeMat);

    cylinderMesh.add(wireframeMesh);
    scene.add(cylinderMesh);

    cylinderMesh.rotation.x = 0;
    cylinderMesh.rotation.z = 0;
    cylinderMesh.position.set(-1, 0, 0);

    mutateCylinderGeometry();
  }

  function buildAirflowField() {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = (Math.random() * 20) - 10;
      const y = (Math.random() * 8) - 4;
      const z = (Math.random() * 4) - 2;

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      particleInitialX.push(x);
      particleYOffset.push(y);
      particleZOffset.push(z);

      // Initial flow streamline particle color assignment (Cyan)
      colors[i * 3] = 0.0;
      colors[i * 3 + 1] = 0.75;
      colors[i * 3 + 2] = 1.0;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.18,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });

    airParticlesSystem = new THREE.Points(geometry, material);
    scene.add(airParticlesSystem);
  }

  /* ================================================================
     INPUT PROCESSING INTERCEPTORS
  ================================================================ */
  function setupInputInterceptors() {
    const lenSlider = document.getElementById('slider-length');
    const hgtSlider = document.getElementById('slider-height');
    const velSlider = document.getElementById('slider-velocity');

    if (lenSlider) {
      lenSlider.addEventListener('input', (e) => {
        inputLength = parseFloat(e.target.value);
        document.getElementById('val-length').textContent = inputLength.toFixed(2) + ' m';
        mutateCylinderGeometry();
        calculatePhysicsTelemetry();
      });
    }

    if (hgtSlider) {
      hgtSlider.addEventListener('input', (e) => {
        inputHeight = parseFloat(e.target.value);
        document.getElementById('val-height').textContent = inputHeight.toFixed(2) + ' m';
        mutateCylinderGeometry();
        calculatePhysicsTelemetry();
      });
    }

    if (velSlider) {
      velSlider.addEventListener('input', (e) => {
        const logVal = parseFloat(e.target.value);
        inputReynolds = Math.round(Math.pow(10, logVal));

        const displayRe = inputReynolds >= 1000000
          ? (inputReynolds / 1000000).toFixed(2) + '×10⁶'
          : (inputReynolds / 1000).toFixed(0) + '×10³';

        document.getElementById('val-velocity').textContent = displayRe;
        calculatePhysicsTelemetry();
      });
    }
  }

  /* ================================================================
     TOOLBAR CONTROLS & EXPORTERS
  ================================================================ */
  function setupToolbarControls() {
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      camera.position.z -= 1.0;
    });

    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      camera.position.z += 1.0;
    });

    document.getElementById('btn-reset-cam')?.addEventListener('click', () => {
      camera.position.set(0, 2, 12);
      controls.target.set(0, 0, 0);
    });

    document.getElementById('btn-download-img')?.addEventListener('click', () => {
      renderer.render(scene, camera);
      const anchor = document.createElement('a');
      anchor.download = `naval_ai_rotor_${inputLength.toFixed(2)}x${inputHeight.toFixed(2)}.png`;
      anchor.href = renderer.domElement.toDataURL('image/png');
      anchor.click();
    });

    document.getElementById('btn-export-csv')?.addEventListener('click', () => {
      const aspect = (inputLength / inputHeight).toFixed(3);
      const regime = getFlowRegime();
      const headers = 'Parameter,Calculated Value,Metric Bounds\n';
      const rows = [
        `Cylinder Length,${inputLength},meters`,
        `Cylinder Diameter,${inputHeight},meters`,
        `Structural Aspect Ratio,${aspect},L/H ratio`,
        `Reynolds Flow Index,${inputReynolds},Re`,
        `Flow Regime,${regime.label},classification`,
        `Lift Force output,${document.getElementById('out-lift').textContent.replace(' kN', '')},kiloNewtons`,
        `Drag Force output,${document.getElementById('out-drag').textContent.replace(' kN', '')},kiloNewtons`
      ].join('\n');

      const blob = new Blob([headers + rows], { type: 'text/csv;charset=utf-8;' });
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = 'rotor_aerodynamics_report.csv';
      anchor.click();
    });
  }

  /* ================================================================
     MODAL INFRASTRUCTURE EVENTS
  ================================================================ */
  function setupTheoryModalEvents() {
    const overlay = document.getElementById('theory-overlay');
    const btnOpen = document.getElementById('btn-open-theory');
    const btnClose = document.getElementById('btn-close-theory');
    const btnStart = document.getElementById('btn-start-sim');

    btnOpen?.addEventListener('click', () => overlay.classList.add('active'));
    btnClose?.addEventListener('click', () => overlay.classList.remove('active'));
    btnStart?.addEventListener('click', () => overlay.classList.remove('active'));
  }

  /* ================================================================
     GEOMETRY MUTATION LAYERS
  ================================================================ */
  function mutateCylinderGeometry() {
    if (!cylinderMesh) return;
    const radiusFactor = inputHeight / 2;
    cylinderMesh.scale.set(radiusFactor, inputLength, radiusFactor);

    const el = document.getElementById('val-aspect-ratio');
    if (el) el.textContent = (inputLength / inputHeight).toFixed(2);
  }

  /* ================================================================
     FLOW REGIME EVALUATION
  ================================================================ */
  function getFlowRegime() {
    if (inputReynolds < 200000) {
      return {
        label: 'LAMINAR',
        color: '#00ffcc',
        description: 'Smooth, ordered flow — low mixing, low drag coefficient',
        intensity: 0.0
      };
    } else if (inputReynolds < 500000) {
      return {
        label: 'TRANSITIONAL',
        color: '#f0c040',
        description: 'Mixed regime — unstable boundary layer, rising drag',
        intensity: 0.5
      };
    } else {
      return {
        label: 'TURBULENT',
        color: '#ff4444',
        description: 'Chaotic flow — high drag, strong mixing, vortex shedding',
        intensity: 1.0
      };
    }
  }

  function updateFlowRegimeDisplay(regime) {
    const el = document.getElementById('out-flow-regime');
    if (el) {
      el.textContent = regime.label;
      el.style.color = regime.color;
    }

    const badge = document.getElementById('regime-badge');
    if (badge) {
      badge.textContent = '● ' + regime.label;
      badge.style.color = regime.color;
    }

    const desc = document.getElementById('regime-desc');
    if (desc) desc.textContent = regime.description;

    const reVal = document.getElementById('regime-re-val');
    if (reVal) {
      reVal.textContent = inputReynolds >= 1000000
        ? (inputReynolds / 1000000).toFixed(2) + '×10⁶'
        : (inputReynolds / 1000).toFixed(0) + '×10³';
    }

    const barFill = document.getElementById('regime-bar-fill');
    if (barFill) {
      const logMin = Math.log10(1000);
      const logMax = Math.log10(10000000);
      const logRe = Math.log10(Math.max(1000, inputReynolds));
      const pct = ((logRe - logMin) / (logMax - logMin)) * 100;
      barFill.style.left = Math.min(98, Math.max(2, pct)) + '%';
    }
  }

  /* ================================================================
     PHYSICS FLUID MECHANICS MATHEMATICAL SOLVER
  ================================================================ */
  function calculatePhysicsTelemetry() {
    const airKinematicViscosity = 1.511e-5;
    const freeStreamVelocity = (inputReynolds * airKinematicViscosity) / inputHeight;

    // Static processing parameters matching aerodynamic design criteria
    const spinRatio = 2.0;
    const tangentialVelocity = freeStreamVelocity * spinRatio;
    const liftCoefficient = Math.PI * spinRatio;
    const dragCoefficient = 1.2 + (0.4 * Math.pow(spinRatio, 1.4));

    const airDensity = 1.225;
    const projectedArea = inputHeight * inputLength;
    const dynamicPressure = 0.5 * airDensity * Math.pow(freeStreamVelocity, 2);

    const liftKn = (dynamicPressure * projectedArea * liftCoefficient) / 1000;
    const dragKn = (dynamicPressure * projectedArea * dragCoefficient) / 1000;

    const elT = document.getElementById('out-tangential');
    const elL = document.getElementById('out-lift');
    const elD = document.getElementById('out-drag');
    if (elT) elT.textContent = tangentialVelocity.toFixed(1) + ' m/s';
    if (elL) elL.textContent = liftKn.toFixed(2) + ' kN';
    if (elD) elD.textContent = dragKn.toFixed(2) + ' kN';

    const regime = getFlowRegime();
    updateFlowRegimeDisplay(regime);
  }

  /* ================================================================
     CONTINUOUS EXECUTION ANCHOR (ANIMATION LOOP)
  ================================================================ */
  function animateLoop() {
    requestAnimationFrame(animateLoop);

    if (cylinderMesh) {
      cylinderMesh.rotation.y += 0.012;
    }

    if (airParticlesSystem) {
      const positions = airParticlesSystem.geometry.attributes.position.array;
      const colors = airParticlesSystem.geometry.attributes.color.array;
      const radius = (inputHeight / 2) * (cylinderMesh ? cylinderMesh.scale.x : 0.5);
      const regime = getFlowRegime();
      const deflectionStrength = Math.min(1.2, 0.2 + (Math.log10(inputReynolds) * 0.12));
      const flowSpeed = 0.04 + (Math.log10(inputReynolds) * 0.012);

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        positions[i * 3] += flowSpeed;

        const currentX = positions[i * 3];
        const baseY = particleYOffset[i];
        const baseZ = particleZOffset[i];

        // Reset particles out of visual boundary matrix back to entrance threshold
        if (currentX > 10) {
          positions[i * 3] = -10;
          positions[i * 3 + 1] = baseY;
          positions[i * 3 + 2] = baseZ;
          colors[i * 3] = 0.0;
          colors[i * 3 + 1] = 0.75;
          colors[i * 3 + 2] = 1.0;
          continue;
        }

        const cx = currentX - (-1.0);
        const cy = positions[i * 3 + 1];
        const distXY = Math.sqrt(cx * cx + cy * cy);
        const cylRadius = radius * 1.1;

        // Calculate dynamic deflection matrix based on potential flow math + Magnus effect forces
        if (distXY > 0.05 && distXY < 6.0 && distXY > cylRadius * 0.85) {
          const potentialFactor = (cylRadius * cylRadius) / (distXY * distXY);
          const magnusDeflection = deflectionStrength
            * (1.0 - Math.min(1.0, distXY / 4.0))
            * (cylRadius / distXY);

          if (currentX > -4.5 && currentX < 3.5) {
            positions[i * 3 + 1] = baseY * (1.0 + potentialFactor * 0.6)
              + (magnusDeflection * Math.sin(cx * 0.5) * 1.4);

            // Add random vortex shedding mixing for turbulent fields
            if (regime.intensity > 0) {
              positions[i * 3 + 2] = baseZ
                + (regime.intensity * 0.1 * Math.sin(currentX * 3.0 + i * 0.1));
            }

            // High-pressure boundary color morphing mapping (Orange forward entry, Violet aft escape)
            if (cx < 0) {
              colors[i * 3] = 1.0;
              colors[i * 3 + 1] = 0.55;
              colors[i * 3 + 2] = 0.05;
            } else {
              colors[i * 3] = 0.35;
              colors[i * 3 + 1] = 0.1;
              colors[i * 3 + 2] = 1.0;
            }
          }
        }
      }

      airParticlesSystem.geometry.attributes.position.needsUpdate = true;
      airParticlesSystem.geometry.attributes.color.needsUpdate = true;
    }

    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  // ================================================================
  // PUBLIC SURFACE — exposed for the homepage hero (and anything else
  // that wants to talk to this rotor engine without owning its globals).
  // ================================================================
  window.init3DScene = init3DScene;
  Object.defineProperty(window, 'cylRenderer',  { configurable: true, get: () => renderer });
  Object.defineProperty(window, 'cylCamera',    { configurable: true, get: () => camera });
  Object.defineProperty(window, 'cylinderMesh', { configurable: true, get: () => cylinderMesh });
})();
