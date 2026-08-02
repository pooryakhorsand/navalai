/**
 * js/holtrop_cad.js — Holtrop & Mennen Container Ship CAD Engine
 * High-Fidelity Procedural Mesh Construction & WebGL Context Management.
 *
 * Wrapped in an IIFE to eliminate global variable collisions.
 */
(function () {
  'use strict';

  let scene, camera, renderer, controls;
  let hullGroup, waterPlane, waterGeometry;
  let isWireframe = false;
  let waveAmp = 1.6;
  let activeContainerId = 'hero-holtrop-viewport'; // Fallback explicit default target layer
  let lastWidth = 0;
  let lastHeight = 0;
  const clock = new THREE.Clock();

  // Container colours (classic international shipping lines)
  const CONTAINER_COLORS = [
    0xb23b3b, // Maersk / K-Line Red
    0x2f6fb0, // MSC Blue
    0x3f9e57, // Evergreen Green
    0x8a8f96, // Hapag-Lloyd Grey
    0xd08a2a, // CMA CGM Orange
    0x7a5fb0, // ONE Magenta Variant
    0xc9a227, // Yang Ming Yellow
    0x2f8f8f, // Teal Liner Line
    0xa84b4b  // Brown-Red Oxide
  ];

  /**
   * Initializes the Three.js Engine inside an explicit DOM container layer
   * @param {string} containerId - The explicit layout layer target ID string
   */
  function init3D(containerId) {
    if (containerId) {
      activeContainerId = containerId;
    }

    const container = document.getElementById(activeContainerId);
    if (!container) { 
      console.warn(`Initialization Warning: Target layer "#${activeContainerId}" not found. Trying fallback target...`);
      return; 
    }

    // Capture initial structural bounds safely
    let width = container.clientWidth || 540;
    let height = container.clientHeight || 360;
    lastWidth = width;
    lastHeight = height;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b253a); 

    camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 8000);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Flush old contents before printing canvas interface context
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // Prevent diving below simulated ocean floor line

    // Dynamic professional studio illumination layout
    scene.add(new THREE.AmbientLight(0x3a4b6e, 0.65));
    
    const sun = new THREE.DirectionalLight(0xfff5df, 1.4);
    sun.position.set(400, 500, 250);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 1024;
    sun.shadow.mapSize.height = 1024;
    scene.add(sun);
    
    const skyLight = new THREE.DirectionalLight(0x8cb6ff, 0.4);
    skyLight.position.set(-200, 400, -200);
    scene.add(skyLight);

    const under = new THREE.DirectionalLight(0x4ed0e1, 0.5);
    under.position.set(-100, -400, -100);
    scene.add(under);

    // High-density surface geometry matrix for dynamic wave animation displacement
    waterGeometry = new THREE.PlaneGeometry(2400, 2400, 90, 90);
    const waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x14426b,
      roughness: 0.12,
      metalness: 0.6,
      flatShading: true,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide
    });
    waterPlane = new THREE.Mesh(waterGeometry, waterMaterial);
    waterPlane.rotation.x = -Math.PI / 2;
    waterPlane.position.y = 0;
    scene.add(waterPlane);

    hullGroup = new THREE.Group();
    scene.add(hullGroup);

    // Initial positioning calibration vectors
    frameCamera(165, 8.5); 
    window.addEventListener('resize', onWindowResize);
    animate();
  }

  function frameCamera(L, meanDraft) {
    if (!camera || !controls) return;
    camera.position.set(L * 0.95, L * 0.48, L * 1.15);
    controls.target.set(0, meanDraft * 0.2, 0);
    controls.update();
  }

  function renderHullShape(state) {
    if (!hullGroup) return;

    // Purge geometry tree array systematically from the frame memory buffer
    while (hullGroup.children.length) {
      const obj = hullGroup.children[0];
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        else obj.material.dispose();
      }
      hullGroup.remove(obj);
    }

    // Extrapolate state matrices variables
    const L = state.wl || 165;
    const B = state.beam || 28;
    const T = (state.df + state.da) / 2 || 8.75;
    const CB = state.cb || 0.65;
    const lcb = (state.lcb / 100) * L || 0;

    waveAmp = Math.max(0.6, L * 0.011);

    const body = new THREE.Group();
    body.position.x = lcb;
    hullGroup.add(body);

    // Material generator function shortcut
    function createMaterial(colorCode, rough, metal, transparent = false, opac = 1.0) { 
      return new THREE.MeshStandardMaterial({ 
        color: colorCode, 
        roughness: rough, 
        metalness: metal, 
        wireframe: isWireframe,
        transparent: transparent,
        opacity: opac
      }); 
    }

    const mHull      = createMaterial(0x1a2634, 0.35, 0.5);   // Anti-fouling dark hull top sides
    const mBoot      = createMaterial(0x9e2a2b, 0.4, 0.2);    // Traditional boot-topping oxide red
    const mHatch     = createMaterial(0x343a40, 0.6, 0.2);    // Weather deck dark gray
    const mAcc       = createMaterial(0xf4f4f9, 0.4, 0.1);    // High-visibility white superstructure
    const mFunnel    = createMaterial(0x212529, 0.5, 0.4);    // Funnel casing steel stack
    const mFband     = createMaterial(0xc8a84b, 0.2, 0.8);    // Corporate yellow band insignia
    const mDark      = createMaterial(0x11161b, 0.6, 0.3);    // Below-water engineering lines
    const mBulb      = createMaterial(0x131d28, 0.3, 0.6);    // Forged casting nose cone matching structural lines
    const mMast      = createMaterial(0xdfe3e6, 0.5, 0.4);    // Solid grey mast frameworks
    const mLashing   = createMaterial(0x6c757d, 0.5, 0.7);    // Galvanized container lashing structures
    
    const mGlass     = new THREE.MeshStandardMaterial({ 
      color: 0xbee3db, 
      emissive: 0x1d3557, 
      roughness: 0.05, 
      metalness: 0.9, 
      transparent: true, 
      opacity: 0.85, 
      wireframe: isWireframe 
    });

    const hH = T * 1.62;          
    const deckTopY = hH - T;      

    // --- STRUCTURAL LAYER 1: Hydrodynamic Parametric Hull Shell Displacement ---
    const hGeo = new THREE.BoxGeometry(L, hH, B, 90, 20, 40);
    const hp = hGeo.attributes.position;
    for (let i = 0; i < hp.count; i++) {
      let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
      const nx = x / (L / 2), ny = y / (hH / 2);

      // Procedural math curve generation parsing bow and run lines dependencies
      if (nx > 0.50) {
        const t = (nx - 0.50) / 0.50;
        z *= Math.pow(1 - t, 1.8 - CB * 0.6);
        if (ny > 0.1) {
          x += t * ny * (L * 0.025); // Apply modern forward flare profile lines
        }
      }
      if (ny < 0) {
        // Resolve cross-sectional waterplane volumetric constraints inside the bilge radius
        z *= Math.pow(1 + ny, 0.52 + (1 - CB) * 0.65);
      }

      if (nx < -0.45) {
        const t = Math.abs(nx + 0.45) / 0.55;
        if (state.transom) {
          z *= (1 - t * 0.14); // Broad modern container deck stern profile execution
          if (ny > 0.4) x -= (t * 0.02 * L); 
        } else {
          x -= t * (L * 0.07); // Classical cruiser stern counter line
          z *= (1 - t * 0.38);
        }
      }
      hp.setXYZ(i, x, y, z);
    }
    hGeo.computeVertexNormals();
    const hullMeshObj = new THREE.Mesh(hGeo, mHull);
    hullMeshObj.position.y = hH / 2 - T;
    body.add(hullMeshObj);

    // --- STRUCTURAL LAYER 2: Dual Boot-Topping Dynamic Waterline Plate ---
    const bootGeo = new THREE.BoxGeometry(L * 1.003, T * 0.12, B * 1.006, 40, 1, 1);
    const bootMeshObj = new THREE.Mesh(bootGeo, mBoot);
    bootMeshObj.position.y = 0;
    body.add(bootMeshObj);

    // --- STRUCTURAL LAYER 3: Weather Deck Plating & Continuous Coamings ---
    const deckGeo = new THREE.BoxGeometry(L * 0.985, T * 0.08, B * 0.972);
    const deckMeshObj = new THREE.Mesh(deckGeo, mHatch);
    deckMeshObj.position.y = deckTopY + T * 0.04;
    body.add(deckMeshObj);

    // --- STRUCTURAL LAYER 4: High-Density Cargo Matrix Engine Layout ---
    const cargoXmin = -L * 0.34;
    const cargoXmax = L * 0.34;
    const cargoLen = cargoXmax - cargoXmin;
    const cargoZ = B * 0.88;

    const nBays = Math.max(4, Math.min(24, Math.floor(cargoLen / 11.5)));
    const nRows = Math.max(3, Math.min(13, Math.floor(cargoZ / 2.45)));
    const bayPitch = cargoLen / nBays;
    const rowPitch = cargoZ / nRows;
    const cHeight = 2.60; 
    const deckBaseY = deckTopY + T * 0.08;

    // Build functional modular stack arrays with volumetric randomized variance matching true TEU metrics
    for (let bay = 0; bay < nBays; bay++) {
      const bayCenterX = cargoXmin + (bay + 0.5) * bayPitch;
      
      // Skip cells where accommodations or specific bulkheads are positioned
      if (Math.abs(bayCenterX - (-L * 0.22)) < L * 0.05) continue; 

      const fxN = bay / Math.max(1, nBays - 1);            
      const lengthwiseProfile = 1 - Math.pow((fxN - 0.5) * 1.8, 2); 

      // Build safe continuous vertical container rows execution path
      for (let row = 0; row < nRows; row++) {
        const rowCenterZ = -cargoZ / 2 + (row + 0.5) * rowPitch;
        
        // Exclude outer rows near the bow and stern corners to keep containers from floating outside the hull lines
        const combinedHullFactor = (Math.abs(bayCenterX) / (L / 2)) + (Math.abs(rowCenterZ) / (B / 2));
        if (combinedHullFactor > 1.32) continue;

        const widthwiseProfile = 1 - Math.abs((row / Math.max(1, nRows - 1)) - 0.5) * 0.65;
        
        let tiers = Math.round(3 + lengthwiseProfile * 4.5 * widthwiseProfile);
        tiers = Math.max(1, Math.min(8, tiers));

        // Inject high-precision local container geometric arrays
        const w = bayPitch * 0.88;
        const dpt = rowPitch * 0.88;
        const h = tiers * cHeight;

        const containerMaterial = createMaterial(
          CONTAINER_COLORS[(bay * 7 + row * 4) % CONTAINER_COLORS.length], 
          0.55, 
          0.1
        );
        
        const stackMesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, dpt), containerMaterial);
        stackMesh.position.set(bayCenterX, deckBaseY + h / 2, rowCenterZ);
        body.add(stackMesh);

        // Append stylized container lashing bridge frameworks across outer slots
        if (row === 0 || row === nRows - 1 || bay % 4 === 0) {
          const bridgeGeo = new THREE.BoxGeometry(w * 1.04, 0.3, dpt * 1.04);
          const bridgeMesh = new THREE.Mesh(bridgeGeo, mLashing);
          bridgeMesh.position.set(bayCenterX, deckBaseY + 0.15, rowCenterZ);
          body.add(bridgeMesh);
        }
      }
    }

    // --- STRUCTURAL LAYER 5: Forecastle Raised Deck Assembly (Fore-deck) ---
    const fcL = L * 0.09;
    const fcH = T * 0.42;
    const fcGeo = new THREE.BoxGeometry(fcL, fcH, B * 0.72);
    const fcMesh = new THREE.Mesh(fcGeo, mHull);
    fcMesh.position.set(L / 2 - fcL * 0.4, deckTopY + fcH / 2, 0);
    body.add(fcMesh);

    // --- STRUCTURAL LAYER 6: Accommodations Block Architecture (Island Deckhouse) ---
    const accL = L * 0.095;
    const accB = B * 0.82;
    const accH = cHeight * 7.5;
    const accX = -L * 0.22; // Modern optimized mid-aft layout localization
    
    const accGeo = new THREE.BoxGeometry(accL, accH, accB);
    const accMesh = new THREE.Mesh(accGeo, mAcc);
    accMesh.position.set(accX, deckTopY + accH / 2, 0);
    body.add(accMesh);

    // Multi-tier layered bridge viewport glass band arrays
    for (let tier = 4; tier <= 7; tier++) {
      const gH = 0.95;
      const glassGeo = new THREE.BoxGeometry(accL * 1.01, gH, accB * 1.01);
      const glassMesh = new THREE.Mesh(glassGeo, mGlass);
      glassMesh.position.set(accX + accL * 0.02, deckTopY + (tier * cHeight) + 0.8, 0);
      body.add(glassMesh);
    }

    // Modern overhanging Navigation Bridge Wings extension plates
    const wingL = accL * 0.45;
    const wingB = B * 1.08;
    const wingH = cHeight * 0.95;
    const wingGeo = new THREE.BoxGeometry(wingL, wingH, wingB);
    const wingMesh = new THREE.Mesh(wingGeo, mAcc);
    wingMesh.position.set(accX + accL * 0.25, deckTopY + accH - wingH / 2, 0);
    body.add(wingMesh);

    // Navigation Bridge top radome scanner assets array
    const mastGeo = new THREE.CylinderGeometry(0.6, 1.2, 16, 8);
    const mastMesh = new THREE.Mesh(mastGeo, mMast);
    mastMesh.position.set(accX, deckTopY + accH + 8, 0);
    body.add(mastMesh);

    const radarGeo = new THREE.BoxGeometry(8, 0.4, 0.8);
    const radarMesh = new THREE.Mesh(radarGeo, mFunnel);
    radarMesh.position.set(accX, deckTopY + accH + 16, 0);
    body.add(radarMesh);

    // --- STRUCTURAL LAYER 7: Engine Exhaust Funnel Assembly Casing ---
    const fnR = B * 0.062;
    const fnH = cHeight * 4.6;
    const fnX = accX - accL * 0.82;
    
    const funnelCasingGeo = new THREE.CylinderGeometry(fnR * 0.72, fnR, fnH, 16);
    const funnelMesh = new THREE.Mesh(funnelCasingGeo, mFunnel);
    funnelMesh.position.set(fnX, deckTopY + fnH / 2, 0);
    body.add(funnelMesh);
    
    const funnelBandGeo = new THREE.CylinderGeometry(fnR * 0.74, fnR * 0.82, fnH * 0.18, 16);
    const fbandMesh = new THREE.Mesh(funnelBandGeo, mFband);
    fbandMesh.position.set(fnX, deckTopY + fnH * 0.72, 0);
    body.add(fbandMesh);

    // Inner detailed exhaust pipe manifolds
    const pipeGeo = new THREE.CylinderGeometry(0.4, 0.4, 2.5, 8);
    const pipe1 = new THREE.Mesh(pipeGeo, mDark);
    pipe1.position.set(fnX - 1, deckTopY + fnH + 1, 0.8);
    body.add(pipe1);
    const pipe2 = pipe1.clone();
    pipe2.position.z = -0.8;
    body.add(pipe2);

    // --- STRUCTURAL LAYER 8: Holtrop Hydrodynamic Appendage Matrix ---
    // A. Bulbous Bow Geometry
    if (state.bulbous) {
      const bulbGeo = new THREE.SphereGeometry(B * 0.125, 20, 16);
      const bulbMesh = new THREE.Mesh(bulbGeo, mBulb);
      bulbMesh.scale.set(2.1, 1.1, 1.1); // Dynamic longitudinal elongation coefficient matrix
      bulbMesh.position.set(L / 2 + B * 0.04, -T * 0.44, 0);
      body.add(bulbMesh);
    }

    // B. Bow Thruster Tunnel Ring Representation
    const thrusterGeo = new THREE.CylinderGeometry(B * 0.035, B * 0.035, B * 1.02, 12);
    thrusterGeo.rotateX(Math.PI / 2);
    const thrusterMesh = new THREE.Mesh(thrusterGeo, mDark);
    thrusterMesh.position.set(L / 2 - fcL * 1.5, -T * 0.38, 0);
    body.add(thrusterMesh);

    // C. Stern Semi-Balanced Skeg & High-Efficiency Rudder Profile
    if (state.behind_skeg || state.behind_stern || state.twin) {
      const rudderProfileGeo = new THREE.BoxGeometry(L * 0.026, T * 0.88, B * 0.016);
      const rudderMesh = new THREE.Mesh(rudderProfileGeo, mDark);
      rudderMesh.position.set(-L * 0.485, -T * 0.38, 0);
      body.add(rudderMesh);
    }

    // D. Bilge Keels Dampening Arrays
    if (state.keel > 0) {
      const keelGeo = new THREE.BoxGeometry(L * 0.32, T * 0.03, B * 0.04);
      const keelStarboard = new THREE.Mesh(keelGeo, mDark);
      keelStarboard.position.set(0, -T * 0.72, B * 0.46);
      keelStarboard.rotation.x = Math.PI / 6; 
      body.add(keelStarboard);
      
      const keelPort = new THREE.Mesh(keelGeo, mDark);
      keelPort.position.set(0, -T * 0.72, -B * 0.46);
      keelPort.rotation.x = -Math.PI / 6;
      body.add(keelPort);
    }

    // E. Propulsion Shaft Line Array Tubes
    if (state.shaft > 0) {
      const shaftLength = L * 0.24;
      const shaftTubeGeo = new THREE.CylinderGeometry(B * 0.014, B * 0.014, shaftLength, 12);
      const shaftMeshSTBD = new THREE.Mesh(shaftTubeGeo, mDark);
      shaftMeshSTBD.rotation.z = Math.PI / 2;
      shaftMeshSTBD.position.set(-L * 0.34, -T * 0.78, state.twin ? B * 0.18 : 0);
      body.add(shaftMeshSTBD);
      
      if (state.twin) {
        const shaftMeshPORT = shaftMeshSTBD.clone();
        shaftMeshPORT.position.z = -B * 0.18;
        body.add(shaftMeshPORT);
      }
    }
  }

  /**
   * Continuous WebGL Renderer Frame & Layout Dimensions Guard
   */
  function animate() {
    requestAnimationFrame(animate);
    const elapsedSeconds = clock.getElapsedTime();

    // LAYOUT RE-SIZE WATCHDOG: Fixes multi-tab context collapse errors instantly
    const activeLayoutContainer = document.getElementById(activeContainerId);
    if (activeLayoutContainer && renderer && camera) {
      const currentWidth = activeLayoutContainer.clientWidth;
      const currentHeight = activeLayoutContainer.clientHeight;

      if ((currentWidth !== lastWidth || currentHeight !== lastHeight) && currentWidth > 0 && currentHeight > 0) {
        lastWidth = currentWidth;
        lastHeight = currentHeight;
        
        camera.aspect = currentWidth / currentHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(currentWidth, currentHeight);
      }
    }

    // Dynamic wave equation simulation loop over spatial vertices matrices
    if (waterGeometry && !isWireframe) {
      const positionAttr = waterGeometry.attributes.position;
      for (let i = 0; i < positionAttr.count; i++) {
        const coordX = positionAttr.getX(i);
        const coordY = positionAttr.getY(i);
        
        const calculatedWaveDisplacement = 
            Math.sin(coordX * 0.038 + elapsedSeconds * 1.5) * waveAmp
          + Math.cos(coordY * 0.032 + elapsedSeconds * 1.2) * waveAmp * 0.85
          + Math.sin((coordX + coordY) * 0.072 + elapsedSeconds * 2.1) * waveAmp * 0.3;
          
        positionAttr.setZ(i, calculatedWaveDisplacement);
      }
      waterGeometry.computeVertexNormals();
      waterGeometry.attributes.position.needsUpdate = true;
    }

    // Apply real-time 6-DOF marine motions harmonics to ship group node orientation
    if (hullGroup) {
      hullGroup.position.y = Math.sin(elapsedSeconds * 1.4) * waveAmp * 0.36 - 0.08;
      hullGroup.rotation.z = Math.cos(elapsedSeconds * 1.5) * 0.012; // Roll profile mock
      hullGroup.rotation.x = Math.sin(elapsedSeconds * 0.95) * 0.006; // Pitch profile mock
    }

    if (controls) controls.update();
    if (renderer) renderer.render(scene, camera);
  }

  function onWindowResize() {
    const container = document.getElementById(activeContainerId);
    if (!container || !renderer || !camera) return;
    
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;

    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  // Map safe execution hooks globally across namespace boundaries
  window.HoltropCAD = {
    init3D: init3D,
    renderHullShape: renderHullShape,
    frameCamera: frameCamera,
    onWindowResize: onWindowResize,
    toggleWireframe: () => { isWireframe = !isWireframe; },
    getRenderer: () => renderer,
    getScene: () => scene,
    getCamera: () => camera
  };
})();