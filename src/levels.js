// Floors stacked on floors, and the things that go wrong the further out you get.
//
// Level lv's floor sits at y = lv * FH. Each level has its own layout (its own seed, from levelSeed)
// and they connect two ways: drop holes in the floor, and stairs that rise through a stairwell into
// the level above. A mutation level 0..8, growing with distance from the origin (going up or down
// counts too), makes the odd things more common: missing ceiling tiles with cable bundles hanging out,
// and "wrong" objects (a backwards stop sign stuck in the carpet, desks sunk into the floor or through
// a wall, stretched chairs, a chair on the ceiling, a door frame standing on its own).
// Everything here is a pure function of (seed, level, cell), like the walls in gen.js.
import { CELL, HEIGHT, THICK, CHUNK, hashU, buildChunk, lightKind, kindH, kindV, wallLike } from './gen.js';

export const FH = 3.4;                       // floor to floor: 2.8 m room + 0.6 m ceiling void and slab
const U = (p) => Math.floor(p * 2 ** 32);
const unit = (h) => (h >>> 8) / 16777216;
export const levelSeed = (seed, lv) => lv === 0 ? seed : 1 + hashU(seed, 900, lv, 7) % 16777214;
export const levelOf = (y) => Math.floor((y + 0.05) / FH);

// ---- mutation: 0 near the start, +1 every 40 cells (120 m) out, levels count as 25 cells each ----
export const MUT_STEP = 40, MUT_LEVEL = 25;
export function mutation(lv, x, z) {
  if (Math.abs(x) > 2000 || Math.abs(z) > 2000 || Math.abs(lv) > 60) return 8;
  const d2 = x * x + z * z + lv * MUT_LEVEL * lv * MUT_LEVEL;
  let k = 0; while (k < 8 && d2 >= ((k + 1) * MUT_STEP) ** 2) k++;
  return k;
}
const ramp = (a, b) => Array.from({ length: 9 }, (_, k) => U(a + (b - a) * k / 8));
// per mutation level: missing ceiling tile, wrong object per cell, drop hole per cell
export const MISS_U = ramp(0.004, 0.06), PROP_U = ramp(0.0015, 0.035), DROP_U = ramp(0.003, 0.012);
const STAIR_U = U(0.006);

// ---- stairs and holes ----
// raw rolls; the rules below keep a cell from holding two openings that would fight
const S = (seed, lv, x, z) => hashU(seed, 910 + lv * 31, x, z) < STAIR_U;
const D = (seed, lv, x, z) => hashU(seed, 920 + lv * 31, x, z) < DROP_U[mutation(lv, x, z)];
export const stairAt = (seed, lv, x, z) => S(seed, lv, x, z) && !S(seed, lv - 1, x, z);
export const dropAt = (seed, lv, x, z) => D(seed, lv, x, z) && !S(seed, lv, x, z) && !S(seed, lv - 1, x, z);

// Stair in cell (x, z) of level lv, written into st: [dx, dz, half width, steps, open0, variant].
// It climbs FH over RUN metres along (dx, dz), centred in the cell. Variants: 0 normal, 1 a few
// giant steps, 2 lots of tiny ones, 3 very narrow, 4 very wide, 5 a stairwell so low you must crouch.
// open0: where along the run (0..1) the stairwell opening in the ceiling starts.
export const RUN = 2.3;
export function stairShape(seed, lv, x, z, st) {
  const h = hashU(seed, 930 + lv * 31, x, z), d = h & 3, v = (h >>> 2) % 6;
  st[0] = d === 0 ? 1 : d === 1 ? -1 : 0; st[1] = d === 2 ? 1 : d === 3 ? -1 : 0;
  st[2] = v === 3 ? 0.36 : v === 4 ? 1.15 : 0.62;
  st[3] = v === 1 ? 5 : v === 2 ? 30 : 14;
  const rise = FH / st[3], clear = v === 5 ? 1.6 : 1.0;  // ground height you may reach under the ceiling
  st[4] = Math.max(0.1, Math.floor(clear / rise) / st[3] - 0.03);
  st[5] = v;
  return st;
}
// opening rect of a stairwell (ceiling of lv, floor of lv + 1)
function wellRect(x, z, st, r) {
  const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL, w = st[2] + 0.1;
  const a = -RUN / 2 + st[4] * RUN, b = RUN / 2;          // along the run
  if (st[0] !== 0) { const p = cx + st[0] * a, q = cx + st[0] * b; r[0] = Math.min(p, q); r[2] = Math.max(p, q); r[1] = cz - w; r[3] = cz + w; }
  else { const p = cz + st[1] * a, q = cz + st[1] * b; r[1] = Math.min(p, q); r[3] = Math.max(p, q); r[0] = cx - w; r[2] = cx + w; }
  return r;
}
function dropRect(seed, lv, x, z, r) {
  const h1 = hashU(seed, 940 + lv * 31, x, z), h2 = hashU(seed, 941 + lv * 31, x, z);
  const hx = 0.45 + 0.6 * unit(h1), hz = 0.7 + 0.45 * unit(h2);
  const cx = (x + 0.5) * CELL + ((h1 & 255) / 255 - 0.5) * 0.2, cz = (z + 0.5) * CELL + ((h2 & 255) / 255 - 0.5) * 0.2;
  r[0] = cx - hx; r[1] = cz - hz; r[2] = cx + hx; r[3] = cz + hz;
  return r;
}
const stH = new Float64Array(6);
// opening in the floor of level lv at cell (x, z): a drop hole, or the top of a stairwell from below
export function floorHole(seed, lv, x, z, r) {
  if (dropAt(seed, lv, x, z)) { dropRect(seed, lv, x, z, r); return true; }
  if (stairAt(seed, lv - 1, x, z)) { wellRect(x, z, stairShape(seed, lv - 1, x, z, stH), r); return true; }
  return false;
}
export const ceilHole = (seed, lv, x, z, r) => floorHole(seed, lv + 1, x, z, r);
const rH = new Float64Array(4);
const inRect = (r, px, pz) => px > r[0] && px < r[2] && pz > r[1] && pz < r[3];
// light kind of a cell, with panels removed where the ceiling is open
export function cellLight(seed, lv, x, z) {
  return ceilHole(seed, lv, x, z, rH) ? 0 : lightKind(levelSeed(seed, lv), x, z);
}

// Height of whatever you would stand on at (px, pz), starting from level lv and falling through
// openings. Stairs are stepped: each tread is flat.
export function groundAt(seed, lv, px, pz) {
  const x = Math.floor(px / CELL), z = Math.floor(pz / CELL);
  for (let l = lv; l > lv - 4; l--) {
    if (stairAt(seed, l, x, z)) {
      stairShape(seed, l, x, z, stH);
      const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL;
      const along = (stH[0] !== 0 ? (px - cx) * stH[0] : (pz - cz) * stH[1]) + RUN / 2;
      const across = Math.abs(stH[0] !== 0 ? pz - cz : px - cx);
      if (along >= 0 && along <= RUN && across <= stH[2]) {
        const i = Math.min(stH[3] - 1, Math.floor(along / RUN * stH[3]));
        return l * FH + (i + 1) * FH / stH[3];
      }
    }
    if (!(floorHole(seed, l, x, z, rH) && inRect(rH, px, pz))) return l * FH;
  }
  return (lv - 3) * FH;
}
// height of the ceiling above (px, pz) for someone standing in level lv
export function ceilAt(seed, lv, px, pz) {
  const x = Math.floor(px / CELL), z = Math.floor(pz / CELL);
  return lv * FH + HEIGHT + (ceilHole(seed, lv, x, z, rH) && inRect(rH, px, pz) ? FH : 0);
}

// ---- missing ceiling tiles (0.6 m tiles, grid offset 0.3 m in z so panels fill whole tiles) ----
// Same rule in the shader. Never the two tiles a light panel sits in.
const md = (a, b) => ((a % b) + b) % b;
export function tileMissing(seedL, lv, tx, tz) {
  if (md(tx, 5) === 2 && (md(tz, 5) === 1 || md(tz, 5) === 2)) return false;
  return hashU(seedL, 700, tx, tz) < MISS_U[mutation(lv, Math.floor(tx / 5), Math.floor((tz + 1) / 5))];
}

// ---- wrong objects ----
// prop in cell (x, z) of level lv: [type, yaw, a, b] or type -1. Types: 0 backwards stop sign,
// 1 desk sunk into the floor, 2 desk through a wall, 3 stretched chair, 4 chair on the ceiling,
// 5 filing cabinet tilted into the floor, 6 a lone door frame
const pr = new Float64Array(4);
export function propAt(seed, lv, x, z, out = pr) {
  out[0] = -1;
  if (hashU(seed, 950 + lv * 31, x, z) >= PROP_U[mutation(lv, x, z)]) return out;
  if (stairAt(seed, lv, x, z) || floorHole(seed, lv, x, z, rH) || ceilHole(seed, lv, x, z, rH)) return out;
  const h = hashU(seed, 951 + lv * 31, x, z);
  let t = h % 7;
  out[1] = unit(hashU(seed, 952 + lv * 31, x, z)) * Math.PI * 2;
  out[2] = unit(hashU(seed, 953 + lv * 31, x, z)); out[3] = unit(hashU(seed, 954 + lv * 31, x, z));
  if (t === 2) {                    // needs a wall on one of the cell's edges; the desk straddles it
    const sL = levelSeed(seed, lv);
    const side = wallLike(kindH(sL, x, z)) ? 0 : wallLike(kindH(sL, x, z + 1)) ? 1 : wallLike(kindV(sL, x, z)) ? 2 : wallLike(kindV(sL, x + 1, z)) ? 3 : -1;
    if (side < 0) t = 1; else out[1] = side;
  }
  out[0] = t;
  return out;
}
// where a prop blocks you: up to two circles [x, z, r]
const circ = new Float64Array(6);
function propCircles(seed, lv, x, z) {
  const p = propAt(seed, lv, x, z), t = p[0];
  circ[2] = circ[5] = 0;
  if (t < 0 || t === 4) return circ;
  const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL;
  if (t === 2) {
    const s = p[1];
    circ[0] = s >= 2 ? (s === 2 ? x : x + 1) * CELL : cx + (p[2] - 0.5) * 1.2;
    circ[1] = s < 2 ? (s === 0 ? z : z + 1) * CELL : cz + (p[2] - 0.5) * 1.2;
    circ[2] = 0.75; return circ;
  }
  if (t === 6) {                    // two posts of the door frame
    const c = Math.cos(p[1]), sn = Math.sin(p[1]);
    circ[0] = cx + c * 0.62; circ[1] = cz + sn * 0.62; circ[2] = 0.2;
    circ[3] = cx - c * 0.62; circ[4] = cz - sn * 0.62; circ[5] = 0.2;
    return circ;
  }
  circ[0] = cx; circ[1] = cz; circ[2] = t === 0 ? 0.15 : t === 1 ? 0.75 : t === 3 ? 0.4 : 0.45;
  return circ;
}
export function collideProps(seed, lv, pos, r) {
  const cx = Math.floor(pos[0] / CELL), cz = Math.floor(pos[1] / CELL);
  for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
    const c = propCircles(seed, lv, x, z);
    for (let k = 0; k < 6; k += 3) {
      if (c[k + 2] <= 0) continue;
      const dx = pos[0] - c[k], dz = pos[1] - c[k + 1], d = Math.hypot(dx, dz), rr = r + c[k + 2];
      if (d < rr && d > 1e-6) { pos[0] = c[k] + dx / d * rr; pos[1] = c[k + 1] + dz / d * rr; }
    }
  }
}

// ---- building a level's chunk: walls (gen.js) with openings, then stairs, shafts, cables, props ----
const FLOATS = 7;
export function buildLevelChunk(seed, lv, cx, cz, out) {
  const sL = levelSeed(seed, lv), y0 = lv * FH;
  let n = buildChunk(sL, cx, cz, out, {
    y0,
    floorHole: (x, z, r) => floorHole(seed, lv, x, z, r),
    ceilHole: (x, z, r) => ceilHole(seed, lv, x, z, r),
    light: (x, z) => cellLight(seed, lv, x, z),
  }) * FLOATS;
  const V = (x, y, z, nx, ny, nz, m) => { if (n + FLOATS > out.length) return; out[n] = x; out[n + 1] = y; out[n + 2] = z; out[n + 3] = nx; out[n + 4] = ny; out[n + 5] = nz; out[n + 6] = m; n += FLOATS; };
  const Q = (a, b, c, d, nx, ny, nz, m) => { V(...a, nx, ny, nz, m); V(...b, nx, ny, nz, m); V(...c, nx, ny, nz, m); V(...a, nx, ny, nz, m); V(...c, nx, ny, nz, m); V(...d, nx, ny, nz, m); };
  // oriented box: centre c, half sizes h, rotation R (3x3, columns = local axes), material m
  const OB = (c, h, R, m) => {
    const P = (sx, sy, sz) => [c[0] + R[0] * sx * h[0] + R[3] * sy * h[1] + R[6] * sz * h[2], c[1] + R[1] * sx * h[0] + R[4] * sy * h[1] + R[7] * sz * h[2], c[2] + R[2] * sx * h[0] + R[5] * sy * h[1] + R[8] * sz * h[2]];
    const face = (ax, s, m2) => {             // the face whose normal is local axis ax * s
      const u = (ax + 1) % 3, v = (ax + 2) % 3, pt = (a, b) => { const q = [0, 0, 0]; q[ax] = s; q[u] = a; q[v] = b; return P(q[0], q[1], q[2]); };
      Q(pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1), R[ax * 3] * s, R[ax * 3 + 1] * s, R[ax * 3 + 2] * s, m2);
    };
    for (let ax = 0; ax < 3; ax++) { face(ax, 1, m); face(ax, -1, m); }
  };
  // rotation from yaw (about y), then pitch (about local x), then roll (about local z)
  const rot = (yaw, pitch = 0, roll = 0) => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    const X = [cy, 0, -sy], Y = [0, 1, 0], Z = [sy, 0, cy];
    const Y1 = [Y[0] * cp + Z[0] * sp, Y[1] * cp + Z[1] * sp, Y[2] * cp + Z[2] * sp], Z1 = [Z[0] * cp - Y[0] * sp, Z[1] * cp - Y[1] * sp, Z[2] * cp - Y[2] * sp];
    const X2 = [X[0] * cr + Y1[0] * sr, X[1] * cr + Y1[1] * sr, X[2] * cr + Y1[2] * sr], Y2 = [Y1[0] * cr - X[0] * sr, Y1[1] * cr - X[1] * sr, Y1[2] * cr - X[2] * sr];
    return [...X2, ...Y2, ...Z1];
  };
  const loc = (R, o, l) => [o[0] + R[0] * l[0] + R[3] * l[1] + R[6] * l[2], o[1] + R[1] * l[0] + R[4] * l[1] + R[7] * l[2], o[2] + R[2] * l[0] + R[5] * l[1] + R[8] * l[2]];

  const st = new Float64Array(6), r = new Float64Array(4), p = new Float64Array(4);
  const x0 = cx * CHUNK, z0 = cz * CHUNK, MAX_BUNDLES = 8;
  let bundles = 0;
  for (let z = z0; z < z0 + CHUNK; z++) for (let x = x0; x < x0 + CHUNK; x++) {
    const mx = (x + 0.5) * CELL, mz = (z + 0.5) * CELL;
    // shaft lining between this level's ceiling and the next floor, around any ceiling opening
    if (ceilHole(seed, lv, x, z, r)) {
      const ya = y0 + HEIGHT, yb = y0 + FH;
      Q([r[0], ya, r[1]], [r[2], ya, r[1]], [r[2], yb, r[1]], [r[0], yb, r[1]], 0, 0, 1, 11);
      Q([r[0], ya, r[3]], [r[2], ya, r[3]], [r[2], yb, r[3]], [r[0], yb, r[3]], 0, 0, -1, 11);
      Q([r[0], ya, r[1]], [r[0], ya, r[3]], [r[0], yb, r[3]], [r[0], yb, r[1]], 1, 0, 0, 11);
      Q([r[2], ya, r[1]], [r[2], ya, r[3]], [r[2], yb, r[3]], [r[2], yb, r[1]], -1, 0, 0, 11);
    }
    // stairs: n solid steps, carpet on the treads
    if (stairAt(seed, lv, x, z)) {
      stairShape(seed, lv, x, z, st);
      const [dx, dz, hw, N] = st, px = -dz, pz = dx, rise = FH / N;
      const at = (s, a, y) => [mx + dx * (s - RUN / 2) + px * a, y0 + y, mz + dz * (s - RUN / 2) + pz * a];
      for (let i = 0; i < N; i++) {
        const s0 = RUN * i / N, s1 = RUN * (i + 1) / N, y = rise * (i + 1);
        Q(at(s0, -hw, y), at(s0, hw, y), at(s1, hw, y), at(s1, -hw, y), 0, 1, 0, 0);
        Q(at(s0, -hw, y - rise), at(s0, hw, y - rise), at(s0, hw, y), at(s0, -hw, y), -dx, 0, -dz, 11);
        Q(at(s0, -hw, 0), at(s1, -hw, 0), at(s1, -hw, y), at(s0, -hw, y), -px, 0, -pz, 11);
        Q(at(s0, hw, 0), at(s1, hw, 0), at(s1, hw, y), at(s0, hw, y), px, 0, pz, 11);
      }
      Q(at(RUN, -hw, 0), at(RUN, hw, 0), at(RUN, hw, FH), at(RUN, -hw, FH), dx, 0, dz, 11);
    }
    if (ceilHole(seed, lv, x, z, r)) continue;
    // cable bundles drooping out of missing ceiling tiles
    const tx0 = x * 5, tz0 = Math.floor((z * CELL - 0.3) / 0.6);
    for (let tz = tz0; tz < tz0 + 6; tz++) for (let tx = tx0; tx < tx0 + 5; tx++) {
      const ccz = 0.3 + (tz + 0.5) * 0.6;
      if (ccz < z * CELL || ccz >= (z + 1) * CELL) continue;          // tile centre must be in this cell
      if (bundles >= MAX_BUNDLES || !tileMissing(sL, lv, tx, tz) || hashU(sL, 701, tx, tz) >= U(0.3)) continue;
      bundles++;
      // a bundle: k cables leaving the hole roughly together, each drooping a little differently
      const ccx = (tx + 0.5) * 0.6, k = 3 + hashU(sL, 702, tx, tz) % 5, hb = hashU(sL, 704, tx, tz);
      const ang0 = unit(hb) * 6.283, len0 = 0.8 + 1.6 * unit(hashU(sL, 705, tx, tz)), sag0 = 0.4 + 0.9 * unit(hashU(sL, 706, tx, tz));
      for (let c = 0; c < k; c++) {
        const hc = hashU(sL, 703 + c, tx, tz), jit = (b) => ((hc >>> b) & 255) / 255 - 0.5;
        const ang = ang0 + jit(0) * 0.5, len = len0 * (1 + jit(8) * 0.3), sag = sag0 * (1 + jit(16) * 0.5);
        const loop = (hc >>> 24) % 5 !== 0;    // most loop back up into the ceiling, some just dangle
        const ax = ccx + jit(4) * 0.2, az = ccz + jit(12) * 0.2;
        const bx = ax + Math.cos(ang) * len, bz = az + Math.sin(ang) * len, w = 0.005 + 0.004 * ((hc >>> 20) & 3) / 3;
        const SEG = 8, pt = (t) => loop
          ? [ax + (bx - ax) * t, y0 + HEIGHT + 0.05 - sag * 4 * t * (1 - t), az + (bz - az) * t]
          : [ax + (bx - ax) * 0.12 * t, y0 + HEIGHT + 0.05 - sag * 1.3 * t, az + (bz - az) * 0.12 * t];
        for (let j = 0; j < SEG; j++) {
          const a = pt(j / SEG), b = pt((j + 1) / SEG);
          Q([a[0] - w, a[1], a[2]], [a[0] + w, a[1], a[2]], [b[0] + w, b[1], b[2]], [b[0] - w, b[1], b[2]], 0, 0, 1, 5);
          Q([a[0], a[1], a[2] - w], [a[0], a[1], a[2] + w], [b[0], b[1], b[2] + w], [b[0], b[1], b[2] - w], 1, 0, 0, 5);
        }
      }
    }
    // wrong objects
    propAt(seed, lv, x, z, p);
    const t = p[0];
    if (t < 0) continue;
    const yaw = p[1];
    const desk = (o, R) => {                   // 1.4 x 0.7 office desk, origin at the floor centre
      OB(loc(R, o, [0, 0.74, 0]), [0.7, 0.02, 0.35], R, 9);
      for (const [lx, lz] of [[-0.66, -0.31], [0.66, -0.31], [-0.66, 0.31], [0.66, 0.31]]) OB(loc(R, o, [lx, 0.36, lz]), [0.025, 0.36, 0.025], R, 6);
      OB(loc(R, o, [0, 0.45, -0.3]), [0.62, 0.25, 0.01], R, 9);
    };
    const chair = (o, R, legs = 0.45, back = 0.45) => {
      OB(loc(R, o, [0, legs, 0]), [0.24, 0.04, 0.24], R, 10);
      OB(loc(R, o, [0, legs + 0.04 + back, -0.22]), [0.22, back, 0.03], R, 10);
      OB(loc(R, o, [0, legs / 2, 0]), [0.025, legs / 2, 0.025], R, 6);
      for (let k = 0; k < 5; k++) {          // five-star base: each leg's axes are R turned by a about local y
        const a = k * 1.2566, c = Math.cos(a), sn = Math.sin(a);
        const Rk = [R[0] * c + R[6] * sn, R[1] * c + R[7] * sn, R[2] * c + R[8] * sn, R[3], R[4], R[5], R[6] * c - R[0] * sn, R[7] * c - R[1] * sn, R[8] * c - R[2] * sn];
        OB(loc(R, o, [c * 0.15, 0.04, sn * 0.15]), [0.15, 0.015, 0.02], Rk, 6);
      }
    };
    if (t === 0) {                             // stop sign, stuck in the floor at a lean, facing the wrong way
      const R = rot(yaw, (p[2] - 0.5) * 0.7, (p[3] - 0.5) * 0.5), o = [mx, y0 - 0.35, mz];
      OB(loc(R, o, [0, 1.1, 0]), [0.03, 1.1, 0.03], R, 6);
      const c = loc(R, o, [0, 2.05, 0.04]), oct = (rad, zoff, m, nz) => {
        for (let k = 0; k < 8; k++) {
          const a0 = (k + 0.5) * Math.PI / 4, a1 = (k + 1.5) * Math.PI / 4;
          const A = loc(R, c, [0, 0, zoff]), B = loc(R, c, [Math.cos(a0) * rad, Math.sin(a0) * rad, zoff]), C = loc(R, c, [Math.cos(a1) * rad, Math.sin(a1) * rad, zoff]);
          V(...A, R[6] * nz, R[7] * nz, R[8] * nz, m); V(...B, R[6] * nz, R[7] * nz, R[8] * nz, m); V(...C, R[6] * nz, R[7] * nz, R[8] * nz, m);
        }
      };
      oct(0.38, -0.005, 6, -1); oct(0.38, 0.0, 8, 1); oct(0.345, 0.004, 7, 1);
      // "STOP" in a 3x5 pixel font, mirrored
      const G = { S: [7, 4, 7, 1, 7], T: [7, 2, 2, 2, 2], O: [7, 5, 5, 5, 7], P: [7, 5, 7, 4, 4] }, px = 0.034;
      'STOP'.split('').forEach((ch, li) => G[ch].forEach((row, ry) => { for (let cxp = 0; cxp < 3; cxp++) if (row & (4 >> cxp)) {
        const gx = -((li * 4 + cxp) - 7) * px, gy = (2 - ry) * px;
        Q(loc(R, c, [gx - px / 2, gy - px / 2, 0.008]), loc(R, c, [gx + px / 2, gy - px / 2, 0.008]), loc(R, c, [gx + px / 2, gy + px / 2, 0.008]), loc(R, c, [gx - px / 2, gy + px / 2, 0.008]), R[6], R[7], R[8], 8);
      } }));
    } else if (t === 1) desk([mx, y0 - 0.25 - 0.3 * p[2], mz], rot(yaw, (p[3] - 0.5) * 0.2));
    else if (t === 2) {                        // desk half through a wall
      const s = p[1], along = (p[2] - 0.5) * 1.2;
      const o = s < 2 ? [mx + along, y0, (s === 0 ? z : z + 1) * CELL] : [(s === 2 ? x : x + 1) * CELL, y0, mz + along];
      desk(o, rot(s < 2 ? 0.3 * (p[3] - 0.5) : Math.PI / 2 + 0.3 * (p[3] - 0.5)));
    } else if (t === 3) chair([mx, y0, mz], rot(yaw), 0.45 + 0.9 * p[2], 0.45 + 0.8 * p[3]);
    else if (t === 4) chair([mx, y0 + HEIGHT, mz], rot(yaw, 0, Math.PI));
    else if (t === 5) OB([mx, y0 + 0.4, mz], [0.24, 0.7, 0.32], rot(yaw, 0.25 + 0.3 * p[2], (p[3] - 0.5) * 0.4), 6);
    else if (t === 6) {                        // a door frame standing in the middle of the room
      const R = rot(yaw), o = [mx, y0, mz];
      OB(loc(R, o, [-0.62, HEIGHT / 2, 0]), [0.17, HEIGHT / 2, THICK], R, 2);
      OB(loc(R, o, [0.62, HEIGHT / 2, 0]), [0.17, HEIGHT / 2, THICK], R, 2);
      OB(loc(R, o, [0, (HEIGHT + 2.05) / 2, 0]), [0.45, (HEIGHT - 2.05) / 2, THICK], R, 2);
    }
  }
  return n / FLOATS;
}
