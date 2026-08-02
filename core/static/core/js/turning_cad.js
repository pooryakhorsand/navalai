/**
 * turning_cad.js
 * NavalAI — Isolated 3D Turning Circle CAD Engine for Hero Demo
 *
 * Self-contained: initialise with initTurningCAD(containerId).
 * Feed trajectory data with updateTurningTrajectory(data).
 *
 * Mirrors the yacht_cad.js / b_cad.js / holtrop_cad.js pattern so
 * index.html can call it the same way as every other demo layer.
 *
 * Dependencies: three.js r128, OrbitControls.js
 */

(function () {
    'use strict';

    /* ── private module state ── */
    let tc_scene, tc_camera, tc_renderer, tc_controls;
    let tc_waterGeo, tc_waterPlane;
    let tc_shipModel   = null;
    let tc_trajLine    = null;
    let tc_trajGeom    = null;
    let tc_startMarker = null;
    let tc_rudderMarker = null;
    let tc_clock       = null;

    let tc_animElapsed = 0;
    let tc_isPlaying   = true;
    const TC_ANIM_DURATION = 6.0;   // compress full manoeuvre into N seconds

    let tc_simData = null;           // trajectory data fed via updateTurningTrajectory()
    let tc_containerId = null;

    /* ── public: initialise ── */
    window.initTurningCAD = function (containerId) {
        tc_containerId = containerId;
        const container = document.getElementById(containerId);
        if (!container) {
            console.error('TurningCAD: element "#' + containerId + '" not found.');
            return;
        }

        tc_clock = new THREE.Clock();

        /* Scene */
        tc_scene = new THREE.Scene();
        tc_scene.background = new THREE.Color(0x0b253a);

        /* Camera */
        tc_camera = new THREE.PerspectiveCamera(
            45,
            container.clientWidth / container.clientHeight,
            0.5, 50000
        );
        tc_camera.position.set(600, 500, 700);

        /* Renderer */
        tc_renderer = new THREE.WebGLRenderer({
            antialias: true, alpha: true, preserveDrawingBuffer: true
        });
        tc_renderer.setSize(container.clientWidth, container.clientHeight);
        tc_renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(tc_renderer.domElement);

        /* Controls */
        tc_controls = new THREE.OrbitControls(tc_camera, tc_renderer.domElement);
        tc_controls.enableDamping  = true;
        tc_controls.dampingFactor  = 0.06;
        tc_controls.target.set(0, 0, 0);

        /* Lights */
        tc_scene.add(new THREE.AmbientLight(0x3a4b6e, 0.7));

        const sun = new THREE.DirectionalLight(0xfff5df, 1.3);
        sun.position.set(400, 800, 300);
        tc_scene.add(sun);

        const fill = new THREE.DirectionalLight(0x4ed0e1, 0.6);
        fill.position.set(-200, -400, -200);
        tc_scene.add(fill);

        /* Dynamic water plane */
        tc_waterGeo = new THREE.PlaneGeometry(16000, 16000, 120, 120);
        const waterMat = new THREE.MeshStandardMaterial({
            color: 0x4ed0e1,
            roughness: 0.1,
            metalness: 0.5,
            flatShading: true,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide
        });
        tc_waterPlane = new THREE.Mesh(tc_waterGeo, waterMat);
        tc_waterPlane.rotation.x = -Math.PI / 2;
        tc_scene.add(tc_waterPlane);

        /* Build a default ship at a sensible scale */
        _buildShip(30);

        /* Resize listener */
        window.addEventListener('resize', _onResize);

        /* Kick off render loop */
        _animate();
    };

    /* ── public: feed trajectory data ── */
    window.updateTurningTrajectory = function (data) {
        /*
         * Accepts an object with arrays:
         *   t_series, x_series, y_series, psi_series (optional)
         *
         * Also accepts the full simCache shape from app_turning.js:
         *   { time_series: { t_series, x_series, y_series, psi_series, U_series, ... } }
         */
        if (!data) return;

        let ts = data;
        if (data.time_series) ts = data.time_series;

        if (!ts.x_series || !ts.x_series.length) return;

        tc_simData = ts;
        tc_animElapsed = 0;

        _rebuildTrajectory();
        _frameCamera();
    };

    /* ═══════════════════════════════════════════════════════
       PRIVATE — SHIP MODEL
    ═══════════════════════════════════════════════════════ */
    function _buildShip(L) {
        if (tc_shipModel) {
            tc_scene.remove(tc_shipModel);
            tc_shipModel.traverse(function (o) {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
                    else o.material.dispose();
                }
            });
        }

        tc_shipModel = new THREE.Group();

        const B = L / 7;
        const H = L / 3.5;

        const hullMat = new THREE.MeshStandardMaterial({ color: 0x005b66, roughness: 0.2, metalness: 0.7 });
        const superMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, metalness: 0.1 });
        const deckMat  = new THREE.MeshStandardMaterial({ color: 0xd2b48c, roughness: 0.55, metalness: 0.0 });
        const trimMat  = new THREE.MeshStandardMaterial({ color: 0xc8a84b, roughness: 0.15, metalness: 0.95 });
        const noseMat  = new THREE.MeshStandardMaterial({ color: 0xfb7185, roughness: 0.2,  metalness: 0.6 });

        /* Hull */
        const hGeo = new THREE.BoxGeometry(L, H, B, 24, 4, 8);
        const hp   = hGeo.attributes.position;
        for (let i = 0; i < hp.count; i++) {
            const x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
            const nx = x / (L / 2);
            const ny = y / (H / 2);
            /* Bow taper */
            if (nx > 0.45) {
                const t = (nx - 0.45) / 0.55;
                hp.setZ(i, z * Math.pow(1 - t, 1.4));
                if (ny > 0) hp.setX(i, x + ny * 0.2 * t * L);
            }
            /* Keel V-shape */
            if (ny < 0) {
                hp.setZ(i, z * Math.pow(1 + ny, 0.55));
            }
        }
        hGeo.computeVertexNormals();
        const hull = new THREE.Mesh(hGeo, hullMat);
        hull.position.y = H * 0.1;
        tc_shipModel.add(hull);

        /* Deck */
        const dGeo = new THREE.BoxGeometry(L * 0.97, H * 0.04, B * 0.94, 16, 1, 8);
        const dp = dGeo.attributes.position;
        for (let i = 0; i < dp.count; i++) {
            const nx = dp.getX(i) / (L / 2);
            if (nx > 0.45) dp.setZ(i, dp.getZ(i) * Math.pow(1 - (nx - 0.45) / 0.55, 1.2));
        }
        dGeo.computeVertexNormals();
        const deck = new THREE.Mesh(dGeo, deckMat);
        deck.position.y = H * 0.62;
        tc_shipModel.add(deck);

        /* Superstructure */
        const sGeo = new THREE.BoxGeometry(L * 0.22, H * 0.9, B * 0.7);
        const sup  = new THREE.Mesh(sGeo, superMat);
        sup.position.set(-L * 0.12, H * 1.05, 0);
        tc_shipModel.add(sup);

        /* Waterline trim stripe */
        const trim = new THREE.Mesh(
            new THREE.BoxGeometry(L * 0.98, H * 0.065, B * 1.01),
            trimMat
        );
        trim.position.y = -H * 0.36;
        tc_shipModel.add(trim);

        /* Bow direction cone — teal/pink so the turning direction reads instantly */
        const nose = new THREE.Mesh(
            new THREE.ConeGeometry(B * 0.16, L * 0.11, 12),
            noseMat
        );
        nose.rotation.z = -Math.PI / 2;
        nose.position.set(L * 0.56, H * 0.4, 0);
        tc_shipModel.add(nose);

        tc_scene.add(tc_shipModel);
    }

    /* ═══════════════════════════════════════════════════════
       PRIVATE — TRAJECTORY LINE + MARKERS
    ═══════════════════════════════════════════════════════ */
    function _rebuildTrajectory() {
        if (!tc_simData || !tc_scene) return;

        const xs = tc_simData.x_series;
        const ys = tc_simData.y_series;
        const n  = xs.length;
        if (!n) return;

        /* Remove old line */
        if (tc_trajLine) {
            tc_scene.remove(tc_trajLine);
            tc_trajLine.geometry.dispose();
            tc_trajLine.material.dispose();
            tc_trajLine = null;
        }

        /* Build buffer — x → world-X, y → world-Z */
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            positions[i * 3]     = xs[i];
            positions[i * 3 + 1] = 0.5;
            positions[i * 3 + 2] = ys[i];
        }
        tc_trajGeom = new THREE.BufferGeometry();
        tc_trajGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        tc_trajGeom.setDrawRange(0, 1);

        tc_trajLine = new THREE.Line(
            tc_trajGeom,
            new THREE.LineBasicMaterial({ color: 0x4ed0e1, linewidth: 2 })
        );
        tc_scene.add(tc_trajLine);

        /* Markers */
        const span  = _trajectorySpan(xs, ys);
        const mSize = Math.max(6, Math.min(35, span * 0.014));

        if (tc_startMarker)  { tc_scene.remove(tc_startMarker);  tc_startMarker.geometry.dispose();  tc_startMarker.material.dispose(); }
        if (tc_rudderMarker) { tc_scene.remove(tc_rudderMarker); tc_rudderMarker.geometry.dispose(); tc_rudderMarker.material.dispose(); }

        tc_startMarker = new THREE.Mesh(
            new THREE.SphereGeometry(mSize, 12, 8),
            new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 0.7 })
        );
        tc_startMarker.position.set(xs[0], 1, ys[0]);
        tc_scene.add(tc_startMarker);

        /* Rudder-applied marker — roughly at 20% of trajectory */
        const rIdx = Math.floor(n * 0.18);
        if (rIdx > 0) {
            tc_rudderMarker = new THREE.Mesh(
                new THREE.SphereGeometry(mSize, 12, 8),
                new THREE.MeshStandardMaterial({ color: 0xfb7185, emissive: 0xfb7185, emissiveIntensity: 0.7 })
            );
            tc_rudderMarker.position.set(xs[rIdx], 1, ys[rIdx]);
            tc_scene.add(tc_rudderMarker);
        }

        /* Resize ship proportionally to trajectory */
        const shipL = Math.max(8, Math.min(span * 0.045, 120));
        _buildShip(shipL);
    }

    /* ═══════════════════════════════════════════════════════
       PRIVATE — CAMERA FRAMING
    ═══════════════════════════════════════════════════════ */
    function _frameCamera() {
        if (!tc_simData || !tc_camera || !tc_controls) return;
        const xs = tc_simData.x_series;
        const ys = tc_simData.y_series;

        let xMin = xs[0], xMax = xs[0], yMin = ys[0], yMax = ys[0];
        for (let i = 1; i < xs.length; i++) {
            if (xs[i] < xMin) xMin = xs[i]; if (xs[i] > xMax) xMax = xs[i];
            if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i];
        }
        const cx   = (xMin + xMax) / 2;
        const cz   = (yMin + yMax) / 2;
        const span = Math.max(xMax - xMin, yMax - yMin, 100) * 1.35;

        tc_controls.target.set(cx, 0, cz);
        tc_camera.position.set(cx - span * 0.12, span * 0.72, cz + span * 0.88);
        tc_controls.update();
    }

    /* ═══════════════════════════════════════════════════════
       PRIVATE — HELPERS
    ═══════════════════════════════════════════════════════ */
    function _trajectorySpan(xs, ys) {
        let xMin = xs[0], xMax = xs[0], yMin = ys[0], yMax = ys[0];
        for (let i = 1; i < xs.length; i++) {
            if (xs[i] < xMin) xMin = xs[i]; if (xs[i] > xMax) xMax = xs[i];
            if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i];
        }
        return Math.max(xMax - xMin, yMax - yMin, 50);
    }

    /* ═══════════════════════════════════════════════════════
       PRIVATE — ANIMATION LOOP
    ═══════════════════════════════════════════════════════ */
    function _animate() {
        requestAnimationFrame(_animate);

        const dt  = tc_clock.getDelta();
        const t   = tc_clock.getElapsedTime();

        /* ── Dynamic water ── */
        if (tc_waterGeo) {
            const p = tc_waterGeo.attributes.position;
            for (let i = 0; i < p.count; i++) {
                const u = p.getX(i), v = p.getY(i);
                const z =
                    Math.sin(u * 0.005 + t * 1.4) * 4.2
                  + Math.cos(v * 0.004 + t * 1.1) * 3.1
                  + Math.sin((u + v) * 0.008 + t * 1.8) * 1.3;
                p.setZ(i, z);
            }
            tc_waterGeo.computeVertexNormals();
            tc_waterGeo.attributes.position.needsUpdate = true;
        }

        /* ── Ship trajectory playback ── */
        if (tc_simData && tc_shipModel && tc_trajGeom) {
            if (tc_isPlaying) {
                tc_animElapsed = (tc_animElapsed + dt) % TC_ANIM_DURATION;
            }

            const xs = tc_simData.x_series;
            const ys = tc_simData.y_series;
            const ps = tc_simData.psi_series;
            const n  = xs.length;

            const phase = tc_animElapsed / TC_ANIM_DURATION;
            const fIdx  = phase * (n - 1);
            const i0    = Math.floor(fIdx);
            const i1    = Math.min(n - 1, i0 + 1);
            const frac  = fIdx - i0;

            const x = xs[i0] * (1 - frac) + xs[i1] * frac;
            const y = ys[i0] * (1 - frac) + ys[i1] * frac;

            tc_shipModel.position.set(x, Math.sin(t * 1.8) * 0.5, y);

            /* Heading */
            if (ps && ps.length === n) {
                let psi0 = ps[i0], psi1 = ps[i1];
                let dPsi = psi1 - psi0;
                if (dPsi >  180) dPsi -= 360;
                if (dPsi < -180) dPsi += 360;
                const psiDeg = psi0 + dPsi * frac;
                tc_shipModel.rotation.y = -psiDeg * Math.PI / 180;
            }

            /* Cosmetic rolling */
            tc_shipModel.rotation.z = Math.cos(t * 2.1) * 0.045;
            tc_shipModel.rotation.x = Math.sin(t * 1.3) * 0.02;

            /* Reveal trajectory progressively */
            tc_trajGeom.setDrawRange(0, i0 + 1);
        } else if (tc_shipModel) {
            /* No data yet — gentle idle animation */
            tc_shipModel.position.y  = Math.sin(t * 1.9) * 0.22;
            tc_shipModel.rotation.z  = Math.cos(t * 2.3) * 0.06;
            tc_shipModel.rotation.x  = Math.sin(t * 1.3) * 0.12;
            tc_shipModel.rotation.y += 0.004;
        }

        if (tc_controls) tc_controls.update();
        if (tc_renderer && tc_scene && tc_camera) {
            tc_renderer.render(tc_scene, tc_camera);
        }
    }

    /* ═══════════════════════════════════════════════════════
       PRIVATE — RESIZE
    ═══════════════════════════════════════════════════════ */
    function _onResize() {
        if (!tc_containerId) return;
        const container = document.getElementById(tc_containerId);
        if (!container || !tc_renderer || !tc_camera) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!w || !h) return;
        tc_camera.aspect = w / h;
        tc_camera.updateProjectionMatrix();
        tc_renderer.setSize(w, h);
    }

})();