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
  if (stairAt(seed, lv - 1, x, z)) { wellRect(x, z, stairShape(seed, lv - 1, x, z, stH), r); return true; }
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
      const cx = (x + 0.5) * CELL, cz = (z + 0.5) * CELL;
      const along = (stH[0] !== 0 ? (px - cx) * stH[0] : (pz - cz) * stH[1]) + RUN / 2;
      const across = Math.abs(stH[0] !== 0 ? pz - cz : px - cx);
      if (along >= 0 && along <= RUN && across <= stH[2]) {
        const i = Math.min(stH[3] - 1, Math.floor(along / RUN * stH[3]));
        return l * FH + (i + 1) * FH / stH[3];
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
  }) * FLOATS;
  const V = (x, y, z, nx, ny, nz, m) => { if (n + FLOATS > out.length) return; out[n] = x; out[n + 1] = y; out[n + 2] = z; out[n + 3] = nx; out[n + 4] = ny; out[n + 5] = nz; out[n + 6] = m; n += FLOATS; };
  const Q = (a, b, c, d, nx, ny, nz, m) => { V(...a, nx, ny, nz, m); V(...b, nx, ny, nz, m); V(...c, nx, ny, nz, m); V(...a, nx, ny, nz, m); V(...c, nx, ny, nz, m); V(...d, nx, ny, nz, m); };
  // oriented box: centre c, half sizes h, rotation R (3x3, columns = local axes), material m
  // skip: faces to leave out, bit (2 * axis + (negative side ? 1 : 0)); 8 = the bottom (never seen on the floor)
  const OB = (c, h, R, m, skip = 0) => {
    const P = (sx, sy, sz) => [c[0] + R[0] * sx * h[0] + R[3] * sy * h[1] + R[6] * sz * h[2], c[1] + R[1] * sx * h[0] + R[4] * sy * h[1] + R[7] * sz * h[2], c[2] + R[2] * sx * h[0] + R[5] * sy * h[1] + R[8] * sz * h[2]];
    const face = (ax, s, m2) => {             // the face whose normal is local axis ax * s
      const u = (ax + 1) % 3, v = (ax + 2) % 3, pt = (a, b) => { const q = [0, 0, 0]; q[ax] = s; q[u] = a; q[v] = b; return P(q[0], q[1], q[2]); };
      Q(pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1), R[ax * 3] * s, R[ax * 3 + 1] * s, R[ax * 3 + 2] * s, m2);
    };
    for (let ax = 0; ax < 3; ax++) { if (!(skip & (1 << ax * 2))) face(ax, 1, m); if (!(skip & (2 << ax * 2))) face(ax, -1, m); }
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

  // ---- furniture. Origins at the floor centre; a seat faces +z, a desk's user side is +z.
  // Materials: 6 metal, 9 laminate, 10 fabric, 13 screen, 14 black plastic, 15 drawer fronts, 16 beige plastic
  const B8 = 8;                                // leave out bottom faces
  // office chair: five-star base, gas column, seat, reclined back on a spine, armrests
  const officeChair = (o, R, legs = 0.45, back = 0.3, arms = true) => {
    for (let k = 0; k < 5; k++) { const a = k * 1.2566 + 0.3, Rk = turnY(R, a); OB(loc(R, o, [Math.cos(a) * 0.15, 0.05, -Math.sin(a) * 0.15]), [0.15, 0.018, 0.022], Rk, 14, B8); }
    OB(loc(R, o, [0, 0.09, 0]), [0.035, 0.035, 0.035], R, 14, B8);
    OB(loc(R, o, [0, (legs + 0.12) / 2, 0]), [0.022, (legs - 0.12) / 2, 0.022], R, 6, B8 | 4);
    OB(loc(R, o, [0, legs - 0.03, 0]), [0.11, 0.025, 0.11], R, 14);
    OB(loc(R, o, [0, legs + 0.035, 0.01]), [0.25, 0.04, 0.24], R, 10);
    OB(loc(R, o, [0, legs + 0.12, -0.26]), [0.035, 0.12, 0.014], R, 14);
    const Rb = tiltX(R, 0.14);
    OB(loc(R, o, [0, legs + 0.2 + back, -0.27 - 0.14 * (0.1 + back)]), [0.23, back, 0.035], Rb, 10);
    if (arms) for (const sx of [-0.27, 0.27]) {
      OB(loc(R, o, [sx, legs + 0.13, -0.02]), [0.014, 0.1, 0.022], R, 14, B8);
      OB(loc(R, o, [sx, legs + 0.24, 0]), [0.03, 0.014, 0.11], R, 14);
    }
  };
  // stacking chair, the kind set out in rows: four thin legs, the back legs rise into the backrest
  const stackChair = (o, R) => {
    OB(loc(R, o, [0, 0.45, 0]), [0.22, 0.03, 0.21], R, 10);
    for (const sx of [-0.19, 0.19]) {
      OB(loc(R, o, [sx, 0.21, 0.17]), [0.012, 0.21, 0.012], R, 6, B8 | 4);
      OB(loc(R, o, [sx, 0.45, -0.2]), [0.012, 0.45, 0.012], tiltX(R, 0.06), 6, B8);
    }
    OB(loc(R, o, [0, 0.79, -0.235]), [0.21, 0.12, 0.02], tiltX(R, 0.06), 10);
  };
  // office desk: drawer pedestal on the right, side panel on the left, modesty panel,
  // a beige CRT on a stand and a keyboard
  const desk = (o, R) => {
    OB(loc(R, o, [0, 0.74, 0]), [0.7, 0.018, 0.36], R, 9);
    OB(loc(R, o, [0.48, 0.36, 0]), [0.2, 0.36, 0.33], R, 9, B8 | 4);
    for (let k = 0; k < 3; k++) {
      const y = 0.6 - k * 0.23;
      OB(loc(R, o, [0.48, y, 0.335]), [0.185, 0.1, 0.006], R, 15, 32);
      OB(loc(R, o, [0.48, y + 0.06, 0.345]), [0.05, 0.008, 0.008], R, 6, 32);
    }
    OB(loc(R, o, [-0.67, 0.36, 0]), [0.02, 0.36, 0.33], R, 9, B8 | 4);
    OB(loc(R, o, [-0.19, 0.45, -0.31]), [0.46, 0.25, 0.01], R, 9);
    OB(loc(R, o, [0, 0.775, -0.14]), [0.11, 0.017, 0.11], R, 16, B8);
    OB(loc(R, o, [0, 0.96, -0.24]), [0.15, 0.13, 0.13], R, 16, B8);
    OB(loc(R, o, [0, 0.965, -0.075]), [0.2, 0.175, 0.04], R, 16);
    OB(loc(R, o, [0, 0.975, -0.033]), [0.16, 0.13, 0.004], R, 13, 32);
    OB(loc(R, o, [0, 0.77, 0.17]), [0.22, 0.012, 0.075], tiltX(R, -0.05), 16, B8);
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
      OB([px, y0 + top / 2, pz], [len, top / 2, 0.035], R, 12, B8);
      OB([px, y0 + top + 0.012, pz], [len, 0.012, 0.042], R, 6);                 // aluminium cap rail
      if (py >= 0) OB([px, y0 + 0.05, pz], [len - 0.01, 0.05, 0.04], R, 14, B8); // kick strip
    } else if (type === ITEM_CHAIR) officeChair(o, R);
    else if (type === ITEM_SEAT) stackChair(o, R);
    else if (type === ITEM_DOOR) {                // a plain door, shut, set against the wall
      OB(loc(R, o, [0, 1.0, 0.03]), [0.44, 1.0, 0.025], R, 21, B8 | 32);
      for (const sx of [-0.49, 0.49]) OB(loc(R, o, [sx, 1.04, 0.025]), [0.05, 1.04, 0.025], R, 16, B8 | 32);
      OB(loc(R, o, [0, 2.12, 0.025]), [0.54, 0.05, 0.025], R, 16, 32);
      OB(loc(R, o, [0.34, 0.98, 0.075]), [0.025, 0.025, 0.02], R, 6, 32);
      OB(loc(R, o, [0.34, 0.98, 0.06]), [0.045, 0.06, 0.004], R, 6, 32);
    }
    else if (type === ITEM_FRAME) { o[1] = y0; frame(o, R, -py); }
    else if (type === ITEM_PILLAR) OB([px, y0 + (py + HEIGHT) / 2, pz], [0.25, (HEIGHT - py) / 2, 0.25], R, 2);
    else desk(o, R);
  };
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
    // ---- the pool: tiled basin walls where the next cell isn't pool, a drain, a ladder ----
    if (poolAt(seed, lv, x, z)) {
      const yb = y0 - POOL_D, ax = x * CELL, az = z * CELL, bx = ax + CELL, bz = az + CELL;
      Q([ax, yb, az], [ax, yb, bz], [bx, yb, bz], [bx, yb, az], 0, 1, 0, 19);
      if (!poolAt(seed, lv, x, z - 1)) Q([ax, yb, az], [bx, yb, az], [bx, y0, az], [ax, y0, az], 0, 0, 1, 19);
      if (!poolAt(seed, lv, x, z + 1)) Q([bx, yb, bz], [ax, yb, bz], [ax, y0, bz], [bx, y0, bz], 0, 0, -1, 19);
      if (!poolAt(seed, lv, x - 1, z)) Q([ax, yb, bz], [ax, yb, az], [ax, y0, az], [ax, y0, bz], 1, 0, 0, 19);
      if (!poolAt(seed, lv, x + 1, z)) Q([bx, yb, az], [bx, yb, bz], [bx, y0, bz], [bx, y0, az], -1, 0, 0, 19);
      const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (hashU(sL, 970, x, z) % 3 === 0) OB([mx, yb + 0.004, mz], [0.12, 0.004, 0.12], I, 14, B8);
      if (!poolAt(seed, lv, x, z - 1) && !poolAt(seed, lv, x - 1, z)) {      // ladder in the pool's corner cell
        const lz = az + 0.09;
        for (const rx of [mx - 0.25, mx + 0.25]) {
          OB([rx, (yb + y0 + 0.85) / 2, lz], [0.018, (y0 + 0.85 - yb) / 2, 0.018], I, 6, B8);
          OB([rx, y0 + 0.85, lz - 0.17], [0.018, 0.018, 0.17], I, 6);
          OB([rx, y0 + 0.43, az - 0.33], [0.018, 0.43, 0.018], I, 6, B8);
        }
        for (let k = 1; k <= 2; k++) OB([mx, yb + k * POOL_D / 3, lz], [0.25, 0.012, 0.025], I, 6);
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
      const n0 = n;
      for (const sx of [-0.08, 0.08]) OB(loc(R, o, [sx, 0.47, 0]), [0.05, 0.47, 0.055], R, 20, B8);
      OB(loc(R, o, [0, 1.24, 0]), [0.15, 0.32, 0.075], R, 20);
      OB(loc(R, o, [0, 1.6, 0.01]), [0.03, 0.05, 0.03], R, 20);
      OB(loc(R, o, [0, 1.76, 0.03]), [0.085, 0.12, 0.1], tiltX(R, -0.25), 20);
      for (const sx of [-0.2, 0.2]) OB(loc(R, o, [sx, 0.98, 0]), [0.03, 0.56, 0.03], R, 20);
      for (let v = n0; v < n; v += FLOATS) { out[v + 3] = mx; out[v + 4] = y0; out[v + 5] = mz; }   // feet, for the vertex shader
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
      OB(o, [0.24, 0.7, 0.32], R, 6);
      for (let k = 0; k < 4; k++) {
        const y = 0.7 - 0.175 - k * 0.35;
        OB(loc(R, o, [0, y, 0.325]), [0.215, 0.155, 0.006], R, 6, 32);
        OB(loc(R, o, [0, y + 0.07, 0.338]), [0.06, 0.012, 0.008], R, 14, 32);
        OB(loc(R, o, [0, y + 0.115, 0.333]), [0.035, 0.018, 0.003], R, 8, 32);      // label card
      }
    }
    else if (t === 6) {                        // a door frame standing in the middle of the room
      const R = rot(yaw), o = [mx, y0, mz];
      OB(loc(R, o, [-0.62, HEIGHT / 2, 0]), [0.17, HEIGHT / 2, THICK], R, 2);
      OB(loc(R, o, [0.62, HEIGHT / 2, 0]), [0.17, HEIGHT / 2, THICK], R, 2);
      OB(loc(R, o, [0, (HEIGHT + 2.05) / 2, 0]), [0.45, (HEIGHT - 2.05) / 2, THICK], R, 2);
    }
  }
  return n / FLOATS;
}
