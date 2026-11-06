/* AXON hero: a 3D synapse. Dark chrome axons, gold nodes, travelling gold impulses, electric arcs. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('axon3d');
const still = document.getElementById('stageStill');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = matchMedia('(max-width: 767px), (pointer: coarse)').matches;
const lowEnd = (navigator.hardwareConcurrency || 8) <= 2;

function start() {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, alpha: false, powerPreference: 'high-performance' }); }
  catch (e) { return; }
  const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x0b1423, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const GOLD = new THREE.Color('#F2C14E'), GOLD_HI = new THREE.Color('#FFE08A'), WHITE_GOLD = new THREE.Color('#FFF1C2');

  scene.add(new THREE.AmbientLight(0x8fa2c4, 0.35));
  const key = new THREE.DirectionalLight(0xdfe8ff, 1.3); key.position.set(-3, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x6aa0ff, 1.1); rim.position.set(4, -2, -3); scene.add(rim);
  const goldLight = new THREE.PointLight(0xffc75a, 6, 5, 1.6); scene.add(goldLight);

  const chrome = new THREE.MeshPhysicalMaterial({ color: 0x232c3d, metalness: 1, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.5 });
  const goldMetal = new THREE.MeshPhysicalMaterial({ color: GOLD, metalness: 1, roughness: 0.22, clearcoat: 1, envMapIntensity: 1.6, emissive: new THREE.Color('#7a5410'), emissiveIntensity: 0.35 });
  const bulbMat = new THREE.MeshPhysicalMaterial({ color: 0x1a2232, metalness: 0.85, roughness: 0.12, clearcoat: 1, envMapIntensity: 1.8 });

  const rig = new THREE.Group(); scene.add(rig);
  const obj = new THREE.Group(); rig.add(obj);

  function taperTube(curve, seg, rad, r0, r1) {
    const frames = curve.computeFrenetFrames(seg, false), pos = [], nor = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const u = i / seg, P = curve.getPointAt(u), N = frames.normals[i], B = frames.binormals[i], r = r0 + (r1 - r0) * Math.pow(u, 1.2);
      for (let j = 0; j <= rad; j++) {
        const v = j / rad * Math.PI * 2, s = Math.sin(v), c = -Math.cos(v);
        const nx = c * N.x + s * B.x, ny = c * N.y + s * B.y, nz = c * N.z + s * B.z;
        nor.push(nx, ny, nz); pos.push(P.x + r * nx, P.y + r * ny, P.z + r * nz);
      }
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) { const a = i * (rad + 1) + j, b = (i + 1) * (rad + 1) + j; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx); return g;
  }
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const GAP = 0.5, BULB = 0.24;
  const axA = new THREE.CatmullRomCurve3([V(-3.6, 1.7, -0.6), V(-2.6, 1.25, -0.2), V(-1.55, 0.45, 0.15), V(-GAP - BULB * 0.8, 0.06, 0)]);
  const axB = new THREE.CatmullRomCurve3([V(3.6, -1.5, -0.6), V(2.6, -1.1, -0.2), V(1.55, -0.38, 0.15), V(GAP + BULB * 0.8, -0.04, 0)]);
  const axons = [axA, axB];
  const SEG = mobile ? 90 : 150, RAD = mobile ? 14 : 24;
  axons.forEach((c) => {
    obj.add(new THREE.Mesh(taperTube(c, SEG, RAD, 0.15, 0.085), chrome));
    // gold nodes along the axon
    [0.16, 0.34, 0.52, 0.7, 0.86].forEach((u) => {
      const r = 0.15 + (0.085 - 0.15) * Math.pow(u, 1.2);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.06, 0.018, 10, 48), goldMetal);
      ring.position.copy(c.getPointAt(u)); ring.lookAt(ring.position.clone().add(c.getTangentAt(u))); obj.add(ring);
    });
    // dendrites branching at the outer end
    const p0 = c.getPointAt(0), t0 = c.getTangentAt(0).clone().negate();
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * Math.PI * 2 + 0.4, side = new THREE.Vector3(Math.cos(ang) * 0.6, Math.sin(ang) * 0.6, Math.sin(ang * 1.7) * 0.3);
      const d = new THREE.CatmullRomCurve3([p0.clone(), p0.clone().add(t0.clone().multiplyScalar(0.35)).add(side.clone().multiplyScalar(0.35)), p0.clone().add(t0.clone().multiplyScalar(0.7)).add(side.clone().multiplyScalar(0.9))]);
      obj.add(new THREE.Mesh(taperTube(d, 24, 8, 0.07, 0.012), chrome));
    }
    const tip = c.getPointAt(1).clone().add(c.getTangentAt(1).multiplyScalar(BULB * 0.5));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(BULB, 48, 32), bulbMat); bulb.position.copy(tip); obj.add(bulb);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(BULB * 0.78, 0.022, 12, 56), goldMetal);
    collar.position.copy(c.getPointAt(0.985)); collar.lookAt(collar.position.clone().add(c.getTangentAt(1))); obj.add(collar);
    c.userData = { tip };
  });

  function glowTex(stops) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    stops.forEach(([o, c]) => gr.addColorStop(o, c)); g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  const haloTex = glowTex([[0, 'rgba(255,241,194,1)'], [0.25, 'rgba(255,224,138,0.75)'], [0.6, 'rgba(242,193,78,0.18)'], [1, 'rgba(242,193,78,0)']]);
  const dotTex = glowTex([[0, 'rgba(255,241,194,1)'], [0.4, 'rgba(242,193,78,0.6)'], [1, 'rgba(242,193,78,0)']]);
  const add = (opts) => new THREE.SpriteMaterial(Object.assign({ map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }, opts));

  // synaptic core
  const core = new THREE.Sprite(add({ opacity: 0.9 })); core.scale.setScalar(0.9); obj.add(core);
  const heart = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 14), new THREE.MeshBasicMaterial({ color: WHITE_GOLD })); obj.add(heart);
  const waves = [0, 1, 2].map(() => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.006, 8, 96), new THREE.MeshBasicMaterial({ color: GOLD_HI, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    obj.add(m); return { m, t: 1 };
  });

  // the story: guest messages (cool) travel IN along axon A, AXON turns them into ready inquiries (gold) that travel OUT along axon B
  const COOL = new THREE.Color('#BFD8FF'), COOL_HALO = new THREE.Color('#7FAEFF');
  const pulses = [];
  const NP = mobile ? 3 : 4;
  for (let i = 0; i < NP; i++) {
    const hIn = new THREE.Sprite(add({ opacity: 0.95, color: COOL_HALO })); hIn.material.userData.cool = true; hIn.scale.setScalar(0.62);
    const mIn = new THREE.Mesh(new THREE.SphereGeometry(0.048, 14, 10), new THREE.MeshBasicMaterial({ color: COOL })); mIn.material.userData.cool = true;
    mIn.add(hIn); obj.add(mIn);
    const hOut = new THREE.Sprite(add({ opacity: 1 })); hOut.scale.setScalar(0.7);
    const mOut = new THREE.Mesh(new THREE.SphereGeometry(0.052, 14, 10), new THREE.MeshBasicMaterial({ color: WHITE_GOLD }));
    mOut.add(hOut); obj.add(mOut);
    pulses.push({ mIn, mOut, off: i / NP, last: 0, label: i, chipIn: null, chipOut: null });
  }

  // floating labels drawn on canvas: channel chips on incoming messages, "inquiry ready" chips on outgoing ones
  const isTR = () => (document.documentElement.lang || 'en').indexOf('tr') === 0;
  const isLight = () => document.documentElement.classList.contains('light');
  const CHANNELS = () => isTR() ? ['WhatsApp · 02:14', 'Web sitesi', 'E-posta', 'Instagram', 'WhatsApp · DE', 'Web · EN'] : ['WhatsApp · 02:14', 'Website', 'Email', 'Instagram', 'WhatsApp · DE', 'Web · FR'];
  function chipTexture(text, kind) {
    const cv = document.createElement('canvas'), g = cv.getContext('2d'), fs = 40, pad = 30;
    g.font = '600 ' + fs + 'px Inter, system-ui, sans-serif';
    const w = Math.ceil(g.measureText(text).width) + pad * 2 + (kind === 'in' ? 34 : 0), h = 76;
    cv.width = w; cv.height = h; g.font = '600 ' + fs + 'px Inter, system-ui, sans-serif';
    const r = h / 2, light = isLight();
    g.beginPath(); g.moveTo(r, 2); g.lineTo(w - r, 2); g.arc(w - r, r, r - 2, -Math.PI / 2, Math.PI / 2); g.lineTo(r, h - 2); g.arc(r, r, r - 2, Math.PI / 2, Math.PI * 1.5); g.closePath();
    if (kind === 'out') { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#FFF1C2'); gr.addColorStop(0.45, '#F2C14E'); gr.addColorStop(1, '#D9A033'); g.fillStyle = gr; g.fill(); }
    else if (kind === 'tag') { g.fillStyle = light ? 'rgba(255,255,255,0.92)' : 'rgba(11,20,35,0.78)'; g.fill(); g.lineWidth = 3; g.strokeStyle = light ? 'rgba(168,121,10,0.55)' : 'rgba(242,193,78,0.55)'; g.stroke(); }
    else { g.fillStyle = light ? 'rgba(255,255,255,0.95)' : 'rgba(23,36,58,0.92)'; g.fill(); g.lineWidth = 3; g.strokeStyle = light ? 'rgba(47,111,214,0.45)' : 'rgba(127,174,255,0.6)'; g.stroke(); }
    let x = pad;
    if (kind === 'in') { g.fillStyle = light ? '#2F6FD6' : '#9CC2FF'; g.beginPath(); g.arc(x + 9, h / 2, 9, 0, Math.PI * 2); g.fill(); x += 34; }
    g.fillStyle = kind === 'out' ? '#0B1423' : kind === 'tag' ? (light ? '#8A6308' : '#FFE08A') : (light ? '#0F172A' : '#F4F6F9');
    g.textBaseline = 'middle'; g.fillText(text, x, h / 2 + 2);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return { t, aspect: w / h };
  }
  function chip(text, kind, height) {
    const { t, aspect } = chipTexture(text, kind);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sp.renderOrder = 20; sp.scale.set(height * aspect, height, 1); sp.userData = { text, kind, height }; obj.add(sp); return sp;
  }
  function retext(sp, text) {
    const { t, aspect } = chipTexture(text, sp.userData.kind);
    sp.material.map.dispose(); sp.material.map = t; sp.material.needsUpdate = true;
    sp.userData.text = text; sp.scale.set(sp.userData.height * aspect, sp.userData.height, 1);
  }
  const CH = mobile ? 0.19 : 0.175;
  pulses.forEach((p, i) => { p.chipIn = chip(CHANNELS()[i % 6], 'in', CH); p.chipOut = chip(isTR() ? '✓ Talep hazır' : '✓ Inquiry ready', 'out', CH); });
  const tagGuest = chip(isTR() ? 'Misafir mesajları' : 'Guest messages', 'tag', CH * 1.05);
  const tagTeam = chip(isTR() ? 'Ekibiniz' : 'Your team', 'tag', CH * 1.05);
  const tagAI = chip('AXON AI', 'tag', CH * 1.1);
  tagGuest.position.set(-1.0, 1.02, 0);
  tagTeam.position.set(1.15, -0.78, 0);
  tagAI.position.set(0, 0.66, 0);
  [tagGuest, tagTeam, tagAI].forEach((t) => { t.renderOrder = 30; });
  function relabel() {
    pulses.forEach((p, i) => { retext(p.chipIn, CHANNELS()[(p.label) % 6]); retext(p.chipOut, isTR() ? '✓ Talep hazır' : '✓ Inquiry ready'); });
    retext(tagGuest, isTR() ? 'Misafir mesajları' : 'Guest messages'); retext(tagTeam, isTR() ? 'Ekibiniz' : 'Your team'); retext(tagAI, 'AXON AI');
  }
  window.addEventListener('axon-lang', () => { relabel(); if (!running) frame(0); });

  // electric arcs across the gap
  const ARCS = mobile ? 4 : 7, ARC_PTS = 14, arcs = [];
  for (let a = 0; a < ARCS; a++) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_PTS * 3), 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: a % 2 ? GOLD_HI : WHITE_GOLD, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    obj.add(l); arcs.push(l);
  }
  function strike(l) {
    const p = l.geometry.attributes.position.array, x0 = -GAP + 0.06, x1 = GAP - 0.06, amp = 0.05 + Math.random() * 0.09;
    for (let i = 0; i < ARC_PTS; i++) {
      const u = i / (ARC_PTS - 1), env = Math.sin(Math.PI * u);
      p[i * 3] = x0 + (x1 - x0) * u; p[i * 3 + 1] = 0.01 + (Math.random() - 0.5) * 2 * amp * env; p[i * 3 + 2] = (Math.random() - 0.5) * 2 * amp * env;
    }
    l.geometry.attributes.position.needsUpdate = true; l.material.opacity = 0.35 + Math.random() * 0.6;
  }
  arcs.forEach(strike);

  // photons crossing the gap + floating dust
  const NPH = mobile ? 24 : 44, phGeo = new THREE.BufferGeometry(), phPos = new Float32Array(NPH * 3), phSeed = [];
  for (let i = 0; i < NPH; i++) phSeed.push([Math.random(), (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.6, Math.random() < 0.5 ? 1 : -1]);
  phGeo.setAttribute('position', new THREE.BufferAttribute(phPos, 3));
  obj.add(new THREE.Points(phGeo, new THREE.PointsMaterial({ map: dotTex, size: 0.06, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
  const NF = mobile ? 30 : 60, fGeo = new THREE.BufferGeometry(), fPos = new Float32Array(NF * 3), fSeed = [];
  for (let i = 0; i < NF; i++) fSeed.push([(Math.random() - 0.5) * 9, (Math.random() - 0.5) * 5, -Math.random() * 3, Math.random() * 6.28, 0.15 + Math.random() * 0.35]);
  fGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
  rig.add(new THREE.Points(fGeo, new THREE.PointsMaterial({ map: dotTex, size: 0.045, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending })));

  // glow comes from additive sprites only (no post-processing: it blew out on some GPUs)
  const composer = null;
  const outer = new THREE.Sprite(add({ opacity: 0.35 })); outer.scale.setScalar(2.4); obj.add(outer);

  // light / dark theme: dark chrome + additive gold glow on navy, light chrome + normal-blended gold on white
  const glowMats = [], basicMats = [];
  scene.traverse((o) => { const m = o.material; if (!m) return; if (m.blending === THREE.AdditiveBlending) glowMats.push([m, m.color.clone()]); else if (m.isMeshBasicMaterial) basicMats.push([m, m.color.clone()]); });
  const LIGHT_GOLD = new THREE.Color('#C98F12'), LIGHT_COOL = new THREE.Color('#2F6FD6');
  function applyTheme(light) {
    renderer.setClearColor(light ? 0xffffff : 0x0b1423, 1);
    chrome.color.set(light ? 0xaeb8c6 : 0x232c3d); chrome.roughness = light ? 0.26 : 0.2;
    bulbMat.color.set(light ? 0xc3cbd6 : 0x1a2232);
    glowMats.forEach(([m, c]) => { m.blending = light ? THREE.NormalBlending : THREE.AdditiveBlending; m.color.copy(light ? (m.userData.cool ? LIGHT_COOL : LIGHT_GOLD) : c); m.needsUpdate = true; });
    basicMats.forEach(([m, c]) => { m.color.copy(light ? (m.userData.cool ? LIGHT_COOL : LIGHT_GOLD) : c); });
    relabel();
    if (!running) frame(0);
  }
  window.addEventListener('axon-theme', (e) => applyTheme(!!(e.detail && e.detail.light)));
  const desktop = () => stage.clientWidth >= 640;
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); if (composer) { composer.setPixelRatio(dpr); composer.setSize(w, h); }
    camera.aspect = w / h;
    const fit = 5.0 / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(camera.aspect, 1.4));
    camera.position.set(0, 0.2, Math.max(5.2, fit)); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    const wide = window.innerWidth >= 1024;
    obj.position.set(wide ? 0.55 : 0, wide ? 0.85 : 0.45, 0);
    obj.scale.setScalar(wide ? 1.0 : 0.95);
  }
  new ResizeObserver(resize).observe(stage); resize();

  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  window.addEventListener('pointermove', (e) => { mouse.tx = e.clientX / innerWidth * 2 - 1; mouse.ty = -(e.clientY / innerHeight) * 2 + 1; }, { passive: true });

  const clock = new THREE.Clock();
  let T = 0, beat = 0, nextArc = 0, visible = true, running = false, shown = false;
  function frame(dt) {
    T += dt;
    mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 2.5); mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 2.5);
    rig.rotation.y = Math.sin(T * 0.22) * 0.14 + mouse.x * 0.25;
    rig.rotation.x = Math.sin(T * 0.17) * 0.05 - mouse.y * 0.12;
    obj.rotation.z = Math.sin(T * 0.3) * 0.03;

    pulses.forEach((p) => {
      const u = (T * 0.16 + p.off) % 1, e = u * u * (3 - 2 * u);
      // incoming message rides axon A towards the synapse
      p.mIn.position.copy(axA.getPointAt(Math.min(e, 0.999)));
      p.mIn.visible = u < 0.985;
      p.chipIn.position.copy(p.mIn.position).add(V(0, 0.24, 0.05));
      p.chipIn.material.opacity = Math.min(1, u * 8) * (u > 0.86 ? Math.max(0, (0.97 - u) / 0.11) : 1);
      // the qualified inquiry it became leaves along axon B (one cycle behind, so it starts as the message arrives)
      const o = e; p.mOut.position.copy(axB.getPointAt(Math.max(0.001, 1 - o)));
      p.mOut.visible = p.started && u > 0.02;
      p.chipOut.position.copy(p.mOut.position).add(V(0, -0.24, 0.05));
      p.chipOut.material.opacity = p.started ? Math.min(1, u * 6) * (u > 0.85 ? Math.max(0, (1 - u) / 0.15) : 1) : 0;
      if (u < p.last) {
        beat = 1; p.started = true;
        const w = waves.find((x) => x.t >= 1) || waves[0]; w.t = 0;
        p.label += NP; retext(p.chipIn, CHANNELS()[p.label % 6]);
      }
      p.last = u;
    });
    tagAI.material.opacity = 0.75 + beat * 0.25;
    beat = Math.max(0, beat - dt * 1.5);
    const breathe = 0.5 + 0.5 * Math.sin(T * 2.4);
    core.scale.setScalar(1.2 + breathe * 0.18 + beat * 0.9); outer.scale.setScalar(2.2 + breathe * 0.3 + beat * 1.2); outer.material.opacity = 0.28 + beat * 0.3; core.material.opacity = 0.65 + breathe * 0.15 + beat * 0.2;
    heart.scale.setScalar(1 + beat * 0.9 + breathe * 0.15);
    goldLight.intensity = 4 + breathe * 2 + beat * 10;
    waves.forEach((w) => { w.t = Math.min(1, w.t + dt * 0.85); w.m.scale.setScalar(0.4 + w.t * 2.4); w.m.material.opacity = (1 - w.t) * 0.85; w.m.rotation.y = mouse.x * 0.4; });
    if (T > nextArc) { arcs.forEach((l) => { if (Math.random() < 0.7) strike(l); }); nextArc = T + 0.05 + Math.random() * 0.07 - beat * 0.03; }
    for (let i = 0; i < NPH; i++) {
      const s = phSeed[i]; s[0] += dt * s[3] * (1 + beat); if (s[0] > 1) { s[0] = 0; s[4] = Math.random() < 0.5 ? 1 : -1; }
      const k = Math.sin(s[0] * Math.PI);
      phPos[i * 3] = (s[0] * 2 - 1) * (GAP - 0.08) * s[4]; phPos[i * 3 + 1] = s[1] * k; phPos[i * 3 + 2] = s[2] * k;
    }
    phGeo.attributes.position.needsUpdate = true;
    for (let i = 0; i < NF; i++) { const s = fSeed[i]; fPos[i * 3] = s[0] + Math.sin(T * s[4] + s[3]) * 0.2; fPos[i * 3 + 1] = s[1] + Math.cos(T * s[4] * 0.8 + s[3]) * 0.16; fPos[i * 3 + 2] = s[2]; }
    fGeo.attributes.position.needsUpdate = true;
    goldLight.position.copy(obj.position);
    if (composer) composer.render(); else renderer.render(scene, camera);
    if (!shown) { shown = true; canvas.classList.remove('opacity-0'); still.classList.add('opacity-0'); }
  }
  function loop() { if (!visible || document.hidden) { running = false; return; } running = true; frame(Math.min(clock.getDelta(), 0.05)); requestAnimationFrame(loop); }
  function kick() { if (!running && !reduced) { clock.getDelta(); loop(); } }
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; kick(); }).observe(stage);
  document.addEventListener('visibilitychange', kick);
  applyTheme(document.documentElement.classList.contains('light'));
  if (reduced) { T = 2.5; frame(0); } else kick();
}
if (!lowEnd) { try { start(); } catch (e) { /* keep the still illustration */ } }
