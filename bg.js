/* Three.js 動態背景：粒子星雲 + 漂浮幾何體 + 光暈；抽獎時加速、中獎時爆發 */
(function () {
  if (!window.THREE) return;
  const canvas = document.getElementById('bg');
  if (!canvas) return;
  const OVERLAY = document.body.classList.contains('overlay');
  const params = new URLSearchParams(location.search);
  if (OVERLAY && params.get('bg') === '0') return;
  let enabled = true;
  try { if (localStorage.getItem('lw.bg3d') === '0') enabled = false; } catch { /* ignore */ }
  canvas.style.display = enabled ? '' : 'none';
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 0); // 透明，覆蓋層可直接疊在 OBS 畫面上
  const scene = new THREE.Scene();
  if (!OVERLAY) scene.fog = new THREE.FogExp2(0x0d0d1a, 0.03);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 120);
  camera.position.set(0, 0, 20);
  const PAL = [0xffd166, 0xc77dff, 0xff6b6b, 0x4d96ff, 0xff8fab, 0x48cae4, 0xffb703];
  const state = { energy: 0 };
  const mouse = { x: 0, y: 0 };

  // 圓點貼圖（給粒子與光暈）
  function radialTexture(size, inner, outer) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, inner); grad.addColorStop(1, outer);
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; return tex;
  }
  const dot = radialTexture(64, 'rgba(255,255,255,1)', 'rgba(255,255,255,0)');

  // 粒子星雲
  const N = OVERLAY ? 1500 : 2200;
  const pos = new Float32Array(N * 3); const col = new Float32Array(N * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const r = 6 + Math.cbrt(Math.random()) * 30;
    const th = Math.random() * Math.PI * 2; const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.6;
    pos[i * 3 + 2] = r * Math.cos(ph) - 8;
    tmp.setHex(PAL[Math.floor(Math.random() * PAL.length)]).offsetHSL(0, 0, (Math.random() - 0.5) * 0.2);
    col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pMat = new THREE.PointsMaterial({ size: 0.26, vertexColors: true, map: dot, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const points = new THREE.Points(pGeo, pMat);
  scene.add(points);

  // 光暈球（營造色彩與景深）
  const orbs = [];
  [[0xc77dff, -12, 5, -14, 26], [0xffd166, 12, -4, -12, 22], [0x4d96ff, 4, 8, -18, 20], [0xff6b6b, -6, -9, -16, 18]].forEach(([c, x, y, z, s], i) => {
    const color = `#${c.toString(16).padStart(6, '0')}`;
    const tex = radialTexture(256, color, 'rgba(0,0,0,0)');
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    sp.position.set(x, y, z); sp.scale.set(s, s, 1);
    scene.add(sp);
    orbs.push({ sp, bx: x, by: y, speed: 0.12 + i * 0.04, phase: i * 1.7 });
  });

  // 漂浮幾何體
  const geos = [new THREE.IcosahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0), new THREE.TorusGeometry(1, 0.32, 8, 28), new THREE.TetrahedronGeometry(1, 0), new THREE.DodecahedronGeometry(1, 0)];
  const shapes = [];
  for (let i = 0; i < (OVERLAY ? 12 : 18); i++) {
    const geo = geos[i % geos.length];
    const color = PAL[i % PAL.length];
    const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.4 }));
    const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false }));
    const g = new THREE.Group(); g.add(wire); g.add(fill);
    const a = Math.random() * Math.PI * 2; const r = 7 + Math.random() * 12;
    g.position.set(Math.cos(a) * r, (Math.random() - 0.5) * 12, -2 - Math.random() * 14);
    const s = 0.5 + Math.random() * 1.6; g.scale.set(s, s, s);
    g.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    scene.add(g);
    shapes.push({ g, rx: (Math.random() - 0.5) * 0.5, ry: (Math.random() - 0.5) * 0.6, bob: 0.3 + Math.random() * 0.5, phase: Math.random() * 6, baseY: g.position.y });
  }

  window.addEventListener('pointermove', (e) => { mouse.x = (e.clientX / window.innerWidth) * 2 - 1; mouse.y = -((e.clientY / window.innerHeight) * 2 - 1); }, { passive: true });
  function resize() { renderer.setSize(window.innerWidth, window.innerHeight, false); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); }
  window.addEventListener('resize', resize); resize();

  const bursts = [];
  // 把畫面座標換成攝影機前方 z=8 平面上的世界座標，粒子從那裡往四面八方噴
  function burstAt(clientX, clientY, n = 90) {
    if (!enabled) return;
    const ndc = new THREE.Vector3((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1, 0.5).unproject(camera);
    const dir = ndc.sub(camera.position).normalize();
    const origin = camera.position.clone().add(dir.multiplyScalar(12));
    const pos = new Float32Array(n * 3); const vel = new Float32Array(n * 3); const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([origin.x, origin.y, origin.z], i * 3);
      const a = Math.random() * Math.PI * 2; const sp = 14 + Math.random() * 12; // 要快到能立刻衝出轉盤外緣（背景層在轉盤下面）
      vel.set([Math.cos(a) * sp, Math.sin(a) * sp + 3, (Math.random() - 0.5) * 4], i * 3);
      tmp.setHex(PAL[Math.floor(Math.random() * PAL.length)]); c.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const mat = new THREE.PointsMaterial({ size: 0.5, vertexColors: true, map: dot, transparent: true, opacity: 1, blending: pMat.blending, depthWrite: false });
    const pts = new THREE.Points(geo, mat); scene.add(pts);
    bursts.push({ pts, geo, mat, vel, n, age: 0, life: 1.6 });
  }
  const clock = new THREE.Clock();
  let running = !document.hidden;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; clock.getDelta(); });
  function tick() {
    requestAnimationFrame(tick);
    if (!running || !enabled) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    const e = state.energy; const sp = prefersReduced ? 0.15 : 1 + e * 5;
    points.rotation.y += dt * 0.04 * sp;
    points.rotation.z = Math.sin(t * 0.07) * 0.08;
    pMat.size = 0.26 + e * 0.14; pMat.opacity = Math.min(1, 0.9 + e * 0.1);
    shapes.forEach((s) => {
      s.g.rotation.x += s.rx * dt * sp; s.g.rotation.y += s.ry * dt * sp;
      s.g.position.y = s.baseY + Math.sin(t * s.bob + s.phase) * 0.8;
    });
    orbs.forEach((o) => {
      o.sp.position.x = o.bx + Math.sin(t * o.speed + o.phase) * 3;
      o.sp.position.y = o.by + Math.cos(t * o.speed * 0.8 + o.phase) * 2;
      o.sp.material.opacity = (o.light ? 0.22 : 0.55) + e * 0.3;
    });
    camera.position.x += (mouse.x * 1.6 - camera.position.x) * 0.04;
    camera.position.y += (mouse.y * 1.0 - camera.position.y) * 0.04;
    camera.lookAt(0, 0, -6);
    // 一次性粒子爆發（GO 按鈕點擊）
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i]; b.age += dt;
      const arr = b.geo.getAttribute('position').array;
      for (let j = 0; j < b.n; j++) { b.vel[j * 3 + 1] -= 9 * dt; arr[j * 3] += b.vel[j * 3] * dt; arr[j * 3 + 1] += b.vel[j * 3 + 1] * dt; arr[j * 3 + 2] += b.vel[j * 3 + 2] * dt; }
      b.geo.getAttribute('position').needsUpdate = true;
      b.mat.opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age >= b.life) { scene.remove(b.pts); b.geo.dispose(); b.mat.dispose(); bursts.splice(i, 1); }
    }
    renderer.render(scene, camera);
  }
  tick();

  const tween = (target, props, opts) => {
    if (window.anime) { anime.remove(target); anime({ targets: target, ...props, ...opts }); }
    else Object.keys(props).forEach((k) => { target[k] = Array.isArray(props[k]) ? props[k][props[k].length - 1] : props[k]; });
  };
  const wireMats = shapes.map((s) => s.g.children[0].material);
  const fillMats = shapes.map((s) => s.g.children[1].material);
  const baseCol = col.slice();
  function setTheme(theme) {
    const light = theme === 'light';
    // 白底：改用一般混合、顏色壓暗；黑底：加色混合發光
    pMat.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    pMat.opacity = light ? 0.8 : 0.9; pMat.needsUpdate = true;
    const arr = pGeo.getAttribute('color').array;
    for (let i = 0; i < arr.length; i++) arr[i] = light ? baseCol[i] * 0.75 : baseCol[i];
    pGeo.getAttribute('color').needsUpdate = true;
    orbs.forEach((o) => { o.sp.material.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; o.sp.material.needsUpdate = true; o.light = light; });
    wireMats.forEach((m) => { m.opacity = light ? 0.55 : 0.4; });
    fillMats.forEach((m) => { m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; m.opacity = light ? 0.08 : 0.05; m.needsUpdate = true; });
    if (!OVERLAY) scene.fog = light ? new THREE.FogExp2(0xf4efe4, 0.03) : new THREE.FogExp2(0x0d0d1a, 0.03);
  }
  try { setTheme(localStorage.getItem('lw.theme') || 'dark'); } catch { /* ignore */ }
  window.WheelBG = {
    burstAt,
    setTheme,
    setEnabled(v) { enabled = v !== false; canvas.style.display = enabled ? '' : 'none'; if (enabled) clock.getDelta(); },
    setSpinning(v) { tween(state, { energy: v ? 1 : 0 }, { duration: v ? 700 : 1600, easing: 'easeOutQuad' }); },
    burst() {
      tween(state, { energy: [2.2, 0] }, { duration: 2200, easing: 'easeOutExpo' });
      tween(points.scale, { x: [1, 1.18, 1], y: [1, 1.18, 1], z: [1, 1.18, 1] }, { duration: 1200, easing: 'easeOutCubic' });
    },
  };
})();
