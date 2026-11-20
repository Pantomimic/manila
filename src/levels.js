// Floors stacked on floors, and the things that go wrong the further out you get.
//
// Level lv's floor sits at y = lv * FH. Each level has its own layout (its own seed, from levelSeed)
// and they connect two ways: drop holes in the floor, and stairs that rise through a stairwell into
// the level above. A mutation level 0..8, growing with distance from the origin (going up or down
// counts too), makes the odd things more common: missing ceiling tiles with cable bundles hanging out,
// and "wrong" objects (a backwards stop sign stuck in the carpet, desks sunk into the floor or through
// a wall, stretched chairs, a chair on the ceiling, a door frame standing on its own).
// Everything here is a pure function of (seed, level, cell), like the walls in gen.js.
import { CELL, HEIGHT, THICK, CHUNK, hashU, reaches, buildChunk, lightKind, kindH, kindV, wallLike, mutation, MUT_STEP, MUT_LEVEL, noteLevel, roomCell, bow, doorShape, SALT_H, SALT_V } from './gen.js';
import * as G from './gen.js';                // live room bounds (G.rX0 ..) after roomCell
export { mutation, MUT_STEP, MUT_LEVEL };

export const FH = 3.4;                       // floor to floor: 2.8 m room + 0.6 m ceiling void and slab
const U = (p) => Math.floor(p * 2 ** 32);
const unit = (h) => (h >>> 8) / 16777216;
export const levelSeed = (seed, lv) => { const s = lv === 0 ? seed : 1 + hashU(seed, 900, lv, 7) % 16777214; noteLevel(s, lv); return s; };
export const levelOf = (y) => Math.floor((y + 0.05) / FH);

// mutation (gen.js): 0 near the start, +1 every 40 cells (120 m) out, levels count as 25 cells each
const ramp = (a, b) => Array.from({ length: 9 }, (_, k) => U(a + (b - a) * k / 8));
// per mutation level: missing ceiling tile, wrong object per cell, drop hole per cell
export const MISS_U = ramp(0.004, 0.06), PROP_U = ramp(0.0015, 0.035), DROP_U = ramp(0.003, 0.012);
const STAIR_U = U(0.006);

// ---- stairs and holes ----
// raw rolls; the rules below keep a cell from holding two openings that would fight
const S = (seed, lv, x, z) => hashU(seed, 910 + lv * 31, x, z) < STAIR_U;
const D = (seed, lv, x, z) => hashU(seed, 920 + lv * 31, x, z) < DROP_U[mutation(lv, x, z)];
// ...and no opening may lead into a sealed pocket: the cell you arrive in (the one above a stair,
// below a hole) must join at least OPEN_NEED cells. Flood fills are cached; only rolled cells get one.
const OPEN_NEED = 60, openCache = new Map();
export function openTo(seed, lv, x, z) {
  const key = (lv + 512) * 2 ** 42 + (x + 2 ** 20) * 2 ** 21 + (z + 2 ** 20);
  let v = openCache.get(key);
  if (v === undefined) { v = reaches(levelSeed(seed, lv), x, z, OPEN_NEED); openCache.set(key, v); }
  return v;
}
const S2 = (seed, lv, x, z) => S(seed, lv, x, z) && !S(seed, lv - 1, x, z);
// rooms that must stay whole: no holes or stairs in the pool, the hallway or the closet
const calm = (seed, lv, x, z) => { const t = roomCell(levelSeed(seed, lv), x, z); return t === 9 || t === 10 || t === 12; };
export const stairAt = (seed, lv, x, z) => S2(seed, lv, x, z) && !calm(seed, lv, x, z) && !calm(seed, lv + 1, x, z) && openTo(seed, lv + 1, x, z);
export const dropAt = (seed, lv, x, z) => D(seed, lv, x, z) && !S(seed, lv, x, z) && !S(seed, lv - 1, x, z) && !calm(seed, lv, x, z) && !calm(seed, lv - 1, x, z) && openTo(seed, lv - 1, x, z);

// Stair in cell (x, z) of level lv, written into st: [dx, dz, half width, steps, open0, variant,
// off, clip, sink, cut].
// It climbs FH over RUN metres along (dx, dz), centred in the cell. Variants: 0 normal, 1 a few
// giant steps, 2 lots of tiny ones, 3 very narrow, 4 very wide, 5 a stairwell so low you must crouch.
// open0: where along the run (0..1) the stairwell opening in the ceiling starts.
// Further out some go wrong (more of them with mutation): off shifts the stair sideways so it runs
// into the wall beside it (cut 1: the wall has been cut away round it, 0: the steps just pass through);
// clip 1: no opening above, the stair climbs into the ceiling and goes nowhere; clip 2: the whole stair
// is sunk sink metres into the floor (you can still step off the top).
export const RUN = 2.3;
export function stairShape(seed, lv, x, z, st) {
  const h = hashU(seed, 930 + lv * 31, x, z), d = h & 3, v = (h >>> 2) % 6;
  st[0] = d === 0 ? 1 : d === 1 ? -1 : 0; st[1] = d === 2 ? 1 : d === 3 ? -1 : 0;
  st[2] = v === 3 ? 0.36 : v === 4 ? 1.15 : 0.62;
  st[3] = v === 1 ? 5 : v === 2 ? 30 : 14;
  const rise = FH / st[3], clear = v === 5 ? 1.6 : 1.0;  // ground height you may reach under the ceiling
  st[4] = Math.max(0.1, Math.floor(clear / rise) / st[3] - 0.03);
  st[5] = v;
  st[6] = st[7] = st[8] = st[9] = 0;
  const f = mutation(lv, x, z) / 8, c = hashU(seed, 935 + lv * 31, x, z), rc = unit(c);
  const pSide = 0.03 + 0.3 * f, pCeil = 0.02 + 0.12 * f, pSunk = 0.02 + 0.15 * f;
  if (rc < pSide) {
    st[6] = ((c & 1) ? 1 : -1) * Math.max(0, CELL / 2 - st[2] + 0.05 + 0.4 * unit(hashU(seed, 936 + lv * 31, x, z)));
    st[9] = (c >>> 1) & 1;
  } else if (rc < pSide + pCeil) st[7] = 1;
  else if (rc < pSide + pCeil + pSunk) { st[7] = 2; st[8] = 0.15 + 0.4 * unit(hashU(seed, 937 + lv * 31, x, z)); }
  return st;
}
// opening rect of a stairwell (ceiling of lv, floor of lv + 1)
// (shifted with the stair, and cut off at the cell's edges: past them the stair runs into the floor above)
function wellRect(x, z, st, r) {
  const cx = (x + 0.5) * CELL - st[1] * st[6], cz = (z + 0.5) * CELL + st[0] * st[6], w = st[2] + 0.1;
  const a = -RUN / 2 + st[4] * RUN, b = RUN / 2;          // along the run
  if (st[0] !== 0) { const p = cx + st[0] * a, q = cx + st[0] * b; r[0] = Math.min(p, q); r[2] = Math.max(p, q); r[1] = cz - w; r[3] = cz + w; }
  else { const p = cz + st[1] * a, q = cz + st[1] * b; r[1] = Math.min(p, q); r[3] = Math.max(p, q); r[0] = cx - w; r[2] = cx + w; }
  r[0] = Math.max(r[0], x * CELL); r[1] = Math.max(r[1], z * CELL); r[2] = Math.min(r[2], (x + 1) * CELL); r[3] = Math.min(r[3], (z + 1) * CELL);
  return r;
}
function dropRect(seed, lv, x, z, r) {
  const h1 = hashU(seed, 940 + lv * 31, x, z), h2 = hashU(seed, 941 + lv * 31, x, z);
  const hx = 0.45 + 0.6 * unit(h1), hz = 0.7 + 0.45 * unit(h2);
  const cx = (x + 0.5) * CELL + ((h1 & 255) / 255 - 0.5) * 0.2, cz = (z + 0.5) * CELL + ((h2 & 255) / 255 - 0.5) * 0.2;
  r[0] = cx - hx; r[1] = cz - hz; r[2] = cx + hx; r[3] = cz + hz;
  return r;
}
const stH = new Float64Array(10);
// opening in the floor of level lv at cell (x, z): a drop hole, or the top of a stairwell from below
export function floorHole(seed, lv, x, z, r) {
  if (stairAt(seed, lv - 1, x, z) && stairShape(seed, lv - 1, x, z, stH)[7] !== 1) { wellRect(x, z, stH, r); return true; }
  if (pitAt(seed, lv, x, z)) { r[0] = x * CELL + PIT_EDGE; r[1] = z * CELL + PIT_EDGE; r[2] = (x + 1) * CELL - PIT_EDGE; r[3] = (z + 1) * CELL - PIT_EDGE; return true; }
  if (dropAt(seed, lv, x, z)) { dropRect(seed, lv, x, z, r); return true; }
  return false;
}
// pit room: every cell but the outer ring is a hole, leaving walkways PIT_EDGE * 2 wide between them
const PIT_EDGE = 0.4;
function pitAt(seed, lv, x, z) {
  return roomCell(levelSeed(seed, lv), x, z) === 0 && x > G.rX0 && x < G.rX1 - 1 && z > G.rZ0 && z < G.rZ1 - 1 && !stairAt(seed, lv, x, z)
    && openTo(seed, lv - 1, x, z);
}
export const ceilHole = (seed, lv, x, z, r) => floorHole(seed, lv + 1, x, z, r);
// a stair pushed sideways into the wall on one of its cell's edges, with the wall cut away round it
// (gen.js cutRun): out = [a0, a1, y0, y1] along that edge, the cut line 1.2 m above the nosings (a slot over the rail)
const stC = new Float64Array(10);
function stairCut(seed, lv, salt, line, i, out) {
  for (const sg of [1, -1]) {                       // the cell on the - side (edge on its + side), then the + side
    const cx = salt === SALT_H ? i : sg > 0 ? line - 1 : line, cz = salt === SALT_H ? (sg > 0 ? line - 1 : line) : i;
    if (!stairAt(seed, lv, cx, cz)) continue;
    stairShape(seed, lv, cx, cz, stC);
    if (stC[6] === 0 || !stC[9]) continue;
    const runsX = stC[0] !== 0, ps = Math.sign(stC[6]) * (runsX ? stC[0] : -stC[1]);   // which way it sticks out, across
    if (runsX !== (salt === SALT_H) || ps !== sg) continue;
    const d = runsX ? stC[0] : stC[1], c = ((runsX ? cx : cz) + 0.5) * CELL, ya = 1.2 - stC[8], yb = FH + 1.2 - stC[8];
    const p = c - d * RUN / 2, q = c + d * RUN / 2;
    if (p < q) { out[0] = p; out[1] = q; out[2] = ya; out[3] = yb; } else { out[0] = q; out[1] = p; out[2] = yb; out[3] = ya; }
    return true;
  }
  return false;
}
// pool room: every cell but the outer ring is the drained pool, POOL_D below the floor
export const POOL_D = 0.55;
export function poolAt(seed, lv, x, z) {
  if (roomCell(levelSeed(seed, lv), x, z) !== 9) return false;
  if (!(x > G.rX0 && x < G.rX1 - 1 && z > G.rZ0 && z < G.rZ1 - 1)) return false;
  return !stairAt(seed, lv, x, z) && !floorHole(seed, lv, x, z, rP);
}
const rP = new Float64Array(4);
const rH = new Float64Array(4);
const inRect = (r, px, pz) => px > r[0] && px < r[2] && pz > r[1] && pz < r[3];
// light kind of a cell, with panels removed where the ceiling is open
export function cellLight(seed, lv, x, z) {
  if (ceilHole(seed, lv, x, z, rH)) return 0;
  const sL = levelSeed(seed, lv);
  const t = roomCell(sL, x, z);
  if (t === 4)                                  // dark room: one flickering panel in the middle
    return x === (G.rX0 + G.rX1 - 1) >> 1 && z === (G.rZ0 + G.rZ1 - 1) >> 1 ? 2 : 0;
  if (t === 10 || t === 11 || t === 12) return 1;   // hallway (all alike), follow room (the shader picks), closet
  return lightKind(sL, x, z);
}

// ---- where a cell's light panel is, and how a hanging one hangs ----
// lightGeom fills out: [ox, oz, hx, hz, lx, ly, lz]: the panel's rectangle in the ceiling (centre
// offset from the cell centre, half sizes), and where its light comes from (offset from the cell
// centre, height above the floor). Near the start every panel is a 2x4 ft troffer in the middle of
// its cell; further out more of them are shifted off the tile grid, turned, or the wrong size.
// The shader reads both from the world texture (render.js fillData).
// A hanging panel (kind 4) also sets hang: variant (0 swung down from one short end, 1 from one long
// side, 2 dropped level on its wires, 3 hanging from a corner), the pivot (offset from the cell centre,
// height), the pivot in the panel's own frame, and the rotation.
const PANEL_SIZES = [[0.3, 0.6], [0.3, 0.3], [0.15, 0.6], [0.3, 1.2], [0.45, 0.45], [0.6, 0.6], [0.2, 0.9]];
export const hang = { v: -1, P: new Float64Array(3), q: new Float64Array(3), R: new Float64Array(9) };
const axisRot = (R, kx, ky, kz, a) => {               // R = rotation by a about unit axis k (columns = images of x, y, z)
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  R[0] = c + kx * kx * t; R[1] = ky * kx * t + kz * s; R[2] = kz * kx * t - ky * s;
  R[3] = kx * ky * t - kz * s; R[4] = c + ky * ky * t; R[5] = kz * ky * t + kx * s;
  R[6] = kx * kz * t + ky * s; R[7] = ky * kz * t - kx * s; R[8] = c + kz * kz * t;
};
export function lightGeom(seed, lv, x, z, kind, out) {
  const sL = levelSeed(seed, lv), t = roomCell(sL, x, z), f = mutation(lv, x, z) / 8;
  let ox = 0, oz = 0, hx = 0.3, hz = 0.6;
  // the hallway repeats exactly, the follow room and closet stay plain, the wet room's reflections assume the grid
  if (!(t === 4 || t === 7 || t >= 10) && unit(hashU(sL, 340, x, z)) < 0.012 + 0.3 * f) {
    const sz = PANEL_SIZES[hashU(sL, 341, x, z) % (kind === 4 ? 3 : PANEL_SIZES.length)];   // hanging ones stay small
    const k = 0.9 + 0.25 * unit(hashU(sL, 342, x, z)) * f;
    [hx, hz] = (hashU(sL, 343, x, z) & 1) ? [sz[1] * k, sz[0] * k] : [sz[0] * k, sz[1] * k];
    const m = 0.15 + 0.7 * f;
    ox = Math.max(-1, Math.min(1, (unit(hashU(sL, 344, x, z)) * 2 - 1))) * Math.min(m, 1.4 - hx);
    oz = Math.max(-1, Math.min(1, (unit(hashU(sL, 345, x, z)) * 2 - 1))) * Math.min(m, 1.4 - hz);
  }
  out[0] = ox; out[1] = oz; out[2] = hx; out[3] = hz;
  out[4] = ox; out[5] = HEIGHT - 0.05; out[6] = oz;
  hang.v = -1;
  if (kind !== 4) return out;
  const h = hashU(sL, 346, x, z), u1 = unit(hashU(sL, 347, x, z)), r = unit(h);
  const v = r < 0.35 ? 0 : r < 0.6 ? 1 : r < 0.8 ? 2 : 3;
  const longZ = hz >= hx, L = longZ ? hz : hx, S = longZ ? hx : hz;
  // swing toward the middle of the cell, so the panel stays inside it
  const towards = (o) => (Math.abs(o) > 0.05 ? (o > 0 ? -1 : 1) : (h & 16) ? 1 : -1);
  const P = hang.P, q = hang.q, R = hang.R;
  if (v === 2) {                                     // dropped level, hanging on its wires
    const d = 0.3 + 0.42 * u1;
    q[0] = q[1] = q[2] = 0; P[0] = ox; P[1] = HEIGHT - d; P[2] = oz;
    const yaw = (unit(hashU(sL, 348, x, z)) - 0.5) * 0.5, pit = (unit(hashU(sL, 349, x, z)) - 0.5) * 0.35, rol = (((h >>> 8) & 255) / 255 - 0.5) * 0.35;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pit), sp = Math.sin(pit), cr = Math.cos(rol), sr = Math.sin(rol);
    // yaw, then pitch about x, then roll about z (same order as rot())
    const X = [cy, 0, -sy], Z = [sy, 0, cy], Y1 = [Z[0] * sp, cp, Z[2] * sp], Z1 = [Z[0] * cp, -sp, Z[2] * cp];
    const X2 = [X[0] * cr + Y1[0] * sr, X[1] * cr + Y1[1] * sr, X[2] * cr + Y1[2] * sr], Y2 = [Y1[0] * cr - X[0] * sr, Y1[1] * cr - X[1] * sr, Y1[2] * cr - X[2] * sr];
    R.set([...X2, ...Y2, ...Z1]);
  } else {
    let ux = 0, uz = 0, a;
    if (v === 0) {                                   // hinged at one short end
      const s = towards(longZ ? oz : ox);
      if (longZ) { uz = s; q[0] = 0; q[2] = -s * L; } else { ux = s; q[0] = -s * L; q[2] = 0; }
      a = 0.55 + 0.6 * u1;
    } else if (v === 1) {                            // hinged along one long side
      const s = towards(longZ ? ox : oz);
      if (longZ) { ux = s; q[0] = -s * S; q[2] = 0; } else { uz = s; q[0] = 0; q[2] = -s * S; }
      a = 0.75 + 0.7 * u1;
    } else {                                         // one corner still caught in the grid
      const sx = towards(ox), sz = towards(oz), d = Math.hypot(hx, hz);
      q[0] = -sx * hx; q[2] = -sz * hz; ux = sx * hx / d; uz = sz * hz / d;
      a = 1.05 + 0.4 * u1;
    }
    q[1] = 0; P[0] = ox + q[0]; P[1] = HEIGHT; P[2] = oz + q[2];
    axisRot(R, uz, 0, -ux, a);                       // axis u x down: turns u toward the floor
  }
  hang.v = v;
  // the light: the middle of the diffuser, a little below it
  const lx = -q[0], ly = -0.16 - q[1], lz = -q[2];
  out[4] = P[0] + R[0] * lx + R[3] * ly + R[6] * lz; out[5] = P[1] + R[1] * lx + R[4] * ly + R[7] * lz; out[6] = P[2] + R[2] * lx + R[5] * ly + R[8] * lz;
  return out;
}

// cellLight, but with the follow room's rule applied for someone in cell (pcx, pcz)
export function liveLight(seed, lv, x, z, pcx, pcz) {
  const k = cellLight(seed, lv, x, z);
  return k && (x !== pcx || z !== pcz) && roomCell(levelSeed(seed, lv), x, z) === 11 ? 0 : k;
}

// Height of whatever you would stand on at (px, pz), starting from level lv and falling through
// openings. Stairs are stepped: each tread is flat.
export function groundAt(seed, lv, px, pz) {
  const x = Math.floor(px / CELL), z = Math.floor(pz / CELL);
  for (let l = lv; l > lv - 4; l--) {
    if (stairAt(seed, l, x, z)) {
      stairShape(seed, l, x, z, stH);
      const cx = (x + 0.5) * CELL - stH[1] * stH[6], cz = (z + 0.5) * CELL + stH[0] * stH[6];
      const along = (stH[0] !== 0 ? (px - cx) * stH[0] : (pz - cz) * stH[1]) + RUN / 2;
      const across = Math.abs(stH[0] !== 0 ? pz - cz : px - cx);
      if (along >= 0 && along <= RUN && across <= stH[2]) {
        const i = Math.min(stH[3] - 1, Math.floor(along / RUN * stH[3]));
        return l * FH + Math.max(0, (i + 1) * FH / stH[3] - stH[8]);
      }
    }
    if (!(floorHole(seed, l, x, z, rH) && inRect(rH, px, pz))) return l * FH - (poolAt(seed, l, x, z) ? POOL_D : 0);
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
  if (roomCell(seedL, Math.floor((tx + 0.5) * 0.6 / CELL), Math.floor((0.3 + (tz + 0.5) * 0.6) / CELL)) === 10) return false;   // the hallway repeats exactly
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
  if (roomCell(levelSeed(seed, lv), x, z) >= 0) return out;
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
    circ[0] = cx + c * 0.62; circ[1] = cz - sn * 0.62; circ[2] = 0.2;
    circ[3] = cx - c * 0.62; circ[4] = cz + sn * 0.62; circ[5] = 0.2;
    return circ;
  }
  circ[0] = cx; circ[1] = cz; circ[2] = t === 0 ? 0.15 : t === 1 ? 0.75 : t === 3 ? 0.4 : 0.45;
  return circ;
}
function pushCircle(pos, r, x, z, cr) {
  const dx = pos[0] - x, dz = pos[1] - z, d = Math.hypot(dx, dz), rr = r + cr;
  if (d < rr && d > 1e-6) { pos[0] = x + dx / d * rr; pos[1] = z + dz / d * rr; }
}
// props and special-room furniture push you out (circles; allocation free, runs every frame)
let cPos = null, cR = 0, cH = 0;
const ITEM_TOP = [1.25, 1.15, HEIGHT, 2.1, 1.5, 0.95, 2.1];   // how tall each item stands (the drone flies over the low ones)
const solidOf = (type, px, py, pz, yaw, pitch, roll, sr, len) => {
  if (sr <= 0 || cH > ITEM_TOP[type] + py) return;
  if (type === ITEM_PART) {                       // thin wall: push out of its box
    const hx = yaw === 0 ? len : 0.04, hz = yaw === 0 ? 0.04 : len;
    const qx = Math.min(Math.max(cPos[0], px - hx), px + hx), qz = Math.min(Math.max(cPos[1], pz - hz), pz + hz);
    const dx = cPos[0] - qx, dz = cPos[1] - qz, d = Math.hypot(dx, dz);
    if (d < cR && d > 1e-6) { cPos[0] = qx + dx / d * cR; cPos[1] = qz + dz / d * cR; }
    else if (d <= 1e-6) { if (yaw === 0) cPos[1] = pz + (cPos[1] >= pz ? 1 : -1) * (hz + cR); else cPos[0] = px + (cPos[0] >= px ? 1 : -1) * (hx + cR); }
    return;
  }
  if (type === ITEM_FRAME) {
    const c = Math.cos(yaw) * 0.62, sn = Math.sin(yaw) * 0.62;
    pushCircle(cPos, cR, px + c, pz - sn, sr); pushCircle(cPos, cR, px - c, pz + sn, sr);
  } else pushCircle(cPos, cR, px, pz, sr);
};
// hy: height of the body's bottom above the floor (0 when walking); things lower than that are skipped
const PROP_TOP = [2.6, 0.8, 0.8, 2.2, 0, 1.4, 2.1];
export function collideProps(seed, lv, pos, r, hy = 0) {
  const cx = Math.floor(pos[0] / CELL), cz = Math.floor(pos[1] / CELL);
  cPos = pos; cR = r; cH = hy;
  for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
    const t = propAt(seed, lv, x, z)[0];
    if (t >= 0 && hy < PROP_TOP[t]) {
      const c = propCircles(seed, lv, x, z);
      for (let k = 0; k < 6; k += 3) if (c[k + 2] > 0) pushCircle(pos, r, c[k], c[k + 1], c[k + 2]);
    }
    furnish(seed, lv, x, z, solidOf);
    if (stairAt(seed, lv, x, z)) stairSolid(seed, lv, x, z, false, pos, r, hy, cx, cz);
    if (stairAt(seed, lv - 1, x, z)) stairSolid(seed, lv - 1, x, z, true, pos, r, hy, cx, cz);
  }
}
function pushSeg(pos, r, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((pos[0] - ax) * ex + (pos[1] - az) * ez) / (ex * ex + ez * ez || 1)));
  pushCircle(pos, r, ax + ex * t, az + ez * t, 0);
}
function pushRect(pos, r, x0, z0, x1, z1) {
  const qx = Math.max(x0, Math.min(x1, pos[0])), qz = Math.max(z0, Math.min(z1, pos[1]));
  if (qx !== pos[0] || qz !== pos[1]) { pushCircle(pos, r, qx, qz, 0); return; }
  const d = [pos[0] - x0, x1 - pos[0], pos[1] - z0, z1 - pos[1]], k = d.indexOf(Math.min(...d));   // inside: out the nearest side
  if (k === 0) pos[0] = x0 - r; else if (k === 1) pos[0] = x1 + r; else if (k === 2) pos[1] = z0 - r; else pos[1] = z1 + r;
}
// a stair's handrails (you're on the stair's level) or the guard rail round its opening (you're upstairs),
// and, for a stair pushed into the next cell, the part that sticks out there
const stS = new Float64Array(10);
function stairSolid(seed, l, x, z, upstairs, pos, r, hy, pcx, pcz) {
  stairShape(seed, l, x, z, stS);
  const [dx, dz, hw] = stS, px = -dz, pz = dx, off = stS[6];
  const ox = (x + 0.5) * CELL + px * off, oz = (z + 0.5) * CELL + pz * off;
  const P = (s, a) => [ox + dx * (s - RUN / 2) + px * a, oz + dz * (s - RUN / 2) + pz * a];
  if (upstairs) {
    if (stS[7] === 1 || hy > 1.05) return;
    const gw = hw + 0.12, s0 = stS[4] * RUN - 0.02;
    for (const [sa, aa, sb, ab] of [[s0, -gw, RUN, -gw], [s0, gw, RUN, gw], [s0, -gw, s0, gw]]) { const A = P(sa, aa), B = P(sb, ab); pushSeg(pos, r, A[0], A[1], B[0], B[1]); }
    return;
  }
  if (hy > 2.3) return;
  for (const sd of [-1, 1]) { const A = P(0.03, sd * (hw + 0.022)), B = P(RUN, sd * (hw + 0.022)); pushSeg(pos, r, A[0], A[1], B[0], B[1]); }
  if (off !== 0 && (pcx !== x || pcz !== z)) {
    const A = P(0, -hw - 0.045), B = P(RUN, hw + 0.045);
    let x0 = Math.min(A[0], B[0]), x1 = Math.max(A[0], B[0]), z0 = Math.min(A[1], B[1]), z1 = Math.max(A[1], B[1]);
    const X0 = x * CELL, X1 = X0 + CELL, Z0 = z * CELL, Z1 = Z0 + CELL;
    if (dx !== 0) { if (z1 > Z1) z0 = Z1; else if (z0 < Z0) z1 = Z0; else return; }
    else { if (x1 > X1) x0 = X1; else if (x0 < X0) x1 = X0; else return; }
    pushRect(pos, r, x0, z0, x1, z1);
  }
}

// ---- special-room furniture (rooms themselves are laid out in gen.js) ----
// furnish() calls emit(type, x, y, z, yaw, pitch, roll, solidRadius) for each item in cell (x, z):
// x, z in metres, y = offset from the floor (negative: sunk into it). Used for both the geometry and
// collision, so they always agree. Further out, more items come out wrong.
export const ITEM_DESK = 0, ITEM_CHAIR = 1, ITEM_PILLAR = 2, ITEM_FRAME = 3, ITEM_PART = 4, ITEM_SEAT = 5, ITEM_DOOR = 6;   // PART: extra arg = half length; SEAT: stacking chair
const PI = Math.PI;
const isWrong = (sL, k, x, z, f) => hashU(sL, 830 + k, x, z) < U(0.03 + 0.35 * f);
const rnd = (sL, k, x, z) => unit(hashU(sL, 860 + k, x, z));
export function furnish(seed, lv, x, z, emit) {
  const sL = levelSeed(seed, lv), t = roomCell(sL, x, z);
  if (t < 1 || t === 6 || t === 7 || t >= 9 && t <= 11) return;   // red, wet, pool, hallway, follow: shader and geometry elsewhere
  const sides = G.rSides;
  const x0 = G.rX0, z0 = G.rZ0, x1 = G.rX1, rh = G.rH, z1 = G.rZ1;   // copied: the calls below move the room cache
  const dir = (rh >>> 8) & 3, yaw0 = dir * PI / 2, f = mutation(lv, x, z) / 8;
  const mx = (x + 0.5) * CELL, mz = (z + 0.5) * CELL;
  if (t === 12) {                                   // closet: a door on the far wall that doesn't open
    const sd = sides === 1 ? 1 : sides === 2 ? 0 : sides === 4 ? 3 : 2;   // opposite the way in
    const w = THICK + 0.005;
    if (sd === 0) emit(ITEM_DOOR, mx, 0, z * CELL + w, 0, 0, 0, 0);
    else if (sd === 1) emit(ITEM_DOOR, mx, 0, (z + 1) * CELL - w, PI, 0, 0, 0);
    else if (sd === 2) emit(ITEM_DOOR, x * CELL + w, 0, mz, PI / 2, 0, 0, 0);
    else emit(ITEM_DOOR, (x + 1) * CELL - w, 0, mz, -PI / 2, 0, 0, 0);
    return;
  }
  if (t === 3) {                                    // pillar on the cell's inner corner
    if (x === x0 || z === z0) return;
    const w = isWrong(sL, 0, x, z, f) ? hashU(sL, 840, x, z) % 3 : -1, u = rnd(sL, 0, x, z);
    const bottom = w === 0 ? 0.9 + 1.2 * u : 0;    // stops short of the floor
    const ox = w === 1 ? (u - 0.5) * 1.4 : 0, oz = w === 1 ? (rnd(sL, 1, x, z) - 0.5) * 1.4 : 0;
    emit(ITEM_PILLAR, x * CELL + ox, bottom, z * CELL + oz, w === 2 ? 0.3 + u * 0.5 : 0, 0, 0, bottom > 1.2 ? 0 : 0.36);
    return;
  }
  if (stairAt(seed, lv, x, z) || floorHole(seed, lv, x, z, rH) || ceilHole(seed, lv, x, z, rH)) return;
  if (t === 1) {                                    // office: a desk, monitor and chair; some cells empty
    if (hashU(sL, 831, x, z) % 6 === 0) return;
    const w = isWrong(sL, 0, x, z, f) ? hashU(sL, 832, x, z) % 4 : -1, u = rnd(sL, 0, x, z);
    emit(ITEM_DESK, mx, w === 1 ? -0.3 - 0.35 * u : 0, mz, w === 0 ? yaw0 + (u - 0.5) * 2.4 : yaw0, w === 2 ? 0.25 + 0.3 * u : 0, 0, 0.8);
    const sx = Math.sin(yaw0) * 0.62, sz = Math.cos(yaw0) * 0.62;
    if (w === 3) emit(ITEM_CHAIR, mx + sx, HEIGHT, mz + sz, yaw0 + PI, 0, PI, 0);
    else emit(ITEM_CHAIR, mx + sx, 0, mz + sz, yaw0 + PI + (rnd(sL, 1, x, z) - 0.5) * 0.5, 0, 0, 0);
    return;
  }
  if (t === 2) {                                    // audience: four chairs a cell, all facing one way
    for (let k = 0; k < 4; k++) {
      const px = mx + ((k & 1) ? 0.72 : -0.72), pz = mz + ((k & 2) ? 0.72 : -0.72);
      const w = isWrong(sL, k, x, z, f) ? hashU(sL, 850 + k, x, z) % 4 : -1;
      if (w === 0) emit(ITEM_SEAT, px, 0, pz, yaw0 + PI, 0, 0, 0.3);              // turned round
      else if (w === 1) emit(ITEM_SEAT, px, 0.24, pz, yaw0 + 0.6, 0, PI / 2, 0.3);   // on its side
      else if (w === 2) emit(ITEM_SEAT, px, HEIGHT, pz, yaw0, 0, PI, 0);           // on the ceiling
      else emit(ITEM_SEAT, px, w === 3 ? -0.38 : 0, pz, yaw0, 0, 0, 0.3);         // (3: sunk to the seat)
    }
    return;
  }
  if (t === 4) {                                    // dark room: one chair under the one light
    if (x !== (x0 + x1 - 1) >> 1 || z !== (z0 + z1 - 1) >> 1) return;
    emit(ITEM_SEAT, mx, 0, mz, rnd(sL, 0, x, z) * 2 * PI, 0, 0, 0.35);
    return;
  }
  if (t === 8) {                                    // cubicles: partitions on the inner edges, a gap at one end
    for (let k = 0; k < 2; k++) {
      const hor = k === 0;
      if (hor ? z === z0 : x === x0) continue;
      const h = hashU(sL, 870 + k, x, z);
      if (h % 10 < 3) continue;                      // some partitions missing
      const gapAtStart = (h >>> 8) & 1, a0 = gapAtStart ? 0.9 : 0.05, a1 = gapAtStart ? CELL - 0.05 : CELL - 0.9;
      const c = (a0 + a1) / 2, half = (a1 - a0) / 2, w = isWrong(sL, 4 + k, x, z, f);
      if (hor) emit(ITEM_PART, x * CELL + c, w ? -0.6 : 0, z * CELL, 0, 0, 0, 1, half);
      else emit(ITEM_PART, x * CELL, w ? -0.6 : 0, z * CELL + c, PI / 2, 0, 0, 1, half);
    }
    if (hashU(sL, 872, x, z) % 2 === 0) {
      const w = isWrong(sL, 0, x, z, f), u = rnd(sL, 0, x, z);
      emit(ITEM_DESK, mx + 0.3, w ? -0.4 : 0, mz + 0.3, yaw0 + (w ? (u - 0.5) * 2 : 0), 0, 0, 0.8);
      emit(ITEM_CHAIR, mx + 0.3 + Math.sin(yaw0) * 0.62, 0, mz + 0.3 + Math.cos(yaw0) * 0.62, yaw0 + PI + (u - 0.5) * 0.6, 0, 0, 0);
    }
    return;
  }
  if (t === 5) {                                    // frames: in step, or sinking row by row
    const idx = (dir & 1) ? x - x0 : z - z0, sink = (rh >>> 12) & 1 ? 0.3 * idx : 0;
    const w = isWrong(sL, 0, x, z, f);
    emit(ITEM_FRAME, mx, -sink, mz, w ? yaw0 + (rnd(sL, 0, x, z) - 0.5) * 2 : yaw0, 0, 0, sink > 2.0 ? 0 : 0.2);
  }
}

// ---- building a level's chunk: walls (gen.js) with openings, then stairs, shafts, cables, props ----
const FLOATS = 7;
// A figure standing in cell (x, z), rarely, where a long straight open view runs away from it:
// returns the direction it faces down that view (0 +x, 1 -x, 2 +z, 3 -z) or -1.
const fR = new Float64Array(4);
export function figureAt(seed, lv, x, z) {
  const sL = levelSeed(seed, lv);
  if (hashU(sL, 980, x, z) >= U(0.0015 + 0.005 * mutation(lv, x, z) / 8) || roomCell(sL, x, z) >= 0) return -1;
  if (stairAt(seed, lv, x, z) || floorHole(seed, lv, x, z, fR) || propAt(seed, lv, x, z)[0] >= 0) return -1;
  const d0 = hashU(sL, 981, x, z) & 3;
  for (let q = 0; q < 4; q++) {
    const d = (d0 + q) & 3, dx = d === 0 ? 1 : d === 1 ? -1 : 0, dz = d === 2 ? 1 : d === 3 ? -1 : 0;
    let open = true;
    for (let k = 0; k < 6 && open; k++) {
      const X = x + dx * k, Z = z + dz * k;
      open = dx !== 0 ? kindV(sL, dx > 0 ? X + 1 : X, Z) === 0 : kindH(sL, X, dz > 0 ? Z + 1 : Z) === 0;
    }
    if (open) return d;
  }
  return -1;
}
const poolRect = (x, z, r) => { r[0] = x * CELL; r[1] = z * CELL; r[2] = (x + 1) * CELL; r[3] = (z + 1) * CELL; return true; };
// "EXIT" and arrows in a 3x5 pixel font (rows top to bottom, bit 4 = left column)
const GLYPH = { E: [7, 4, 6, 4, 7], X: [5, 5, 2, 5, 5], I: [7, 2, 2, 2, 7], T: [7, 2, 2, 2, 2], '<': [1, 2, 4, 2, 1], '>': [4, 2, 1, 2, 4] };
const dsW = new Float64Array(5);
export function buildLevelChunk(seed, lv, cx, cz, out) {
  const sL = levelSeed(seed, lv), y0 = lv * FH;
  let n = buildChunk(sL, cx, cz, out, {
    y0,
    floorHole: (x, z, r) => floorHole(seed, lv, x, z, r) || (poolAt(seed, lv, x, z) && poolRect(x, z, r)),
    ceilHole: (x, z, r) => ceilHole(seed, lv, x, z, r),
    light: (x, z) => cellLight(seed, lv, x, z),
    cut: (salt, line, i, out) => stairCut(seed, lv, salt, line, i, out),
  }) * FLOATS;
  const V = (x, y, z, nx, ny, nz, m) => { if (n + FLOATS > out.length) return; out[n] = x; out[n + 1] = y; out[n + 2] = z; out[n + 3] = nx; out[n + 4] = ny; out[n + 5] = nz; out[n + 6] = m; n += FLOATS; };
  const Q = (a, b, c, d, nx, ny, nz, m) => { V(...a, nx, ny, nz, m); V(...b, nx, ny, nz, m); V(...c, nx, ny, nz, m); V(...a, nx, ny, nz, m); V(...c, nx, ny, nz, m); V(...d, nx, ny, nz, m); };
  // oriented box: centre c, half sizes h, rotation R (3x3, columns = local axes), material m
  // skip: faces to leave out, bit (2 * axis + (negative side ? 1 : 0)); 8 = the bottom (never seen on the floor)
  const OB = (c, h, R, m, skip = 0) => {
    for (let k = 0; k < 8; k++) {
      const x = (k & 1 ? -h[0] : h[0]), y = (k & 2 ? -h[1] : h[1]), z = (k & 4 ? -h[2] : h[2]);
      rbP[k * 3] = c[0] + R[0] * x + R[3] * y + R[6] * z; rbP[k * 3 + 1] = c[1] + R[1] * x + R[4] * y + R[7] * z; rbP[k * 3 + 2] = c[2] + R[2] * x + R[5] * y + R[8] * z;
    }
    for (let ax = 0; ax < 3; ax++) for (let neg = 0; neg < 2; neg++) {      // the face whose normal is local axis ax, negated if neg
      if (skip & ((neg ? 2 : 1) << ax * 2)) continue;
      const u = 1 << (ax + 1) % 3, v = 1 << (ax + 2) % 3, sb = neg << ax, g = neg ? -1 : 1;
      const nx = R[ax * 3] * g, ny = R[ax * 3 + 1] * g, nz = R[ax * 3 + 2] * g;
      for (const k of [sb, sb | u, sb | u | v, sb, sb | u | v, sb | v]) V(rbP[k * 3], rbP[k * 3 + 1], rbP[k * 3 + 2], nx, ny, nz, m);
    }
  };
  // R turned by a about its own x axis (positive: the top leans back toward -z)
  const tiltX = (R, a) => {
    const c = Math.cos(a), sn = Math.sin(a);
    return [R[0], R[1], R[2], R[3] * c - R[6] * sn, R[4] * c - R[7] * sn, R[5] * c - R[8] * sn, R[6] * c + R[3] * sn, R[7] * c + R[4] * sn, R[8] * c + R[5] * sn];
  };
  // R turned by a about its own y axis
  const turnY = (R, a) => {
    const c = Math.cos(a), sn = Math.sin(a);
    return [R[0] * c + R[6] * sn, R[1] * c + R[7] * sn, R[2] * c + R[8] * sn, R[3], R[4], R[5], R[6] * c - R[0] * sn, R[7] * c - R[1] * sn, R[8] * c - R[2] * sn];
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

  // ---- rounded shapes. RB: a box whose edges are rounded off by b (one bevel strip per edge with the
  // normals of the two faces it joins, so light rolls round the edge instead of stopping at it).
  // skip works as for OB, and also drops the edges and corners that touch a skipped face.
  const VN = (p, nn, m) => V(p[0], p[1], p[2], nn[0], nn[1], nn[2], m);
  // (every point is a corner of either the full box or the box shrunk by b on some axes: 64 of them,
  // worked out once per box into rbP, then triangles pick from them)
  const RB = (c, h, R, m, b, skip = 0) => {
    b = Math.min(b, h[0] * 0.95, h[1] * 0.95, h[2] * 0.95);
    if (b <= 0.0005) { OB(c, h, R, m, skip); return; }
    for (let k = 0; k < 64; k++) {
      const x = (k & 1 ? -1 : 1) * (k & 8 ? h[0] - b : h[0]), y = (k & 2 ? -1 : 1) * (k & 16 ? h[1] - b : h[1]), z = (k & 4 ? -1 : 1) * (k & 32 ? h[2] - b : h[2]);
      rbP[k * 3] = c[0] + R[0] * x + R[3] * y + R[6] * z; rbP[k * 3 + 1] = c[1] + R[1] * x + R[4] * y + R[7] * z; rbP[k * 3 + 2] = c[2] + R[2] * x + R[5] * y + R[8] * z;
    }
    // point index: sign bit per axis (1 = negative) | inset bit per axis << 3
    const pi = (sg, ins) => sg | ins << 3;
    const E = (k, ax, neg) => { const g = neg ? -1 : 1; V(rbP[k * 3], rbP[k * 3 + 1], rbP[k * 3 + 2], R[ax * 3] * g, R[ax * 3 + 1] * g, R[ax * 3 + 2] * g, m); };
    for (let ax = 0; ax < 3; ax++) for (let neg = 0; neg < 2; neg++) {
      if (skip & ((neg ? 2 : 1) << ax * 2)) continue;
      const u = (ax + 1) % 3, v = (ax + 2) % 3, ins = (1 << u) | (1 << v), sb = neg << ax;
      const k00 = pi(sb, ins), k10 = pi(sb | 1 << u, ins), k11 = pi(sb | 1 << u | 1 << v, ins), k01 = pi(sb | 1 << v, ins);
      E(k00, ax, neg); E(k10, ax, neg); E(k11, ax, neg); E(k00, ax, neg); E(k11, ax, neg); E(k01, ax, neg);
    }
    for (let a1 = 0; a1 < 3; a1++) for (let a2 = a1 + 1; a2 < 3; a2++) {
      const a3 = 3 - a1 - a2;
      for (let n1 = 0; n1 < 2; n1++) for (let n2 = 0; n2 < 2; n2++) {
        if ((skip & ((n1 ? 2 : 1) << a1 * 2)) || (skip & ((n2 ? 2 : 1) << a2 * 2))) continue;
        const sb = n1 << a1 | n2 << a2, iA = (1 << a2) | (1 << a3), iB = (1 << a1) | (1 << a3);
        const A0 = pi(sb | 1 << a3, iA), A1 = pi(sb, iA), B1 = pi(sb, iB), B0 = pi(sb | 1 << a3, iB);
        E(A0, a1, n1); E(A1, a1, n1); E(B1, a2, n2); E(A0, a1, n1); E(B1, a2, n2); E(B0, a2, n2);
      }
    }
    for (let sb = 0; sb < 8; sb++) {
      if ((skip & ((sb & 1 ? 2 : 1))) || (skip & ((sb & 2 ? 2 : 1) << 2)) || (skip & ((sb & 4 ? 2 : 1) << 4))) continue;
      E(pi(sb, 6), 0, sb & 1); E(pi(sb, 5), 1, (sb >> 1) & 1); E(pi(sb, 3), 2, (sb >> 2) & 1);
    }
  };
  // CYL: a round bar from a to b, radius r at a and r2 at b, smooth sides; caps: 1 closes a, 2 closes b
  const CYL = (a, b, r, m, segs = 8, caps = 0, r2 = r) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], dl = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= dl; d[1] /= dl; d[2] /= dl;
    const t = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let e1 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
    const el = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / el, e1[1] / el, e1[2] / el];
    const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    const ring = (k) => { const an = k / segs * 2 * PI, c = Math.cos(an), sn = Math.sin(an); return [e1[0] * c + e2[0] * sn, e1[1] * c + e2[1] * sn, e1[2] * c + e2[2] * sn]; };
    const at = (o, nn, rr) => [o[0] + nn[0] * rr, o[1] + nn[1] * rr, o[2] + nn[2] * rr];
    const nd = [-d[0], -d[1], -d[2]];
    for (let k = 0; k < segs; k++) {
      const n0 = ring(k), n1 = ring(k + 1);
      VN(at(a, n0, r), n0, m); VN(at(a, n1, r), n1, m); VN(at(b, n1, r2), n1, m);
      VN(at(a, n0, r), n0, m); VN(at(b, n1, r2), n1, m); VN(at(b, n0, r2), n0, m);
      if (caps & 1) { VN(a, nd, m); VN(at(a, n1, r), nd, m); VN(at(a, n0, r), nd, m); }
      if (caps & 2) { VN(b, d, m); VN(at(b, n0, r2), d, m); VN(at(b, n1, r2), d, m); }
    }
  };
  // SPH: an ellipsoid with radii rr (local axes of R), smooth
  const SPH = (c, rr, R, m, lat = 6, lon = 8) => {
    const pt = (i, j) => {
      const th = i / lat * PI, ph = j / lon * 2 * PI, l = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      const nl = [l[0] / rr[0], l[1] / rr[1], l[2] / rr[2]], q = [l[0] * rr[0], l[1] * rr[1], l[2] * rr[2]];
      const n0 = [R[0] * nl[0] + R[3] * nl[1] + R[6] * nl[2], R[1] * nl[0] + R[4] * nl[1] + R[7] * nl[2], R[2] * nl[0] + R[5] * nl[1] + R[8] * nl[2]];
      const nlen = Math.hypot(n0[0], n0[1], n0[2]);
      return [loc(R, c, q), [n0[0] / nlen, n0[1] / nlen, n0[2] / nlen]];
    };
    for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
      const A = pt(i, j), B = pt(i + 1, j), C = pt(i + 1, j + 1), D = pt(i, j + 1);
      VN(A[0], A[1], m); VN(B[0], B[1], m); VN(C[0], C[1], m); VN(A[0], A[1], m); VN(C[0], C[1], m); VN(D[0], D[1], m);
    }
  };
  // HULL: a box whose front (+z, half sizes f) and back (-z, half sizes k) differ, between local z z0 > z1;
  // dy shifts the back up or down. Flat faces. (The back of a CRT.)
  const HULL = (o, R, f, k, z0, z1, dy, m) => {
    const p = [[-f[0], -f[1], z0], [f[0], -f[1], z0], [f[0], f[1], z0], [-f[0], f[1], z0], [-k[0], -k[1] + dy, z1], [k[0], -k[1] + dy, z1], [k[0], k[1] + dy, z1], [-k[0], k[1] + dy, z1]].map((q) => loc(R, o, q));
    const ctr = loc(R, o, [0, dy / 2, (z0 + z1) / 2]);
    for (const [a, b, c, d] of [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]) {
      const A = p[a], B = p[b], C = p[c], D = p[d];
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
      let nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(nn[0], nn[1], nn[2]) || 1; nn = [nn[0] / l, nn[1] / l, nn[2] / l];
      if ((A[0] - ctr[0]) * nn[0] + (A[1] - ctr[1]) * nn[1] + (A[2] - ctr[2]) * nn[2] < 0) nn = [-nn[0], -nn[1], -nn[2]];
      Q(A, B, C, D, nn[0], nn[1], nn[2], m);
    }
  };

  // a cable from a to b sagging by sag in the middle (a parabola), as a chain of round segments
  const cable = (a, b, sag, r, m, seg = 8, ring = 5) => {
    let p = a;
    for (let j = 1; j <= seg; j++) {
      const t = j / seg, q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
      CYL(p, q, r, m, ring); p = q;
    }
  };
  // ---- furniture. Origins at the floor centre; a seat faces +z, a desk's user side is +z.
  // Materials: 6 metal, 9 laminate, 10 fabric, 13 screen, 14 black plastic, 15 drawer fronts, 16 beige plastic
  const B8 = 8;                                // leave out bottom faces
  // office chair: five-star base on casters, gas lift, padded seat and back on a spine, armrests
  const officeChair = (o, R, legs = 0.45, back = 0.3, arms = true) => {
    for (let k = 0; k < 5; k++) {
      const a = k * 1.2566 + 0.3, Rk = turnY(R, a), ca = Math.cos(a), sa = Math.sin(a);   // (turnY: local x -> (cos a, sin a))
      RB(loc(R, o, [ca * 0.15, 0.078, sa * 0.15]), [0.15, 0.016, 0.02], Rk, 14, 0.012);
      const w = loc(R, o, [ca * 0.285, 0.032, sa * 0.285]), ax = [-sa * 0.022, 0, ca * 0.022];   // caster wheel, across the spoke
      CYL(loc(R, w, [-ax[0], 0, -ax[2]]), loc(R, w, ax), 0.03, 14, 8, 3);
      CYL(loc(R, o, [ca * 0.285, 0.05, sa * 0.285]), loc(R, o, [ca * 0.285, 0.08, sa * 0.285]), 0.012, 14, 6);
    }
    CYL(loc(R, o, [0, 0.06, 0]), loc(R, o, [0, 0.105, 0]), 0.048, 14, 10, 2);
    CYL(loc(R, o, [0, 0.1, 0]), loc(R, o, [0, 0.27, 0]), 0.034, 14, 10);                         // shroud
    CYL(loc(R, o, [0, 0.27, 0]), loc(R, o, [0, legs - 0.05, 0]), 0.022, 6, 10);                  // chrome lift
    RB(loc(R, o, [0, legs - 0.045, -0.01]), [0.11, 0.025, 0.13], R, 14, 0.01);                  // mechanism
    RB(loc(R, o, [0, legs - 0.012, 0.02]), [0.235, 0.012, 0.225], R, 14, 0.01);                 // seat shell
    RB(loc(R, o, [0, legs + 0.04, 0.02]), [0.245, 0.045, 0.235], R, 10, 0.04);                  // cushion
    const Rb = tiltX(R, 0.14);
    RB(loc(R, o, [0, legs + 0.1, -0.255]), [0.035, 0.1, 0.014], tiltX(R, 0.3), 14, 0.01);       // spine
    const bc = [0, legs + 0.2 + back, -0.27 - 0.14 * (0.1 + back)];
    RB(loc(R, o, bc), [0.23, back, 0.04], Rb, 10, 0.045);                                       // padded back
    RB(loc(R, o, [bc[0], bc[1], bc[2] - 0.035]), [0.215, back * 0.94, 0.012], Rb, 14, 0.012);   // its shell
    if (arms) for (const sx of [-0.27, 0.27]) {
      RB(loc(R, o, [sx, legs + 0.11, -0.02]), [0.014, 0.1, 0.022], R, 14, 0.008, B8);
      RB(loc(R, o, [sx, legs + 0.225, 0]), [0.032, 0.016, 0.12], R, 14, 0.014);
    }
  };
  // stacking chair, the kind set out in rows: tubular steel legs, the back legs rising into the backrest,
  // a padded seat and back
  const stackChair = (o, R) => {
    RB(loc(R, o, [0, 0.45, 0]), [0.22, 0.03, 0.21], R, 10, 0.025);
    for (const sx of [-0.19, 0.19]) {
      CYL(loc(R, o, [sx, 0.005, 0.17]), loc(R, o, [sx, 0.43, 0.17]), 0.011, 6, 6);
      CYL(loc(R, o, [sx, 0.005, -0.19]), loc(R, o, [sx, 0.92, -0.25]), 0.011, 6, 6);
      CYL(loc(R, o, [sx, 0.41, 0.17]), loc(R, o, [sx, 0.41, -0.19]), 0.009, 6, 6);               // side rail
      for (const z of [0.17, -0.19]) CYL(loc(R, o, [sx, 0.0, z]), loc(R, o, [sx, 0.012, z]), 0.014, 14, 6, 3);   // glides
    }
    CYL(loc(R, o, [-0.19, 0.41, 0.17]), loc(R, o, [0.19, 0.41, 0.17]), 0.009, 6, 6);
    const Rb = tiltX(R, 0.07);
    RB(loc(R, o, [0, 0.79, -0.235]), [0.205, 0.11, 0.02], Rb, 10, 0.018);
  };
  // office desk: drawer pedestal on the right, side panel on the left, modesty panel,
  // a beige CRT on a stand, a keyboard and a mouse
  const desk = (o, R) => {
    RB(loc(R, o, [0, 0.74, 0]), [0.7, 0.018, 0.36], R, 9, 0.007);
    RB(loc(R, o, [0.48, 0.36, 0]), [0.2, 0.36, 0.33], R, 9, 0.005, B8 | 4);
    for (let k = 0; k < 3; k++) {
      const y = 0.6 - k * 0.23;
      RB(loc(R, o, [0.48, y, 0.334]), [0.188, 0.105, 0.009], R, 15, 0.005, 32);
      CYL(loc(R, o, [0.43, y + 0.06, 0.355]), loc(R, o, [0.53, y + 0.06, 0.355]), 0.006, 6, 6, 3);
      for (const hx of [0.435, 0.525]) CYL(loc(R, o, [hx, y + 0.06, 0.342]), loc(R, o, [hx, y + 0.06, 0.355]), 0.004, 6, 5);
    }
    RB(loc(R, o, [-0.67, 0.36, 0]), [0.02, 0.36, 0.33], R, 9, 0.005, B8 | 4);
    RB(loc(R, o, [-0.19, 0.45, -0.31]), [0.46, 0.25, 0.01], R, 9, 0.004);
    // monitor: round foot, neck, rounded bezel, the tapered tube housing behind it, the glass
    CYL(loc(R, o, [0, 0.758, -0.14]), loc(R, o, [0, 0.772, -0.14]), 0.1, 16, 12, 2, 0.09);
    RB(loc(R, o, [0, 0.79, -0.15]), [0.05, 0.025, 0.05], R, 16, 0.015, B8);
    const mo = loc(R, o, [0, 0.965, -0.075]);
    RB(mo, [0.2, 0.175, 0.035], R, 16, 0.02);
    HULL(mo, R, [0.185, 0.16], [0.11, 0.1], -0.03, -0.31, -0.02, 16);
    RB(loc(R, o, [0, 0.975, -0.038]), [0.163, 0.132, 0.004], R, 13, 0.006, 32);
    // keyboard: a tilted tray with rows of keys, a mouse beside it
    const Rk = tiltX(R, -0.05), ko = loc(R, o, [0, 0.77, 0.17]);
    RB(ko, [0.22, 0.012, 0.075], Rk, 16, 0.008, B8);
    for (let row = 0; row < 4; row++) for (let col = 0; col < 15; col++) {
      if (row === 3 && col > 3 && col < 11) { if (col === 4) RB(loc(Rk, ko, [0, 0.019, 0.052]), [0.075, 0.006, 0.011], Rk, 16, 0.003, B8 | 32); continue; }
      OB(loc(Rk, ko, [-0.196 + col * 0.028, 0.019, -0.042 + row * 0.031]), [0.0115, 0.006, 0.0115], Rk, 16, B8 | 32 | 1 | 2);
    }
    RB(loc(R, o, [0.33, 0.773, 0.16]), [0.03, 0.016, 0.05], R, 16, 0.015, B8);
  };
  // a door frame sunk s metres into the floor, cut off at floor level (so it can't poke out of the
  // ceiling of the level below)
  const frame = (o, R, s) => {
    const top = HEIGHT - s, lb = Math.max(0, 2.05 - s);
    if (top <= 0.02) return;
    if (lb === 0) { OB(loc(R, o, [0, top / 2, 0]), [0.79, top / 2, THICK], R, 2); return; }   // only the lintel is left
    OB(loc(R, o, [-0.62, top / 2, 0]), [0.17, top / 2, THICK], R, 2);
    OB(loc(R, o, [0.62, top / 2, 0]), [0.17, top / 2, THICK], R, 2);
    OB(loc(R, o, [0, (top + lb) / 2, 0]), [0.45, (top - lb) / 2, THICK], R, 2);
  };
  const build = (type, px, py, pz, yaw, pitch, roll, sr, len) => {
    const R = rot(yaw, pitch, roll), o = [px, y0 + py, pz];
    if (type === ITEM_PART) {                    // partition 1.5 m tall, cut off at the floor if sunk
      const top = 1.5 + py; if (top <= 0.02) return;
      RB([px, y0 + top / 2, pz], [len, top / 2, 0.035], R, 12, 0.02, B8);
      RB([px, y0 + top + 0.012, pz], [len + 0.004, 0.014, 0.042], R, 6, 0.012);  // aluminium cap rail
      for (const e of [-len, len]) RB(loc(R, [px, y0, pz], [e, top / 2, 0]), [0.012, top / 2, 0.04], R, 6, 0.008, B8);   // end posts
      if (py >= 0) RB([px, y0 + 0.05, pz], [len - 0.01, 0.05, 0.04], R, 14, 0.006, B8); // kick strip
    } else if (type === ITEM_CHAIR) officeChair(o, R);
    else if (type === ITEM_SEAT) stackChair(o, R);
    else if (type === ITEM_DOOR) {                // a plain door, shut, set against the wall
      RB(loc(R, o, [0, 1.0, 0.03]), [0.44, 1.0, 0.022], R, 21, 0.006, B8 | 32);
      for (const sx of [-0.49, 0.49]) RB(loc(R, o, [sx, 1.04, 0.025]), [0.05, 1.04, 0.025], R, 16, 0.008, B8 | 32);
      RB(loc(R, o, [0, 2.12, 0.025]), [0.54, 0.05, 0.025], R, 16, 0.008, 32);
      CYL(loc(R, o, [0.34, 0.98, 0.052]), loc(R, o, [0.34, 0.98, 0.058]), 0.03, 6, 12, 2);       // rose
      CYL(loc(R, o, [0.34, 0.98, 0.058]), loc(R, o, [0.34, 0.98, 0.09]), 0.009, 6, 8);          // spindle
      SPH(loc(R, o, [0.34, 0.98, 0.105]), [0.028, 0.028, 0.022], R, 6);                          // knob
      for (const hy of [0.25, 1.75]) CYL(loc(R, o, [-0.44, hy - 0.05, 0.055]), loc(R, o, [-0.44, hy + 0.05, 0.055]), 0.008, 6, 6, 3);   // hinges
    }
    else if (type === ITEM_FRAME) { o[1] = y0; frame(o, R, -py); }
    else if (type === ITEM_PILLAR) OB([px, y0 + (py + HEIGHT) / 2, pz], [0.25, (HEIGHT - py) / 2, 0.25], R, 2);
    else desk(o, R);
  };
  const st = new Float64Array(10), r = new Float64Array(4), p = new Float64Array(4);
  const LG = new Float64Array(7), pL = new Float64Array(4), rL = new Float64Array(4), RD = new Float64Array(9), I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let hungN = 0;
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
    // ---- stairs: carpeted treads with black rubber nosings, painted risers, papered side panels that
    // follow the slope, a wooden handrail on metal balusters; a guard rail round the opening upstairs ----
    if (stairAt(seed, lv, x, z)) {
      stairShape(seed, lv, x, z, st);
      const [dx, dz, hw, N] = st, px = -dz, pz = dx, rise = FH / N, g = RUN / N, off = st[6], sink = st[8];
      const ox = mx + px * off, oz = mz + pz * off, yb = y0 - sink;
      const at = (s, a, y) => [ox + dx * (s - RUN / 2) + px * a, yb + y, oz + dz * (s - RUN / 2) + pz * a];
      const Rs = rot(Math.atan2(dx, -dz));               // local z = -run direction, x = across (to match at())
      const box = (s, a, y, hs, ha, hy, m, b, skip = 0) => RB(at(s, a, y), [ha, hy, hs], Rs, m, b, skip);
      const nose = Math.min(0.035, g * 0.35);
      for (let i = 0; i < N; i++) {
        const s0 = g * i, s1 = g * (i + 1), y = rise * (i + 1);
        Q(at(s0, -hw, y), at(s0, hw, y), at(s1, hw, y), at(s1, -hw, y), 0, 1, 0, 0);                    // tread (carpet)
        Q(at(s0, -hw, y - rise), at(s0, hw, y - rise), at(s0, hw, y - 0.02), at(s0, -hw, y - 0.02), -dx, 0, -dz, 16);   // riser
        box(s0 + nose * 0.3, 0, y - 0.011, nose, hw, 0.0125, 14, Math.min(0.009, nose * 0.5));          // nosing
      }
      // side panels: from the floor up to just above the nosings, flat once they reach the floor above
      const lineY = (sv) => Math.min(FH, sv / RUN * FH + rise + 0.07), sF = Math.min(RUN, (FH - rise - 0.07) / FH * RUN);
      for (const sd of [-1, 1]) {
        const a0 = sd * hw, a1 = sd * (hw + 0.045), n = sd;
        for (const [sa, sb] of [[-0.02, sF], [sF, RUN]]) {
          if (sb - sa < 1e-3) continue;
          const ya = lineY(Math.max(0, sa)), ybb = lineY(sb);
          Q(at(sa, a1, 0), at(sb, a1, 0), at(sb, a1, ybb), at(sa, a1, ya), px * n, 0, pz * n, 2);         // outside
          Q(at(sa, a0, rise * 0), at(sb, a0, 0), at(sb, a0, ybb), at(sa, a0, ya), -px * n, 0, -pz * n, 2); // inside (above the treads)
          const tl = Math.hypot(sb - sa, ybb - ya), ny = (sb - sa) / tl, ns = -(ybb - ya) / tl;
          Q(at(sa, a0, ya), at(sb, a0, ybb), at(sb, a1, ybb), at(sa, a1, ya), dx * ns, ny, dz * ns, 16);    // cap
        }
        Q(at(-0.02, a0, 0), at(-0.02, a1, 0), at(-0.02, a1, lineY(0)), at(-0.02, a0, lineY(0)), -dx, 0, -dz, 16);
      }
      Q(at(RUN, -hw - 0.045, 0), at(RUN, hw + 0.045, 0), at(RUN, hw + 0.045, FH), at(RUN, -hw - 0.045, FH), dx, 0, dz, 2);   // back
      // handrails: a newel post at the foot, balusters on the side panels, the rail 0.9 m above the nosings
      const railY = (sv) => sv / RUN * FH + rise + 0.9;
      for (const sd of [-1, 1]) {
        const ar = sd * (hw + 0.022);
        CYL(at(0.03, ar, 0), at(0.03, ar, railY(0.03) + 0.06), 0.032, 15, 8, 2);
        SPH(at(0.03, ar, railY(0.03) + 0.075), [0.042, 0.042, 0.042], I3, 15, 4, 8);
        const nb = Math.max(2, Math.round(RUN / 0.16));
        for (let k = 1; k < nb; k++) { const sv = RUN * k / nb; CYL(at(sv, ar, lineY(sv)), at(sv, ar, railY(sv)), 0.009, 6, 6); }
        CYL(at(0.03, ar, railY(0.03)), at(RUN, ar, railY(RUN)), 0.026, 15, 8);
        if (st[7] !== 1) {                     // a newel post at the top too, standing on the floor above
          CYL(at(RUN - 0.03, ar, FH), at(RUN - 0.03, ar, railY(RUN) + 0.06), 0.032, 15, 8, 2);
          SPH(at(RUN - 0.03, ar, railY(RUN) + 0.075), [0.042, 0.042, 0.042], I3, 15, 4, 8);
        }
      }
      // upstairs: a guard rail along both sides and across the far end of the opening
      if (st[7] !== 1) {
        wellRect(x, z, st, r);
        const yU = y0 + FH, gw = hw + 0.12, s0 = st[4] * RUN - 0.02;
        const post = (sv, a) => { const p0 = at(sv, a, 0); CYL([p0[0], yU, p0[2]], [p0[0], yU + 1.04, p0[2]], 0.022, 6, 8, 2); };
        const rail = (sa, aa, sb, ab, h, rr) => { const p0 = at(sa, aa, 0), p1 = at(sb, ab, 0); CYL([p0[0], yU + h, p0[2]], [p1[0], yU + h, p1[2]], rr, 6, 8); };
        for (const [sa, aa, sb, ab] of [[s0, -gw, RUN, -gw], [s0, gw, RUN, gw], [s0, -gw, s0, gw]]) {
          rail(sa, aa, sb, ab, 1.02, 0.022); rail(sa, aa, sb, ab, 0.5, 0.012);
          const n = Math.max(1, Math.round(Math.hypot(sb - sa, ab - aa) / 1.1));
          for (let k = 0; k <= n; k++) post(sa + (sb - sa) * k / n, aa + (ab - aa) * k / n);
        }
      }
    }
    // ---- the pool: tiled basin walls where the next cell isn't pool, a drain, a ladder ----
    if (poolAt(seed, lv, x, z)) {
      const yb = y0 - POOL_D, ax = x * CELL, az = z * CELL, bx = ax + CELL, bz = az + CELL;
      Q([ax, yb, az], [ax, yb, bz], [bx, yb, bz], [bx, yb, az], 0, 1, 0, 19);
      if (!poolAt(seed, lv, x, z - 1)) Q([ax, yb, az], [bx, yb, az], [bx, y0, az], [ax, y0, az], 0, 0, 1, 19);
      if (!poolAt(seed, lv, x, z + 1)) Q([bx, yb, bz], [ax, yb, bz], [ax, y0, bz], [bx, y0, bz], 0, 0, -1, 19);
      if (!poolAt(seed, lv, x - 1, z)) Q([ax, yb, bz], [ax, yb, az], [ax, y0, az], [ax, y0, bz], 1, 0, 0, 19);
      if (!poolAt(seed, lv, x + 1, z)) Q([bx, yb, az], [bx, yb, bz], [bx, y0, bz], [bx, y0, az], -1, 0, 0, 19);
      const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      // coping: a rounded concrete lip along each edge, overhanging the basin a little. Pieces overlap
      // by 2 cm to hide the rounded ends, each a fraction of a mm lower than its neighbour (no z-fighting);
      // z edges run past the corner to cover it.
      const CW = 0.15, CO = 0.035, CH = 0.022;
      for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        if (poolAt(seed, lv, x + dx, z + dz)) continue;
        if (dx === 0) {
          const ez = dz < 0 ? az : bz, x0 = ax - (poolAt(seed, lv, x - 1, z) ? 0.02 : CW), x1 = bx + (poolAt(seed, lv, x + 1, z) ? 0.02 : CW);
          RB([(x0 + x1) / 2, y0 - 0.008 - (x & 1) * 0.0006, ez + dz * (CW - CO) / 2], [(x1 - x0) / 2, CH, (CW + CO) / 2], I, 11, 0.018, B8);
        } else {
          const ex = dx < 0 ? ax : bx, z0 = az + (poolAt(seed, lv, x, z - 1) ? -0.02 : CO - 0.02), z1 = bz - (poolAt(seed, lv, x, z + 1) ? -0.02 : CO - 0.02);
          RB([ex + dx * (CW - CO) / 2, y0 - 0.0083 - (z & 1) * 0.0006, (z0 + z1) / 2], [(CW + CO) / 2, CH, (z1 - z0) / 2], I, 11, 0.018, B8);
        }
      }
      if (hashU(sL, 970, x, z) % 3 === 0) {                                  // round drain: rim, dark sump, grate bars
        CYL([mx, yb, mz], [mx, yb + 0.006, mz], 0.13, 6, 16, 2);
        CYL([mx, yb + 0.006, mz], [mx, yb + 0.0075, mz], 0.108, 14, 16, 2);
        for (let k = -2; k <= 2; k++) { const oz = k * 0.04; OB([mx, yb + 0.009, mz + oz], [Math.sqrt(0.108 * 0.108 - oz * oz), 0.0015, 0.007], I, 6, B8); }
      }
      if (!poolAt(seed, lv, x, z - 1) && !poolAt(seed, lv, x - 1, z)) {      // ladder in the pool's corner cell
        // two bent stainless tubes: up out of the basin, over the coping in a half circle, down into the deck
        const fz = az + 0.11, top = y0 + 0.5, rr = 0.19, cz = fz - rr, r = 0.021;
        for (const rx of [mx - 0.27, mx + 0.27]) {
          let p = [rx, yb + 0.03, fz];
          CYL([rx, yb, fz], p, r * 1.15, 14, 10, 1);                          // rubber foot
          const step = (q) => { CYL(p, q, r, 6, 10); SPH(q, [r, r, r], I, 6, 4, 10); p = q; };
          step([rx, top, fz]);
          for (let k = 1; k <= 10; k++) { const t = k / 10 * PI; step([rx, top + rr * Math.sin(t), cz + rr * Math.cos(t)]); }
          step([rx, y0, cz - rr]);
          CYL([rx, y0, cz - rr], [rx, y0 + 0.012, cz - rr], 0.042, 6, 14, 2);   // deck flange
        }
        for (let k = 1; k <= 2; k++) {                                        // treads with a black anti-slip top
          const ty = yb + k * POOL_D / 3 + 0.02;
          RB([mx, ty, fz - 0.035], [0.25, 0.014, 0.065], I, 6, 0.008);
          OB([mx, ty + 0.0145, fz - 0.035], [0.22, 0.001, 0.05], I, 14, B8);
        }
      }
    }
    // ---- on the walls: outlets low down, return-air grilles up high, exit signs over some doors ----
    for (let e = 0; e < 2; e++) {
      const hor = e === 0, salt = hor ? SALT_H : SALT_V, line = hor ? z : x, i = hor ? x : z;
      const k = hor ? kindH(sL, x, z) : kindV(sL, x, z);
      if (k !== 1 && k !== 2) continue;
      if (roomCell(sL, x, z) === 10 || roomCell(sL, hor ? x : x - 1, hor ? z - 1 : z) === 10) continue;   // the hallway stays bare
      const h = hashU(sL, 961 + e, line, i), s = (h & 1) ? 1 : -1, u = unit(hashU(sL, 963 + e, line, i));
      const L = line * CELL, I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const at = (a, y, o) => hor ? [a, y0 + y, L + o] : [L + o, y0 + y, a];
      const half = (ha, hy, ho) => hor ? [ha, hy, ho] : [ho, hy, ha];
      const r0 = unit(h);
      if (k === 1) {
        if (r0 >= 0.13 || bow(sL, salt, line, i) !== 0) continue;
        const a = i * CELL + 0.35 + u * (CELL - 0.7);
        if (r0 < 0.1) {                              // outlet: beige plate, two dark sockets
          OB(at(a, 0.32, s * (THICK + 0.006)), half(0.036, 0.058, 0.006), I, 16);
          for (const dy of [-0.022, 0.022]) OB(at(a, 0.32 + dy, s * (THICK + 0.0125)), half(0.014, 0.011, 0.001), I, 14);
        } else OB(at(a, 2.38, s * (THICK + 0.012)), half(0.26, 0.13, 0.012), I, 18);   // grille
        continue;
      }
      // exit sign over a door: lit red letters, sometimes an arrow pointing nowhere in particular
      if (r0 >= 0.08) continue;
      doorShape(sL, salt, line, i, dsW);
      if (dsW[0] !== 1 || dsW[3] > 2.45) continue;
      const a = i * CELL + (dsW[1] + dsW[2]) / 2 * CELL, yc = dsW[3] + 0.17, o = s * (THICK + 0.03);
      OB(at(a, yc, o), half(0.21, 0.085, 0.03), I, 14);
      const arrow = (h >>> 8) % 3, text = (arrow === 1 ? '<' : '') + 'EXIT' + (arrow === 2 ? '>' : '');
      const px = 0.022, wpx = text.length * 4 - 1, dir = hor ? s : -s, of = o + s * 0.031;
      for (let ci = 0; ci < text.length; ci++) GLYPH[text[ci]].forEach((row, ry) => {
        for (let c = 0; c < 3; c++) if (row & (4 >> c)) {
          const ga = a + dir * ((ci * 4 + c) - (wpx - 1) / 2) * px, gy = yc + (2 - ry) * px;
          const a0 = ga - px / 2, a1 = ga + px / 2, b0 = gy - px / 2, b1 = gy + px / 2;
          const nx = hor ? 0 : s, nz = hor ? s : 0;
          const P3 = (aa, yy) => hor ? [aa, y0 + yy, L + of] : [L + of, y0 + yy, aa];
          Q(P3(a0, b0), P3(a1, b0), P3(a1, b1), P3(a0, b1), nx, 0, nz, 17);
        }
      });
    }
    // ---- rarely, at the far end of a long open view, someone standing (the shader hides them up close) ----
    const fd = figureAt(seed, lv, x, z);
    if (fd >= 0) {
      const dx = fd === 0 ? 1 : fd === 1 ? -1 : 0, dz = fd === 2 ? 1 : fd === 3 ? -1 : 0;
      const R = rot(dx > 0 ? Math.PI / 2 : dx < 0 ? -Math.PI / 2 : dz > 0 ? 0 : Math.PI), o = [mx, y0, mz];
      const n0 = n, P = (q) => loc(R, o, q);
      for (const sx of [-1, 1]) {                                    // legs: thigh, shin, foot
        CYL(P([sx * 0.08, 0.95, 0]), P([sx * 0.075, 0.5, 0.01]), 0.062, 20, 7, 0, 0.046);
        CYL(P([sx * 0.075, 0.5, 0.01]), P([sx * 0.07, 0.08, -0.01]), 0.046, 20, 7, 0, 0.034);
        RB(P([sx * 0.072, 0.035, 0.035]), [0.042, 0.035, 0.11], R, 20, 0.03, B8);
      }
      SPH(P([0, 0.95, 0]), [0.155, 0.13, 0.1], R, 20, 5, 8);               // hips
      SPH(P([0, 1.13, 0.005]), [0.15, 0.17, 0.09], R, 20, 5, 8);           // belly
      SPH(P([0, 1.34, 0.005]), [0.175, 0.19, 0.1], R, 20, 5, 8);           // chest
      for (const sx of [-1, 1]) {                                    // shoulders, arms hanging close, long hands
        SPH(P([sx * 0.175, 1.47, 0]), [0.06, 0.055, 0.055], R, 20, 4, 6);
        CYL(P([sx * 0.185, 1.47, 0]), P([sx * 0.195, 1.15, -0.01]), 0.045, 20, 6, 0, 0.038);   // arms hang against the body
        CYL(P([sx * 0.195, 1.15, -0.01]), P([sx * 0.19, 0.86, 0.02]), 0.037, 20, 6, 0, 0.028);
        SPH(P([sx * 0.19, 0.79, 0.025]), [0.025, 0.08, 0.038], R, 20, 4, 6);
      }
      CYL(P([0, 1.48, 0]), P([0, 1.63, 0.02]), 0.045, 20, 7, 0, 0.04);    // neck, a little long
      SPH(P([0, 1.73, 0.035]), [0.08, 0.115, 0.095], tiltX(R, -0.3), 20, 6, 8);   // head, bowed slightly
      for (let v = n0; v < n; v += FLOATS) { out[v + 3] = mx; out[v + 4] = y0; out[v + 5] = mz; }   // feet, for the vertex shader
    }
    if (ceilHole(seed, lv, x, z, r)) continue;
    // ---- broken and hanging light panels (the shader draws the rest flat in the ceiling) ----
    const kL = cellLight(seed, lv, x, z);
    if (kL === 3 || (kL === 4 && hungN < 6)) {
      lightGeom(seed, lv, x, z, kL, LG);
      const ox = LG[0], oz = LG[1], hx = LG[2], hz = LG[3], cxL = mx + ox, czL = mz + oz, yC = y0 + HEIGHT;
      const longZ = hz >= hx, L = longZ ? hz : hx, S = longZ ? hx : hz;
      const P2 = (a, c, y) => longZ ? [cxL + c, y, czL + a] : [cxL + a, y, czL + c];   // along the long side, across it
      if (kL === 3) {                          // the cover's gone: two bare tubes in their sockets, the ballast channel
        const dead = (hashU(sL, 312, x, z) & 1) === 1;
        for (const side of [-1, 1]) {
          const c = side * S * 0.33;
          CYL(P2(-(L - 0.045), c, yC - 0.034), P2(L - 0.045, c, yC - 0.034), 0.0127, dead && side > 0 ? 8 : 4, 8, 3);
          for (const e of [-1, 1]) RB(P2(e * (L - 0.026), c, yC - 0.024), longZ ? [0.024, 0.024, 0.02] : [0.02, 0.024, 0.024], I3, 16, 0.006);
        }
        RB(P2(0, 0, yC - 0.009), longZ ? [S * 0.14, 0.009, L - 0.07] : [L - 0.07, 0.009, S * 0.14], I3, 3, 0.004);
        // the lens door: on the floor underneath, hanging open from one side, or gone
        const dv = hashU(sL, 350, x, z) % 10;
        if (dv < 4 && roomCell(sL, x, z) < 0 && propAt(seed, lv, x, z, pL)[0] < 0 && !floorHole(seed, lv, x, z, rL) && !stairAt(seed, lv, x, z)) {
          const u = unit(hashU(sL, 351, x, z)), R = rot((u - 0.5) * 1.4), o = [cxL + (u - 0.5) * 0.7, y0 + 0.008, czL + (unit(hashU(sL, 354, x, z)) - 0.5) * 0.7];
          RB(o, [hx, 0.008, hz], R, 3, 0.004, B8);
          OB(loc(R, o, [0, 0.0085, 0]), [hx - 0.02, 0.0012, hz - 0.02], R, 8, B8);
        } else if (dv < 8) {
          const s = (hashU(sL, 352, x, z) & 1) ? 1 : -1, a = 1.3 + 0.25 * unit(hashU(sL, 353, x, z));
          const ux = longZ ? -s : 0, uz = longZ ? 0 : -s;                 // hinge -> free edge
          axisRot(RD, uz, 0, -ux, a);
          const piv = P2(0, s * S, yC - 0.004);
          RB(loc(RD, piv, [ux * S, -0.008, uz * S]), [hx, 0.008, hz], RD, 3, 0.004);
          OB(loc(RD, piv, [ux * S, -0.0172, uz * S]), [hx - 0.02, 0.0012, hz - 0.02], RD, 8);
        }
      } else {                                 // hanging: housing and diffuser, its wires, the flex conduit
        hungN++;
        const R = hang.R, q = hang.q, piv = [mx + hang.P[0], y0 + hang.P[1], mz + hang.P[2]];
        const W = (lx, ly, lz) => loc(R, piv, [lx - q[0], ly - q[1], lz - q[2]]);
        RB(W(0, -0.055, 0), [hx, 0.055, hz], R, 3, 0.012);
        OB(W(0, -0.1125, 0), [hx - 0.025, 0.003, hz - 0.025], R, 4);
        if (hang.v === 2) for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const ex = sx * (hx - 0.03), ez = sz * (hz - 0.03);
          CYL([cxL + ex * 1.05, yC + 0.02, czL + ez * 1.05], W(ex, 0, ez), 0.0022, 6, 4);
        }
        const a0 = [cxL + 0.08 * (longZ ? 1 : 0.5), yC + 0.03, czL + 0.08 * (longZ ? 0.5 : 1)], b0 = W(0.1 * (longZ ? 1 : 0), 0, 0.1 * (longZ ? 0 : 1));
        cable(a0, b0, 0.12 + 0.12 * unit(hashU(sL, 355, x, z)), 0.0085, 6, 8, 6);
      }
    }
    // cable bundles drooping out of missing ceiling tiles
    const tx0 = x * 5, tz0 = Math.floor((z * CELL - 0.3) / 0.6);
    for (let tz = tz0; tz < tz0 + 6; tz++) for (let tx = tx0; tx < tx0 + 5; tx++) {
      const ccz = 0.3 + (tz + 0.5) * 0.6;
      if (ccz < z * CELL || ccz >= (z + 1) * CELL) continue;          // tile centre must be in this cell
      if (bundles >= MAX_BUNDLES || !tileMissing(sL, lv, tx, tz) || hashU(sL, 701, tx, tz) >= U(0.3)) continue;
      bundles++;
      // a bundle: k cables leaving the hole roughly together. Most loop back up into the ceiling, some
      // dangle with a plug on the end, and now and then one has slumped all the way down onto the floor.
      const ccx = (tx + 0.5) * 0.6, k = 3 + hashU(sL, 702, tx, tz) % 5, hb = hashU(sL, 704, tx, tz);
      const ang0 = unit(hb) * 6.283, len0 = 0.8 + 1.6 * unit(hashU(sL, 705, tx, tz)), sag0 = 0.4 + 0.8 * unit(hashU(sL, 706, tx, tz));
      const floorOk = roomCell(sL, x, z) < 0 && !floorHole(seed, lv, x, z, rL) && !stairAt(seed, lv, x, z) && propAt(seed, lv, x, z, pL)[0] < 0;
      const top = y0 + HEIGHT + 0.04;
      for (let c = 0; c < k; c++) {
        const hc = hashU(sL, 703 + c, tx, tz), hd = hashU(sL, 720 + c, tx, tz), jit = (b) => ((hc >>> b) & 255) / 255 - 0.5;
        const ty = unit(hd);                     // what kind of cable
        const [w, m] = ty < 0.45 ? [0.004 + 0.002 * unit(hc), 5] : ty < 0.65 ? [0.008, 14] : ty < 0.8 ? [0.0035, 16] : ty < 0.93 ? [0.011, 6] : [0.005, 7];
        const ang = ang0 + jit(0) * 0.6, len = len0 * (1 + jit(8) * 0.35), sag = sag0 * (1 + jit(16) * 0.5);
        const ax = ccx + jit(4) * 0.22, az = ccz + jit(12) * 0.22, a = [ax, top, az];
        const shape = (hc >>> 24) % 20;          // 0-11 loop, 12-17 dangle, 18-19 down to the floor
        if (shape < 12) {
          cable(a, [ax + Math.cos(ang) * len, top - 0.02, az + Math.sin(ang) * len], Math.min(sag, HEIGHT - 1.2), w, m, 10);
        } else if (shape < 18 || !floorOk) {     // dangling: a gentle curve down, sometimes a plug on the end
          const dl = 0.35 + 1.1 * unit(hashU(sL, 730 + c, tx, tz)), dx = Math.cos(ang) * 0.25, dz = Math.sin(ang) * 0.25;
          let pp = a;
          for (let j = 1; j <= 8; j++) {
            const t = j / 8, q = [ax + dx * t * t + jit(20) * 0.05 * Math.sin(t * 5), top - dl * t, az + dz * t * t];
            CYL(pp, q, w, m, 5); pp = q;
          }
          if ((hd >>> 4) & 1) RB([pp[0], pp[1] - 0.02, pp[2]], [w + 0.007, 0.024, w + 0.005], I3, (hd >>> 5) & 1 ? 14 : 16, 0.004);
          else if (m === 5 || m === 14) for (const s2 of [-1, 1]) CYL(pp, [pp[0] + s2 * 0.012, pp[1] - 0.03, pp[2] + 0.006], 0.0012, 6, 3);   // bare wires
        } else {                                 // slumped onto the floor: down in a curve, then along the carpet
          const kx = (v) => Math.max(x * CELL + 0.15, Math.min((x + 1) * CELL - 0.15, v)), kz = (v) => Math.max(z * CELL + 0.15, Math.min((z + 1) * CELL - 0.15, v));   // stay in the cell
          const fx = kx(ax + Math.cos(ang) * 0.4), fz = kz(az + Math.sin(ang) * 0.4), fy = y0 + w;
          let pp = a;
          for (let j = 1; j <= 10; j++) {         // quadratic curve: from the hole, pulled down toward the floor
            const t = j / 10, u = 1 - t, q = [u * u * ax + 2 * u * t * ax + t * t * fx, u * u * top + 2 * u * t * (fy + 0.1) + t * t * fy, u * u * az + 2 * u * t * az + t * t * fz];
            CYL(pp, q, w, m, 5); pp = q;
          }
          const run = 0.5 + 0.9 * unit(hashU(sL, 731 + c, tx, tz)), a2 = ang + jit(20) * 1.2;
          for (let j = 1; j <= 4; j++) {
            const q = [kx(fx + Math.cos(a2) * run * j / 4 + Math.sin(j * 1.7 + c) * 0.04), fy, kz(fz + Math.sin(a2) * run * j / 4 + Math.cos(j * 1.3 + c) * 0.04)];
            CYL(pp, q, w, m, 5); pp = q;
          }
        }
      }
    }
    furnish(seed, lv, x, z, build);
    // wrong objects
    propAt(seed, lv, x, z, p);
    const t = p[0];
    if (t < 0) continue;
    const yaw = p[1];
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
    } else if (t === 3) officeChair([mx, y0, mz], rot(yaw), 0.45 + 0.9 * p[2], 0.3 + 0.6 * p[3]);
    else if (t === 4) officeChair([mx, y0 + HEIGHT, mz], rot(yaw, 0, Math.PI));
    else if (t === 5) {                        // four-drawer filing cabinet tilted into the floor
      const R = rot(yaw, 0.25 + 0.3 * p[2], (p[3] - 0.5) * 0.4), o = [mx, y0 + 0.4, mz];
      RB(o, [0.24, 0.7, 0.32], R, 6, 0.01);
      for (let k = 0; k < 4; k++) {
        const y = 0.7 - 0.175 - k * 0.35;
        RB(loc(R, o, [0, y, 0.326]), [0.218, 0.158, 0.009], R, 6, 0.006, 32);
        RB(loc(R, o, [0, y + 0.07, 0.34]), [0.065, 0.014, 0.01], R, 6, 0.006, 32);              // pull
        RB(loc(R, o, [0, y + 0.115, 0.336]), [0.036, 0.019, 0.002], R, 6, 0.002, 32);           // label holder
        OB(loc(R, o, [0, y + 0.115, 0.3385]), [0.03, 0.014, 0.0005], R, 8, 32 | 1 | 2 | 4 | 8);   // card
      }
    }
    else if (t === 6) {                        // a door frame standing in the middle of the room
      const R = rot(yaw), o = [mx, y0, mz];
      OB(loc(R, o, [-0.62, HEIGHT / 2, 0]), [0.17, HEIGHT / 2, THICK], R, 2);
      OB(loc(R, o, [0.62, HEIGHT / 2, 0]), [0.17, HEIGHT / 2, THICK], R, 2);
      OB(loc(R, o, [0, (HEIGHT + 2.05) / 2, 0]), [0.45, (HEIGHT - 2.05) / 2, THICK], R, 2);
    }
  }
  // glossy triangles last: they are drawn with a second pipeline that adds highlights, so the shader
  // for walls, carpet and ceiling (most of the screen) stays small enough to run at full speed
  const nv = n / FLOATS;
  let w = 0;
  shinyFrom = 0;
  if (!part || part.length < out.length) part = new Float32Array(out.length);
  const TF = 3 * FLOATS;
  for (let pass = 0; pass < 2; pass++) {
    for (let t = 0; t < n; t += TF) {
      if (SHINY[out[t + 6] | 0] !== pass) continue;
      for (let j = 0; j < TF; j++) part[w + j] = out[t + j];
      w += TF;
    }
    if (pass === 0) shinyFrom = w / FLOATS;
  }
  out.set(part.subarray(0, n));
  return nv;
}
// materials drawn with highlights: metal, sign red/white, laminate, glass, black and beige plastic,
// drawer fronts, pool tile, door paint
const SHINY = new Uint8Array(32); for (const m of [6, 7, 8, 9, 13, 14, 15, 16, 19, 21]) SHINY[m] = 1;
let part = null;
const rbP = new Float64Array(64 * 3);
// vertex index where the last chunk built by buildLevelChunk switches to glossy materials
export let shinyFrom = 0;
