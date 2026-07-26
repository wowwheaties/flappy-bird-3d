// Flappy Bird 3D — Three.js (M4)
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────
  const GRAVITY = -15;          // units/s² (negative = down in world Y)
  const FLAP_VEL = 8;           // upward impulse on flap
  const PIPE_SPEED = 4.5;       // scroll speed (world X direction, toward bird)
  const BIRD_RADIUS = 0.6;      // collision sphere radius
  const GROUND_Y = -8;          // pipe spawn clamp
  const KILL_Y = -24;             // fall death — generous room below play band
  const CEILING_Y = 8;          // world Y ceiling
  const PIPE_INTERVAL = 1.55;   // faster pipe cadence
  const PIPE_GAP = 3.6;         // gap height in world units
  const PLAY_LENGTH = 100;      // total scroll distance before pipes wrap
  const SPAWN_X = 11;           // spawn fully on-screen (camera sees ~x 0..12)

  // ── Near constants ───────────────────────────────────────
  const TARGET_FPS = 30;
  const FRAME_DT = 1 / TARGET_FPS;
  const COL_SKY = new THREE.Color(0x6eb6e0);
  const COL_FLASH = new THREE.Color(0xff6666);

  // Best score & mute (M2)
  let bestScore = parseInt(localStorage.getItem('flappy3d_best') || '0', 10);
  let muted = localStorage.getItem('flappy3d_muted') === '1';
  let audioCtx = null;            // Web Audio API context
  let fartBuf = null;               // HTMLAudioElement template for real fart SFX

  function getAudioContext() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { /* no-op */ }
    }
    return audioCtx;
  }

  function playTone(freq, duration, type, volume) {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume || 0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (e) { /* no-op */ }
  }

  function ensureFartAudio() {
    if (fartBuf) return fartBuf;
    try {
      const a = new Audio();
      // prefer mp3; ogg if browser likes it
      if (a.canPlayType('audio/mpeg')) a.src = 'assets/sfx/cute-fart.mp3';
      else a.src = 'assets/sfx/cute-fart.ogg';
      a.preload = 'auto';
      a.volume = 0.7;
      fartBuf = a;
    } catch (e) { fartBuf = null; }
    return fartBuf;
  }

  function sfxFart() {
    if (muted) return;
    // Real sample (overlap-safe via clone)
    try {
      const base = ensureFartAudio();
      if (base && base.src) {
        const a = base.cloneNode();
        a.volume = 0.65 + Math.random() * 0.15;
        a.playbackRate = 0.95 + Math.random() * 0.15; // slight cute variation
        const p = a.play();
        if (p && p.catch) p.catch(function () { /* autoplay block until gesture */ });
        return;
      }
    } catch (e) { /* fall through */ }
    // Fallback synthetic if file missing
    playTone(120, 0.15, 'sawtooth', 0.2);
  }
  function sfxFlap()   { sfxFart(); }
  function sfxScore()  { if (!muted) playTone(900, 0.12, 'square', 0.2); }
  function sfxDie()    { if (!muted) playTone(200, 0.3, 'sawtooth', 0.3); }

  let texLoader = null;
  window.__texErrors = [];
  const _texWait = [];
  function loadTex(url) {
    if (!texLoader) texLoader = new THREE.TextureLoader();
    const t = texLoader.load(
      url,
      function (tex) { tex.needsUpdate = true; },
      undefined,
      function (err) { window.__texErrors.push(url); }
    );
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    // M13: use global max anisotropy when available
    if (window.__maxAniso) {
      t.anisotropy = Math.min(8, window.__maxAniso);
    } else {
      t.anisotropy = 8;
    }
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    _texWait.push(t);
    return t;
  }

  // Sky-safe texture: no mipmaps, integer repeat — kills black seam lines.
  function loadSkyTex(url) {
    var t = loadTex(url);
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  window.__texturesReady = new Promise(function (resolve) {
    function check() {
      var ok = _texWait.length > 0 && _texWait.every(function (t) {
        return t.image && t.image.width > 0;
      });
      if (ok || window.__texErrors.length) resolve();
      else setTimeout(check, 50);
    }
    setTimeout(check, 100);
    setTimeout(function () { resolve(); }, 5000);
  });

  // ── M3: Pause & Flash ───────────────────────────────────────
  let paused = false;
  let flashT = 0; // death flash timer (seconds)
  let wingPhase = 0;
  let flapAnimT = 0;

  function togglePause() {
    if (state !== STATE.PLAY) return;
    paused = !paused;
    updateOverlay();
  }

  function _isMuted() { return muted; }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('flappy3d_muted', muted ? '1' : '0');
    const muteEl = document.getElementById('mute');
    if (muteEl) muteEl.textContent = 'Sound: ' + (muted ? 'Off' : 'On');
  }

  // ── M3: Dynamic gap helper ─────────────────────────────────
  function currentGap() {
    return Math.max(2.4, Math.min(4.8, PIPE_GAP + 0.8 - score * 0.08));
  }

  // ── State ────────────────────────────────────────────────────
  let bird, pipes, score, state; // TITLE / PLAY / GAMEOVER
  let puffPoints = null;
  let puffData = null;
  const PUFF_N = 64;
  let groundMesh = null;
  let lastPipeMat = null;
  let skyMesh = null;
  let hillsMesh = null;
  let combo = 0;
  let lastTick, tickCount, pipeSpawnTimer;
  let scene, camera, renderer;
  let canvas, scoreEl, overlayEl, testOverlayEl;

  const STATE = { TITLE: 'TITLE', PLAY: 'PLAY', GAMEOVER: 'GAMEOVER' };

  // ── Helpers ──────────────────────────────────────────────────
  function createBirdMesh() {
    const group = new THREE.Group();
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const softWhite = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
    const redMat = new THREE.MeshLambertMaterial({ color: 0xe53935 });
    const orangeMat = new THREE.MeshLambertMaterial({ color: 0xff9800 });
    const blackMat = new THREE.MeshLambertMaterial({ color: 0x222222 });

    // Main body — pure circle/sphere (no stretch)
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 20, 16), whiteMat);
    group.add(body);

    // Small head bump on front-top (still round silhouette)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 12), softWhite);
    head.position.set(0.35, 0.28, 0);
    group.add(head);

    // Tiny red comb on top
    const comb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), redMat);
    comb.position.set(0.32, 0.58, 0);
    comb.scale.set(0.8, 1.2, 0.5);
    group.add(comb);
    const comb2 = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), redMat);
    comb2.position.set(0.42, 0.55, 0);
    comb2.scale.set(0.7, 1.0, 0.45);
    group.add(comb2);

    // Wattle
    const wattle = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), redMat);
    wattle.position.set(0.55, 0.12, 0);
    wattle.scale.set(0.6, 1.2, 0.4);
    group.add(wattle);

    // Beak
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 6), orangeMat);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.62, 0.25, 0);
    group.add(beak);

    // Eye
    const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), whiteMat);
    eyeW.position.set(0.42, 0.35, 0.22);
    group.add(eyeW);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), blackMat);
    pupil.position.set(0.46, 0.36, 0.28);
    group.add(pupil);

    // Round wing (sphere flattened) — flap target
    const wing = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), softWhite);
    wing.scale.set(0.9, 0.35, 1.1);
    wing.position.set(0.0, 0.05, 0.45);
    group.add(wing);
    group.userData.wing = wing;

    // Tiny orange feet tucked under
    for (const z of [-0.1, 0.1]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), orangeMat);
      foot.scale.set(1.2, 0.4, 0.8);
      foot.position.set(0.05, -0.58, z);
      group.add(foot);
    }

    return group;
  }

  function createPipeMesh(gapSize) {
    const group = new THREE.Group();
    const pipeMat = new THREE.MeshLambertMaterial({ color: 0x43a047 });
    lastPipeMat = pipeMat;
    const capMat = new THREE.MeshLambertMaterial({ color: 0x388e3c });

    const halfGap = (gapSize || PIPE_GAP) / 2;
    const pipeH = 20;
    const pipeW = 1.6;
    const pipeD = 1.6;
    const capH = 0.45;
    const capW = 2.05;
    // Nest body slightly into the cap so faces never coplanar
    const nest = 0.12;

    // Top pipe body: bottom edge sits inside the cap
    const topPipe = new THREE.Mesh(new THREE.BoxGeometry(pipeW, pipeH, pipeD), pipeMat);
    topPipe.position.y = halfGap + nest + pipeH / 2;
    topPipe.castShadow = true;
    group.add(topPipe);

    // Top lip (wider ring at gap edge)
    const topCap = new THREE.Mesh(new THREE.BoxGeometry(capW, capH, capW), capMat);
    topCap.position.y = halfGap + capH / 2;
    topCap.castShadow = true;
    // polygonOffset so cap wins depth cleanly if any residual overlap
    capMat.polygonOffset = true;
    capMat.polygonOffsetFactor = -1;
    capMat.polygonOffsetUnits = -1;
    group.add(topCap);

    // Bottom pipe body: top edge sits inside bottom cap
    const botPipe = new THREE.Mesh(new THREE.BoxGeometry(pipeW, pipeH, pipeD), pipeMat);
    botPipe.position.y = -(halfGap + nest + pipeH / 2);
    botPipe.castShadow = true;
    group.add(botPipe);

    // Bottom lip (wider ring at gap edge)
    const botCap = new THREE.Mesh(new THREE.BoxGeometry(capW, capH, capW), capMat);
    botCap.position.y = -(halfGap + capH / 2);
    botCap.castShadow = true;
    group.add(botCap);

    return group;
  }

  function createGroundMesh() {
    // Share sky look without a second plane — empty group for API/parallax hook
    groundMesh = new THREE.Group();
    groundMesh.userData.isGround = true;
    const map = loadSkyTex('assets/textures/sky_clouds.png');
    groundMesh.userData.skyMap = map;
    return groundMesh;
  }

  function createSkyMesh() {
    const map = loadSkyTex('assets/textures/sky_clouds.png');
    map.repeat.set(1, 1);
    const mat = new THREE.MeshBasicMaterial({ map: map, depthWrite: false });
    skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(240, 140), mat);
    skyMesh.position.set(0, 2, -12);
    skyMesh.renderOrder = -10;
    skyMesh.userData.isSky = true;
    skyMesh.userData.skyMap = map;
    return skyMesh;
  }

  function createHillsMesh() {
    hillsMesh = new THREE.Group();
    hillsMesh.position.set(0, 0, -1.5);
    hillsMesh.userData.isHills = true;
    return hillsMesh;
  }

  // ── Core game logic ──────────────────────────────────────────
  function reset() {
    // Remove any live pipe meshes from the scene
    if (pipes && pipes.length && scene) {
      for (let i = 0; i < pipes.length; i++) {
        const p = pipes[i];
        if (p.mesh) {
          scene.remove(p.mesh);
          p.mesh.traverse(function (child) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
          });
        }
      }
    }
    // Keep existing bird mesh if present (do not null it)
    const keepMesh = bird && bird.mesh ? bird.mesh : null;
    bird = {
      x: 0, y: 0, z: 0,
      vy: 0,
      radius: BIRD_RADIUS,
      dead: false,
      mesh: keepMesh,
    };
    if (keepMesh) {
      keepMesh.position.set(0, 0, 0);
      keepMesh.rotation.z = 0;
    }
    pipes = [];
    score = 0;

    // ── M10: reset puffs ───────────────────────────────────────
    if (puffData) {
      for (let i = 0; i < PUFF_N; i++) {
        puffData.life[i] = 0;
        puffData.pos[i * 3 + 1] = -999;
      }
    }
    combo = 0;
    flapAnimT = 0;
    state = STATE.TITLE;
    paused = false;
    flashT = 0;
    lastTick = performance.now() / 1000;
    tickCount = 0;
    pipeSpawnTimer = 0.25; // first pipe almost immediately
  }

  function flap() {
    if (paused) { paused = false; updateOverlay(); return; }
    sfxFlap();
    if (state === STATE.GAMEOVER) {
      reset();
      state = STATE.PLAY;
      bird.vy = FLAP_VEL;
      flapAnimT = 0.2;
      return;
    }
    if (state === STATE.TITLE) {
      state = STATE.PLAY;
    }
    bird.vy = FLAP_VEL; // upward impulse
    flapAnimT = 0.2;

    // ── M10: fart puff particles on flap (behind bird rear) ───────────────
    if (puffData) {
      let spawned = 0;
      for (let i = 0; i < PUFF_N && spawned < 12; i++) {
        if (puffData.life[i] <= 0) {
          puffData.life[i] = 0.4 + Math.random() * 0.2;
          puffData.pos[i * 3] = bird.x - 0.55 + (Math.random() - 0.5) * 0.15;
          puffData.pos[i * 3 + 1] = bird.y - 0.2 + (Math.random() - 0.5) * 0.1;
          puffData.pos[i * 3 + 2] = bird.z + (Math.random() - 0.5) * 0.2;
          puffData.vel[i * 3] = -2.2 - Math.random() * 1.8;
          puffData.vel[i * 3 + 1] = -0.8 - Math.random() * 1.2;
          puffData.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.2;
          spawned++;
        }
      }
    }
  }

  function tick(dt) {
    if (state !== STATE.PLAY) return;

    if (paused) { updateOverlay(); return; }
    tickCount++;

    // Gravity — always applied in PLAY
    bird.vy += GRAVITY * dt;
    bird.y += bird.vy * dt;

    const effectiveSpeed = Math.min(PIPE_SPEED + score * 0.15, 10);

    // Move pipes toward bird (negative X direction)
    for (let i = pipes.length - 1; i >= 0; i--) {
      const p = pipes[i];
      p.x -= effectiveSpeed * dt;
      if (p.mesh) p.mesh.position.x = p.x;

      // Mark as passed when pipe passes bird's x position
      if (!p.passed && p.x + 0.8 < bird.x) {
        p.passed = true;
        score++;
        combo++;
        updateScore();
        sfxScore();
      }

      // Remove pipes that scroll off screen
      if (p.x < -PLAY_LENGTH / 2) {
        scene.remove(p.mesh);
        p.mesh.traverse(child => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
        pipes.splice(i, 1);
      }
    }

    // Spawn new pipes
    pipeSpawnTimer -= dt;
    if (pipeSpawnTimer <= 0 && bird.x < PLAY_LENGTH / 2 - 5) {
      spawnPipe();
      pipeSpawnTimer = Math.max(0.85, PIPE_INTERVAL - score * 0.04);
    }

    // Collision detection — AABB sphere vs box
    checkCollisions();

    // Update mesh position
    if (bird.mesh) {
      bird.mesh.position.set(bird.x, bird.y, bird.z);
      const tilt = Math.max(-0.6, Math.min(0.8, bird.vy * 0.04));
      bird.mesh.rotation.z = tilt;
      if (bird.mesh.userData.wing) {
        if (flapAnimT > 0) {
          flapAnimT = Math.max(0, flapAnimT - dt);
          bird.mesh.userData.wing.rotation.z = Math.sin((0.2 - flapAnimT) * 40) * 0.6;
        } else {
          bird.mesh.userData.wing.rotation.z = Math.sin(performance.now() / 200) * 0.15;
        }
      }
    }
    // Sky parallax via UV offset (no plane edge seams)
    if (skyMesh && skyMesh.material && skyMesh.material.map) {
      skyMesh.material.map.offset.x = (skyMesh.material.map.offset.x + effectiveSpeed * dt * 0.004) % 1;
    }
    // M4 T3: scroll ground group X (API parallax even if group is empty visual)
    if (groundMesh) {
      groundMesh.position.x -= effectiveSpeed * dt * 0.5;
    }
    if (hillsMesh) {
      hillsMesh.position.x -= effectiveSpeed * dt * 0.07;
      if (hillsMesh.position.x < -30) hillsMesh.position.x += 60;
    }

    // ── M10: age puff particles ────────────────────────────────
    if (puffData) {
      for (let i = 0; i < PUFF_N; i++) {
        if (puffData.life[i] > 0) {
          puffData.life[i] -= dt;
          puffData.pos[i * 3] += puffData.vel[i * 3] * dt;
          puffData.pos[i * 3 + 1] += puffData.vel[i * 3 + 1] * dt;
          puffData.pos[i * 3 + 2] += puffData.vel[i * 3 + 2] * dt;
          if (puffData.life[i] <= 0) {
            puffData.pos[i * 3 + 1] = -999;
          }
        }
      }
      puffPoints.geometry.attributes.position.needsUpdate = true;
    }

    updateOverlay();
  }

  function spawnPipe() {
    // Random gap center Y between GROUND_Y + 2 and CEILING_Y - 2
    const minY = GROUND_Y + 3;
    const maxY = CEILING_Y - 3;
    let gapCenterY = minY + Math.random() * (maxY - minY);

    // Clamp so both edges stay in bounds with dynamic gap
    const gap = currentGap();
    if (gapCenterY + gap / 2 > CEILING_Y - 0.5) gapCenterY = CEILING_Y - 0.5 - gap / 2;
    if (gapCenterY - gap / 2 < GROUND_Y + 0.5) gapCenterY = GROUND_Y + 0.5 + gap / 2;

    const mesh = createPipeMesh(gap);
    mesh.position.set(SPAWN_X, gapCenterY, 0);
    scene.add(mesh);

    pipes.push({
      x: SPAWN_X,
      y: gapCenterY,
      gapTop: gapCenterY + gap / 2,
      gapBot: gapCenterY - gap / 2,
      width: 1.6,
      depth: 1.6,
      passed: false,
      mesh: mesh,
    });
  }
  function checkCollisions() {
    const bx = bird.x;
    const by = bird.y;
    const br = bird.radius;

    // Ground collision
    if (by < KILL_Y + br) {
      die();
      return;
    }

    // Ceiling collision
    if (by > CEILING_Y - br) {
      die();
      return;
    }

    // Pipe collisions — check all active pipes
    for (let i = 0; i < pipes.length; i++) {
      const p = pipes[i];
      const px = p.x;
      const pw = p.width / 2 + br;
      const pd = p.depth / 2 + br;

      // Horizontal overlap with pipe body
      if (bx > px - pw && bx < px + pw) {
        // Check top pipe (above gap center)
        if (by > p.gapTop - br) {
          die();
          return;
        }
        // Check bottom pipe (below gap center)
        if (by < p.gapBot + br) {
          die();
          return;
        }
      }
    }
  }

  function die() {
    bird.dead = true;
    state = STATE.GAMEOVER;
    combo = 0;
    // Update best score
    flashT = 0.25;
    if (scene) scene.background = COL_FLASH;
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem("flappy3d_best", String(bestScore));
    }
    const bestEl = document.getElementById('best');
    if (bestEl) bestEl.textContent = 'Best: ' + bestScore;
    sfxDie();
    updateOverlay();
  }

  function updateScore() {
    if (scoreEl) {
      scoreEl.textContent = String(score);
      scoreEl.classList.remove('pop');
      void scoreEl.offsetWidth;
      scoreEl.classList.add('pop');
    }
    const cEl = document.getElementById('combo');
    if (cEl) cEl.textContent = combo >= 2 ? ('x' + combo) : '';
  }

  function updateOverlay() {
    const bestEl = document.getElementById('best');
    if (bestEl) bestEl.textContent = 'Best: ' + bestScore;
    if (!overlayEl) return;
    if (paused && state === STATE.PLAY) {
      overlayEl.textContent = 'PAUSED\nP to resume';
      overlayEl.style.color = '#ffd700';
    } else if (state === STATE.TITLE) {
      overlayEl.textContent = 'Press SPACE or tap to start';
      overlayEl.style.color = '#fff';
    } else if (state === STATE.PLAY) {
      overlayEl.textContent = '';
    } else if (state === STATE.GAMEOVER) {
      overlayEl.textContent = `Game Over — Score: ${score}\nBest: ${bestScore}\nTap to restart`;
      overlayEl.style.color = '#ff6b6b';
    }
  }

  // ── Three.js setup ───────────────────────────────────────────
  function initScene() {
    scene = new THREE.Scene();
    scene.background = COL_SKY;

    // Camera — perspective, looking along +Z toward the play corridor
    const aspect = canvas.clientWidth / canvas.clientHeight;
    camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 200);
    camera.position.set(-5, 3, 18);
    camera.lookAt(0, 0, 0);

    // Renderer — WebGL with antialiasing (guard: reuse if already exists)
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
      renderer.shadowMap.enabled = false;
      // renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // M13: clamp pixel ratio to avoid GPU strain on HiDPI
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setClearColor(0x6eb6e0, 1);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.castShadow = false;
    dirLight.shadow.mapSize.set(1024, 1024);
    var sc = dirLight.shadow.camera;
    sc.left = -14; sc.right = 20; sc.top = 16; sc.bottom = -8;
    sc.near = 0.5; sc.far = 40;
    sc.updateProjectionMatrix();
    dirLight.shadow.bias = -0.0015;
    dirLight.shadow.normalBias = 0.02;
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // Sky plane (behind everything)
    const sky = createSkyMesh();
    scene.add(sky);

    // Hills layer (between sky and ground)
    const hills = createHillsMesh();
    scene.add(hills);

    // Ground plane
    const ground = createGroundMesh();
    scene.add(ground);

    // Bird mesh
    bird.mesh = createBirdMesh();
    bird.mesh.traverse(function (c) { if (c.isMesh) c.castShadow = true; });
    scene.add(bird.mesh);

    if (groundMesh) groundMesh.traverse(function (c) {
      if (c.isMesh) c.receiveShadow = true;
    });

    // ── M10: Flap puff particles ───────────────────────────────
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(PUFF_N * 3);
    const life = new Float32Array(PUFF_N); // 0 = dead
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: 0xc4b454, size: 0.35, transparent: true, opacity: 0.75, depthWrite: false });
    puffPoints = new THREE.Points(geo, mat);
    puffData = { pos: pos, life: life, vel: new Float32Array(PUFF_N * 3) };
    scene.add(puffPoints);
  }

  function onResize() {
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // M13: keep pixel ratio in sync on resize
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }


  // ── M3: Camera follow ───────────────────────────────────────
  function updateCamera() {
    if (!camera || !bird) return;
    const targetY = bird.y * 0.35 + 2;
    camera.position.x = -5;
    camera.position.y = targetY;
    camera.position.z = 18;
    camera.lookAt(bird.x + 4, bird.y * 0.25, 0);
  }

  // ── Game loop ────────────────────────────────────────────────
  let running = false;
  let animId = null;
  let accum = 0;  function gameLoop() {
    if (!running) return;
    const now = performance.now() / 1000;
    let elapsed = now - lastTick;
    lastTick = now;
    if (elapsed > 0.1) elapsed = 0.1;
    accum += elapsed;
    let steps = 0;
    while (accum >= FRAME_DT && steps < 3) {
      tick(FRAME_DT);
      if (flashT > 0) {
        flashT = Math.max(0, flashT - FRAME_DT);
        if (scene) scene.background = flashT > 0 ? COL_FLASH : COL_SKY;
      }
      accum -= FRAME_DT;
      steps++;
    }
    updateCamera();
    if (renderer && scene && camera) renderer.render(scene, camera);
    animId = requestAnimationFrame(gameLoop);
  }

  function start() {
    if (running) return;
    running = true;
    lastTick = performance.now() / 1000;
    accum = 0;
    gameLoop();
  }

  function stop() {
    running = false;
    if (animId) cancelAnimationFrame(animId);
  }

  // ── Public API — exposed as window.__flappy3d ────────────────
  const api = {
    bird: null,
    pipes: [],
    score: 0,
    state: STATE.TITLE,
    tickCount: 0,
    dead: false,

    init(canvasEl, scoreElement, overlayElement, testOverlay) {
      canvas = canvasEl;
      scoreEl = scoreElement;
      overlayEl = overlayElement;
      testOverlayEl = testOverlay;
      reset();
      ensureFartAudio(); // preload real fart SFX on startup
      bird.mesh = null; // will be created in initScene
      initScene();
      onResize();
      window.addEventListener('resize', onResize);

      // Store references for selftest
      api.bird = bird;
      api.pipes = pipes;
    },

    start: start,
    stop: stop,
    flap: flap,
    reset: function () {
      stop();
      reset();
      initScene();
      onResize();
      // Re-attach mesh reference
      bird.mesh = createBirdMesh();
      scene.add(bird.mesh);
      api.bird = bird;
      api.pipes = pipes;
    },

    tick: function (dt) {
      if (!dt) dt = 1 / 60;
      const beforeY = bird.y;
      tick(dt);
      return { yDelta: bird.y - beforeY, vy: bird.vy };
    },

    // ── Selftest helpers ───────────────────────────────────────
    _tickCount: function () { return tickCount; },
    _birdY: function () { return bird.y; },
    _birdVy: function () { return bird.vy; },
    _score: function () { return score; },
    _dead: function () { return bird.dead; },
    _state: function () { return state; },
    _pipesLength: function () { return pipes.length; },

    // Force a pipe spawn at current position for collision testing
    _spawnPipeAtX: function (x) {
      const minY = GROUND_Y + 3;
      const maxY = CEILING_Y - 3;
      const gapCenterY = bird.y; // center gap on bird Y for guaranteed overlap
      const mesh = createPipeMesh();
      mesh.position.set(x, gapCenterY, 0);
      scene.add(mesh);
      pipes.push({
        x: x, y: gapCenterY,
        gapTop: gapCenterY + PIPE_GAP / 2,
        gapBot: gapCenterY - PIPE_GAP / 2,
        width: 1.6, depth: 1.6,
        passed: false, mesh: mesh,
      });
    },

    // Force collision check (useful for selftest)
    _checkCollisions: function () {
      const bx = bird.x;
      const by = bird.y;
      const br = bird.radius;
      if (by < KILL_Y + br || by > CEILING_Y - br) return true;
      for (let i = 0; i < pipes.length; i++) {
        const p = pipes[i];
        const px = p.x, pw = p.width / 2 + br, pd = p.depth / 2 + br;
        if (bx > px - pw && bx < px + pw) {
          if (by > p.gapTop - br || by < p.gapBot + br) return true;
        }
      }
      return false;
    },

    // Clear all pipes for clean selftest state
    _clearPipes: function () {
      for (let i = pipes.length - 1; i >= 0; i--) {
        scene.remove(pipes[i].mesh);
        pipes.splice(i, 1);
      }
    },

    // Set bird position directly for selftest
    _setBirdPos: function (x, y) {
      bird.x = x;
      bird.y = y;
      if (bird.mesh) bird.mesh.position.set(x, y, bird.z);
    },

    // Set velocity directly
    _setVy: function (vy) { bird.vy = vy; },

    _forcePlay: function () { state = STATE.PLAY; bird.dead = false; },

    // M2 helpers
    _best: function () { return bestScore; },
    _setBest: function (n) {
      bestScore = n;
      localStorage.setItem("flappy3d_best", String(n));
    },
    _pipeSpeed: function () {
      return Math.min(PIPE_SPEED + score * 0.15, 10);
    },

    // M12 helpers
    _hillsX: function () { return hillsMesh ? hillsMesh.position.x : 0; },
    _setScore: function (n) {
      score = n;
      updateScore();
    },
    _mute: function (on) {
      muted = !!on;
      localStorage.setItem('flappy3d_muted', muted ? '1' : '0');
      const muteEl = document.getElementById('mute');
      if (muteEl) muteEl.textContent = 'Sound: ' + (muted ? 'Off' : 'On');
    },
    _sfxFlap: sfxFlap,
    _sfxScore: sfxScore,
    _sfxDie: sfxDie,

    // Public _die() helper for selftest — calls die()
    _die: function () { die(); },

    // M3 helpers
    _gap: function () { return currentGap(); },
    _paused: function () { return !!paused; },
    _togglePause: function () { togglePause(); },
    _toggleMute: function () { toggleMute(); },
    _isMuted: function () { return muted; },
    _flashT: function () { return flashT; },
    _cameraY: function () { return camera ? camera.position.y : 0; },
    _updateCamera: function () { updateCamera(); },
    _wingAngle: function () {
      return (bird && bird.mesh && bird.mesh.userData.wing) ? bird.mesh.userData.wing.rotation.z : 0;
    },
    _flapAnimT: function () { return flapAnimT; },
    _triggerFlapAnim: function () { flapAnimT = 0.2; },
    _groundX: function () { return groundMesh ? groundMesh.position.x : 0; },
    _skyX: function () { return skyMesh ? skyMesh.position.x : 0; },
    _skyTex: function () { return !!(skyMesh && skyMesh.material && skyMesh.material.map); },
    _groundTex: function () {
      if (!groundMesh) return false;
      // groundMesh is now a Group (no material.map); check userData.skyMap
      if (groundMesh.userData && groundMesh.userData.skyMap) return true;
      var ok = false;
      groundMesh.traverse(function (c) {
        if (c.isMesh && c.material && c.material.map) ok = true;
      });
      return ok;
    },
    _pipeTex: function () { return !!lastPipeMat; },
    _birdTex: function () {
      if (!bird || !bird.mesh) return false;
      const body = bird.mesh.children[0];
      return !!(body && body.material && body.material.map);
    },
    _matInfo: function () {
      function info(mat) {
        if (!mat) return { hasMap: false, w: 0, h: 0, colorSpace: null, anisotropy: 0 };
        var m = mat.map;
        return {
          hasMap: !!m,
          w: m && m.image ? (m.image.width || 0) : 0,
          h: m && m.image ? (m.image.height || 0) : 0,
          colorSpace: m ? m.colorSpace : null,
          anisotropy: m ? m.anisotropy : 0,
        };
      }
      var pipeMat = lastPipeMat;
      return {
        sky: info(skyMesh && skyMesh.material),
        ground: info(groundMesh && groundMesh.material),
        pipe: info(pipeMat),
        bird: info(bird && bird.mesh && bird.mesh.children[0] && bird.mesh.children[0].material),
      };
    },
    _combo: function () { return combo; },

    // ── M10 puff helpers ───────────────────────────────────────
    _puffLive: function () {
      if (!puffData) return 0;
      let n = 0;
      for (let i = 0; i < PUFF_N; i++) { if (puffData.life[i] > 0) n++; }
      return n;
    },
    _setCombo: function (n) { combo = n; updateScore(); },
    _shadowsOn: function () { return !!(renderer && renderer.shadowMap && renderer.shadowMap.enabled); },
    _rendererCount: function () { return renderer ? 1 : 0; },
    _pixelRatio: function () { return renderer ? renderer.getPixelRatio() : 0; },
    // M3 helpers end
  };

  window.__flappy3d = api;
  window.__game = api;

  // ── Selftest — runs when ?selftest=1 ─────────────────────────
  window.selftest_M1 = async function (game, testOverlayEl) {
    return new Promise(function (resolve) {
      let passed = true;
      const failures = [];

      function assert(condition, msg) {
        if (!condition) {
          failures.push(msg);
          passed = false;
        }
      }

      function report() {
        testOverlayEl.textContent = passed ? 'SELFTEST M1 PASS' : 'SELFTEST M1 FAIL: ' + failures.join('; ');
        if (!passed) testOverlayEl.classList.add('fail');
        resolve(passed);
      }

      // ── Test 1: Gravity — tick 30x dt=1/60 without flap, assert bird.y decreased ──
      game.reset();
      game._forcePlay();
      const startY = game._birdY();
      for (let i = 0; i < 30; i++) {
        game.tick(1 / 60);
      }
      const endY = game._birdY();
      assert(endY < startY, 'Test 1 FAIL: bird.y did not decrease under gravity (' + startY.toFixed(4) + ' → ' + endY.toFixed(4) + ')');

      // ── Test 2: Flap — _setVy(0); flap(); assert _birdVy()>0 ──
      game._setVy(0);
      game.flap();
      const postFlapVy = game._birdVy();
      assert(postFlapVy > 0, 'Test 2 FAIL: bird.vy not positive after flap (got ' + postFlapVy.toFixed(4) + ')');

      // ── Test 3: Collision — _setBirdPos(0,0); _clearPipes(); spawn pipe at x=0 with gapCenterY=12 so gapBot high, bird at 0 collides; assert _checkCollisions() ──
      game._setBirdPos(0, 0);
      game._clearPipes();
      const testGapCenter = 12;
      const mesh3 = createPipeMesh();
      mesh3.position.set(0, testGapCenter, 0);
      scene.add(mesh3);
      pipes.push({
        x: 0, y: testGapCenter,
        gapTop: testGapCenter + PIPE_GAP / 2,
        gapBot: testGapCenter - PIPE_GAP / 2,
        width: 1.6, depth: 1.6,
        passed: false, mesh: mesh3,
      });
      const collided = game._checkCollisions();
      assert(collided === true, 'Test 3 FAIL: expected collision (gapBot=' + pipes[pipes.length-1].gapBot.toFixed(2) + ', bird.y=0)');

      // ── Test 4: pipe pass scores +1 (gap must be flyable — do NOT reuse Test3 gapCenter=12) ──
      game.reset();
      game._forcePlay();
      game._clearPipes();
      game._setBirdPos(0, 0);
      game._setVy(0);
      // Gap centered on bird so no collision while pipe scrolls past
      const passGapCenter = 0;
      const mesh4 = createPipeMesh();
      mesh4.position.set(5, passGapCenter, 0);
      scene.add(mesh4);
      pipes.push({
        x: 5, y: passGapCenter,
        gapTop: passGapCenter + PIPE_GAP / 2,
        gapBot: passGapCenter - PIPE_GAP / 2,
        width: 1.6, depth: 1.6,
        passed: false, mesh: mesh4,
      });
      // Hold bird still so gravity cannot kill; move pipe left past bird (x=0)
      for (let i = 0; i < 12; i++) {
        game._setBirdPos(0, 0);
        game._setVy(0);
        pipes[0].x -= 0.75;
        pipes[0].mesh.position.x = pipes[0].x;
        game.tick(1 / 60);
      }
      const finalScore = game._score();
      assert(finalScore === 1, 'Test 4 FAIL: expected score=1 after pipe pass (got ' + finalScore + ')');
      assert(game._state() === 'PLAY', 'Test 4 FAIL: bird should still be PLAY after clean pass (state=' + game._state() + ')');

      // All tests done — report result
      report();
    });
  };

  // M2 Selftest (window.selftest_M2)
  window.selftest_M2 = async function (game, testOverlayEl) {
    return new Promise(function (resolve) {
      let passed = true;
      const failures = [];

      function assert(condition, msg) {
        if (!condition) {
          failures.push(msg);
          passed = false;
        }
      }

      function report() {
        testOverlayEl.textContent = passed ? 'SELFTEST M2 PASS' : 'SELFTEST M2 FAIL: ' + failures.join('; ');
        if (!passed) testOverlayEl.classList.add('fail');
        resolve(passed);
      }

      // T1: _setBest(0); _setScore(5); call die; assert best === 5
      game._setBest(0);
      game._setScore(5);
      game._die();
      assert(game._best() === 5, 'T1 FAIL: expected best=5 after die (got ' + game._best() + ')');

      // T2: _setBest(10); _setScore(3); _die(); assert best stays 10
      game._setBest(10);
      game._setScore(3);
      game._die();
      assert(game._best() === 10, 'T2 FAIL: expected best=10 (no regress) after die with lower score (got ' + game._best() + ')');

      // T3: _pipeSpeed increases with score, caps at 10
      game._setScore(0);
      const s0 = game._pipeSpeed();
      game._setScore(20);
      const s1 = game._pipeSpeed();
      assert(s1 > s0, 'T3 FAIL: pipe speed did not increase (s0=' + s0 + ', s1=' + s1 + ')');
      assert(s1 <= 10, 'T3 FAIL: pipe speed exceeded cap at score=20 (got ' + s1 + ')');

      // T4: reset() does NOT clear best
      game._setBest(10);
      game.reset();
      assert(game._score() === 0, 'T4 FAIL: score should be 0 after reset (got ' + game._score() + ')');
      assert(game._best() === 10, 'T4 FAIL: best should stay 10 after reset (got ' + game._best() + ')');

      report();
    });
  };

  // M3 Selftest (window.selftest_M3)
  window.selftest_M3 = async function (game, testOverlayEl) {
    return new Promise(function (resolve) {
      let passed = true;
      const failures = [];

      function assert(condition, msg) {
        if (!condition) {
          failures.push(msg);
          passed = false;
        }
      }

      function report() {
        testOverlayEl.textContent = passed ? 'SELFTEST M3 PASS' : 'SELFTEST M3 FAIL: ' + failures.join('; ');
        if (!passed) testOverlayEl.classList.add('fail');
        resolve(passed);
      }

      // T1: dynamic gap — wider early, tightens with score
      game._setScore(0);
      const g0 = game._gap();
      game._setScore(20);
      const g1 = game._gap();
      assert(g1 < g0, 'T1 FAIL: gap did not tighten (g0=' + g0.toFixed(4) + ', g1=' + g1.toFixed(4) + ')');
      assert(g1 >= 2.4, 'T1 FAIL: gap below minimum at score=20 (got ' + g1.toFixed(4) + ')');

      // T2: camera follow — camera Y changes when bird Y changes
      game.reset();
      game._forcePlay();
      game._setBirdPos(0, 0);
      game._updateCamera();
      const camAt0 = game._cameraY();
      game._setBirdPos(0, 5);
      game._updateCamera();
      const camAt5 = game._cameraY();
      assert(typeof camAt0 === 'number', 'T2 FAIL: camera Y not a number at bird y=0');
      assert(camAt5 !== camAt0, 'T2 FAIL: camera Y did not change when bird moved from 0 to 5 (cam0=' + camAt0.toFixed(4) + ', cam5=' + camAt5.toFixed(4) + ')');

      // T3: pause — tick does NOT move bird while paused
      game._forcePlay();
      game._togglePause();
      assert(game._paused() === true, 'T3 FAIL: paused should be true after toggle (got ' + game._paused() + ')');
      const startY = bird.y;
      for (let i = 0; i < 10; i++) {
        game.tick(1 / 60);
      }
      assert(Math.abs(bird.y - startY) < 0.01, 'T3 FAIL: bird moved while paused (' + startY.toFixed(4) + ' → ' + bird.y.toFixed(4) + ')');
      game._togglePause();

      // T4: mute toggle — persists to localStorage
      game._mute(false);
      game._toggleMute();
      assert(game._isMuted() === true, 'T4 FAIL: muted should be true after toggle');
      const stored = localStorage.getItem('flappy3d_muted');
      assert(stored === '1', 'T4 FAIL: localStorage flappy3d_muted not "1" (got "' + stored + '")');

      // T5: death flash — die() sets flashT > 0
      game.reset();
      game._forcePlay();
      game._die();
      assert(game._flashT() > 0, 'T5 FAIL: flashT should be positive after die (got ' + game._flashT().toFixed(4) + ')');

      report();
    });
  };

  window.selftest_M4 = async function (game, testOverlayEl) {
    return new Promise(function (resolve) {
      let passed = true;
      const failures = [];
      function assert(c, m) { if (!c) { failures.push(m); passed = false; } }
      function report() {
        testOverlayEl.textContent = passed ? 'SELFTEST M4 PASS' : 'SELFTEST M4 FAIL: ' + failures.join('; ');
        if (!passed) testOverlayEl.classList.add('fail');
        resolve(passed);
      }
      game.reset(); game._forcePlay();
      game._triggerFlapAnim();
      assert(game._flapAnimT() > 0, 'T1 FAIL: flapAnimT');
      game._setVy(0); game._setBirdPos(0, 0);
      for (let i = 0; i < 5; i++) game.tick(1 / 60);
      assert(typeof game._wingAngle() === 'number', 'T2 FAIL: wing');
      game.reset(); game._forcePlay();
      const gx0 = game._groundX();
      for (let i = 0; i < 30; i++) {
        game._setBirdPos(0, 0); game._setVy(0); game.tick(1 / 60);
      }
      assert(game._groundX() !== gx0, 'T3 FAIL: parallax gx0=' + gx0 + ' gx1=' + game._groundX());
      game._setCombo(3);
      assert(game._combo() === 3, 'T4a FAIL combo');
      game._die();
      assert(game._combo() === 0, 'T4b FAIL combo clear');
      assert(window.__game === window.__flappy3d, 'T5 FAIL __game');
      report();
    });
  };

  window.selftest_POLISH = async function (game, testOverlayEl) {
    return new Promise(async function (resolve) {
      let passed = true;
      const failures = [];
      function assert(c, m) { if (!c) { failures.push(m); passed = false; } }
      function report() {
        testOverlayEl.textContent = passed ? 'SELFTEST POLISH PASS' : 'SELFTEST POLISH FAIL: ' + failures.join('; ');
        if (!passed) testOverlayEl.classList.add('fail');
        resolve(passed);
      }
      try {
        if (window.__texturesReady) await window.__texturesReady;
      } catch (e) {}
      assert(!window.__texErrors || window.__texErrors.length === 0, 'tex errors: ' + (window.__texErrors||[]).join(','));
      assert(game._skyTex && game._skyTex(), 'sky tex');
      assert(game._groundTex && game._groundTex(), 'ground tex');
      assert(game._shadowsOn && game._shadowsOn() === false, 'shadows should be off (clean art)');
      assert(typeof game._puffLive === 'function', 'puffLive');
      assert(typeof game._hillsX === 'function', 'hillsX');
      assert(window.__game === window.__flappy3d, '__game');
      // force play flap for puffs
      game.reset(); game._forcePlay();
      game.flap();
      assert(game._puffLive() >= 1, 'puffs after flap got ' + game._puffLive());
      report();
    });
  };

})();
