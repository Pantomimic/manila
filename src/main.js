// The page: WebGPU setup, controls, movement and the frame loop. Drawing lives in render.js.
// Rule carried over from abyssal-garden: no allocations inside frame() (no GC stutter).
import { collide, findSpawn } from './gen.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c'), menu = $('menu'), hud = $('hud');
const EYE = 1.6, RADIUS = 0.3, WALK = 2.4, RUN = 5.6;

function pickSeed() {
  const q = new URLSearchParams(location.search).get('seed');
  if (q) { const n = parseInt(q, 10); if (n > 0 && n < 16777216) return n; }   // stays exact as an f32 in the shader
  const s = 1 + Math.floor(Math.random() * 16777214);
  try { history.replaceState(null, '', '?seed=' + s); } catch {}
  return s;
}

async function start() {
  if (!navigator.gpu) throw new Error('This needs WebGPU. Try a current Chrome or Edge.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  const device = await adapter.requestDevice();
  device.lost.then((i) => { if (i.reason !== 'destroyed') showError('The graphics device was lost: ' + i.message); });
  device.addEventListener('uncapturederror', (e) => showError('Graphics error: ' + e.error.message));
  const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });

  const seed = pickSeed();
  const qs = new URLSearchParams(location.search);
  if (qs.has('shot')) menu.classList.add('off');      // ?shot&yaw=deg: no menu, fixed view
  const R = createRenderer(device, FMT, seed);

  // player: start in the middle of a cell (walls only sit on cell edges) that joins the open maze
  const pos = new Float64Array(findSpawn(seed));
  const cam = { x: pos[0], y: EYE, z: pos[1], yaw: (parseFloat(qs.get('yaw')) || 0) * Math.PI / 180, pitch: 0 };
  let bob = 0, stats = false, audio = null;
  const keys = new Set();
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyH') stats = !stats; if (e.code === 'KeyM' && audio) audio.toggleMute(); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  // sound starts on the first click (browsers only allow audio after a user gesture)
  const wake = () => { try { if (!audio) audio = createAudio(); audio.resume(); } catch (e) { console.warn('no audio', e); } };
  $('go').onclick = () => { wake(); canvas.requestPointerLock(); };
  canvas.onclick = () => { wake(); if (!document.pointerLockElement) canvas.requestPointerLock(); };
  document.addEventListener('pointerlockchange', () => { menu.classList.toggle('off', document.pointerLockElement === canvas); keys.clear(); });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    cam.yaw += e.movementX * 0.0022;
    cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch - e.movementY * 0.0022));
  });

  let last = performance.now(), fpsT = 0, fpsN = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    R.resize(w, h);

    if (document.pointerLockElement === canvas) {
      const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      if (f || s) {
        const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? RUN : WALK, inv = sp * dt / Math.hypot(f, s);
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
        pos[0] += (sy * f + cy * s) * inv; pos[1] += (-cy * f + sy * s) * inv;
        collide(seed, pos, RADIUS);
        bob += sp * dt * 2.2;
      }
    }
    cam.x = pos[0]; cam.z = pos[1]; cam.y = EYE + Math.sin(bob) * 0.035;
    R.stream(cam.x, cam.z, false);
    R.render(ctx.getCurrentTexture().createView(), cam, now / 1000);
    if (audio) audio.update(seed, cam.x, cam.z, now / 1000);

    fpsT += dt; fpsN++; if (fpsT >= 0.5) {
      const st = R.stats;
      hud.textContent = 'seed ' + seed + (stats ? '\n' + (fpsN / fpsT).toFixed(0) + ' fps  ' + w + 'x' + h + '  ' + st.tris + ' tris  chunk ' + st.chunkX + ',' + st.chunkZ : '');
      fpsT = 0; fpsN = 0;
    }
  }
  R.stream(cam.x, cam.z, true);   // whole start area before the first frame
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
}

function showError(m) { menu.classList.remove('off'); $('err').textContent = m; console.error(m); }
start().catch((e) => showError(e.message || String(e)));
