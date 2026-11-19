// The page: WebGPU setup, controls, movement and the frame loop. Drawing lives in render.js.
// Rule carried over from abyssal-garden: no allocations inside frame() (no GC stutter).
import { collide, cramped, findSpawn } from './gen.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c'), menu = $('menu'), hud = $('hud');
const EYE = 1.6, CROUCH_EYE = 0.95, RADIUS = 0.3, WALK = 2.4, RUN = 5.6, SNEAK = 1.2;
const TALL = 1.75, SHORT = 1.1;                     // player height standing / crouched, for low doorways
const FOV = 75, ZOOM_FOV = 28;

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
  const cam = { x: pos[0], y: EYE, z: pos[1], yaw: (parseFloat(qs.get('yaw')) || 0) * Math.PI / 180, pitch: 0, fov: FOV * Math.PI / 180 };
  let bob = 0, stats = false, audio = null, crouched = false, eye = EYE, fov = FOV, zoom = false;
  const keys = new Set();
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyH') stats = !stats; if (e.code === 'KeyM' && audio) audio.toggleMute(); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  // sound starts on the first click (browsers only allow audio after a user gesture)
  const volEl = $('vol');
  try { const v = localStorage.getItem('backrooms.volume'); if (v !== null) volEl.value = v; } catch {}
  const vol = () => volEl.value / 100;
  volEl.oninput = () => { if (audio) audio.setVolume(vol()); try { localStorage.setItem('backrooms.volume', volEl.value); } catch {} };
  const wake = () => { try { if (!audio) { audio = createAudio(); audio.setVolume(vol()); } audio.resume(); } catch (e) { console.warn('no audio', e); } };
  // mouse sensitivity slider, kept like the volume
  const sensEl = $('sens');
  try { const v = localStorage.getItem('backrooms.sens'); if (v !== null) sensEl.value = v; } catch {}
  const sens = () => 0.0022 * Math.pow(4, (sensEl.value - 50) / 50);       // x1/4 .. x4 around the default
  sensEl.oninput = () => { try { localStorage.setItem('backrooms.sens', sensEl.value); } catch {} };

  // Pointer lock with raw mouse input where the browser has it. Chrome's default (OS-accelerated)
  // pointer lock sometimes reports one huge jump in movementX/Y, which snapped the view; raw input
  // avoids most of that and the spike filter below drops the rest.
  const lock = () => {
    try {
      const p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => canvas.requestPointerLock());
    } catch { canvas.requestPointerLock(); }
  };
  $('go').onclick = () => { wake(); lock(); };
  canvas.onclick = () => { wake(); if (!document.pointerLockElement) lock(); };
  canvas.oncontextmenu = (e) => e.preventDefault();
  document.addEventListener('pointerlockchange', () => { menu.classList.toggle('off', document.pointerLockElement === canvas); keys.clear(); zoom = false; skip = 2; });
  document.addEventListener('mousedown', (e) => { if (e.button === 2 && document.pointerLockElement === canvas) zoom = true; });
  document.addEventListener('mouseup', (e) => { if (e.button === 2) zoom = false; });
  let avg = 4, skip = 0;                      // running mean of |movement|; events to ignore after (re)locking
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    const mx = e.movementX, my = e.movementY, m = Math.abs(mx) + Math.abs(my);
    if (skip > 0) { skip--; return; }
    const spike = m > 120 && m > avg * 8;     // one huge event out of nowhere; real flicks ramp up
    avg += (m - avg) * 0.2;                   // (updated anyway, so a sustained fast move gets through)
    if (spike) return;
    const k = sens() * fov / FOV;             // slower aim while zoomed
    cam.yaw += mx * k;
    cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch - my * k));
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
      // hold C to crouch; you stay down while something low is overhead
      if (keys.has('KeyC')) crouched = true;
      else if (crouched && !cramped(seed, pos, RADIUS, TALL)) crouched = false;
      if (f || s) {
        const sp = crouched ? SNEAK : (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? RUN : WALK, inv = sp * dt / Math.hypot(f, s);
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
        pos[0] += (sy * f + cy * s) * inv; pos[1] += (-cy * f + sy * s) * inv;
        collide(seed, pos, RADIUS, crouched ? SHORT : TALL);
        bob += sp * dt * 2.2;
      }
    }
    const ease = 1 - Math.exp(-dt * 12);
    eye += ((crouched ? CROUCH_EYE : EYE) - eye) * ease;
    fov += ((zoom ? ZOOM_FOV : FOV) - fov) * ease;
    cam.fov = fov * Math.PI / 180;
    cam.x = pos[0]; cam.z = pos[1]; cam.y = eye + Math.sin(bob) * (crouched ? 0.02 : 0.035);
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
