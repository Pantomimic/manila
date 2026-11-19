// The page: WebGPU setup, controls, movement and the frame loop. Drawing lives in render.js.
// Rule carried over from abyssal-garden: no allocations inside frame() (no GC stutter).
import { collide, cramped, findSpawn, roomCell, lightLevel, CELL } from './gen.js';
import * as G from './gen.js';                // live room bounds after roomCell
import { createRenderer } from './render.js';
import { levelOf, levelSeed, groundAt, ceilAt, collideProps, FH, liveLight } from './levels.js';
import { createAudio } from './audio.js';
import { createPhotos, AUTO_EVERY } from './photos.js';
import { flyDrone } from './drone.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c'), menu = $('menu'), hud = $('hud');
const EYE = 1.6, CROUCH_EYE = 0.95, RADIUS = 0.3, WALK = 2.4, RUN = 5.6, SNEAK = 1.2;
const TALL = 1.75, SHORT = 1.1;                     // player height standing / crouched, for low doorways
const FOV = 75, ZOOM_FOV = 28, STEP = 0.75, GRAVITY = 12;

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
  // a photo's where.txt link (?x=&z=&y=&yaw=&pitch=, &drone) opens the game at that exact view
  const num = (k, d) => { const v = parseFloat(qs.get(k)); return Number.isFinite(v) ? v : d; };
  const pos = new Float64Array(qs.has('x') && qs.has('z') ? [num('x', 0), num('z', 0)] : findSpawn(seed));
  const cam = { x: pos[0], y: EYE, z: pos[1], yaw: num('yaw', 0) * Math.PI / 180, pitch: num('pitch', 0) * Math.PI / 180, fov: FOV * Math.PI / 180 };
  let bob = 0, stats = false, audio = null, crouched = false, eye = EYE, fov = FOV, zoom = false;
  let py = 0, vy = 0, grounded = true, camFeet = 0;    // feet height; levels are FH apart
  if (qs.has('y')) { py = num('y', EYE) - EYE; camFeet = py; grounded = false; }
  // drone: F to fly. You become a small camera drone (Space up, C down); F again drops you where it is
  let drone = qs.has('drone');
  const dr = { y: num('y', EYE), v: new Float64Array(3) }, dv = dr.v;
  let autoCam = false, autoT = 0, shoot = false, flashT = 0;
  const flash = $('flash'), phInfo = $('phn');
  const photos = createPhotos(canvas, () => showPhotos());
  function showPhotos() {
    const u = photos.unsaved;
    phInfo.textContent = photos.folder ? photos.count + ' photos, saving to the folder "' + photos.folder + '"'
      : u ? u + ' photo' + (u > 1 ? 's' : '') + ' not saved yet' : photos.count ? 'All photos saved' : 'No photos yet: P takes one, O takes one every ' + AUTO_EVERY + ' s';
    $('phsave').disabled = !u || !!photos.folder;
  }
  showPhotos();
  $('phsave').onclick = () => photos.saveZip(seed).catch((e) => showError(e.message));
  $('phdir').onclick = () => photos.pickFolder().catch((e) => { if (e.name !== 'AbortError') showError(e.message); });
  if (!window.showDirectoryPicker) $('phdir').style.display = 'none';
  function toggleDrone() {
    if (!drone) { drone = true; dr.y = cam.y; dv.fill(0); }
    else {                                              // drop to the floor from where the drone is
      if (cramped(levelSeed(seed, levelOf(dr.y)), pos, RADIUS, SHORT)) return;   // (not from inside a window)
      drone = false; py = dr.y - 0.4; camFeet = py; eye = 0.4; vy = 0; grounded = false;
      if (cramped(levelSeed(seed, levelOf(py + 1.0)), pos, RADIUS, TALL)) crouched = true;
    }
    if (audio) audio.drone(drone ? 0 : -1);
  }
  // camcorder look (V): VHS colour smear, wobble, tracking noise, a date stamp, slow auto exposure
  const vhsEl = $('vhs'), vhsDate = $('vhsdate'), vhsTime = $('vhstime');
  try { R.look.camcorder = localStorage.getItem('backrooms.vhs') === '1'; } catch {}
  vhsEl.classList.toggle('off', !R.look.camcorder);
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const tapeDay = (MON[seed % 12] + '. ' + (1 + (seed >> 4) % 28) + ' ' + (1993 + (seed >> 9) % 7));
  const tapeStart = (seed >> 3) % (12 * 3600) + 3600;            // seconds past midnight when the tape starts
  vhsDate.textContent = tapeDay;
  const tapeClock = (t) => {
    const s = Math.floor(tapeStart + t) % 86400, h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h < 12 ? 'AM ' : 'PM ') + ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  let expo = 1, stepN = 0, loops = -1, hallK = -99;
  const keys = new Set(), key = (c) => keys.has(c) ? 1 : 0;
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyH') stats = !stats;
    if (e.code === 'KeyM' && audio) audio.toggleMute();
    if (document.pointerLockElement !== canvas || e.repeat) return;
    if (e.code === 'KeyF') toggleDrone();
    if (e.code === 'KeyP') shoot = true;
    if (e.code === 'KeyO') { autoCam = !autoCam; autoT = 0; }
    if (e.code === 'KeyV') { R.look.camcorder = !R.look.camcorder; vhsEl.classList.toggle('off', !R.look.camcorder); try { localStorage.setItem('backrooms.vhs', R.look.camcorder ? '1' : ''); } catch {} }
    if (e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  // sound starts on the first click (browsers only allow audio after a user gesture)
  const volEl = $('vol');
  try { const v = localStorage.getItem('backrooms.volume'); if (v !== null) volEl.value = v; } catch {}
  const vol = () => volEl.value / 100;
  volEl.oninput = () => { if (audio) audio.setVolume(vol()); try { localStorage.setItem('backrooms.volume', volEl.value); } catch {} };
  const wake = () => { try { if (!audio) { audio = createAudio(); audio.setVolume(vol()); audio.drone(drone ? 0 : -1); } audio.resume(); } catch (e) { console.warn('no audio', e); } };
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
  document.addEventListener('pointerlockchange', () => { menu.classList.toggle('off', document.pointerLockElement === canvas); keys.clear(); zoom = false; skip = 2; autoCam = false; showPhotos(); });
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

    const locked = document.pointerLockElement === canvas;
    if (drone) {
      const k = key;                                    // (keys are cleared whenever the mouse is let go)
      flyDrone(seed, pos, dr, k('KeyW') - k('KeyS'), k('KeyD') - k('KeyA'), k('Space') - k('KeyC'), k('ShiftLeft') || k('ShiftRight'), cam.yaw, dt);
    }
    else if (locked) {
      const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      // walls and props of the level your body is in (on a stair that changes halfway up)
      const bodyLv = levelOf(py + 1.0), sB = levelSeed(seed, bodyLv);
      // hold C to crouch; you stay down while something low is overhead
      if (keys.has('KeyC')) crouched = true;
      else if (crouched && !cramped(sB, pos, RADIUS, TALL) && py + TALL < ceilAt(seed, levelOf(py), pos[0], pos[1])) crouched = false;
      if (f || s) {
        const sp = crouched ? SNEAK : (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? RUN : WALK, inv = sp * dt / Math.hypot(f, s);
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw), ox = pos[0], oz = pos[1], tall = crouched ? SHORT : TALL;
        pos[0] += (sy * f + cy * s) * inv; pos[1] += (-cy * f + sy * s) * inv;
        collide(sB, pos, RADIUS, tall);
        collideProps(seed, bodyLv, pos, RADIUS);
        // a step too high (the side of a stair) or a ceiling too low for your head: you don't move
        if (grounded) {
          const g = groundAt(seed, levelOf(py + STEP), pos[0], pos[1]);
          if (g - py > STEP || Math.max(g, py) + tall > ceilAt(seed, levelOf(Math.max(g, py)), pos[0], pos[1])) { pos[0] = ox; pos[1] = oz; }
        }
        bob += sp * dt * 2.2;
        // footsteps: one each half bob cycle, on carpet, soaked carpet or pool tile
        const n = Math.floor(bob / Math.PI);
        if (n !== stepN && grounded) {
          stepN = n;
          const rm = roomCell(sB, Math.floor(pos[0] / CELL), Math.floor(pos[1] / CELL));
          if (audio) audio.step(rm === 7 ? 1 : rm === 9 ? 2 : 0, crouched ? 0.2 : sp > WALK ? 1 : 0.5);
        }
        hallway(sB);
      }
    }
    const ease = 1 - Math.exp(-dt * 12);
    fov += ((zoom ? ZOOM_FOV : FOV) - fov) * ease;
    cam.fov = fov * Math.PI / 180;
    cam.x = pos[0]; cam.z = pos[1];
    if (drone) cam.y = dr.y + Math.sin(now / 1000 * 1.9) * 0.012;      // a slight hover wobble
    else {
      // gravity: stand on whatever is under you, step up and down stairs, fall through holes
      const g = groundAt(seed, levelOf(py + STEP), pos[0], pos[1]);
      if (g >= py - 1e-3) { py = g; vy = 0; grounded = true; }
      else if (grounded && py - g <= STEP) py = g;
      else {
        grounded = false; vy -= GRAVITY * dt; py += vy * dt;
        if (py <= g) { py = g; vy = 0; grounded = true; }
      }
      camFeet = grounded ? camFeet + (py - camFeet) * (1 - Math.exp(-dt * 16)) : py;   // smooth over steps
      eye += ((crouched ? CROUCH_EYE : EYE) - eye) * ease;
      cam.y = camFeet + eye + Math.sin(bob) * (crouched ? 0.02 : 0.035);
    }
    const feet = drone ? levelOf(dr.y) * FH : py;
    R.stream(cam.x, feet, cam.z, false);
    // auto exposure (camcorder only): opens up slowly in the dark, clamps down in bright rooms
    if (R.look.camcorder) {
      const lvE = levelOf(feet + 1.0), sE = levelSeed(seed, lvE), ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
      let est = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const X = ccx + dx, Z = ccz + dz, k = liveLight(seed, lvE, X, Z, ccx, ccz);
        if (!k) continue;
        const ex = (X + 0.5) * CELL - cam.x, ez = (Z + 0.5) * CELL - cam.z;
        est += lightLevel(sE, X, Z, k, now / 1000) / (1 + (ex * ex + ez * ez) / 8);
      }
      const target = Math.min(3.2, Math.max(0.75, 1.6 / (0.35 + est)));
      expo += (target - expo) * (1 - Math.exp(-dt * 0.8));
    } else expo = 1;
    R.look.exposure = expo;
    { // the hallway's darkness comes on over a second or two once you're in it
      const lvC = levelOf(cam.y - 1.0), inHall = roomCell(levelSeed(seed, lvC), Math.floor(cam.x / CELL), Math.floor(cam.z / CELL)) === 10;
      R.look.hall += ((inHall ? 1 : 0) - R.look.hall) * (1 - Math.exp(-dt * 1.2));
    }
    R.render(ctx.getCurrentTexture().createView(), cam, now / 1000);
    // photos: read the canvas now, in the same task as the draw, before it is shown
    if (autoCam && locked && (autoT += dt) >= AUTO_EVERY) { autoT = 0; shoot = true; }
    if (shoot) {
      shoot = false; photos.take(seed, cam, drone, R.look.camcorder ? [tapeDay, tapeClock(now / 1000)] : null); flashT = 1;
      if (audio) audio.shutter();
    }
    if (flashT > 0) { flashT = Math.max(0, flashT - dt * 5); flash.style.opacity = (flashT * 0.5).toFixed(3); }
    // (a bug in the sound must never stop the frame: the HUD below silently froze once)
    if (audio) try {
      audio.listen(cam.x, cam.y, cam.z, cam.yaw);
      audio.update(seed, levelOf(drone ? dr.y : py + 1.0), cam.x, cam.z, now / 1000);
      if (drone) audio.drone(Math.hypot(dv[0], dv[1], dv[2]));
    } catch (e) { console.error(e); audio = null; }

    fpsT += dt; fpsN++; if (fpsT >= 0.5) {
      if (R.look.camcorder) vhsTime.textContent = tapeClock(now / 1000);
      const st = R.stats;
      hud.textContent = 'seed ' + seed + (drone ? '  ·  drone' : '') + (autoCam ? '  ·  auto camera' : '') + (photos.count ? '  ·  ' + photos.count + ' photos' : '') + (stats ? '\n' + (fpsN / fpsT).toFixed(0) + ' fps  ' + w + 'x' + h + '  ' + st.tris + ' tris  chunk ' + st.chunkX + ',' + st.chunkZ + '  level ' + st.level : '');
      fpsT = 0; fpsN = 0;
    }
  }
  // The hallway room loops: walking along it, a few times you are put back three cells without
  // noticing (the hallway is built to look the same all along), then it lets you through.
  function hallway(sB) {
    const cx = Math.floor(pos[0] / CELL), cz = Math.floor(pos[1] / CELL);
    if (roomCell(sB, cx, cz) !== 10) { loops = -1; hallK = -99; return; }
    const alongX = G.rX1 - G.rX0 > 1, n = alongX ? G.rX1 - G.rX0 : G.rZ1 - G.rZ0, k = (alongX ? cx - G.rX0 : cz - G.rZ0);
    if (loops < 0) loops = 2 + (Math.floor(Math.random() * 4));
    if (loops > 0 && hallK !== -99) {
      let shift = 0;
      if (k === n - 4 && hallK === n - 5) shift = -3;    // (the shader fogs the hallway past ~7 m, so the
      else if (k === 3 && hallK === 4) shift = 3;        //  ends are never in view when this happens)
      if (shift) { pos[alongX ? 0 : 1] += shift * CELL; loops--; hallK = k + shift; return; }
    }
    hallK = k;
  }

  R.stream(cam.x, drone ? levelOf(dr.y) * FH : py, cam.z, true);   // whole start area before the first frame
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
}

function showError(m) { menu.classList.remove('off'); $('err').textContent = m; console.error(m); }
start().catch((e) => showError(e.message || String(e)));
