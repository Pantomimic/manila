// The renderer: chunk streaming, the scene pass and post-processing. No DOM access, so the same code
// runs in the browser (main.js) and headless in Node for screenshots (tools/shot.mjs).
// No allocations in render() apart from what WebGPU itself needs per frame.
import { CELL, CHUNK, MAX_VERTS, edgeSpan, SALT_H, SALT_V, roomCell, hashU } from './gen.js';
import { FH, buildLevelChunk, levelSeed, levelOf, cellLight, lightGeom, shinyFrom } from './levels.js';
import { SCENE } from './shaders.js';
import { POST } from './post.js';

const HDR = 'rgba16float', DEPTH = 'depth24plus', LEVELS = 5;
// Chunks within RANGE (in chunks, square) of the camera's chunk are kept loaded. 3 -> 7x7 chunks,
// 72 m in every direction, well past where the fog swallows everything. The levels above and below
// are only seen through holes and stairwells, so they get RANGE2.
const RANGE = 3, RANGE2 = 1, SLOTS = (2 * RANGE + 1) ** 2 + 2 * (2 * RANGE2 + 1) ** 2, BUILDS_PER_FRAME = 2;
const FOV = 75 * Math.PI / 180, NEAR = 0.05, FAR = 200;
export const EXPOSURE = 1.0, BLOOM = 0.12, GRAIN = 0.035;

export function createRenderer(device, outFormat, seed) {
  const Q = device.queue, TU = GPUTextureUsage, BU = GPUBufferUsage;

  // ---- chunk streaming: one chunk per slot, each slot with its own vertex buffer, sized to fit (grown
  // in 256 kB steps and reused while it is big enough), so detailed rooms don't cost every slot memory ----
  const slotBuf = new Array(SLOTS).fill(null);
  const scratch = new Float32Array(MAX_VERTS * 7);
  const slotS = new Int32Array(SLOTS), slotCX = new Int32Array(SLOTS), slotCZ = new Int32Array(SLOTS), slotLV = new Int32Array(SLOTS), slotN = new Int32Array(SLOTS);
  const slotUsed = new Uint8Array(SLOTS);
  const want = new Int32Array(SLOTS * 3);          // chunks still to build (cx, cz, level), nearest first
  let nWant = 0, wantHead = 0, curCX = 1e9, curCZ = 1e9, curLV = 1e9;
  const loadChunk = (slot, cx, cz, lv) => {
    const n = buildLevelChunk(seed, lv, cx, cz, scratch);
    const bytes = Math.max(4, n * 28);
    if (!slotBuf[slot] || slotBuf[slot].size < bytes) {
      if (slotBuf[slot]) slotBuf[slot].destroy();
      slotBuf[slot] = device.createBuffer({ size: Math.ceil(bytes / 262144) * 262144, usage: BU.VERTEX | BU.COPY_DST });
    }
    if (n) Q.writeBuffer(slotBuf[slot], 0, scratch, 0, n * 7);
    slotS[slot] = shinyFrom; slotCX[slot] = cx; slotCZ[slot] = cz; slotLV[slot] = lv; slotN[slot] = n; slotUsed[slot] = 1;
  };
  const isLoaded = (cx, cz, lv) => { for (let i = 0; i < SLOTS; i++) if (slotUsed[i] && slotCX[i] === cx && slotCZ[i] === cz && slotLV[i] === lv) return true; return false; };
  // ---- world data the shader reads instead of re-deriving it per pixel: a DATA x DATA cell window
  // around the camera, addressed by world cell mod DATA, for the levels below, at and above the
  // camera (texture rows [0, DATA), [DATA, 2 DATA), [2 DATA, 3 DATA)). Columns [0, DATA) hold the
  // horizontal edge of each cell, [DATA, 2 DATA) the vertical edge (both as edgeSpan floats),
  // [2 DATA, 3 DATA) the light kind (x), special room theme + 1 (y), steady brightness (z) and flags (w),
  // [3 DATA, 4 DATA) the panel's rectangle (centre offset x, z from the cell centre, half sizes) and
  // [4 DATA, 5 DATA) where its light comes from (offset x, height, offset z) (levels.js lightGeom).
  const DATA = 64, COLS = DATA * 5, LG = new Float64Array(7);
  const dataArr = new Float32Array(COLS * DATA * 3 * 4);
  const dataTex = device.createTexture({ size: [COLS, DATA * 3], format: 'rgba32float', usage: TU.TEXTURE_BINDING | TU.COPY_DST });
  const fillData = (pcx, pcz, plv) => {
    const bx = pcx * CHUNK - 28, bz = pcz * CHUNK - 28;      // covers the loaded chunks plus one cell
    for (let li = 0; li < 3; li++) {
      const lv = plv - 1 + li, sL = levelSeed(seed, lv);
      for (let z = bz; z < bz + DATA; z++) for (let x = bx; x < bx + DATA; x++) {
        const row = ((z & (DATA - 1)) + li * DATA) * COLS, col = x & (DATA - 1);
        edgeSpan(sL, SALT_H, z, x, dataArr, (row + col) * 4);
        edgeSpan(sL, SALT_V, x, z, dataArr, (row + DATA + col) * 4);
        const kind = cellLight(seed, lv, x, z);
        lightGeom(seed, lv, x, z, kind, LG);
        dataArr[(row + 2 * DATA + col) * 4] = kind;
        for (let k = 0; k < 4; k++) dataArr[(row + 3 * DATA + col) * 4 + k] = LG[k];
        for (let k = 0; k < 3; k++) dataArr[(row + 4 * DATA + col) * 4 + k] = LG[4 + k];
        dataArr[(row + 2 * DATA + col) * 4 + 1] = roomCell(sL, x, z) + 1;      // special room theme + 1 (0: none)
        // the light's steady brightness (z) and two coin flips (w: 1 tube gone green, 2 hanging panel flickers),
        // worked out here once instead of per pixel per light in the shader; 4: the panel is off the grid or another size
        dataArr[(row + 2 * DATA + col) * 4 + 2] = 0.82 + 0.18 * ((hashU(sL, 306, x, z) >>> 8) / 16777216);
        dataArr[(row + 2 * DATA + col) * 4 + 3] = (hashU(sL, 313, x, z) & 1) + (kind === 4 ? 2 * (hashU(sL, 305, x, z) & 1) : 0) + (LG[0] || LG[1] || LG[2] !== 0.3 || LG[3] !== 0.6 ? 4 : 0);
      }
    }
    Q.writeTexture({ texture: dataTex }, dataArr, { bytesPerRow: COLS * 16 }, [COLS, DATA * 3]);
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
    const t0 = performance.now();
    for (let k = 0; k < limit && wantHead < nWant; k++, wantHead++) {
      if (k > 0 && limit < SLOTS && performance.now() - t0 > 6) break;   // a furnished chunk can take ~10 ms: one per frame then
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
  let MSAA = 4, AO = true;      // graphics settings (setQuality); pipelines and targets are rebuilt when they change
  const scenePipeDesc = (shiny) => ({
    layout: 'auto',
    vertex: { module: sceneMod, entryPoint: 'vs', buffers: [{ arrayStride: 28, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32' }] }] },
    fragment: { module: sceneMod, entryPoint: 'fs', targets: [{ format: HDR }], constants: { SHINY: shiny ? 1 : 0 } },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: MSAA },
  });
  // two pipelines from one shader: everything, then glossy materials again with highlights (see levels.js)
  let scenePipe, shinyPipe, sceneBG, shinyBG;
  const dataView = dataTex.createView();
  const scenePipes = () => {
    scenePipe = device.createRenderPipeline(scenePipeDesc(false)); shinyPipe = device.createRenderPipeline(scenePipeDesc(true));
    sceneBG = device.createBindGroup({ layout: scenePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: dataView }] });
    shinyBG = device.createBindGroup({ layout: shinyPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: dataView }] });
  };
  scenePipes();

  // ---- post pipelines ----
  const postMod = device.createShaderModule({ code: POST });
  // fsPre reads the depth buffer, which is multisampled or not: its own module for each
  const preMods = { 4: postMod, 1: null };
  const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const postPipe = (entry, format, blend, mod = postMod) => device.createRenderPipeline({ layout: 'auto',
    vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: entry, targets: [{ format, blend }] } });
  const pAO = postPipe('fsAO', 'rg16float'), pBlur = postPipe('fsBlur', 'rg16float'), pDown = postPipe('fsDown', HDR), pUp = postPipe('fsUp', HDR, ADD), pFinal = postPipe('fsFinal', outFormat);
  let pPre = postPipe('fsPre', HDR);
  // with AO off the final pass reads this 1x1 "fully open" texture instead
  const noAO = device.createTexture({ size: [1, 1], format: 'rg16float', usage: TU.TEXTURE_BINDING | TU.COPY_DST });
  Q.writeTexture({ texture: noAO }, new Uint16Array([0x3c00, 0x3c00]), { bytesPerRow: 4 }, [1, 1]);
  const noAOView = noAO.createView();
  const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const PU = new Float32Array(12);
  const puBuf = device.createBuffer({ size: 48, usage: BU.UNIFORM | BU.COPY_DST });

  // ---- size-dependent targets and the pass list; rebuilt only on resize ----
  let W = 0, H = 0, textures = [];
  const msaaAtt = { view: null, resolveTarget: null, loadOp: 'clear', storeOp: 'discard', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
  const depthAtt = { view: null, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 };   // kept: the AO pass reads it
  const scenePass = { colorAttachments: [msaaAtt], depthStencilAttachment: depthAtt };
  const finalAtt = { view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } };
  const finalPass = { colorAttachments: [finalAtt] };
  let blits = [], finalBG = null;     // blits: [{ pass, pipe, bg }]
  let hdrView = null;
  function resize(w, h, force) {
    if (w === W && h === H && !force) return;
    W = w; H = h;
    for (const t of textures) t.destroy();
    const mk = (tw, th, format, usage, sampleCount = 1) => { const t = device.createTexture({ size: [tw, th], format, usage, sampleCount }); textures.push(t); return t; };
    textures = [];
    const depth = mk(W, H, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, MSAA);
    const hdr = mk(W, H, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
    hdrView = hdr.createView(); depthAtt.view = depth.createView();
    if (MSAA > 1) { msaaAtt.view = mk(W, H, HDR, TU.RENDER_ATTACHMENT, MSAA).createView(); msaaAtt.resolveTarget = hdrView; msaaAtt.storeOp = 'discard'; }
    else { msaaAtt.view = hdrView; msaaAtt.resolveTarget = undefined; msaaAtt.storeOp = 'store'; }
    const lv = [];
    for (let i = 0; i < LEVELS; i++) lv.push(mk(Math.max(1, W >> (i + 1)), Math.max(1, H >> (i + 1)), HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING).createView());
    const bg = (pipe, view) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: smp }] });
    const pass = (view, load) => ({ colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
    const ao0 = mk(hw, hh, 'rg16float', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING).createView(), ao1 = mk(hw, hh, 'rg16float', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING).createView();
    blits = [
      { pass: pass(lv[0]), pipe: pPre, bg: device.createBindGroup({ layout: pPre.getBindGroupLayout(0), entries: [{ binding: 0, resource: hdrView }, { binding: 1, resource: smp }, { binding: 3, resource: { buffer: puBuf } }, { binding: 5, resource: depthAtt.view }] }) },
      ...(AO ? [{ pass: pass(ao0), pipe: pAO, bg: device.createBindGroup({ layout: pAO.getBindGroupLayout(0), entries: [{ binding: 0, resource: lv[0] }, { binding: 3, resource: { buffer: puBuf } }] }) },
      { pass: pass(ao1), pipe: pBlur, bg: device.createBindGroup({ layout: pBlur.getBindGroupLayout(0), entries: [{ binding: 4, resource: ao0 }] }) }] : [])];
    for (let i = 1; i < LEVELS; i++) blits.push({ pass: pass(lv[i]), pipe: pDown, bg: bg(pDown, lv[i - 1]) });
    for (let i = LEVELS - 2; i >= 0; i--) blits.push({ pass: pass(lv[i], true), pipe: pUp, bg: bg(pUp, lv[i + 1]) });
    finalBG = device.createBindGroup({ layout: pFinal.getBindGroupLayout(0), entries: [
      { binding: 0, resource: hdrView }, { binding: 1, resource: smp }, { binding: 2, resource: lv[0] }, { binding: 3, resource: { buffer: puBuf } }, { binding: 4, resource: AO ? ao1 : noAOView }] });
  }
  // graphics settings: msaa 1 or 4, ao on or off (resolution is the caller's canvas size)
  function setQuality(msaa, ao) {
    msaa = msaa > 1 ? 4 : 1; ao = !!ao;
    if (msaa === MSAA && ao === AO) return;
    if (msaa !== MSAA) {
      MSAA = msaa;
      if (!preMods[MSAA]) preMods[MSAA] = device.createShaderModule({ code: POST.replace('texture_depth_multisampled_2d', 'texture_depth_2d') });
      pPre = postPipe('fsPre', HDR, undefined, preMods[MSAA]);
      scenePipes();
    }
    AO = ao;
    if (W) resize(W, H, true);
  }

  // view-projection matrix, column-major, WebGPU depth range 0..1
  const P = new Float32Array(16), V = new Float32Array(16);
  function matrices(ex, ey, ez, yaw, pitch, fov) {
    const f = 1 / Math.tan(fov / 2), near = NEAR, far = FAR;
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
  const look = { camcorder: false, exposure: 1, hall: 0 };   // set by the page: camcorder look, auto-exposure factor, hallway darkness 0..1
  // cam: { x, y, z, yaw, pitch, fov? (radians) }; out: the texture view to draw the final image into
  function render(out, cam, time) {
    matrices(cam.x, cam.y, cam.z, cam.yaw, cam.pitch, cam.fov || FOV);
    UB[16] = cam.x; UB[17] = cam.y; UB[18] = cam.z; UB[19] = time; UB[20] = seed; UB[21] = look.hall;
    UB[24] = curLV; UB[25] = levelSeed(seed, curLV - 1); UB[26] = levelSeed(seed, curLV); UB[27] = levelSeed(seed, curLV + 1);
    Q.writeBuffer(ubo, 0, UB);
    PU[0] = time; PU[1] = EXPOSURE; PU[2] = BLOOM; PU[3] = GRAIN; PU[4] = look.camcorder ? 1 : 0; PU[5] = look.exposure;
    const th = Math.tan((cam.fov || FOV) / 2); PU[8] = th * W / H; PU[9] = th; PU[10] = NEAR; PU[11] = FAR;
    Q.writeBuffer(puBuf, 0, PU);

    const enc = device.createCommandEncoder();
    let pass = enc.beginRenderPass(scenePass);
    pass.setPipeline(scenePipe); pass.setBindGroup(0, sceneBG);
    // skip chunks entirely behind the camera (their centre more than a half-diagonal behind)
    const fx = Math.sin(cam.yaw), fz = -Math.cos(cam.yaw), half = CHUNK * CELL * 0.5;
    let verts = 0;
    for (let k = 0; k < 2; k++) {
      if (k === 1) { pass.setPipeline(shinyPipe); pass.setBindGroup(0, shinyBG); }
      for (let i = 0; i < SLOTS; i++) {
        if (!slotUsed[i] || !slotN[i]) continue;
        const vx = (slotCX[i] * CHUNK * CELL + half) - cam.x, vz = (slotCZ[i] * CHUNK * CELL + half) - cam.z;
        if (vx * fx + vz * fz < -half * 1.42) continue;
        const a = k ? slotS[i] : 0, b = k ? slotN[i] : slotS[i];
        if (b > a) { pass.setVertexBuffer(0, slotBuf[i]); pass.draw(b - a, 1, a); verts += b - a; }
      }
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

  return { resize, setQuality, stream, render, stats, look, get width() { return W; }, get height() { return H; } };
}
