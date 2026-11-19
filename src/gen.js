// World layout. Every wall is a pure function of (seed, global grid position), so any part of the
// world can be built on its own and neighbouring pieces always agree — that is what lets the world
// stream in endlessly later.
//
// The world is a grid of square cells CELL metres wide. Walls sit on the grid lines between cells:
//   wallH(x, z): the edge on horizontal line z, running from x to x+1 (separates rows z-1 and z)
//   wallV(x, z): the edge on vertical line x, running from z to z+1 (separates columns x-1 and x)

export const CELL = 3, HEIGHT = 2.8, THICK = 0.1;

// 32-bit integer hash of four ints -> uint32. shaders.js has an exact WGSL copy (hashU), and the
// wall rules below use only integer maths, so the GPU computes the very same walls (for light occlusion).
export function hashU(a, b, c, d) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ c, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ d, 0x165667b1);
  return (h ^ (h >>> 16)) >>> 0;
}
export const hash = (a, b, c, d) => hashU(a, b, c, d) / 4294967296;   // -> [0, 1)

// One grid line: walls come in runs. Each line has its own run length (2..6 cells) and phase, a run
// is solid with probability DENSITY, and single edges are knocked out as doorways. ~95% of cells end
// up reachable; the sealed-off pockets are kept on purpose.
// lineKind: 0 open (no wall), 1 wall, 2 doorway (a gap in a solid run, framed: see doorShape).
export const DENSITY_U = Math.floor(0.35 * 2 ** 32), DOOR_U = Math.floor(0.35 * 2 ** 32);
export const SALT_H = 101, SALT_V = 202;
export function lineKind(seed, salt, line, along) {
  const len = 2 + hashU(seed, salt, line, 1) % 5;
  const off = hashU(seed, salt, line, 2) % len;
  const run = Math.floor((along + off) / len);
  if (hashU(seed, salt + 7, line, run) >= DENSITY_U) return 0;
  return hashU(seed, salt + 13, line, along) >= DOOR_U ? 1 : 2;
}
export const kindH = (seed, x, z) => lineKind(seed, SALT_H, z, x);
export const kindV = (seed, x, z) => lineKind(seed, SALT_V, x, z);
export const wallH = (seed, x, z) => kindH(seed, x, z) === 1;
export const wallV = (seed, x, z) => kindV(seed, x, z) === 1;
const unit = (h) => (h >>> 8) / 16777216;

// The frame of a doorway edge, written into out: [type, lo, hi, top, apex]. lo..hi is the opening as a
// fraction of the edge, top the height of the lintel (the spring line for an arch), apex the arch top.
//   type 0: full-width opening with a dropped soffit above it
//   type 1: narrow door with wall on both sides and a flat lintel
//   type 2: arch
// The shader has the same rules (doorShape) so light only passes through the opening.
export function doorShape(seed, salt, line, along, out) {
  const r = unit(hashU(seed, salt + 21, line, along)), u2 = unit(hashU(seed, salt + 22, line, along)), u3 = unit(hashU(seed, salt + 23, line, along));
  if (r < 0.4) { out[0] = 0; out[1] = 0; out[2] = 1; out[3] = out[4] = 2.05 + 0.3 * u2; return out; }
  let w, top, apex;
  if (r < 0.75) { out[0] = 1; w = 1.0 + 0.6 * u2; top = apex = 2.05 + 0.15 * u3; }
  else { out[0] = 2; w = 1.4 + 1.0 * u2; top = 1.75 + 0.2 * u3; apex = Math.min(HEIGHT - 0.12, top + w * 0.35); }
  const c = 0.5 * CELL + (unit(hashU(seed, salt + 24, line, along)) - 0.5) * (CELL - w - 0.6);
  out[1] = (c - w * 0.5) / CELL; out[2] = (c + w * 0.5) / CELL; out[3] = top; out[4] = apex;
  return out;
}

// Bowed walls: some unbroken wall segments bulge sideways in a smooth curve (zero at both ends). Only
// segments of up to BOW_MAX edges whose inner grid points touch nothing else may bow, so a curve never
// runs into another wall or door. Returns the bulge in metres (0 = straight) and sets bowS/bowE, the
// segment's first edge and one past its last.
const BOW_U = Math.floor(0.3 * 2 ** 32), BOW_MAX = 6;
export let bowS = 0, bowE = 0;
export function bow(seed, salt, line, along) {
  let s = along, e = along + 1;
  while (s > along - BOW_MAX && lineKind(seed, salt, line, s - 1) === 1) s--;
  while (e < along + BOW_MAX && lineKind(seed, salt, line, e) === 1) e++;
  bowS = s; bowE = e;
  if (e - s >= BOW_MAX || hashU(seed, salt + 31, line, s) >= BOW_U) return 0;
  const other = salt === SALT_H ? SALT_V : SALT_H;
  for (let v = s + 1; v < e; v++) if (lineKind(seed, other, v, line - 1) !== 0 || lineKind(seed, other, v, line) !== 0) return 0;
  const A = 0.25 + 0.35 * unit(hashU(seed, salt + 32, line, s));
  return (hashU(seed, salt + 33, line, s) & 1) ? A : -A;
}
// sideways offset of a bowed wall at position p metres along its line
const bowOff = (A, p) => A * Math.sin(Math.PI * (p - bowS * CELL) / ((bowE - bowS) * CELL));
const bowSlope = (A, p) => A * Math.PI / ((bowE - bowS) * CELL) * Math.cos(Math.PI * (p - bowS * CELL) / ((bowE - bowS) * CELL));

// Ceiling lights. Every cell has one 2x4 ft panel in the middle of its ceiling. Its state is a pure
// function of (seed, cell), with the exact same rules in the shader:
//   0 dead, 1 on, 2 flickering, 3 broken cover (bare tubes), 4 hanging (one end dropped out of the grid)
// Dark zones are ZONE x ZONE cell blocks where nearly every panel is dead. Odd states stay sparse.
const U = (p) => Math.floor(p * 2 ** 32);
export const ZONE = 5;
export const LIGHT_U = { darkZone: U(0.09), darkFlicker: U(0.07), dead: U(0.13), flicker: U(0.03), broken: U(0.06), hang: U(0.075) };
export function lightKind(seed, x, z) {
  const h = hashU(seed, 303, x, z);
  if (hashU(seed, 500, Math.floor(x / ZONE), Math.floor(z / ZONE)) < LIGHT_U.darkZone) return h < LIGHT_U.darkFlicker ? 2 : 0;
  if (h < LIGHT_U.dead) return 0;
  const k = hashU(seed, 304, x, z);
  return k < LIGHT_U.flicker ? 2 : k < LIGHT_U.broken ? 3 : k < LIGHT_U.hang ? 4 : 1;
}
// Brightness 0..1 at time t (seconds). Flickering panels (and half the hanging ones) mostly burn
// steadily, then stutter in bursts or drop out for half a second. The shader runs the same maths.
export function lightLevel(seed, x, z, kind, t) {
  if (kind === 0) return 0;
  const base = 0.82 + 0.18 * unit(hashU(seed, 306, x, z));
  if (kind !== 2 && !(kind === 4 && (hashU(seed, 305, x, z) & 1))) return base;
  const ph = unit(hashU(seed, 307, x, z)) * 64;
  const r = unit(hashU(seed + 7919, x, z, Math.floor(t * 2 + ph)));
  if (r < 0.2) return unit(hashU(seed + 7927, x, z, Math.floor(t * 23 + ph * 5))) < 0.55 ? base : 0.03;
  return r < 0.27 ? 0.02 : base;
}
// Hanging panel pose: angle below the ceiling (radians) and which end dropped (+1 = free end at +z).
export const hangAngle = (seed, x, z) => 0.65 + 0.5 * unit(hashU(seed, 310, x, z));
export const hangDir = (seed, x, z) => (hashU(seed, 311, x, z) & 1) ? 1 : -1;

// The world is streamed in square chunks of CHUNK x CHUNK cells. A chunk owns the horizontal edges on
// lines z0..z1-1 and the vertical edges on lines x0..x1-1 inside it, so every edge belongs to exactly
// one chunk. Wall runs that cross a chunk border are split there without the end overlap, so the
// two halves meet flush (no z-fighting).
export const CHUNK = 8;
export const MAX_HANG = 4;                              // hanging panels built per chunk (they're rare)
export const MAX_VERTS = 7000;   // measured worst case ~4900 over 22k chunks; buildChunk stops writing at the limit
const FLOATS = 7;                                       // [px, py, pz, nx, ny, nz, material]

// Writes the chunk's triangles into out (a Float32Array of at least MAX_VERTS * 7) and returns the
// vertex count. Materials: 0 carpet, 1 ceiling, 2 wallpaper, 3 light housing, 4 light diffuser, 5 cable.
export function buildChunk(seed, cx, cz, out) {
  let n = 0;
  const vert = (x, y, z, nx, ny, nz, m) => { if (n + FLOATS > out.length) return; out[n] = x; out[n + 1] = y; out[n + 2] = z; out[n + 3] = nx; out[n + 4] = ny; out[n + 5] = nz; out[n + 6] = m; n += FLOATS; };
  const quad = (ax, ay, az, bx, by, bz, cx_, cy, cz_, dx, dy, dz, nx, ny, nz, m) => {
    vert(ax, ay, az, nx, ny, nz, m); vert(bx, by, bz, nx, ny, nz, m); vert(cx_, cy, cz_, nx, ny, nz, m);
    vert(ax, ay, az, nx, ny, nz, m); vert(cx_, cy, cz_, nx, ny, nz, m); vert(dx, dy, dz, nx, ny, nz, m);
  };
  const H = HEIGHT;
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const X0 = x0 * CELL, X1 = x1 * CELL, Z0 = z0 * CELL, Z1 = z1 * CELL;
  quad(X0, 0, Z0, X0, 0, Z1, X1, 0, Z1, X1, 0, Z0, 0, 1, 0, 0);
  quad(X0, H, Z0, X1, H, Z0, X1, H, Z1, X0, H, Z1, 0, -1, 0, 1);
  // Everything on a grid line is built in line-local coordinates: a = metres along the line, o = sideways
  // offset from it, y = height. P maps them to world space for a horizontal (hor) or vertical line.
  let hor = true, LW = 0;
  const P = (a, o, y, na, no, ny, m) => hor ? vert(a, y, LW + o, na, ny, no, m) : vert(LW + o, y, a, no, ny, na, m);
  const Q = (a0, o0, y0, a1, o1, y1, a2, o2, y2, a3, o3, y3, na, no, ny, m) => {
    P(a0, o0, y0, na, no, ny, m); P(a1, o1, y1, na, no, ny, m); P(a2, o2, y2, na, no, ny, m);
    P(a0, o0, y0, na, no, ny, m); P(a2, o2, y2, na, no, ny, m); P(a3, o3, y3, na, no, ny, m);
  };
  // axis-aligned box on the line: two long sides, end caps, and a bottom face when it doesn't reach the floor
  const B = (a0, a1, y0, y1) => {
    const T = THICK;
    Q(a0, -T, y0, a1, -T, y0, a1, -T, y1, a0, -T, y1, 0, -1, 0, 2);
    Q(a0, T, y0, a1, T, y0, a1, T, y1, a0, T, y1, 0, 1, 0, 2);
    Q(a0, -T, y0, a0, T, y0, a0, T, y1, a0, -T, y1, -1, 0, 0, 2);
    Q(a1, -T, y0, a1, T, y0, a1, T, y1, a1, -T, y1, 1, 0, 0, 2);
    if (y0 > 0) Q(a0, -T, y0, a1, -T, y0, a1, T, y0, a0, T, y0, 0, 0, -1, 2);
  };
  const SUB = 6, ds = new Float64Array(5);
  for (const [salt, ext] of [[SALT_H, x0], [SALT_V, z0]]) {
    hor = salt === SALT_H;
    const l0 = hor ? z0 : x0, a0 = ext, a1 = ext + CHUNK;
    for (let line = l0; line < l0 + CHUNK; line++) {
      LW = line * CELL;
      for (let i = a0; i < a1;) {
        const k = lineKind(seed, salt, line, i);
        if (k === 2) {                       // doorway frame
          doorShape(seed, salt, line, i, ds);
          const u0 = i * CELL + (lineKind(seed, salt, line, i - 1) === 1 ? THICK : 0);
          const u1 = (i + 1) * CELL - (lineKind(seed, salt, line, i + 1) === 1 ? THICK : 0);
          if (ds[0] === 0) B(u0, u1, ds[3], H);
          else {
            const o0 = (i + ds[1]) * CELL, o1 = (i + ds[2]) * CELL;
            B(u0, o0, 0, H); B(o1, u1, 0, H);
            if (ds[0] === 1) B(o0, o1, ds[3], H);
            else {                           // arch: slices from the spring line up to the elliptical crown
              const N = 8, c = (o0 + o1) / 2, hw = (o1 - o0) / 2, T = THICK;
              const ay = (a) => ds[3] + (ds[4] - ds[3]) * Math.sqrt(Math.max(0, 1 - ((a - c) / hw) ** 2));
              for (let j = 0; j < N; j++) {
                const p0 = o0 + (o1 - o0) * j / N, p1 = o0 + (o1 - o0) * (j + 1) / N, y0 = ay(p0), y1 = ay(p1);
                Q(p0, -T, y0, p1, -T, y1, p1, -T, H, p0, -T, H, 0, -1, 0, 2);
                Q(p0, T, y0, p1, T, y1, p1, T, H, p0, T, H, 0, 1, 0, 2);
                const ta = p1 - p0, ty = y1 - y0, tl = Math.hypot(ta, ty);
                Q(p0, -T, y0, p1, -T, y1, p1, T, y1, p0, T, y0, ty / tl, 0, -ta / tl, 2);
              }
            }
          }
          i++; continue;
        }
        if (k === 0) { i++; continue; }
        const A = bow(seed, salt, line, i);
        let e = i; while (e < a1 && lineKind(seed, salt, line, e) === 1) e++;
        if (A === 0) {
          const ea = i === a0 && lineKind(seed, salt, line, i - 1) === 1 ? 0 : THICK, eb = e === a1 && lineKind(seed, salt, line, e) === 1 ? 0 : THICK;
          B(i * CELL - ea, e * CELL + eb, 0, H);
        } else {                             // bowed: SUB slices per edge, smooth normals
          const T = THICK;
          for (let j = i; j < e; j++) for (let q = 0; q < SUB; q++) {
            let p0 = (j + q / SUB) * CELL, p1 = (j + (q + 1) / SUB) * CELL;
            if (j === bowS && q === 0) p0 -= T;
            if (j === bowE - 1 && q === SUB - 1) p1 += T;
            const c0 = Math.min(Math.max(p0, bowS * CELL), bowE * CELL), c1 = Math.min(Math.max(p1, bowS * CELL), bowE * CELL);
            const f0 = bowOff(A, c0), f1 = bowOff(A, c1), s0 = bowSlope(A, c0), s1 = bowSlope(A, c1);
            const n0 = 1 / Math.hypot(1, s0), n1 = 1 / Math.hypot(1, s1);
            for (const sd of [-1, 1]) {
              P(p0, f0 + sd * T, 0, -sd * s0 * n0, sd * n0, 0, 2); P(p1, f1 + sd * T, 0, -sd * s1 * n1, sd * n1, 0, 2); P(p1, f1 + sd * T, H, -sd * s1 * n1, sd * n1, 0, 2);
              P(p0, f0 + sd * T, 0, -sd * s0 * n0, sd * n0, 0, 2); P(p1, f1 + sd * T, H, -sd * s1 * n1, sd * n1, 0, 2); P(p0, f0 + sd * T, H, -sd * s0 * n0, sd * n0, 0, 2);
            }
            if (j === bowS && q === 0) Q(p0, -T, 0, p0, T, 0, p0, T, H, p0, -T, H, -1, 0, 0, 2);
            if (j === bowE - 1 && q === SUB - 1) Q(p1, -T, 0, p1, T, 0, p1, T, H, p1, -T, H, 1, 0, 0, 2);
          }
        }
        i = e;
      }
    }
  }
  // hanging panels: a 0.6 x 1.2 m box hinged at one short end, the other end swung down, plus a cable
  let hung = 0;
  for (let z = z0; z < z1 && hung < MAX_HANG; z++) for (let x = x0; x < x1 && hung < MAX_HANG; x++) {
    if (lightKind(seed, x, z) !== 4) continue;
    hung++;
    const a = hangAngle(seed, x, z), s = hangDir(seed, x, z), ca = Math.cos(a), sa = Math.sin(a);
    const mx = (x + 0.5) * CELL, mz = (z + 0.5) * CELL, py = H - 0.1, pz = mz - s * 0.6;
    const uy = -sa, uz = s * ca;            // along the panel, hinge -> free end
    const ny = -ca, nz = -s * sa;           // diffuser normal (faces down/outward)
    const T = 0.1, L = 1.2, W = 0.3;
    // diffuser face corners (hinge h, free f) and the back face offset by -n*T
    const hy = py, hz = pz, fy = py + uy * L, fz = pz + uz * L;
    const by = -ny * T, bz = -nz * T;
    quad(mx - W, hy, hz, mx + W, hy, hz, mx + W, fy, fz, mx - W, fy, fz, 0, ny, nz, 4);
    quad(mx - W, hy + by, hz + bz, mx + W, hy + by, hz + bz, mx + W, fy + by, fz + bz, mx - W, fy + by, fz + bz, 0, -ny, -nz, 3);
    quad(mx - W, hy, hz, mx - W, fy, fz, mx - W, fy + by, fz + bz, mx - W, hy + by, hz + bz, -1, 0, 0, 3);
    quad(mx + W, hy, hz, mx + W, fy, fz, mx + W, fy + by, fz + bz, mx + W, hy + by, hz + bz, 1, 0, 0, 3);
    quad(mx - W, fy, fz, mx + W, fy, fz, mx + W, fy + by, fz + bz, mx - W, fy + by, fz + bz, 0, uy, uz, 3);
    quad(mx - W, hy, hz, mx + W, hy, hz, mx + W, hy + by, hz + bz, mx - W, hy + by, hz + bz, 0, -uy, -uz, 3);
    // a cable hanging out of the hole in the grid, as two crossed thin strips
    const wx = mx + 0.15, wz = mz + s * 0.25, ex = wx + 0.08, ey = H - 0.55 - 0.3 * sa, ez = wz + s * 0.12, k = 0.008;
    quad(wx - k, H, wz, wx + k, H, wz, ex + k, ey, ez, ex - k, ey, ez, 0, 0, 1, 5);
    quad(wx, H, wz - k, wx, H, wz + k, ex, ey, ez + k, ex, ey, ez - k, 1, 0, 0, 5);
  }
  return n / FLOATS;
}

// Push a circle of radius r at pos (pos[0] = x, pos[1] = z, in metres) out of nearby walls, door
// frames and bowed walls. Allocates nothing (it runs every frame).
const dsC = new Float64Array(5);
export function collide(seed, pos, r) {
  for (let pass = 0; pass < 2; pass++) {
    const cx = Math.floor(pos[0] / CELL), cz = Math.floor(pos[1] / CELL);
    for (let line = cz - 1; line <= cz + 2; line++) for (let i = cx - 1; i <= cx + 1; i++) edge(seed, SALT_H, line, i, pos, r);
    for (let line = cx - 1; line <= cx + 2; line++) for (let i = cz - 1; i <= cz + 1; i++) edge(seed, SALT_V, line, i, pos, r);
  }
}
function edge(seed, salt, line, i, pos, r) {
  const k = lineKind(seed, salt, line, i);
  if (k === 0) return;
  const hor = salt === SALT_H, L = line * CELL, T = THICK;
  if (k === 2) {
    doorShape(seed, salt, line, i, dsC);
    if (dsC[0] !== 0) { slab(hor, pos, r, L, i * CELL - T, (i + dsC[1]) * CELL); slab(hor, pos, r, L, (i + dsC[2]) * CELL, (i + 1) * CELL + T); }
    return;
  }
  const A = bow(seed, salt, line, i);
  if (A === 0) { slab(hor, pos, r, L, i * CELL - T, (i + 1) * CELL + T); return; }
  for (let q = 0; q < 4; q++) {
    const p0 = (i + q / 4) * CELL, p1 = (i + (q + 1) / 4) * CELL, f0 = bowOff(A, p0), f1 = bowOff(A, p1);
    if (hor) pushSeg(pos, r + T, p0, L + f0, p1, L + f1); else pushSeg(pos, r + T, L + f0, p0, L + f1, p1);
  }
}
// wall slab from a0 to a1 along line L
function slab(hor, pos, r, L, a0, a1) { if (hor) push(pos, r, a0, L - THICK, a1, L + THICK); else push(pos, r, L - THICK, a0, L + THICK, a1); }
// push a circle out of a line segment by distance rr
function pushSeg(pos, rr, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, t = Math.min(1, Math.max(0, ((pos[0] - ax) * ex + (pos[1] - az) * ez) / (ex * ex + ez * ez)));
  const dx = pos[0] - (ax + ex * t), dz = pos[1] - (az + ez * t), d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr || d2 < 1e-12) return;
  const d = Math.sqrt(d2), k = (rr - d) / d; pos[0] += dx * k; pos[1] += dz * k;
}
function push(pos, r, ax, az, bx, bz) {
  const qx = Math.min(Math.max(pos[0], ax), bx), qz = Math.min(Math.max(pos[1], az), bz);
  const dx = pos[0] - qx, dz = pos[1] - qz, d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return;
  if (d2 > 1e-12) { const d = Math.sqrt(d2), k = (r - d) / d; pos[0] += dx * k; pos[1] += dz * k; return; }
  // centre inside the slab: leave by the nearest face
  const l = pos[0] - ax + r, rr = bx - pos[0] + r, u = pos[1] - az + r, dn = bz - pos[1] + r, m = Math.min(l, rr, u, dn);
  if (m === l) pos[0] -= l; else if (m === rr) pos[0] += rr; else if (m === u) pos[1] -= u; else pos[1] += dn;
}

// A spawn cell that is part of the big connected maze, not one of the sealed-off pockets: flood-fill
// from candidate cells (spiralling out from the origin) until one reaches `need` cells.
export function findSpawn(seed, need = 600) {
  for (let r = 0; r < 50; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const seen = new Set([dx + ',' + dz]), stack = [dx, dz];
    while (stack.length && seen.size < need) {
      const z = stack.pop(), x = stack.pop();
      const step = (nx, nz, open) => { const k = nx + ',' + nz; if (open && !seen.has(k)) { seen.add(k); stack.push(nx, nz); } };
      step(x + 1, z, !wallV(seed, x + 1, z)); step(x - 1, z, !wallV(seed, x, z));
      step(x, z + 1, !wallH(seed, x, z + 1)); step(x, z - 1, !wallH(seed, x, z));
    }
    if (seen.size >= need) return [(dx + 0.5) * CELL, (dz + 0.5) * CELL];
  }
  return [CELL * 0.5, CELL * 0.5];
}
