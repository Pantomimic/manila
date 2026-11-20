// The look: wallpaper, carpet, drop ceiling and fluorescent panels, all generated in the shader from
// world position. Output is linear HDR; post.js adds bloom, tone mapping, vignette and grain.
import { CELL, HEIGHT } from './gen.js';
import { FH, MISS_U, MUT_STEP, MUT_LEVEL } from './levels.js';

export const SCENE = /* wgsl */ `
struct U { vp: mat4x4f, cam: vec4f, misc: vec4f, lv: vec4f };  // cam.xyz eye, cam.w time; misc.x seed; lv.x camera level, yzw level seeds below/at/above
@group(0) @binding(0) var<uniform> u: U;
// world data around the camera, written by render.js (fillData): edges and light kinds per cell mod 64,
// one band of rows per level (below, at, above the camera's)
@group(0) @binding(1) var world: texture_2d<f32>;

// true in the second scene pipeline, which draws only glossy materials and adds highlights
override SHINY: bool = false;
const CELL = ${CELL.toFixed(1)};
const HEIGHT = ${HEIGHT.toFixed(2)};
const FH = ${FH.toFixed(2)};
// per fragment: its level's seed and texture band, and whether that level's data is loaded at all
var<private> gSeed: u32;
var<private> gRow: i32;
var<private> gOk: bool;

struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) @interpolate(flat) m: f32 };

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: f32) -> VO {
  var o: VO;
  o.pos = u.vp * vec4f(p, 1.0);
  o.wp = p; o.n = n; o.m = m;
  // the figure (material 20) carries its feet position in place of a normal: within 14 m of the
  // camera every one of its vertices goes off screen, so it is simply not there
  if (m > 19.5 && m < 20.5) {
    o.n = vec3f(0.0, 1.0, 0.0);
    if (distance(n.xz, u.cam.xz) < 14.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); }
  }
  return o;
}

// ---- exact copy of gen.js: hashU, wall rules, light rules ----
fn hashU(a: u32, b: u32, c: u32, d: u32) -> u32 {
  var h = (a ^ 0x9e3779b9u) * 0x85ebca6bu;
  h = (h ^ (h >> 13u) ^ b) * 0xc2b2ae35u;
  h = (h ^ (h >> 16u) ^ c) * 0x27d4eb2fu;
  h = (h ^ (h >> 15u) ^ d) * 0x165667b1u;
  return h ^ (h >> 16u);
}
fn seed() -> u32 { return gSeed; }
fn floorDiv(a: i32, b: i32) -> i32 { if (a >= 0) { return a / b; } return -((-a + b - 1) / b); }
fn cellTexel(x: i32, z: i32) -> vec2i { return vec2i(x & 63, (z & 63) + gRow * 64); }
// an edge's opening (lo, hi) along it as 0..1, then lintel height and crown (w > z) or -sill (w < 0).
// lo < 0: solid wall. salt 101 = horizontal line (line = z, along = x), 202 = vertical line.
fn edgeSpan(salt: u32, line: i32, along: i32) -> vec4f {
  if (!gOk) { return vec4f(0.0, 1.0, 99.0, 99.0); }
  if (salt == 101u) { return textureLoad(world, cellTexel(along, line), 0); }
  return textureLoad(world, cellTexel(line, along) + vec2i(64, 0), 0);
}

fn hc(salt: u32, c: vec2i) -> u32 { return hashU(seed(), salt, bitcast<u32>(c.x), bitcast<u32>(c.y)); }
fn unit(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }
// 0 dead, 1 on, 2 flickering, 3 broken cover, 4 hanging (gen.js lightKind, via the world texture)
fn lightKind(c: vec2i) -> i32 { if (!gOk) { return 0; } return i32(textureLoad(world, cellTexel(c.x, c.y) + vec2i(128, 0), 0).x + 0.5); }
// light kind (x) and room theme + 1 (y) in one read
fn cellData(c: vec2i) -> vec2i { if (!gOk) { return vec2i(0); } let t = textureLoad(world, cellTexel(c.x, c.y) + vec2i(128, 0), 0); return vec2i(i32(t.x + 0.5), i32(t.y + 0.5) - 1); }
// special room theme of a cell (gen.js roomCell), -1 for none
fn cellRoom(c: vec2i) -> i32 { if (!gOk) { return -1; } return i32(textureLoad(world, cellTexel(c.x, c.y) + vec2i(128, 0), 0).y + 0.5) - 1; }
// light kind, room theme + 1, steady brightness, flags (render.js fillData)
fn cellTex(c: vec2i) -> vec4f { if (!gOk) { return vec4f(0.0); } return textureLoad(world, cellTexel(c.x, c.y) + vec2i(128, 0), 0); }
fn lightLevel(c: vec2i, kind: i32) -> f32 { let t = cellTex(c); return lightLevelT(c, kind, t.z, t.w); }
fn lightLevelT(c: vec2i, kind: i32, base: f32, flags: f32) -> f32 {
  if (kind == 0) { return 0.0; }
  if (kind != 2 && !(kind == 4 && flags >= 1.5)) { return base; }
  let t = u.cam.w;
  let ph = unit(hc(307u, c)) * 64.0;
  let C = vec2u(bitcast<u32>(c.x), bitcast<u32>(c.y));
  let r = unit(hashU(seed() + 7919u, C.x, C.y, u32(i32(floor(t * 2.0 + ph)))));
  if (r < 0.2) { return select(0.03, base, unit(hashU(seed() + 7927u, C.x, C.y, u32(i32(floor(t * 23.0 + ph * 5.0))))) < 0.55); }
  return select(base, 0.02, r < 0.27);
}
// where a cell's light comes from: the ceiling panel, or the middle of a hanging one
fn lightPos(c: vec2i, kind: i32) -> vec3f {
  let m = vec3f((f32(c.x) + 0.5) * CELL, HEIGHT - 0.05, (f32(c.y) + 0.5) * CELL);
  if (kind != 4) { return m; }
  let a = 0.65 + 0.5 * unit(hc(310u, c));
  let s = select(-1.0, 1.0, (hc(311u, c) & 1u) == 1u);
  return vec3f(m.x, HEIGHT - 0.1 - 0.6 * sin(a) - 0.1, m.z - s * 0.6 + s * 0.6 * cos(a));
}

// ---- light visibility. The line from a surface point to a light in a neighbouring cell crosses at
// most one vertical and one horizontal grid line. Light gets through where that crossing falls inside
// the edge's opening (all of an open edge, the door or arch of a doorway, none of a wall) and below its
// lintel. Openings fade over PEN metres, soft shadow edges instead of hard ones; the crossing's own edge
// plus the nearer neighbour edge add up to exactly 1 across an open boundary.
const PEN = 0.35;
fn through(s: vec4f, t: f32, y: f32) -> f32 {
  if (s.x < 0.0) { return 0.0; }
  let p = PEN / CELL;
  let across = smoothstep(s.x - p, s.x + p, t) * (1.0 - smoothstep(s.y - p, s.y + p, t));
  if (s.w < 0.0) { return across * smoothstep(-s.w - 0.12, -s.w + 0.12, y) * (1.0 - smoothstep(s.z - 0.12, s.z + 0.12, y)); }  // window
  var top = s.z;
  if (s.w > s.z + 0.01) { let q = (t - (s.x + s.y) * 0.5) / ((s.y - s.x) * 0.5); top = s.z + (s.w - s.z) * sqrt(max(0.0, 1.0 - q * q)); }
  return across * (1.0 - smoothstep(top - 0.12, top + 0.12, y));
}
fn crossVis(salt: u32, line: i32, a: f32, y: f32) -> f32 {
  let r = a / CELL; let i = i32(floor(r)); let t = fract(r);
  let nb = select(1, -1, t < 0.5);
  return min(1.0, through(edgeSpan(salt, line, i), t, y) + through(edgeSpan(salt, line, i + nb), t - f32(nb), y));
}

// ---- mutation and missing ceiling tiles: exact copy of levels.js ----
fn mutation(lv: i32, x: i32, z: i32) -> u32 {
  if (abs(x) > 2000 || abs(z) > 2000 || abs(lv) > 60) { return 8u; }
  let d2 = x * x + z * z + lv * ${MUT_LEVEL} * lv * ${MUT_LEVEL};
  var k = 0u;
  loop { if (k >= 8u) { break; } let r = i32(k + 1u) * ${MUT_STEP}; if (d2 < r * r) { break; } k++; }
  return k;
}
fn md5(a: i32) -> i32 { return ((a % 5) + 5) % 5; }
fn tileMissing(lv: i32, t: vec2i) -> bool {
  if (md5(t.x) == 2 && (md5(t.y) == 1 || md5(t.y) == 2)) { return false; }
  if (cellRoom(vec2i(floor((vec2f(t) + 0.5) * 0.6 / CELL + vec2f(0.0, 0.3 / CELL)))) == 10) { return false; }   // the hallway repeats exactly
  var tbl = array<u32, 9>(${MISS_U.map((v) => v + 'u').join(', ')});
  return hashU(gSeed, 700u, bitcast<u32>(t.x), bitcast<u32>(t.y)) < tbl[mutation(lv, floorDiv(t.x, 5), floorDiv(t.y + 1, 5))];
}

// ---- noise ----
fn h2(p: vec2i) -> f32 { return f32(hashU(bitcast<u32>(p.x), bitcast<u32>(p.y), 77u, 5u) >> 8u) / 16777216.0; }
fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2i(1, 0)), w.x), mix(h2(i + vec2i(0, 1)), h2(i + vec2i(1, 1)), w.x), w.y);
}
fn fbm(p: vec2f) -> f32 { return vnoise(p) * 0.5 + vnoise(p * 2.03 + 17.0) * 0.3 + vnoise(p * 4.07 + 41.0) * 0.2; }

// ---- surfaces. d = screen-space footprint in metres, used to fade patterns that would shimmer ----
// g = grime 0..1: some stretches of wall are nearly clean, others badly water damaged
fn wallpaper(along: f32, y: f32, side: f32, d: f32, g: f32) -> vec3f {
  var c = vec3f(0.74, 0.64, 0.33) * (1.04 - 0.08 * g);
  // hung in 53 cm rolls: each roll a shade off the next, the pattern not quite matched at the seam
  let roll = floor(along / 0.53 + side * 0.37);
  let rh = h2(vec2i(i32(roll), i32(side * 7.0) + 40));
  c *= 0.975 + 0.05 * rh;
  let s = along / 0.16;
  let yv = y + (rh - 0.5) * 0.03;
  let aa = clamp(1.0 - d * 12.0, 0.0, 1.0);
  let line = 1.0 - smoothstep(0.015, 0.04, abs(fract(s) - 0.5));        // thin vertical pinstripe
  c *= 1.0 - line * 0.09 * aa;
  let du = abs(fract(s) - 0.5) * 0.16;                                    // small diamonds between stripes
  let dv = abs(fract(yv / 0.32 + 0.5 * floor(s)) - 0.5) * 0.32;
  let dia = 1.0 - smoothstep(0.022, 0.03, (0.08 - du) * 1.2 + dv * 0.5);
  // the print is embossed: lit from above, the top edge of each diamond catches light, the bottom is shaded
  let dvU = abs(fract((yv + 0.006) / 0.32 + 0.5 * floor(s)) - 0.5) * 0.32;
  let diaU = 1.0 - smoothstep(0.022, 0.03, (0.08 - du) * 1.2 + dvU * 0.5);
  c *= 1.0 - dia * 0.06 * aa + (dia - diaU) * 0.08 * clamp(1.0 - d * 60.0, 0.0, 1.0);
  c *= 1.0 + (vnoise(vec2f(along * 3.0, yv * 3.0) + side * 9.0) - 0.5) * 0.05;   // uneven print
  let n = fbm(vec2f(along * 0.9 + side * 31.0, y * 0.9));
  let sv = n * 0.85 + (y - HEIGHT + 0.8) * 0.45 + (g - 0.5) * 0.45;       // water damage from the ceiling
  let stain = smoothstep(0.5, 0.78, sv) * smoothstep(0.08, 0.4, g);
  let tn = vnoise(vec2f(along * 0.22 + side * 13.0, 3.7));               // stain colour drifts along the wall:
  var tint = mix(vec3f(0.72, 0.60, 0.40), vec3f(0.60, 0.62, 0.38), smoothstep(0.35, 0.7, tn));   // brown -> sickly green
  tint = mix(tint, vec3f(0.66, 0.44, 0.30), smoothstep(0.62, 0.85, vnoise(vec2f(along * 0.31 - side * 5.0, 8.1))));  // rust
  tint = mix(tint, vec3f(0.48, 0.44, 0.36), smoothstep(0.7, 0.9, vnoise(vec2f(along * 0.17 + 40.0, side))));  // grey mildew
  c = mix(c, c * tint, stain);
  let rim = (smoothstep(0.47, 0.5, sv) * (1.0 - smoothstep(0.5, 0.56, sv))) * smoothstep(0.08, 0.4, g); // darker tide line at the edge
  c *= 1.0 - rim * 0.14 * clamp(1.0 - d * 20.0, 0.0, 1.0);
  let streak = smoothstep(0.72, 0.9, vnoise(vec2f(along * 5.0 + side * 7.0, y * 0.35))) * smoothstep(0.6, 2.2, y);
  c = mix(c, c * vec3f(0.80, 0.72, 0.55), streak * 0.6 * g);
  c *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.6, y)) * n * (0.3 + 0.7 * g);                  // scuffs low on the wall
  let sx = abs(fract(along / 0.53 + side * 0.37 + 0.5) - 0.5) * 0.53;      // distance to the nearest seam
  let sf = clamp(1.0 - d * 150.0, 0.0, 1.0);
  c *= 1.0 - 0.12 * (1.0 - smoothstep(0.0008, 0.0026, sx)) * sf;            // the seam line
  c *= 1.0 + 0.06 * smoothstep(0.6, 0.9, g) * (1.0 - smoothstep(0.001, 0.004, sx)) * smoothstep(1.6, 2.6, y) * sf;   // lifting where it's damp
  c *= 1.0 + (vnoise(vec2f(along, y) * 260.0) - 0.5) * 0.06 * clamp(1.0 - d * 260.0, 0.0, 1.0);   // paper grain
  if (y < 0.09) { c = vec3f(0.30, 0.23, 0.14) * (0.85 + 0.3 * smoothstep(0.07, 0.09, y)); }   // baseboard
  return c;
}

// commercial loop-pile carpet: every tuft (4 mm) its own shade with the odd dark or pale fibre, faint
// tufting rows, patches where the pile lies differently, damp patches, and old stains with darker rims
fn carpet(p: vec2f, d: f32, g: f32) -> vec3f {
  var c = vec3f(0.52, 0.42, 0.21);
  let near = clamp(1.6 - d * 400.0, 0.0, 1.0);                           // tufts fade before they'd shimmer
  if (near > 0.0) {
    let t = vec2i(floor(p * 250.0));
    let a = h2(t); let b = h2(t + vec2i(7919, 104729));
    var k = 1.0 + (a - 0.5) * 0.42;
    if (b < 0.06) { k *= 0.62; } else if (b > 0.97) { k *= 1.25; }
    c *= mix(1.0, k * (0.97 + 0.06 * step(0.5, fract(p.x * 125.0))), near);   // (rows: every other tuft line)
  }
  let mid = clamp(1.0 - d * 40.0, 0.0, 1.0);
  c *= 1.0 + (vnoise(p * 45.0) - 0.5) * 0.18 * mid;
  c *= 0.86 + fbm(p * 0.7) * 0.26;
  c *= 0.95 + 0.1 * smoothstep(0.3, 0.7, vnoise(p * 2.3 + 31.0));          // pile brushed one way or the other
  let damp = smoothstep(0.6, 0.7, fbm(p * 0.12 + 5.0) + (g - 0.5) * 0.25);  // damp patches
  c = mix(c, c * vec3f(0.62, 0.64, 0.46), damp * 0.85);
  let sv = fbm(p * 1.7 + 77.0) + g * 0.1;                                    // spilled-on stains, here and there
  let st = smoothstep(0.76, 0.785, sv) * smoothstep(0.6, 0.75, vnoise(p * 0.13 + 9.0));
  let rim = st * (1.0 - smoothstep(0.785, 0.82, sv));
  return c * (1.0 - 0.16 * st - 0.14 * rim);
}

// small square tiles (15 cm), pale aqua-white, grout lines, grime in the joints
fn poolTile(p: vec2f, g: f32, d: f32) -> vec3f {
  let t = fract(p / 0.15);
  let id = vec2i(floor(p / 0.15));
  var c = vec3f(0.74, 0.84, 0.84) * (0.94 + 0.08 * h2(id));
  c = mix(c, vec3f(0.62, 0.60, 0.48), smoothstep(0.55, 0.8, vnoise(p * 1.3) + g * 0.3) * 0.5);
  let gr = min(min(t.x, 1.0 - t.x), min(t.y, 1.0 - t.y));
  let line = (1.0 - smoothstep(0.03, 0.06, gr)) * clamp(1.0 - (d - 0.006) * 45.0, 0.0, 1.0);   // grout fades out where it would shimmer
  return mix(c * 0.93, vec3f(0.36, 0.36, 0.32), line);
}
// ceiling tile colour; panel emission handled separately
fn ceiling(pw: vec2f, d: f32, g: f32, lv: i32, hall: bool) -> vec3f {
  let p = pw - vec2f(0.0, 0.3);              // tile grid offset so each panel fills exactly 1 x 2 tiles
  let tile = vec2i(floor(p / 0.6));
  var c = vec3f(0.70, 0.66, 0.52) * (0.92 + h2(tile) * 0.1);
  let missing = !hall && tileMissing(lv, tile);   // (pw is folded in the hallway: no tile is missing there anyway)
  c *= 0.95 + vnoise(p * 30.0) * 0.1 * clamp(1.0 - d * 30.0, 0.0, 1.0);   // pitted acoustic tile
  // fissured mineral fibre: short wormy grooves and pinholes, different on every tile
  let fd = clamp(1.4 - d * 90.0, 0.0, 1.0);
  if (fd > 0.0) {
    let o = vec2f(h2(tile + vec2i(3, 9)), h2(tile + vec2i(11, 5))) * 50.0;
    let w = vnoise(p * 24.0 + o);
    let fis = (1.0 - smoothstep(0.015, 0.075, abs(w - 0.5))) * smoothstep(0.58, 0.72, vnoise(p * 13.0 - o));
    let q = p * 70.0; let pc = vec2i(floor(q));
    let jit = vec2f(h2(pc), h2(pc + vec2i(5, 3))) - 0.5;
    let pin = (1.0 - smoothstep(0.1, 0.2, length(fract(q) - 0.5 - jit * 0.5))) * step(h2(pc + vec2i(9, 1)), 0.4);
    c *= 1.0 - (0.16 * fis + 0.22 * pin) * fd;
  }
  if (h2(tile + vec2i(913, 71)) < 0.005 + 0.07 * g) {                                  // the odd stained tile
    let q = fract(p / 0.6) - 0.5 + (vec2f(vnoise(p * 6.0), vnoise(p * 6.0 + 9.0)) - 0.5) * 0.35;
    c = mix(c, c * vec3f(0.80, 0.70, 0.52), smoothstep(0.40, 0.12, length(q)));
  }
  if (missing) { c = vec3f(0.012, 0.011, 0.01) * (0.6 + vnoise(p * 3.0)); }   // tile gone: the dark void above
  let t = fract(p / 0.6);
  let panelTile = md5(tile.x) == 2 && (md5(tile.y) == 1 || md5(tile.y) == 2);
  if (!missing && !panelTile && h2(tile + vec2i(57, 11)) < 0.012) {                   // air vent: slats in a frame
    let inner = all(abs(t - 0.5) < vec2f(0.4));
    c = select(vec3f(0.5, 0.5, 0.47), mix(vec3f(0.04), vec3f(0.46, 0.46, 0.43), step(0.5, fract(t.y * 9.0))), inner);
  }
  let gr = min(min(t.x, 1.0 - t.x), min(t.y, 1.0 - t.y)) * 0.6;           // metal grid between tiles
  c *= 0.84 + 0.16 * smoothstep(0.012, 0.05, gr);                           // tile edge sits back in shadow
  return mix(vec3f(0.55, 0.54, 0.50), c, smoothstep(0.008, 0.012 + d, gr));
}

@fragment fn fs(vin: VO) -> @location(0) vec4f {
  let fw = fwidth(vin.wp);                   // derivatives must be taken before any branching
  // which level this fragment belongs to; from here on i.wp is relative to that level's floor
  let L = i32(floor((vin.wp.y + select(0.05, 0.6, vin.m > 18.5 && vin.m < 19.5)) / FH));   // (the pool basin dips below the floor)
  let li = L - i32(u.lv.x) + 1;
  gOk = li >= 0 && li <= 2;
  gRow = clamp(li, 0, 2);
  gSeed = u32(select(select(u.lv.w, u.lv.z, li == 1), u.lv.y, li == 0));
  var i = vin;
  i.wp.y -= f32(L) * FH;
  let n = normalize(i.n);
  let wall = abs(n.y) < 0.5;
  let alongX = abs(n.z) > 0.5;               // wall facing +-z runs along x
  let along = select(i.wp.z, i.wp.x, alongX);
  let dAlong = select(fw.z, fw.x, alongX);
  let dFloor = max(fw.x, fw.z);

  // In the hallway room every surface pattern repeats every 9 m (folded, so it stays continuous):
  // main.js moves you back 3 cells now and then and nothing may change. tp: where patterns are read.
  let hall = cellRoom(vec2i(floor(i.wp.xz / CELL))) == 10;
  var tp = i.wp;
  if (hall) { tp = vec3f(4.5 - abs(i.wp.x - 9.0 * floor(i.wp.x / 9.0) - 4.5), i.wp.y, 4.5 - abs(i.wp.z - 9.0 * floor(i.wp.z / 9.0) - 4.5)); }
  // further out (mutation 0..8) everything is dirtier, and the colours drift sickly in patches
  let mu = f32(mutation(L, i32(floor(i.wp.x / CELL)), i32(floor(i.wp.z / CELL)))) / 8.0;
  let g = mix(smoothstep(0.3, 0.7, vnoise(tp.xz * 0.028 + 11.0 + f32(L) * 37.0)), 1.0, 0.5 * mu);   // grime, in patches tens of metres wide
  var albedo: vec3f;
  if (i.m < 0.5) { albedo = carpet(tp.xz, dFloor, g); }
  else if (i.m < 1.5) { albedo = ceiling(tp.xz, dFloor, g, L, hall); }
  else if (i.m < 2.5) { albedo = wallpaper(select(tp.z, tp.x, alongX), i.wp.y, select(2.0 * sign(n.x), sign(n.z), alongX), dAlong, g); }
  else if (i.m < 4.5) { albedo = vec3f(0.55, 0.55, 0.52); }   // light housing
  else if (i.m < 5.5) { albedo = vec3f(0.018, 0.018, 0.02); }  // cable
  else if (i.m < 6.5) { albedo = vec3f(0.42, 0.42, 0.40); }   // painted metal
  else if (i.m < 7.5) { albedo = vec3f(0.55, 0.04, 0.03); }   // stop-sign red
  else if (i.m < 8.5) { albedo = vec3f(0.85, 0.85, 0.82); }   // sign white
  else if (i.m < 9.5) { albedo = vec3f(0.62, 0.55, 0.44); }   // desk laminate
  else if (i.m < 10.5) { albedo = vec3f(0.12, 0.13, 0.16); }  // chair fabric
  else if (i.m < 11.5) { albedo = vec3f(0.40, 0.38, 0.33) * (0.9 + 0.2 * vnoise(i.wp.xz * 4.0 + i.wp.y * 3.0)); }   // concrete
  else if (i.m < 12.5) { albedo = vec3f(0.30, 0.33, 0.38) * (0.92 + 0.16 * vnoise(i.wp.xz * 9.0 + i.wp.y * 9.0)); }   // partition fabric
  else if (i.m < 13.5) { albedo = vec3f(0.02, 0.025, 0.024); }  // CRT glass
  else if (i.m < 14.5) { albedo = vec3f(0.035, 0.035, 0.038); } // black plastic
  else if (i.m < 15.5) { albedo = vec3f(0.54, 0.47, 0.37); }    // drawer fronts
  else if (i.m < 16.5) { albedo = vec3f(0.66, 0.62, 0.52) * (0.96 + 0.08 * vnoise(i.wp.xz * 20.0 + i.wp.y * 20.0)); }   // old beige plastic
  else if (i.m < 17.5) { albedo = vec3f(0.3, 0.02, 0.01); }    // exit sign letters (lit below)
  else if (i.m < 18.5) { albedo = mix(vec3f(0.03), vec3f(0.5, 0.5, 0.47), step(0.45, fract(i.wp.y * 38.0))); }   // return-air grille
  else if (i.m < 19.5) { albedo = poolTile(select(select(i.wp.zy, i.wp.xy, alongX), i.wp.xz, !wall), g, max(max(fw.x, fw.y), fw.z)); }   // pool basin walls and floor
  else if (i.m < 20.5) { albedo = vec3f(0.006, 0.006, 0.007); }  // the figure
  else { albedo = vec3f(0.46, 0.37, 0.26) * (0.92 + 0.16 * vnoise(vec2f(i.wp.y * 40.0, along * 2.0))); }   // painted door

  let f = vec2i(floor(i.wp.xz / CELL));
  let room = cellRoom(f);
  let camC = vec2i(floor(u.cam.xz / CELL));
  if (room == 9 && (i.m < 0.5 || (i.m > 1.5 && i.m < 2.5))) {   // pool room: tiles on the deck and up the walls
    albedo = poolTile(select(i.wp.xz, vec2f(along, i.wp.y), wall), g, max(max(fw.x, fw.y), fw.z)) * select(1.0, 0.93, wall);
  }
  if (room == 7) {                                     // wet room: soaked carpet, damp wicking up the walls
    if (i.m < 0.5) { albedo *= vec3f(0.55, 0.55, 0.5); }
    else if (i.m > 1.5 && i.m < 2.5) { albedo *= mix(vec3f(0.62, 0.6, 0.48), vec3f(1.0), smoothstep(0.25, 0.6 + 0.2 * vnoise(i.wp.xz * 3.0 + i.wp.y), i.wp.y)); }
  }
  let sick = mu * smoothstep(0.35, 0.75, vnoise(tp.xz * 0.06 + vec2f(3.0, f32(L) * 11.0)));
  albedo = mix(albedo, albedo * vec3f(0.92, 0.95, 0.66), sick);
  // wet room floor: soaked carpet with standing puddles (pud 0..1)
  var pud = 0.0;                                       // (an if, not select: select would run fbm everywhere)
  if (room == 7 && i.m < 0.5) { pud = smoothstep(0.47, 0.53, fbm(i.wp.xz * 0.45 + 7.0)); }
  albedo *= 1.0 - 0.65 * pud;
  let wet = pud > 0.0;
  let vd = normalize(u.cam.xyz - vin.wp);
  var light = vec3f(0.018, 0.016, 0.011);
  let up = 0.16 * clamp(-n.y, 0.0, 1.0);    // downward faces (ceiling, lintels, arch soffits) catch light bounced off the floor
  // Light occlusion is worked out from a point in front of a wall face, so a bowed wall that bulges
  // across its grid line is still lit from the side it faces.
  let po = select(i.wp, i.wp + vec3f(n.x, 0.0, n.z) * 0.75, i.m > 1.5 && i.m < 2.5);
  let fo = vec2i(floor(po.xz / CELL));
  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = fo + vec2i(dx, dz);
      let ct = cellTex(c);
      let cd = vec2i(i32(ct.x + 0.5), i32(ct.y + 0.5) - 1);
      let kind = cd.x;
      var level = lightLevelT(c, kind, ct.z, ct.w);
      if (cd.y == 10 && level > 0.0) { level = 0.9; }                     // hallway: every light the same
      if (cd.y == 11 && any(c != camC)) { continue; }                     // follow room: only yours is on
      if (level <= 0.0) { continue; }
      let lp = lightPos(c, kind);
      var vis = 1.0;
      if (dx != 0) {
        let X = fo.x + max(dx, 0); let t = (f32(X) * CELL - po.x) / (lp.x - po.x);
        vis *= crossVis(202u, X, mix(po.z, lp.z, t), mix(po.y, lp.y, t));
      }
      if (dz != 0) {
        let Z = fo.y + max(dz, 0); let t = (f32(Z) * CELL - po.z) / (lp.z - po.z);
        vis *= crossVis(101u, Z, mix(po.x, lp.x, t), mix(po.y, lp.y, t));
      }
      if (vis <= 0.0) { continue; }
      let v = lp - i.wp;
      let d2 = dot(v, v);
      let ndl = max(dot(n, v * inverseSqrt(d2)), 0.0) + up;
      let hz = dot(v.xz, v.xz) / (1.5 * CELL * 1.5 * CELL);           // fades to 0 before the 3x3 window ends
      let win = max(1.0 - hz, 0.0);
      var tint = select(vec3f(1.0, 0.97, 0.86), vec3f(0.93, 1.0, 0.95), kind == 3);   // bare tubes run cold and green
      tint = mix(tint, vec3f(0.86, 1.0, 0.78), 0.3 * mu * f32(i32(ct.w + 0.5) & 1));      // far out, some tubes have gone green
      if (cd.y == 6) { tint = vec3f(1.0, 0.12, 0.06); }                        // red room
      let I = tint * (3.6 * level * vis * win * win / (d2 + 0.8));
      light += I * ndl;
    }
  }
  var col = albedo * light;
  // highlights (worked out after the light loop: anything kept alive through it slows it down).
  // ks: strength per material; carpet, ceiling tile and fabric stay matte. One tightness for all
  // (x^32 by squaring: a pow with a varying exponent cost several ms here).
  var ks = 0.0;
  if (i.m > 5.5 && i.m < 9.5) { ks = select(0.12, 0.3, i.m < 6.5); }          // painted metal; sign enamel
  if ((i.m > 8.5 && i.m < 9.5) || (i.m > 14.5 && i.m < 15.5)) { ks = 0.16; }  // laminate
  if (i.m > 12.5 && i.m < 14.5) { ks = select(0.22, 0.6, i.m < 13.5); }       // glass; black plastic
  if (i.m > 15.5 && i.m < 16.5) { ks = 0.1; }                                 // beige plastic
  if (i.m > 20.5) { ks = 0.08; }                                              // door paint
  if ((i.m > 18.5 && i.m < 19.5) || (room == 9 && (i.m < 0.5 || (i.m > 1.5 && i.m < 2.5)))) { ks = 0.3; }   // glazed tile
  if (SHINY && ks > 0.0 && !wet) {   // from the panel over this spot, as bright as the light arriving here
    let L = normalize(vec3f((f32(f.x) + 0.5) * CELL, HEIGHT - 0.05, (f32(f.y) + 0.5) * CELL) - i.wp);
    var h = max(dot(n, normalize(L + vd)), 0.0);
    h *= h; h *= h; h *= h; h *= h; h *= h;
    let fr = 1.0 - clamp(dot(n, vd), 0.0, 1.0);
    col += light * (ks * h * 1.6 * (1.0 + 2.0 * fr * fr * fr));
  }
  if (wet) {                                           // standing water: a rippled mirror of the ceiling panels
    var r = vec3f(-vd.x, vd.y, -vd.z);
    let rip = sin(i.wp.xz * vec2f(9.0, 11.0) + u.cam.w * vec2f(0.7, -0.5) + i.wp.zx * 5.0) * 0.012;
    r = vec3f(r.x + rip.x, r.y, r.z + rip.y);
    if (r.y > 0.02) {
      let P = i.wp + r * ((HEIGHT - i.wp.y) / r.y);
      let pc = vec2i(floor(P.xz / CELL));
      let l = (fract(P.xz / CELL) - 0.5) * CELL;
      let e = vec2f(0.3, 0.6) - abs(l);
      let k = lightKind(pc);
      let fres = (0.12 + 0.55 * pow(1.0 - vd.y, 4.0)) * pud;
      let tg = fract((P.xz - vec2f(0.0, 0.3)) / 0.6); let tb = min(min(tg.x, 1.0 - tg.x), min(tg.y, 1.0 - tg.y));
      let ceil = mix(vec3f(0.5, 0.48, 0.42), vec3f(0.6, 0.56, 0.45), smoothstep(0.01, 0.04, tb));
      col = mix(col, ceil * light * 1.1, fres);       // the tiled ceiling, upside down (grid only, no stains: cheap)
      if (min(e.x, e.y) > 0.0 && k != 0 && k != 4) {  // (steady brightness: flicker isn't worth the cost here)
        col += vec3f(1.0, 0.98, 0.88) * 1.5 * fres * smoothstep(-0.02, 0.12, min(e.x, e.y));
      }
    }
  }

  // fluorescent panel in the middle of this cell's ceiling (2 ft x 4 ft troffer)
  if (i.m > 0.5 && i.m < 1.5) {
    let l = (fract(i.wp.xz / CELL) - 0.5) * CELL;
    let e = vec2f(0.3, 0.6) - abs(l);
    if (min(e.x, e.y) > 0.0) {
      let kind = lightKind(f);
      var level = lightLevel(f, kind);
      if (room == 10 && level > 0.0) { level = 0.9; }
      if (room == 11 && any(f != camC)) { level = 0.0; }
      if (min(e.x, e.y) < 0.03 && kind != 4) { col = vec3f(0.62, 0.62, 0.58) * light; }   // metal frame
      else if (kind == 4) { col = vec3f(0.003, 0.0028, 0.0025); }                // empty hole in the grid
      else if (kind == 3) {                                                                // cover gone: two bare tubes
        let tube = 1.0 - smoothstep(0.018, 0.026, abs(abs(l.x) - 0.1));
        let dead2 = select(1.0, 0.0, (hc(312u, f) & 1u) == 1u && l.x > 0.0);              // often one tube is out
        let refl = vec3f(0.36, 0.36, 0.34) * (light + 0.3 * level);
        col = mix(refl, vec3f(0.92, 1.0, 0.95) * 12.0 * level * dead2 + vec3f(0.2) * (1.0 - dead2) * light, tube);
      }
      else if (level > 0.05) {
        let grid = 0.94 + 0.06 * step(0.5, fract(l.x * 40.0)) * clamp(1.0 - dFloor * 60.0, 0.0, 1.0);
        col = select(vec3f(1.0, 0.98, 0.88), vec3f(1.0, 0.04, 0.015), room == 6) * select(7.0, 4.0, room == 6) * level * grid * smoothstep(0.03, 0.09, min(e.x, e.y) + 0.03);
      } else { col = vec3f(0.16, 0.16, 0.15) * (light + 0.05); }                          // dead (or flickered off)
    }
  }
  // the diffuser of a hanging panel
  if (i.m > 3.5 && i.m < 4.5) {
    let level = lightLevel(f, 4);
    col = select(vec3f(0.16, 0.16, 0.15) * (light + 0.05), vec3f(1.0, 0.98, 0.88) * 6.0 * level, level > 0.05);
  }

  // CRT glass: a sheen of the room on it, and now and then one left on, glowing with scanlines
  if (i.m > 12.5 && i.m < 13.5) {
    let fr = pow(1.0 - clamp(dot(n, vd), 0.0, 1.0), 3.0);
    col += vec3f(0.5, 0.5, 0.45) * light * (0.06 + 0.5 * fr);
    if (hc(321u, f) % 9u == 0u) {                    // (per cell: one desk a cell)
      let t = u.cam.w;
      let lines = 0.75 + 0.25 * sin(i.wp.y * 1500.0);
      let roll = 0.85 + 0.15 * smoothstep(0.0, 0.08, fract(i.wp.y * 3.0 - t * 0.35));
      let fl = 0.92 + 0.08 * sin(t * 61.0 + f32(hc(322u, f) % 100u));
      col += vec3f(0.30, 0.42, 0.52) * 1.6 * lines * roll * fl;
    }
  }
  if (i.m > 16.5 && i.m < 17.5) {                       // exit sign: glowing red, the odd one stuttering
    var on = 1.0;
    if (hc(331u, f) % 4u == 0u) { on = select(1.0, 0.08, fract(sin(floor(u.cam.w * 9.0) * 12.9898 + f32(f.x * 7 + f.y)) * 43758.5) < 0.3); }
    col += vec3f(1.0, 0.05, 0.02) * 5.0 * on;
  }
  let dist = length(vin.wp - u.cam.xyz);
  col = mix(col, vec3f(0.045, 0.038, 0.02), 1.0 - exp(-dist * 0.03));
  col *= 1.0 - u.misc.y * smoothstep(3.5, 7.5, dist);   // in the hallway the far end is lost in the dark (misc.y fades in)
  return vec4f(col, 1.0);
}
`;
