/**
 * js/b_cad.js
 * Isolated 3D Procedural CAD Engine for Wageningen B-Series Propeller Visualization
 * Dependencies: three.js, OrbitControls.js
 */

let bScene, bCamera, bRenderer, bControls;
let propGroup, bBladeGroup;
let bHubMesh;
let bFlowParticles;

// Global engine configuration matching numerical solver attributes
let bWireframeMode = false;
let bClock = new THREE.Clock();

let propDimensions = {
    blades: 4,
    dar: 0.80,
    pMin: 0.50,
    pMax: 1.40,
    reynolds: 2000000
};

// Fixed Hydrodynamic Reference Tables for Blade Generation
const B_RADIAL_STATIONS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];
const B_CHORD_FACTORS   = [0.182, 0.218, 0.245, 0.264, 0.273, 0.272, 0.257, 0.222, 0.180, 0.000]; 
const B_THICK_FACTORS   = [0.045, 0.039, 0.034, 0.029, 0.024, 0.019, 0.015, 0.010, 0.007, 0.002]; 

const B_PARTICLE_COUNT = 1200;
let bParticlePositions, bParticleLifetimes;

/**
 * Initializes the standalone WebGL viewport for Propeller CAD inspection
 * @param {string} containerId - The target DOM hosting container element ID
 */
function initPropellerCAD(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`Propeller CAD Engine Error: Container element "#${containerId}" not found.`);
        return;
    }

    // Scene setup with deep dark marine engineering theme
    bScene = new THREE.Scene();
    bScene.background = new THREE.Color(0x030914);
    bScene.fog = new THREE.FogExp2(0x030914, 0.04);

    bCamera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
    bCamera.position.set(3.5, 1.5, 3.5);

    bRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    bRenderer.setSize(container.clientWidth, container.clientHeight);
    bRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(bRenderer.domElement);

    bControls = new THREE.OrbitControls(bCamera, bRenderer.domElement);
    bControls.enableDamping = true;
    bControls.dampingFactor = 0.05;
    bControls.maxDistance = 15;
    bControls.minDistance = 1.2;
    bControls.target.set(0, 0, 0);

    // Dynamic High-Fidelity Lighting Profiles
    const ambientLight = new THREE.AmbientLight(0x0f172a, 2.0);
    bScene.add(ambientLight);

    const keySun = new THREE.DirectionalLight(0xffffff, 3.0);
    keySun.position.set(6, 10, 4);
    bScene.add(keySun);

    const rimBronzeLight = new THREE.DirectionalLight(0xc8a84b, 2.5);
    rimBronzeLight.position.set(-6, -2, -4);
    bScene.add(rimBronzeLight);

    const hydroFillLight = new THREE.DirectionalLight(0x06b6d4, 2.0);
    hydroFillLight.position.set(0, 5, -5);
    bScene.add(hydroFillLight);

    // Geometric Group Architecture
    propGroup = new THREE.Group();
    bBladeGroup = new THREE.Group();
    propGroup.add(bBladeGroup);
    bScene.add(propGroup);

    window.addEventListener('resize', () => resizePropellerViewport(containerId));

    // Initial procedural composition
    updatePropellerGeometry(propDimensions.blades, propDimensions.dar, propDimensions.pMin, propDimensions.pMax, propDimensions.reynolds);
    initHydroFlowSimulation();
    animatePropellerCAD();
}

/**
 * Regenerates the full structural components of the propeller from incoming solver states
 */
function updatePropellerGeometry(blades, dar, pMin, pMax, reynolds) {
    if (!bBladeGroup) return;

    // Synchronize parameter block
    propDimensions = { blades, dar, pMin, pMax, reynolds };

    // Clean old blade mesh objects and explicitly dispose memory buffers
    while (bBladeGroup.children.length > 0) {
        const obj = bBladeGroup.children[0];
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
        } else {
            obj.material.dispose();
        }
        bBladeGroup.remove(obj);
    }

    if (bHubMesh) {
        bHubMesh.geometry.dispose();
        if (Array.isArray(bHubMesh.material)) {
            bHubMesh.material.forEach(m => m.dispose());
        } else {
            bHubMesh.material.dispose();
        }
        propGroup.remove(bHubMesh);
    }

    // Material spec matching traditional machined cast bronze/brass alloys
    const bronzeMaterial = new THREE.MeshStandardMaterial({
        color: 0xc8a84b,
        emissive: 0x2e240c,
        roughness: 0.18,
        metalness: 0.90,
        wireframe: bWireframeMode,
        side: THREE.DoubleSide
    });

    // 1. Hub/Boss Generation
    const hubRadius = 0.18;
    const hubLength = 0.65;
    const hubGeometry = new THREE.CylinderGeometry(hubRadius * 0.5, hubRadius * 1.1, hubLength, 32);
    hubGeometry.rotateX(Math.PI / 2); // Align cylindrical axis matching shaft line (Z-axis)
    bHubMesh = new THREE.Mesh(hubGeometry, bronzeMaterial);
    propGroup.add(bHubMesh);

    // 2. Blade Generation Loop via Radial Lofting Stations
    const darModifier = dar / 0.55; 
    const angularStep = (2 * Math.PI) / blades;
    const chordResolution = 12; // Discrete mesh chordwise points per station

    for (let b = 0; b < blades; b++) {
        const bladeGeometry = new THREE.BufferGeometry();
        const vertices = [];
        const indices = [];

        for (let s = 0; s < B_RADIAL_STATIONS.length; s++) {
            const r = B_RADIAL_STATIONS[s];
            const chord = B_CHORD_FACTORS[s] * darModifier;
            const thickness = B_THICK_FACTORS[s];

            // Linear pitch variation from root station to blade tip
            const localPitchRatio = pMin + (pMax - pMin) * ((r - 0.2) / 0.8);
            const localPitchAngle = Math.atan(localPitchRatio / (2 * Math.PI * r));

            for (let p = 0; p <= chordResolution; p++) {
                const tInterp = p / chordResolution;
                const chordPos = (tInterp - 0.35) * chord; // Shift aerodynamic center skewed back
                const thickFactor = Math.sin(tInterp * Math.PI) * thickness;

                // Mathematical matrix shift mapping flat 2D foil paths onto pitched helicoid curves
                const xLocal = chordPos * Math.cos(localPitchAngle) - (thickFactor * 0.15 * Math.sin(localPitchAngle));
                const yLocal = r;
                const zLocal = chordPos * Math.sin(localPitchAngle) + (thickFactor * 0.85 * Math.cos(localPitchAngle));

                vertices.push(xLocal, yLocal, zLocal);
            }
        }

        // Structural index mesh generation for multi-station surface lofting
        const totalStations = B_RADIAL_STATIONS.length;
        const pointsPerSeg = chordResolution + 1;

        for (let i = 0; i < totalStations - 1; i++) {
            for (let j = 0; j < pointsPerSeg - 1; j++) {
                const p0 = i * pointsPerSeg + j;
                const p1 = i * pointsPerSeg + (j + 1);
                const p2 = (i + 1) * pointsPerSeg + j;
                const p3 = (i + 1) * pointsPerSeg + (j + 1);

                indices.push(p0, p1, p2);
                indices.push(p1, p3, p2);
            }
        }

        bladeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        bladeGeometry.setIndex(indices);
        bladeGeometry.computeVertexNormals();

        const currentBladeMesh = new THREE.Mesh(bladeGeometry, bronzeMaterial);
        currentBladeMesh.rotation.z = b * angularStep; // Equidistant angular indexing
        bBladeGroup.add(currentBladeMesh);
    }
}

/**
 * Instantiates the particle tracking vector field around the actuator disc area
 */
function initHydroFlowSimulation() {
    if (bFlowParticles) bScene.remove(bFlowParticles);

    const particleGeometry = new THREE.BufferGeometry();
    bParticlePositions = new Float32Array(B_PARTICLE_COUNT * 3);
    bParticleLifetimes = new Float32Array(B_PARTICLE_COUNT);

    for (let i = 0; i < B_PARTICLE_COUNT; i++) {
        resetHydroParticle(i);
        bParticlePositions[i * 3 + 2] = (Math.random() * 6) - 3; // Distribute across spatial field domain
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(bParticlePositions, 3));

    const particleMaterial = new THREE.PointsMaterial({
        color: 0x38bdf8,
        size: 0.035,
        transparent: true,
        opacity: 0.60,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    bFlowParticles = new THREE.Points(particleGeometry, particleMaterial);
    bScene.add(bFlowParticles);
}

function resetHydroParticle(i) {
    const radius = 0.1 + Math.random() * 1.1;
    const angle = Math.random() * Math.PI * 2;
    bParticlePositions[i * 3 + 0] = Math.cos(angle) * radius;
    bParticlePositions[i * 3 + 1] = Math.sin(angle) * radius;
    bParticlePositions[i * 3 + 2] = -3.0; // Inflow plane source boundary
    bParticleLifetimes[i] = 0;
}

/**
 * Updates flow lines according to Reynolds and Pitch constraints mimicking slip-stream velocity fields
 */
function updateHydroFlowSimulation() {
    if (!bFlowParticles) return;

    const positions = bFlowParticles.geometry.attributes.position.array;
    const baseFlowVelocity = 0.02 + (propDimensions.reynolds / 9000000) * 0.06;
    const avgPitch = (propDimensions.pMin + propDimensions.pMax) / 2.0;

    for (let i = 0; i < B_PARTICLE_COUNT; i++) {
        let x = positions[i * 3 + 0];
        let y = positions[i * 3 + 1];
        let z = positions[i * 3 + 2];
        const radius = Math.sqrt(x*x + y*y);
        
        let vx = 0, vy = 0, vz = baseFlowVelocity;

        // Actuator disk boundary zone interaction logic
        if (z >= -0.2 && z <= 2.5) {
            const twistStrength = (0.04 + (avgPitch * 0.03)) * (1.0 / (radius + 0.15));
            const accelerationFactor = 1.3 + (avgPitch * 0.4);

            if (radius <= 1.1) {
                vx = -y * twistStrength;
                vy =  x * twistStrength;
                vz = baseFlowVelocity * accelerationFactor;

                // Wake slipstream boundary contraction calculation
                const contraction = 1.0 - 0.12 * (1.0 - Math.exp(-z));
                positions[i * 3 + 0] *= contraction;
                positions[i * 3 + 1] *= contraction;
            }
        }

        positions[i * 3 + 0] += vx;
        positions[i * 3 + 1] += vy;
        positions[i * 3 + 2] += vz;
        bParticleLifetimes[i] += 1;

        if (positions[i * 3 + 2] > 3.0 || bParticleLifetimes[i] > 250) {
            resetHydroParticle(i);
        }
    }
    bFlowParticles.geometry.attributes.position.needsUpdate = true;
}

/**
 * Continuous animation execution pipeline loop
 */
function animatePropellerCAD() {
    requestAnimationFrame(animatePropellerCAD);

    // Angular velocity proportional to calculated hydro Reynolds scale states
    const angularVelocity = 0.005 + (propDimensions.reynolds / 9000000) * 0.025;
    if (bBladeGroup) bBladeGroup.rotation.z += angularVelocity;

    updateHydroFlowSimulation();

    if (bControls) bControls.update();
    if (bRenderer && bScene && bCamera) bRenderer.render(bScene, bCamera);
}

function resizePropellerViewport(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !bRenderer || !bCamera) return;

    bCamera.aspect = container.clientWidth / container.clientHeight;
    bCamera.updateProjectionMatrix();
    bRenderer.setSize(container.clientWidth, container.clientHeight);
}

/**
 * Viewport Control Utilities
 */
function togglePropellerWireframe() {
    bWireframeMode = !bWireframeMode;
    if (!bBladeGroup) return;

    bBladeGroup.traverse((child) => {
        if (child.isMesh && child.material) child.material.wireframe = bWireframeMode;
    });
    if (bHubMesh && bHubMesh.material) bHubMesh.material.wireframe = bWireframeMode;
}

function zoomInPropeller() { if (bCamera && bControls) { bCamera.position.multiplyScalar(0.82); bControls.update(); } }
function zoomOutPropeller() { if (bCamera && bControls) { bCamera.position.multiplyScalar(1.18); bControls.update(); } }
function resetPropellerView() {
    if (bCamera && bControls) {
        bCamera.position.set(3.5, 1.5, 3.5);
        bControls.target.set(0, 0, 0);
        if (propGroup) propGroup.rotation.set(0, 0, 0);
        bControls.update();
    }
}

function capturePropellerSnapshot() {
    if (!bRenderer || !bScene || !bCamera) return null;
    bRenderer.render(bScene, bCamera);
    return bRenderer.domElement.toDataURL('image/png');
}