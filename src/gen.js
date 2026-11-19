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
// lineKind: 0 open (no wall), 1 wall, 2 doorway (see doorShape), 3 wall with a window hole.
// Processions override all of this in places (see below).
const U = (p) => Math.floor(p * 2 ** 32);
export const DENSITY_U = U(0.35), DOOR_U = U(0.35), WINDOW_U = U(0.06);
export const SALT_H = 101, SALT_V = 202;
const unit = (h) => (h >>> 8) / 16777216;
export const wallLike = (k) => k === 1 || k === 3;

// ---- mutation: 0 near the start, +1 every MUT_STEP cells (120 m) out, levels count as MUT_LEVEL
// cells each. Integer maths only (the shader has an exact copy). It lives here because the walls,
// doors and lights get stranger with it too.
export const MUT_STEP = 40, MUT_LEVEL = 25;
export function mutation(lv, x, z) {
  if (Math.abs(x) > 2000 || Math.abs(z) > 2000 || Math.abs(lv) > 60) return 8;
  const d2 = x * x + z * z + lv * MUT_LEVEL * lv * MUT_LEVEL;
  let k = 0; while (k < 8 && d2 >= ((k + 1) * MUT_STEP) ** 2) k++;
  return k;
}
// Functions here take a level's seed, not the level. levels.js registers which level each seed
// belongs to (noteLevel) so mutation can be looked up; an unregistered seed counts as level 0.
const LVS = new Map();
export function noteLevel(sL, lv) { if (LVS.get(sL) !== lv) LVS.set(sL, lv); }
export const lvOf = (sL) => { const v = LVS.get(sL); return v === undefined ? 0 : v; };
const mutF = (seed, x, z) => mutation(lvOf(seed), x, z) / 8;          // 0..1

// ---- special rooms: in some RB x RB blocks, one big open room (4..7 cells a side) with a theme.
// Its inside edges are all open, its outline is solid apart from a doorway on 2-4 sides (always two
// opposite ones, so it is a way through). More of them further out.
//   0 pits: the floor is a grid of holes down to the level below, with a ledge round the edge
//   1 office: rows of desks and chairs     2 chairs: an audience of chairs all facing one wall
//   3 pillars: a column at every inner grid point     4 dark: every light out but one
//   5 frames: a door frame standing in every cell, all facing the same way
//   6 red: the lights burn red        7 wet: the carpet is soaked and shines, the walls wick damp
//   8 cubicles: a farm of chest-high partitions, desks in some of the stalls
//   9 pool: a drained, tiled pool sunk into the floor     10 hallway: one cell wide and long; it loops
//   11 follow: only the light above you is on              12 closet: one cell, one way in, a door that goes nowhere
export const RB = 12, ROOM_THEMES = 13;
let rSeed = -1, rBX = 1e9, rBZ = 1e9, rOn = false;
export let rX0 = 0, rZ0 = 0, rX1 = 0, rZ1 = 0, rTheme = 0, rH = 0, rSides = 0;   // rSides: bit per side with a doorway
function roomAt(seed, bx, bz) {
  if (bx === rBX && bz === rBZ && seed === rSeed) return rOn;
  rSeed = seed; rBX = bx; rBZ = bz;
  const m = mutation(lvOf(seed), bx * RB + RB / 2, bz * RB + RB / 2);
  rOn = hashU(seed, 800, bx, bz) < U(0.14 + 0.03 * m);
  if (!rOn) return false;
  rTheme = hashU(seed, 805, bx, bz) % ROOM_THEMES; rH = hashU(seed, 806, bx, bz);
  const big = rTheme === 1 || rTheme === 2 || rTheme === 8 ? 2 : rTheme === 9 ? 3 : 4;   // furniture rooms stay smaller (vertex budget)
  const lo = rTheme === 9 ? 5 : 4;
  let w = lo + hashU(seed, 801, bx, bz) % big, d = lo + hashU(seed, 802, bx, bz) % big;
  rSides = (1 << (rH & 3)) | (1 << (rH & 3 ^ 1)) | ((rH >>> 4) & 15);   // 0/1 and 2/3 are opposite: always a way through
  if (rTheme === 10) {                                   // hallway: open only at its two ends
    const L = 10;                                       // (the loop in main.js needs exactly this)
    if (rH & 4) { w = L; d = 1; rSides = 12; } else { w = 1; d = L; rSides = 3; }
  } else if (rTheme === 12) { w = d = 1; rSides = 1 << (rH & 3); }
  rX0 = bx * RB + 1 + hashU(seed, 803, bx, bz) % (RB - 1 - w); rX1 = rX0 + w;
  rZ0 = bz * RB + 1 + hashU(seed, 804, bx, bz) % (RB - 1 - d); rZ1 = rZ0 + d;
  return true;
}
// theme of the special room that cell (x, z) is inside, or -1. Leaves rX0.. describing that room.
export function roomCell(seed, x, z) {
  if (!roomAt(seed, Math.floor(x / RB), Math.floor(z / RB))) return -1;
  return x >= rX0 && x < rX1 && z >= rZ0 && z < rZ1 ? rTheme : -1;
}
// -1: not a room edge, otherwise the edge's lineKind (0 inside, 1 outline, 2 doorway)
function roomEdge(seed, salt, line, along) {
  const hor = salt === SALT_H, x = hor ? along : line, z = hor ? line : along;
  if (!roomAt(seed, Math.floor(x / RB), Math.floor(z / RB))) return -1;
  let side, a0, len;
  if (hor) {
    if (x < rX0 || x >= rX1 || z < rZ0 || z > rZ1) return -1;
    if (z > rZ0 && z < rZ1) return 0;
    side = z === rZ0 ? 0 : 1; a0 = rX0; len = rX1 - rX0;
  } else {
    if (z < rZ0 || z >= rZ1 || x < rX0 || x > rX1) return -1;
    if (x > rX0 && x < rX1) return 0;
    side = x === rX0 ? 2 : 3; a0 = rZ0; len = rZ1 - rZ0;
  }
  const at = len < 3 ? a0 + (len === 2 ? hashU(seed, 810 + side, rBX, rBZ) % 2 : 0) : a0 + 1 + hashU(seed, 810 + side, rBX, rBZ) % (len - 2);
  return (rSides >> side & 1) && along === at ? 2 : 1;
}

// Processions: in some PB x PB blocks, the same doorway repeated pN times, either
//   in a line (pRow false): a one-cell corridor crossed by door after door, or
//   side by side (pRow true): a wall of doors, each opening into its own one-cell closet.
// Each door is lower than the last (sinking into the floor), smaller, slid further into the wall,
// or (mode 3) exactly the same.
const PB = 10, PROC_U = U(0.3);
let pSeed = -1, pBX = 1e9, pBZ = 1e9, pOn = false, pRow = false, pSalt = 0, pL0 = 0, pA0 = 0, pN = 0, pMode = 0;
function procAt(seed, bx, bz) {                 // one-entry cache: neighbouring edges share a block
  if (bx === pBX && bz === pBZ && seed === pSeed) return pOn;
  pSeed = seed; pBX = bx; pBZ = bz;
  pOn = hashU(seed, 600, bx, bz) < PROC_U;
  if (!pOn) return false;
  const hor = (hashU(seed, 601, bx, bz) & 1) === 1;
  pRow = (hashU(seed, 606, bx, bz) % 5) < 2;
  pN = 4 + hashU(seed, 602, bx, bz) % 4;
  pMode = hashU(seed, 603, bx, bz) % 4;
  // corridor: door lines pL0..pL0+pN-1, all at pA0. row: one door line pL0, doors at pA0..pA0+pN-1,
  // closets behind it (back wall on pL0+1, dividers on the cross lines pA0..pA0+pN).
  const a = 1 + hashU(seed, 604, bx, bz) % (pRow ? PB - 2 : PB - pN), b = 1 + hashU(seed, 605, bx, bz) % (pRow ? PB - pN - 1 : PB - 2);
  pSalt = hor ? SALT_H : SALT_V;
  pL0 = (hor ? bz : bx) * PB + a; pA0 = (hor ? bx : bz) * PB + b;
  return true;
}
// -1: not part of a procession, 1: forced wall, 100 + j: the j-th procession door
export function procEdge(seed, salt, line, along) {
  const x = salt === SALT_H ? along : line, z = salt === SALT_H ? line : along;
  if (!procAt(seed, Math.floor(x / PB), Math.floor(z / PB))) return -1;
  if (pRow) {
    if (salt === pSalt) {
      if (along < pA0 || along >= pA0 + pN) return -1;
      return line === pL0 ? 100 + along - pA0 : line === pL0 + 1 ? 1 : -1;
    }
    return line >= pA0 && line <= pA0 + pN && along === pL0 ? 1 : -1;
  }
  if (salt === pSalt) return along === pA0 && line >= pL0 && line < pL0 + pN ? 100 + line - pL0 : -1;
  return (line === pA0 || line === pA0 + 1) && along >= pL0 && along < pL0 + pN - 1 ? 1 : -1;
}

export function lineKind(seed, salt, line, along) {
  const re = roomEdge(seed, salt, line, along);
  if (re >= 0) return re;
  const pe = procEdge(seed, salt, line, along);
  if (pe >= 0) return pe >= 100 ? 2 : 1;
  const len = 2 + hashU(seed, salt, line, 1) % 5;
  const off = hashU(seed, salt, line, 2) % len;
  const run = Math.floor((along + off) / len);
  const f = salt === SALT_H ? mutF(seed, along, line) : mutF(seed, line, along);
  // further out: a little more wall, and more of it holed by windows
  if (hashU(seed, salt + 7, line, run) >= DENSITY_U + U(0.07 * f)) return 0;
  if (hashU(seed, salt + 13, line, along) < DOOR_U) return 2;
  return hashU(seed, salt + 14, line, along) < WINDOW_U + U(0.08 * f) ? 3 : 1;
}
export const kindH = (seed, x, z) => lineKind(seed, SALT_H, z, x);
export const kindV = (seed, x, z) => lineKind(seed, SALT_V, x, z);
export const wallH = (seed, x, z) => wallLike(kindH(seed, x, z));
export const wallV = (seed, x, z) => wallLike(kindV(seed, x, z));

// The opening in a doorway or window edge, written into out: [type, lo, hi, top, bottom/apex].
// lo..hi is the opening as a fraction of the edge, top the lintel (an arch's spring line).
//   type -1: plain full-height gap      type 0: full width under a dropped soffit
//   type 1: door (lintel at top)        type 2: arch, out[4] = crown height
//   type 3: window, out[4] = sill height
export function doorShape(seed, salt, line, along, out) {
  const pe = procEdge(seed, salt, line, along);
  if (pe >= 100) {
    const j = pe - 100;
    let w = 1.15, top = 2.15, c = 0.5;
    if (pMode === 0) top = Math.max(0.3, 2.15 - j * 0.32);                  // sinking
    else if (pMode === 1) { const k = 0.8 ** j; w *= k; top *= k; }         // shrinking
    else if (pMode === 2) c = 0.5 + j * 0.12;                               // sliding into the wall
    out[0] = 1; out[1] = c - w / 2 / CELL; out[2] = Math.min(c + w / 2 / CELL, 1 - THICK / CELL);
    if (out[2] - out[1] < 0.05) out[1] = out[2] - 0.05;
    out[3] = out[4] = top;
    return out;
  }
  const r = unit(hashU(seed, salt + 21, line, along)), u2 = unit(hashU(seed, salt + 22, line, along)), u3 = unit(hashU(seed, salt + 23, line, along));
  let w, top, apex;
  if (lineKind(seed, salt, line, along) === 3) { out[0] = 3; w = 0.6 + 1.0 * u2; apex = 0.85 + 0.25 * u3; top = Math.min(2.3, apex + 0.5 + 0.5 * unit(hashU(seed, salt + 25, line, along))); }
  else if (r < 0.40) { out[0] = -1; out[1] = 0; out[2] = 1; out[3] = out[4] = 99; return out; }
  else if (r < 0.58) { out[0] = 0; out[1] = 0; out[2] = 1; out[3] = out[4] = 1.95 + 0.5 * u2; return out; }
  else if (r < 0.76) { out[0] = 1; w = 0.8 + 0.7 * u2; top = apex = 1.95 + 0.35 * u3; }     // door
  else if (r < 0.84) { out[0] = 1; w = 1.8 + 0.7 * u2; top = apex = 2.0 + 0.4 * u3; }      // wide opening
  else if (r < 0.89) { out[0] = 1; w = 0.72 + 0.18 * u2; top = apex = 1.7 + 0.2 * u3; }    // small door
  else { out[0] = 2; w = 1.0 + 1.4 * u2; top = 1.6 + 0.4 * u3; apex = Math.min(HEIGHT - 0.12, top + w * (0.25 + 0.25 * unit(hashU(seed, salt + 25, line, along)))); }
  // further out some doors come out wrong: sunk low into the floor and squeezed narrow
  if (out[0] === 1 && unit(hashU(seed, salt + 26, line, along)) < 0.4 * (salt === SALT_H ? mutF(seed, along, line) : mutF(seed, line, along))) {
    const k = 0.4 + 0.45 * unit(hashU(seed, salt + 27, line, along));
    top = apex = top * k; w *= 0.55 + 0.45 * k;
  }
  const c = 0.5 * CELL + (unit(hashU(seed, salt + 24, line, along)) - 0.5) * (CELL - w - 0.6);
  out[1] = (c - w * 0.5) / CELL; out[2] = (c + w * 0.5) / CELL; out[3] = top; out[4] = apex;
  return out;
}
// What the shader needs to know about an edge, as 4 floats: (lo, hi, top, w). lo < 0: solid wall.
// w > top: arch crown; w < 0: window with its sill at -w; otherwise a flat lintel (99 = none).
const dsE = new Float64Array(5);
export function edgeSpan(seed, salt, line, along, out, o) {
  const k = lineKind(seed, salt, line, along);
  if (k === 1) { out[o] = -1; out[o + 1] = -1; out[o + 2] = 0; out[o + 3] = 0; return; }
  if (k === 0) { out[o] = 0; out[o + 1] = 1; out[o + 2] = 99; out[o + 3] = 99; return; }
  doorShape(seed, salt, line, along, dsE);
  out[o] = dsE[1]; out[o + 1] = dsE[2]; out[o + 2] = dsE[3]; out[o + 3] = dsE[0] === 3 ? -dsE[4] : dsE[4];
}

// Bent walls: some unbroken wall segments of up to BOW_MAX edges, whose inner grid points touch
// nothing else, either bulge sideways in a smooth curve (zero at both ends) or, when both ends are
// free too, lean over as a whole. bow() returns the bulge/lean in metres (0 = straight), sets
// bowLean, and bowS/bowE (the segment's first edge and one past its last).
const BOW_U = U(0.3), BOW_MAX = 6;
export let bowS = 0, bowE = 0, bowLean = false;
export function bow(seed, salt, line, along) {
  if (roomEdge(seed, salt, line, along) >= 0) return 0;     // room outlines stay straight
  let s = along, e = along + 1;
  while (s > along - BOW_MAX && lineKind(seed, salt, line, s - 1) === 1) s--;
  while (e < along + BOW_MAX && lineKind(seed, salt, line, e) === 1) e++;
  bowS = s; bowE = e; bowLean = false;
  const f = salt === SALT_H ? mutF(seed, s, line) : mutF(seed, line, s), big = 1 + 1.3 * f;
  if (e - s >= BOW_MAX || hashU(seed, salt + 31, line, s) >= BOW_U + U(0.4 * f)) return 0;
  const other = salt === SALT_H ? SALT_V : SALT_H;
  for (let v = s + 1; v < e; v++) if (lineKind(seed, other, v, line - 1) !== 0 || lineKind(seed, other, v, line) !== 0) return 0;
  const sign = (hashU(seed, salt + 33, line, s) & 1) ? 1 : -1;
  if ((hashU(seed, salt + 34, line, s) & 3) === 0 && lineKind(seed, salt, line, s - 1) === 0 && lineKind(seed, salt, line, e) === 0
      && lineKind(seed, other, s, line - 1) === 0 && lineKind(seed, other, s, line) === 0
      && lineKind(seed, other, e, line - 1) === 0 && lineKind(seed, other, e, line) === 0) {
    bowLean = true;
    return sign * Math.min(1.2, (0.5 + 0.5 * unit(hashU(seed, salt + 32, line, s))) * big);
  }
  return sign * Math.min(0.7, (0.25 + 0.35 * unit(hashU(seed, salt + 32, line, s))) * big);
}
// sideways offset of a bowed wall at position p metres along its line
const bowOff = (A, p) => A * Math.sin(Math.PI * (p - bowS * CELL) / ((bowE - bowS) * CELL));
const bowSlope = (A, p) => A * Math.PI / ((bowE - bowS) * CELL) * Math.cos(Math.PI * (p - bowS * CELL) / ((bowE - bowS) * CELL));

// Ceiling lights. Every cell has one 2x4 ft panel in the middle of its ceiling. Its state is a pure
// function of (seed, cell), with the exact same rules in the shader:
//   0 dead, 1 on, 2 flickering, 3 broken cover (bare tubes), 4 hanging (one end dropped out of the grid)
// Dark zones are ZONE x ZONE cell blocks where nearly every panel is dead. Odd states stay sparse.
export const ZONE = 5;
export const LIGHT_U = { darkZone: U(0.09), darkFlicker: U(0.07), dead: U(0.13), flicker: U(0.03), broken: U(0.06), hang: U(0.075) };
// Further out (mutation) more panels are dead, flickering, broken or hanging, and dark zones spread.
export function lightKind(seed, x, z) {
  const h = hashU(seed, 303, x, z), f = mutF(seed, x, z);
  if (hashU(seed, 500, Math.floor(x / ZONE), Math.floor(z / ZONE)) < LIGHT_U.darkZone + U(0.12 * f)) return h < LIGHT_U.darkFlicker + U(0.1 * f) ? 2 : 0;
  if (h < LIGHT_U.dead + U(0.17 * f)) return 0;
  const k = hashU(seed, 304, x, z), fl = LIGHT_U.flicker + U(0.1 * f), br = fl + LIGHT_U.broken - LIGHT_U.flicker + U(0.04 * f);
  return k < fl ? 2 : k < br ? 3 : k < br + LIGHT_U.hang - LIGHT_U.broken + U(0.04 * f) ? 4 : 1;
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
export const MAX_VERTS = 30000;   // walls ~5000 at worst, plus props and furnished rooms; writers stop at the limit
const FLOATS = 7;                                       // [px, py, pz, nx, ny, nz, material]

// Writes the chunk's triangles into out (a Float32Array of at least MAX_VERTS * 7) and returns the
// vertex count. Materials: 0 carpet, 1 ceiling, 2 wallpaper, 3 light housing, 4 light diffuser, 5 cable.
// opt (all optional): y0 = height of this floor; floorHole / ceilHole(x, z, rect) -> true and rect =
// [x0, z0, x1, z1] in metres when the cell's floor / ceiling has an opening; light(x, z) -> light kind.
const rectH = new Float64Array(4);
export function buildChunk(seed, cx, cz, out, opt = {}) {
  const y0 = opt.y0 || 0;
  let n = 0;
  const vert = (x, y, z, nx, ny, nz, m) => { if (n + FLOATS > out.length) return; out[n] = x; out[n + 1] = y + y0; out[n + 2] = z; out[n + 3] = nx; out[n + 4] = ny; out[n + 5] = nz; out[n + 6] = m; n += FLOATS; };
  const quad = (ax, ay, az, bx, by, bz, cx_, cy, cz_, dx, dy, dz, nx, ny, nz, m) => {
    vert(ax, ay, az, nx, ny, nz, m); vert(bx, by, bz, nx, ny, nz, m); vert(cx_, cy, cz_, nx, ny, nz, m);
    vert(ax, ay, az, nx, ny, nz, m); vert(cx_, cy, cz_, nx, ny, nz, m); vert(dx, dy, dz, nx, ny, nz, m);
  };
  const H = HEIGHT;
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const X0 = x0 * CELL, X1 = x1 * CELL, Z0 = z0 * CELL, Z1 = z1 * CELL;
  // floor and ceiling, one quad per cell, or a frame of four around an opening
  const slabAt = (y, ny, m, hole) => {
    const rect = (ax, az, bx, bz) => { if (bx - ax > 1e-4 && bz - az > 1e-4) quad(ax, y, az, ax, y, bz, bx, y, bz, bx, y, az, 0, ny, 0, m); };
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const ax = x * CELL, az = z * CELL, bx = ax + CELL, bz = az + CELL;
      if (!hole || !hole(x, z, rectH)) { rect(ax, az, bx, bz); continue; }
      const [hx0, hz0, hx1, hz1] = rectH;
      rect(ax, az, bx, hz0); rect(ax, hz1, bx, bz); rect(ax, hz0, hx0, hz1); rect(hx1, hz0, bx, hz1);
    }
  };
  if (!opt.floorHole && !opt.ceilHole) {
    quad(X0, 0, Z0, X0, 0, Z1, X1, 0, Z1, X1, 0, Z0, 0, 1, 0, 0);
    quad(X0, H, Z0, X1, H, Z0, X1, H, Z1, X0, H, Z1, 0, -1, 0, 1);
  } else { slabAt(0, 1, 0, opt.floorHole); slabAt(H, -1, 1, opt.ceilHole); }
  // Everything on a grid line is built in line-local coordinates: a = metres along the line, o = sideways
  // offset from it, y = height. P maps them to world space for a horizontal (hor) or vertical line.
  let hor = true, LW = 0;
  const P = (a, o, y, na, no, ny, m) => hor ? vert(a, y, LW + o, na, ny, no, m) : vert(LW + o, y, a, no, ny, na, m);
  const Q = (a0, o0, y0, a1, o1, y1, a2, o2, y2, a3, o3, y3, na, no, ny, m) => {
    P(a0, o0, y0, na, no, ny, m); P(a1, o1, y1, na, no, ny, m); P(a2, o2, y2, na, no, ny, m);
    P(a0, o0, y0, na, no, ny, m); P(a2, o2, y2, na, no, ny, m); P(a3, o3, y3, na, no, ny, m);
  };
  // axis-aligned box on the line: two long sides, end caps, and bottom/top faces when it doesn't
  // reach the floor/ceiling. lean tilts it: the top is shifted sideways by lean metres.
  const B = (a0, a1, y0, y1, lean = 0) => {
    if (a1 - a0 < 1e-3) return;
    const T = THICK, l0 = lean * y0 / H, l1 = lean * y1 / H, k = 1 / Math.hypot(1, lean / H), ny = lean / H * k;
    Q(a0, l0 - T, y0, a1, l0 - T, y0, a1, l1 - T, y1, a0, l1 - T, y1, 0, -k, ny, 2);
    Q(a0, l0 + T, y0, a1, l0 + T, y0, a1, l1 + T, y1, a0, l1 + T, y1, 0, k, -ny, 2);
    Q(a0, l0 - T, y0, a0, l0 + T, y0, a0, l1 + T, y1, a0, l1 - T, y1, -1, 0, 0, 2);
    Q(a1, l0 - T, y0, a1, l0 + T, y0, a1, l1 + T, y1, a1, l1 - T, y1, 1, 0, 0, 2);
    if (y0 > 0) Q(a0, -T, y0, a1, -T, y0, a1, T, y0, a0, T, y0, 0, 0, -1, 2);
    if (y1 < H - 1e-3) Q(a0, -T, y1, a1, -T, y1, a1, T, y1, a0, T, y1, 0, 0, 1, 2);
  };
  const SUB = 6, ds = new Float64Array(5);
  for (const [salt, ext] of [[SALT_H, x0], [SALT_V, z0]]) {
    hor = salt === SALT_H;
    const l0 = hor ? z0 : x0, a0 = ext, a1 = ext + CHUNK;
    for (let line = l0; line < l0 + CHUNK; line++) {
      LW = line * CELL;
      for (let i = a0; i < a1;) {
        const k = lineKind(seed, salt, line, i);
        if (k === 2 || k === 3) {            // doorway or window frame
          doorShape(seed, salt, line, i, ds);
          const pk = lineKind(seed, salt, line, i - 1), nk = lineKind(seed, salt, line, i + 1);
          // walls stop THICK short of / run THICK past a frame edge so pieces meet without overlap
          const u0 = i * CELL + (k === 2 ? (wallLike(pk) ? THICK : 0) : (wallLike(pk) ? 0 : -THICK));
          const u1 = (i + 1) * CELL - (k === 2 ? (wallLike(nk) ? THICK : 0) : (wallLike(nk) ? 0 : -THICK));
          const o0 = Math.max(u0, (i + ds[1]) * CELL), o1 = Math.min(u1, (i + ds[2]) * CELL);
          if (ds[0] === 0) B(u0, u1, ds[3], H);
          else if (ds[0] === 3) { B(u0, o0, 0, H); B(o1, u1, 0, H); B(o0, o1, 0, ds[4]); B(o0, o1, ds[3], H); }
          else if (ds[0] >= 1) {
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
        const ea = wallLike(lineKind(seed, salt, line, i - 1)) ? 0 : THICK, eb = wallLike(lineKind(seed, salt, line, e)) ? 0 : THICK;
        if (A === 0) B(i * CELL - ea, e * CELL + eb, 0, H);
        else if (bowLean) B(i * CELL - ea, e * CELL + eb, 0, H, A);
        else {                               // bowed: SUB slices per edge, smooth normals
          const T = THICK;
          for (let j = i; j < e; j++) for (let q = 0; q < SUB; q++) {
            let p0 = (j + q / SUB) * CELL, p1 = (j + (q + 1) / SUB) * CELL;
            const first = j === bowS && q === 0, last = j === bowE - 1 && q === SUB - 1;
            if (first) p0 -= ea;
            if (last) p1 += eb;
            const c0 = Math.min(Math.max(p0, bowS * CELL), bowE * CELL), c1 = Math.min(Math.max(p1, bowS * CELL), bowE * CELL);
            const f0 = bowOff(A, c0), f1 = bowOff(A, c1), s0 = bowSlope(A, c0), s1 = bowSlope(A, c1);
            const n0 = 1 / Math.hypot(1, s0), n1 = 1 / Math.hypot(1, s1);
            for (const sd of [-1, 1]) {
              P(p0, f0 + sd * T, 0, -sd * s0 * n0, sd * n0, 0, 2); P(p1, f1 + sd * T, 0, -sd * s1 * n1, sd * n1, 0, 2); P(p1, f1 + sd * T, H, -sd * s1 * n1, sd * n1, 0, 2);
              P(p0, f0 + sd * T, 0, -sd * s0 * n0, sd * n0, 0, 2); P(p1, f1 + sd * T, H, -sd * s1 * n1, sd * n1, 0, 2); P(p0, f0 + sd * T, H, -sd * s0 * n0, sd * n0, 0, 2);
            }
            if (first) Q(p0, -T, 0, p0, T, 0, p0, T, H, p0, -T, H, -1, 0, 0, 2);
            if (last) Q(p1, -T, 0, p1, T, 0, p1, T, H, p1, -T, H, 1, 0, 0, 2);
          }
        }
        i = e;
      }
    }
  }
  // hanging panels: a 0.6 x 1.2 m box hinged at one short end, the other end swung down, plus a cable
  let hung = 0;
  for (let z = z0; z < z1 && hung < MAX_HANG; z++) for (let x = x0; x < x1 && hung < MAX_HANG; x++) {
    if ((opt.light ? opt.light(x, z) : lightKind(seed, x, z)) !== 4) continue;
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
// frames and bent walls, for a player h metres tall: a doorway lower than that is a wall (crouch to
// get through). Returns how far it moved pos. Allocates nothing (it runs every frame).
const dsC = new Float64Array(5);
// h: top of the body above the floor, lo: its bottom (0 walking; a flying drone can pass windows)
export function collide(seed, pos, r, h = 1.75, lo = 0) {
  const ox = pos[0], oz = pos[1];
  for (let pass = 0; pass < 2; pass++) {
    const cx = Math.floor(pos[0] / CELL), cz = Math.floor(pos[1] / CELL);
    for (let line = cz - 1; line <= cz + 2; line++) for (let i = cx - 1; i <= cx + 1; i++) edge(seed, SALT_H, line, i, pos, r, h, lo);
    for (let line = cx - 1; line <= cx + 2; line++) for (let i = cz - 1; i <= cz + 1; i++) edge(seed, SALT_V, line, i, pos, r, h, lo);
  }
  return Math.hypot(pos[0] - ox, pos[1] - oz);
}
// would a player h tall at pos be pushed (used to stop you standing up under a low lintel)
const probe = new Float64Array(2);
export function cramped(seed, pos, r, h, lo = 0) { probe[0] = pos[0]; probe[1] = pos[1]; return collide(seed, probe, r, h, lo) > 1e-4; }
function edge(seed, salt, line, i, pos, r, h, lo) {
  const k = lineKind(seed, salt, line, i);
  if (k === 0) return;
  const hor = salt === SALT_H, L = line * CELL, T = THICK;
  if (k === 3) {                     // window: solid unless the body fits between sill and top
    doorShape(seed, salt, line, i, dsC);
    if (lo > dsC[4] + 0.03 && h < dsC[3] - 0.03) { slab(hor, pos, r, L, i * CELL - T, (i + dsC[1]) * CELL); slab(hor, pos, r, L, (i + dsC[2]) * CELL, (i + 1) * CELL + T); }
    else slab(hor, pos, r, L, i * CELL - T, (i + 1) * CELL + T);
    return;
  }
  if (k === 2) {
    doorShape(seed, salt, line, i, dsC);
    if (dsC[0] >= 0 && Math.max(dsC[3], dsC[0] === 2 ? dsC[4] : 0) < h) { slab(hor, pos, r, L, i * CELL - T, (i + 1) * CELL + T); return; }
    if (dsC[0] >= 1) { slab(hor, pos, r, L, i * CELL - T, (i + dsC[1]) * CELL); slab(hor, pos, r, L, (i + dsC[2]) * CELL, (i + 1) * CELL + T); }
    return;
  }
  const A = k === 1 ? bow(seed, salt, line, i) : 0;
  if (A === 0) { slab(hor, pos, r, L, i * CELL - T, (i + 1) * CELL + T); return; }
  if (bowLean) {                     // the wall at foot level and at head height
    slab(hor, pos, r, L, i * CELL - T, (i + 1) * CELL + T);
    slab(hor, pos, r, L + A * Math.min(h, 1.75) / HEIGHT, i * CELL - T, (i + 1) * CELL + T);
    return;
  }
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

// Can you walk from cell (x, z) to at least `need` cells? Used so holes and stairs never drop you
// into a sealed pocket. Allocates; callers cache the answer.
export function reaches(seed, x0, z0, need) {
  const K = (x, z) => (x + 1048576) * 2097152 + (z + 1048576);
  const seen = new Set([K(x0, z0)]), stack = [x0, z0];
  while (stack.length && seen.size < need) {
    const z = stack.pop(), x = stack.pop();
    const step = (nx, nz, open) => { const k = K(nx, nz); if (open && !seen.has(k)) { seen.add(k); stack.push(nx, nz); } };
    step(x + 1, z, !wallV(seed, x + 1, z)); step(x - 1, z, !wallV(seed, x, z));
    step(x, z + 1, !wallH(seed, x, z + 1)); step(x, z - 1, !wallH(seed, x, z));
  }
  return seen.size >= need;
}

// A spawn cell that is part of the big connected maze, not one of the sealed-off pockets: flood-fill
// from candidate cells (spiralling out from the origin) until one reaches `need` cells.
export function findSpawn(seed, need = 600) {
  for (let r = 0; r < 50; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r || roomCell(seed, dx, dz) >= 0) continue;
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
