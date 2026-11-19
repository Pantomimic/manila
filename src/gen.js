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
export const DENSITY_U = Math.floor(0.35 * 2 ** 32), DOOR_U = Math.floor(0.35 * 2 ** 32);
function lineWall(seed, salt, line, along) {
  const len = 2 + hashU(seed, salt, line, 1) % 5;
  const off = hashU(seed, salt, line, 2) % len;
  const run = Math.floor((along + off) / len);
  if (hashU(seed, salt + 7, line, run) >= DENSITY_U) return false;
  return hashU(seed, salt + 13, line, along) >= DOOR_U;
}
export const wallH = (seed, x, z) => lineWall(seed, 101, z, x);
export const wallV = (seed, x, z) => lineWall(seed, 202, x, z);

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
const unit = (h) => (h >>> 8) / 16777216;
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
export const MAX_VERTS = 12 + CHUNK * CHUNK * 2 * 24 + MAX_HANG * 48;   // floor + ceiling + one slab per edge + hanging panels
const FLOATS = 7;                                       // [px, py, pz, nx, ny, nz, material]

// Writes the chunk's triangles into out (a Float32Array of at least MAX_VERTS * 7) and returns the
// vertex count. Materials: 0 carpet, 1 ceiling, 2 wallpaper, 3 light housing, 4 light diffuser, 5 cable.
export function buildChunk(seed, cx, cz, out) {
  let n = 0;
  const vert = (x, y, z, nx, ny, nz, m) => { out[n] = x; out[n + 1] = y; out[n + 2] = z; out[n + 3] = nx; out[n + 4] = ny; out[n + 5] = nz; out[n + 6] = m; n += FLOATS; };
  const quad = (ax, ay, az, bx, by, bz, cx_, cy, cz_, dx, dy, dz, nx, ny, nz, m) => {
    vert(ax, ay, az, nx, ny, nz, m); vert(bx, by, bz, nx, ny, nz, m); vert(cx_, cy, cz_, nx, ny, nz, m);
    vert(ax, ay, az, nx, ny, nz, m); vert(cx_, cy, cz_, nx, ny, nz, m); vert(dx, dy, dz, nx, ny, nz, m);
  };
  const H = HEIGHT;
  const box = (ax, az, bx, bz) => {
    quad(ax, 0, az, bx, 0, az, bx, H, az, ax, H, az, 0, 0, -1, 2);
    quad(bx, 0, bz, ax, 0, bz, ax, H, bz, bx, H, bz, 0, 0, 1, 2);
    quad(ax, 0, bz, ax, 0, az, ax, H, az, ax, H, bz, -1, 0, 0, 2);
    quad(bx, 0, az, bx, 0, bz, bx, H, bz, bx, H, az, 1, 0, 0, 2);
  };
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const X0 = x0 * CELL, X1 = x1 * CELL, Z0 = z0 * CELL, Z1 = z1 * CELL;
  quad(X0, 0, Z0, X0, 0, Z1, X1, 0, Z1, X1, 0, Z0, 0, 1, 0, 0);
  quad(X0, H, Z0, X1, H, Z0, X1, H, Z1, X0, H, Z1, 0, -1, 0, 1);
  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1;) {
      if (!wallH(seed, x, z)) { x++; continue; }
      let e = x; while (e < x1 && wallH(seed, e, z)) e++;
      const a = x === x0 && wallH(seed, x - 1, z) ? 0 : THICK, b = e === x1 && wallH(seed, e, z) ? 0 : THICK;
      box(x * CELL - a, z * CELL - THICK, e * CELL + b, z * CELL + THICK);
      x = e;
    }
  }
  for (let x = x0; x < x1; x++) {
    for (let z = z0; z < z1;) {
      if (!wallV(seed, x, z)) { z++; continue; }
      let e = z; while (e < z1 && wallV(seed, x, e)) e++;
      const a = z === z0 && wallV(seed, x, z - 1) ? 0 : THICK, b = e === z1 && wallV(seed, x, e) ? 0 : THICK;
      box(x * CELL - THICK, z * CELL - a, x * CELL + THICK, e * CELL + b);
      z = e;
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

// Push a circle of radius r at pos (pos[0] = x, pos[1] = z, in metres) out of nearby walls.
export function collide(seed, pos, r) {
  for (let pass = 0; pass < 2; pass++) {
    const cx = Math.floor(pos[0] / CELL), cz = Math.floor(pos[1] / CELL);
    for (let z = cz - 1; z <= cz + 2; z++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (wallH(seed, x, z)) push(pos, r, x * CELL - THICK, z * CELL - THICK, (x + 1) * CELL + THICK, z * CELL + THICK);
    }
    for (let x = cx - 1; x <= cx + 2; x++) for (let z = cz - 1; z <= cz + 1; z++) {
      if (wallV(seed, x, z)) push(pos, r, x * CELL - THICK, z * CELL - THICK, x * CELL + THICK, (z + 1) * CELL + THICK);
    }
  }
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
