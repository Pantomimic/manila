// Renderer, camera, controls and the frame loop.
// Rule carried over from abyssal-garden: no allocations inside frame() (no GC stutter).
import { CELL, CHUNK, MAX_VERTS, buildChunk, collide, findSpawn } from './gen.js';
import { SCENE } from './shaders.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c'), menu = $('menu'), hud = $('hud');

// Chunks within RANGE (in chunks, square) of the player's chunk are kept loaded. 3 -> 7x7 chunks,
// 72 m in every direction, well past where the fog swallows everything.
const RANGE = 3, SLOTS = (2 * RANGE + 1) ** 2, BUILDS_PER_FRAME = 2;
const EYE = 1.6, RADIUS = 0.3, WALK = 2.4, RUN = 5.6, FOV = 75 * Math.PI / 180;

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
  const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });

  const seed = pickSeed();
  // ?shot&yaw=deg: no menu, fixed view (for automated screenshots)
  const qs = new URLSearchParams(location.search);
  if (qs.has('shot')) menu.classList.add('off');

  // chunk streaming: one vertex buffer split into SLOTS fixed-size slots, one chunk per slot
  const SLOT_BYTES = MAX_VERTS * 28;
  const vbuf = device.createBuffer({ size: SLOT_BYTES * SLOTS, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const scratch = new Float32Array(MAX_VERTS * 7);
  const slotCX = new Int32Array(SLOTS), slotCZ = new Int32Array(SLOTS), slotN = new Int32Array(SLOTS);
  const slotUsed = new Uint8Array(SLOTS);
  const want = new Int32Array(SLOTS * 2);          // chunks still to build, nearest first
  let nWant = 0, curCX = 1e9, curCZ = 1e9, nVerts = 0;
  const loadChunk = (slot, cx, cz) => {
    const n = buildChunk(seed, cx, cz, scratch);
    device.queue.writeBuffer(vbuf, slot * SLOT_BYTES, scratch, 0, n * 7);
    slotCX[slot] = cx; slotCZ[slot] = cz; slotN[slot] = n; slotUsed[slot] = 1;
  };
  const isLoaded = (cx, cz) => { for (let i = 0; i < SLOTS; i++) if (slotUsed[i] && slotCX[i] === cx && slotCZ[i] === cz) return true; return false; };
  // called when the player enters a new chunk: free far slots, list missing chunks ring by ring
  const recenter = (pcx, pcz) => {
    curCX = pcx; curCZ = pcz; nWant = 0;
    for (let i = 0; i < SLOTS; i++) if (slotUsed[i] && (Math.abs(slotCX[i] - pcx) > RANGE || Math.abs(slotCZ[i] - pcz) > RANGE)) slotUsed[i] = 0;
    for (let ring = 0; ring <= RANGE; ring++) for (let dz = -ring; dz <= ring; dz++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring || isLoaded(pcx + dx, pcz + dz)) continue;
      want[nWant * 2] = pcx + dx; want[nWant * 2 + 1] = pcz + dz; nWant++;
    }
  };
  let wantHead = 0;
  const pump = (limit) => {
    for (let k = 0; k < limit && wantHead < nWant; k++, wantHead++) {
      let slot = 0; while (slotUsed[slot]) slot++;
      loadChunk(slot, want[wantHead * 2], want[wantHead * 2 + 1]);
    }
  };
  const chunkOf = (m) => Math.floor(m / (CHUNK * CELL));

  const UB = new Float32Array(24);
  const ubo = device.createBuffer({ size: UB.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: SCENE });
  const pipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32' }] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: FMT }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }] });

  // render targets; recreated only when the canvas size changes
  let depth = null, W = 0, H = 0;
  const colorAtt = { view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
  const depthAtt = { view: null, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 };
  const passDesc = { colorAttachments: [colorAtt], depthStencilAttachment: depthAtt };
  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (w === W && h === H) return;
    W = canvas.width = w; H = canvas.height = h;
    if (depth) depth.destroy();
    depth = device.createTexture({ size: [W, H], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    depthAtt.view = depth.createView();
  }

  // player: start in the middle of a cell (walls only sit on cell edges) that joins the open maze
  const pos = new Float64Array(findSpawn(seed));
  let yaw = (parseFloat(qs.get('yaw')) || 0) * Math.PI / 180, pitch = 0, bob = 0, stats = false;
  const keys = new Set();
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyH') stats = !stats; });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  $('go').onclick = () => canvas.requestPointerLock();
  canvas.onclick = () => { if (!document.pointerLockElement) canvas.requestPointerLock(); };
  document.addEventListener('pointerlockchange', () => { menu.classList.toggle('off', document.pointerLockElement === canvas); keys.clear(); });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    yaw += e.movementX * 0.0022;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0022));
  });
  $('go').textContent = 'Enter';

  // view-projection matrix, column-major, WebGPU depth range 0..1
  const P = new Float32Array(16), V = new Float32Array(16);
  function matrices(ex, ey, ez) {
    const f = 1 / Math.tan(FOV / 2), near = 0.05, far = 200;
    P.fill(0); P[0] = f / (W / H); P[5] = f; P[10] = far / (near - far); P[11] = -1; P[14] = near * far / (near - far);
    // camera basis from yaw/pitch: forward fw, right rt, up up
    const cp = Math.cos(pitch), fx = Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    const rx = Math.cos(yaw), rz = Math.sin(yaw);                        // right = forward x world-up, normalized
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;           // up = right x forward
    V[0] = rx; V[4] = 0;  V[8] = rz;  V[12] = -(rx * ex + rz * ez);
    V[1] = ux; V[5] = uy; V[9] = uz;  V[13] = -(ux * ex + uy * ey + uz * ez);
    V[2] = -fx; V[6] = -fy; V[10] = -fz; V[14] = fx * ex + fy * ey + fz * ez;
    V[3] = 0; V[7] = 0; V[11] = 0; V[15] = 1;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      UB[c * 4 + r] = P[r] * V[c * 4] + P[4 + r] * V[c * 4 + 1] + P[8 + r] * V[c * 4 + 2] + P[12 + r] * V[c * 4 + 3];
    }
  }

  let last = performance.now(), fpsT = 0, fpsN = 0, fps = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    resize();
    { const cx = chunkOf(pos[0]), cz = chunkOf(pos[1]); if (cx !== curCX || cz !== curCZ) { recenter(cx, cz); wantHead = 0; } }
    pump(BUILDS_PER_FRAME);

    if (document.pointerLockElement === canvas) {
      const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      if (f || s) {
        const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? RUN : WALK, inv = sp * dt / Math.hypot(f, s);
        const sy = Math.sin(yaw), cy = Math.cos(yaw);
        pos[0] += (sy * f + cy * s) * inv; pos[1] += (-cy * f + sy * s) * inv;
        collide(seed, pos, RADIUS);
        bob += sp * dt * 2.2;
      }
    }
    const ey = EYE + Math.sin(bob) * 0.035;
    matrices(pos[0], ey, pos[1]);
    UB[16] = pos[0]; UB[17] = ey; UB[18] = pos[1]; UB[19] = now / 1000; UB[20] = seed;
    device.queue.writeBuffer(ubo, 0, UB);

    colorAtt.view = ctx.getCurrentTexture().createView();
    const enc = device.createCommandEncoder(), pass = enc.beginRenderPass(passDesc);
    pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vbuf);
    // skip chunks entirely behind the camera (their centre is more than a half-diagonal behind)
    const fx = Math.sin(yaw), fz = -Math.cos(yaw), half = CHUNK * CELL * 0.5;
    nVerts = 0;
    for (let i = 0; i < SLOTS; i++) {
      if (!slotUsed[i]) continue;
      const vx = (slotCX[i] * CHUNK * CELL + half) - pos[0], vz = (slotCZ[i] * CHUNK * CELL + half) - pos[1];
      if (vx * fx + vz * fz < -half * 1.42) continue;
      pass.draw(slotN[i], 1, i * MAX_VERTS); nVerts += slotN[i];
    }
    pass.end(); device.queue.submit([enc.finish()]);

    fpsT += dt; fpsN++; if (fpsT >= 0.5) { fps = fpsN / fpsT; fpsT = 0; fpsN = 0;
      hud.textContent = 'seed ' + seed + (stats ? '\n' + fps.toFixed(0) + ' fps  ' + W + 'x' + H + '  ' + (nVerts / 3) + ' tris  chunk ' + curCX + ',' + curCZ : ''); }
  }
  recenter(chunkOf(pos[0]), chunkOf(pos[1])); wantHead = 0; pump(SLOTS);   // whole start area before the first frame
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
}

function showError(m) { menu.classList.remove('off'); $('err').textContent = m; console.error(m); }
start().catch((e) => showError(e.message || String(e)));
