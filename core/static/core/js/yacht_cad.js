/**
 * yacht_cad.js
 * Isolated 3D Procedural CAD Engine for Yacht Geometry Visualization
 * Dependency: three.js, OrbitControls.js
 */

let scene, camera, renderer, controls;
let yachtGroup, waterPlane;
let waterGeometry;
let isWireframe = false;
let clock = new THREE.Clock();

let designDimensions = {
    L: 24.0,
    B: 6.0,
    T: 1.5,
    CB: 0.50,
    LCB: -2.5
};

/**
 * Initializes the Three.js viewport in a designated target container
 * @param {string} containerId - The DOM element ID hosting the WebGL canvas
 */
function initCAD(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`CAD Engine error: Element "#${containerId}" not found.`);
        return;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b253a);

    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 500);
    camera.position.set(16, 8, 20);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.5, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const ambientLight = new THREE.AmbientLight(0x3a4b6e, 0.7);
    scene.add(ambientLight);

    const stormSun = new THREE.DirectionalLight(0xfff5df, 1.3);
    stormSun.position.set(30, 45, 20);
    scene.add(stormSun);

    const hullUnderlight = new THREE.DirectionalLight(0x4ed0e1, 0.6);
    hullUnderlight.position.set(-10, -30, -10);
    scene.add(hullUnderlight);

    waterGeometry = new THREE.PlaneGeometry(60, 60, 60, 60);
    const waterMaterial = new THREE.MeshStandardMaterial({
        color: 0x4ed0e1,
        roughness: 0.1,
        metalness: 0.5,
        flatShading: true,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide
    });
    waterPlane = new THREE.Mesh(waterGeometry, waterMaterial);
    waterPlane.rotation.x = -Math.PI / 2;
    scene.add(waterPlane);

    yachtGroup = new THREE.Group();
    scene.add(yachtGroup);

    window.addEventListener('resize', () => resizeCADViewport(containerId));

    updateHullGeometry(designDimensions.L, designDimensions.B, designDimensions.T, designDimensions.CB, designDimensions.LCB);
    animateCAD();
}


function updateHullGeometry(L, B, T, CB, LCB) {
    if (!yachtGroup) return;

    designDimensions = { L, B, T, CB, LCB };

    while (yachtGroup.children.length > 0) {
        const obj = yachtGroup.children[0];
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
        } else {
            obj.material.dispose();
        }
        yachtGroup.remove(obj);
    }

    const hullMat = new THREE.MeshStandardMaterial({ color: 0x005b66, roughness: 0.1, metalness: 0.7, wireframe: isWireframe });
    const superstructureMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, metalness: 0.1, wireframe: isWireframe });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0xd2b48c, roughness: 0.55, metalness: 0.0, wireframe: isWireframe });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x1c120c, roughness: 0.05, metalness: 1.0, transparent: true, opacity: 0.85, wireframe: isWireframe });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xc8a84b, roughness: 0.15, metalness: 0.95, wireframe: isWireframe });

    const hullHeight = T * 1.3;
    const hullGeo = new THREE.BoxGeometry(L, hullHeight, B, 64, 16, 32);
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

    const deckGeo = new THREE.BoxGeometry(L * 0.98, 0.04, B * 0.96, 32, 1, 16);
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
    const cabinGeo = new THREE.BoxGeometry(cabL, cabH, cabB, 32, 8, 16);
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
    const glassGeo = new THREE.BoxGeometry(winL, winH, winB, 16, 4, 8);
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


function animateCAD() {
    requestAnimationFrame(animateCAD);

    const time = clock.getElapsedTime();
    const speedFactor = 0.5; 

    if (waterGeometry) {
        const pos = waterGeometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const u = pos.getX(i);
            const v = pos.getY(i);
            const z = Math.sin(u * 0.22 + time * 2.3) * 0.58 * speedFactor +
                      Math.cos(v * 0.18 + time * 1.9) * 0.46 * speedFactor +
                      Math.sin((u + v) * 0.55 + time * 3.4) * 0.16;
            pos.setZ(i, z);
        }
        waterGeometry.computeVertexNormals();
        waterGeometry.attributes.position.needsUpdate = true;
    }

    if (yachtGroup) {
        yachtGroup.position.y = Math.sin(time * 2.1) * 0.24 * speedFactor - 0.05;
        yachtGroup.rotation.z = Math.cos(time * 2.3) * 0.07 * speedFactor + (speedFactor * 0.02);
        yachtGroup.rotation.x = Math.sin(time * 1.3) * 0.14 * speedFactor;
        yachtGroup.rotation.y = Math.cos(time * 0.7) * 0.03 * speedFactor;
    }

    if (controls) controls.update();
    if (renderer) renderer.render(scene, camera);
}


function resizeCADViewport(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !renderer || !camera) return;

    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}


function toggleWireframeView() {
    isWireframe = !isWireframe;
    if (!yachtGroup) return;

    yachtGroup.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material.wireframe = isWireframe;
        }
    });
}


function zoomInCAD() { if (camera && controls) { camera.position.multiplyScalar(0.85); controls.update(); } }
function zoomOutCAD() { if (camera && controls) { camera.position.multiplyScalar(1.15); controls.update(); } }
function resetCADView() {
    if (camera && controls) {
        camera.position.set(16, 8, 20);
        controls.target.set(0, 0.5, 0);
        controls.update();
    }
}

/**
 * Captures the current frame buffer context of the WebGL canvas
 * @returns {string} base64 DataURL representation of image png
 */
function captureCADSnapshot() {
    if (!renderer || !scene || !camera) return null;
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
}