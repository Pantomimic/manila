// The renderer: chunk streaming, the scene pass and post-processing. No DOM access, so the same code
// runs in the browser (main.js) and headless in Node for screenshots (tools/shot.mjs).
// No allocations in render() apart from what WebGPU itself needs per frame.
import { CELL, CHUNK, MAX_VERTS, edgeSpan, SALT_H, SALT_V } from './gen.js';
import { FH, buildLevelChunk, levelSeed, levelOf, cellLight } from './levels.js';
import { SCENE } from './shaders.js';
import { POST } from './post.js';

const HDR = 'rgba16float', DEPTH = 'depth24plus', MSAA = 4, LEVELS = 5;
// Chunks within RANGE (in chunks, square) of the camera's chunk are kept loaded. 3 -> 7x7 chunks,
// 72 m in every direction, well past where the fog swallows everything. The levels above and below
// are only seen through holes and stairwells, so they get RANGE2.
const RANGE = 3, RANGE2 = 1, SLOTS = (2 * RANGE + 1) ** 2 + 2 * (2 * RANGE2 + 1) ** 2, BUILDS_PER_FRAME = 2;
const FOV = 75 * Math.PI / 180;
export const EXPOSURE = 1.0, BLOOM = 0.12, GRAIN = 0.035;

export function createRenderer(device, outFormat, seed) {
  const Q = device.queue, TU = GPUTextureUsage, BU = GPUBufferUsage;

  // ---- chunk streaming: one vertex buffer split into SLOTS fixed-size slots, one chunk per slot ----
  const SLOT_BYTES = MAX_VERTS * 28;
  const vbuf = device.createBuffer({ size: SLOT_BYTES * SLOTS, usage: BU.VERTEX | BU.COPY_DST });
  const scratch = new Float32Array(MAX_VERTS * 7);
  const slotCX = new Int32Array(SLOTS), slotCZ = new Int32Array(SLOTS), slotLV = new Int32Array(SLOTS), slotN = new Int32Array(SLOTS);
  const slotUsed = new Uint8Array(SLOTS);
  const want = new Int32Array(SLOTS * 3);          // chunks still to build (cx, cz, level), nearest first
  let nWant = 0, wantHead = 0, curCX = 1e9, curCZ = 1e9, curLV = 1e9;
  const loadChunk = (slot, cx, cz, lv) => {
    const n = buildLevelChunk(seed, lv, cx, cz, scratch);
    Q.writeBuffer(vbuf, slot * SLOT_BYTES, scratch, 0, n * 7);
    slotCX[slot] = cx; slotCZ[slot] = cz; slotLV[slot] = lv; slotN[slot] = n; slotUsed[slot] = 1;
  };
  const isLoaded = (cx, cz, lv) => { for (let i = 0; i < SLOTS; i++) if (slotUsed[i] && slotCX[i] === cx && slotCZ[i] === cz && slotLV[i] === lv) return true; return false; };
  // ---- world data the shader reads instead of re-deriving it per pixel: a DATA x DATA cell window
  // around the camera, addressed by world cell mod DATA, for the levels below, at and above the
  // camera (texture rows [0, DATA), [DATA, 2 DATA), [2 DATA, 3 DATA)). Columns [0, DATA) hold the
  // horizontal edge of each cell, [DATA, 2 DATA) the vertical edge (both as edgeSpan floats),
  // [2 DATA, 3 DATA) the light kind.
  const DATA = 64;
  const dataArr = new Float32Array(DATA * 3 * DATA * 3 * 4);
  const dataTex = device.createTexture({ size: [DATA * 3, DATA * 3], format: 'rgba32float', usage: TU.TEXTURE_BINDING | TU.COPY_DST });
  const fillData = (pcx, pcz, plv) => {
    const bx = pcx * CHUNK - 28, bz = pcz * CHUNK - 28;      // covers the loaded chunks plus one cell
    for (let li = 0; li < 3; li++) {
      const lv = plv - 1 + li, sL = levelSeed(seed, lv);
      for (let z = bz; z < bz + DATA; z++) for (let x = bx; x < bx + DATA; x++) {
        const row = ((z & (DATA - 1)) + li * DATA) * DATA * 3, col = x & (DATA - 1);
        edgeSpan(sL, SALT_H, z, x, dataArr, (row + col) * 4);
        edgeSpan(sL, SALT_V, x, z, dataArr, (row + DATA + col) * 4);
        dataArr[(row + 2 * DATA + col) * 4] = cellLight(seed, lv, x, z);
      }
    }
    Q.writeTexture({ texture: dataTex }, dataArr, { bytesPerRow: DATA * 3 * 16 }, [DATA * 3, DATA * 3]);
  };
  const recenter = (pcx, pcz, plv) => {
    curCX = pcx; curCZ = pcz; curLV = plv; nWant = 0; wantHead = 0;
    fillData(pcx, pcz, plv);
    const range = (lv) => lv === plv ? RANGE : RANGE2;
    for (let i = 0; i < SLOTS; i++) if (slotUsed[i] && (Math.abs(slotLV[i] - plv) > 1 || Math.abs(slotCX[i] - pcx) > range(slotLV[i]) || Math.abs(slotCZ[i] - pcz) > range(slotLV[i]))) slotUsed[i] = 0;
    for (let ring = 0; ring <= RANGE; ring++) for (const lv of [plv, plv - 1, plv + 1]) {
      if (ring > range(lv)) continue;
      for (let dz = -ring; dz <= ring; dz++) for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring || isLoaded(pcx + dx, pcz + dz, lv)) continue;
        want[nWant * 3] = pcx + dx; want[nWant * 3 + 1] = pcz + dz; want[nWant * 3 + 2] = lv; nWant++;
      }
    }
  };
  const pump = (limit) => {
    for (let k = 0; k < limit && wantHead < nWant; k++, wantHead++) {
      let slot = 0; while (slotUsed[slot]) slot++;
      loadChunk(slot, want[wantHead * 3], want[wantHead * 3 + 1], want[wantHead * 3 + 2]);
    }
  };
  const chunkOf = (m) => Math.floor(m / (CHUNK * CELL));
  // keep the area around (x, z) on the level of height y (feet) loaded; all = build everything missing now
  function stream(x, y, z, all) {
    const cx = chunkOf(x), cz = chunkOf(z), lv = levelOf(y);
    if (cx !== curCX || cz !== curCZ || lv !== curLV) recenter(cx, cz, lv);
    pump(all ? SLOTS : BUILDS_PER_FRAME);
  }

  // ---- scene pipeline ----
  const UB = new Float32Array(28);
  const ubo = device.createBuffer({ size: UB.byteLength, usage: BU.UNIFORM | BU.COPY_DST });
  const sceneMod = device.createShaderModule({ code: SCENE });
  const scenePipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: sceneMod, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32' }] }] },
    fragment: { module: sceneMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: MSAA },
  });
  const sceneBG = device.createBindGroup({ layout: scenePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: dataTex.createView() }] });

  // ---- post pipelines ----
  const postMod = device.createShaderModule({ code: POST });
  const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const postPipe = (entry, format, blend) => device.createRenderPipeline({ layout: 'auto',
    vertex: { module: postMod, entryPoint: 'vs' }, fragment: { module: postMod, entryPoint: entry, targets: [{ format, blend }] } });
  const pPre = postPipe('fsPre', HDR), pDown = postPipe('fsDown', HDR), pUp = postPipe('fsUp', HDR, ADD), pFinal = postPipe('fsFinal', outFormat);
  const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const PU = new Float32Array(4);
  const puBuf = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

  // ---- size-dependent targets and the pass list; rebuilt only on resize ----
  let W = 0, H = 0, textures = [];
  const msaaAtt = { view: null, resolveTarget: null, loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
  const depthAtt = { view: null, depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 };
  const scenePass = { colorAttachments: [msaaAtt], depthStencilAttachment: depthAtt };
  const finalAtt = { view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
  const finalPass = { colorAttachments: [finalAtt] };
  let blits = [], finalBG = null;     // blits: [{ pass, pipe, bg }]
  function resize(w, h) {
    if (w === W && h === H) return;
    W = w; H = h;
    for (const t of textures) t.destroy();
    const mk = (tw, th, format, usage, sampleCount = 1) => { const t = device.createTexture({ size: [tw, th], format, usage, sampleCount }); textures.push(t); return t; };
    textures = [];
    const msaa = mk(W, H, HDR, TU.RENDER_ATTACHMENT, MSAA), depth = mk(W, H, DEPTH, TU.RENDER_ATTACHMENT, MSAA);
    const hdr = mk(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
    msaaAtt.view = msaa.createView(); msaaAtt.resolveTarget = hdr.createView(); depthAtt.view = depth.createView();
    const lv = [];
    for (let i = 0; i < LEVELS; i++) lv.push(mk(Math.max(1, W >> (i + 1)), Math.max(1, H >> (i + 1)), HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING).createView());
    const bg = (pipe, view) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: smp }] });
    const pass = (view, load) => ({ colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    blits = [{ pass: pass(lv[0]), pipe: pPre, bg: bg(pPre, msaaAtt.resolveTarget) }];
    for (let i = 1; i < LEVELS; i++) blits.push({ pass: pass(lv[i]), pipe: pDown, bg: bg(pDown, lv[i - 1]) });
    for (let i = LEVELS - 2; i >= 0; i--) blits.push({ pass: pass(lv[i], true), pipe: pUp, bg: bg(pUp, lv[i + 1]) });
    finalBG = device.createBindGroup({ layout: pFinal.getBindGroupLayout(0), entries: [
      { binding: 0, resource: msaaAtt.resolveTarget }, { binding: 1, resource: smp }, { binding: 2, resource: lv[0] }, { binding: 3, resource: { buffer: puBuf } }] });
  }

  // view-projection matrix, column-major, WebGPU depth range 0..1
  const P = new Float32Array(16), V = new Float32Array(16);
  function matrices(ex, ey, ez, yaw, pitch, fov) {
    const f = 1 / Math.tan(fov / 2), near = 0.05, far = 200;
    P.fill(0); P[0] = f / (W / H); P[5] = f; P[10] = far / (near - far); P[11] = -1; P[14] = near * far / (near - far);
    const cp = Math.cos(pitch), fx = Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    const rx = Math.cos(yaw), rz = Math.sin(yaw);                        // right = forward x world-up
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;           // up = right x forward
    V[0] = rx; V[4] = 0;  V[8] = rz;  V[12] = -(rx * ex + rz * ez);
    V[1] = ux; V[5] = uy; V[9] = uz;  V[13] = -(ux * ex + uy * ey + uz * ez);
    V[2] = -fx; V[6] = -fy; V[10] = -fz; V[14] = fx * ex + fy * ey + fz * ez;
    V[3] = 0; V[7] = 0; V[11] = 0; V[15] = 1;
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      UB[c * 4 + r] = P[r] * V[c * 4] + P[4 + r] * V[c * 4 + 1] + P[8 + r] * V[c * 4 + 2] + P[12 + r] * V[c * 4 + 3];
    }
  }

  const stats = { tris: 0, chunkX: 0, chunkZ: 0, level: 0 };
  // cam: { x, y, z, yaw, pitch, fov? (radians) }; out: the texture view to draw the final image into
  function render(out, cam, time) {
    matrices(cam.x, cam.y, cam.z, cam.yaw, cam.pitch, cam.fov || FOV);
    UB[16] = cam.x; UB[17] = cam.y; UB[18] = cam.z; UB[19] = time; UB[20] = seed;
    UB[24] = curLV; UB[25] = levelSeed(seed, curLV - 1); UB[26] = levelSeed(seed, curLV); UB[27] = levelSeed(seed, curLV + 1);
    Q.writeBuffer(ubo, 0, UB);
    PU[0] = time; PU[1] = EXPOSURE; PU[2] = BLOOM; PU[3] = GRAIN;
    Q.writeBuffer(puBuf, 0, PU);

    const enc = device.createCommandEncoder();
    let pass = enc.beginRenderPass(scenePass);
    pass.setPipeline(scenePipe); pass.setBindGroup(0, sceneBG); pass.setVertexBuffer(0, vbuf);
    // skip chunks entirely behind the camera (their centre more than a half-diagonal behind)
    const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw), half = CHUNK * CELL * 0.5;
    let verts = 0;
    for (let i = 0; i < SLOTS; i++) {
      if (!slotUsed[i]) continue;
      const vx = (slotCX[i] * CHUNK * CELL + half) - cam.x, vz = (slotCZ[i] * CHUNK * CELL + half) - cam.z;
      if (vx * fx + vz * fz < -half * 1.42) continue;
      pass.draw(slotN[i], 1, i * MAX_VERTS); verts += slotN[i];
    }
    pass.end();
    for (let i = 0; i < blits.length; i++) {
      const b = blits[i];
      pass = enc.beginRenderPass(b.pass); pass.setPipeline(b.pipe); pass.setBindGroup(0, b.bg); pass.draw(3); pass.end();
    }
    finalAtt.view = out;
    pass = enc.beginRenderPass(finalPass); pass.setPipeline(pFinal); pass.setBindGroup(0, finalBG); pass.draw(3); pass.end();
    Q.submit([enc.finish()]);
    stats.tris = verts / 3; stats.chunkX = curCX; stats.chunkZ = curCZ; stats.level = curLV;
  }

  return { resize, stream, render, stats, get width() { return W; }, get height() { return H; } };
}
