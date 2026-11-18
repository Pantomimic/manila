// The look: wallpaper, carpet, drop ceiling and fluorescent panels, all generated in the shader from
// world position. Output is linear HDR; post.js adds bloom, tone mapping, vignette and grain.
import { CELL, HEIGHT, DENSITY_U, DOOR_U, PANEL_U } from './gen.js';

export const SCENE = /* wgsl */ `
struct U { vp: mat4x4f, cam: vec4f, misc: vec4f };  // cam.xyz eye, cam.w time; misc.x seed
@group(0) @binding(0) var<uniform> u: U;

const CELL = ${CELL.toFixed(1)};
const HEIGHT = ${HEIGHT.toFixed(2)};

struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) @interpolate(flat) m: f32 };

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: f32) -> VO {
  var o: VO;
  o.pos = u.vp * vec4f(p, 1.0);
  o.wp = p; o.n = n; o.m = m;
  return o;
}

// ---- exact copy of gen.js: hashU, wall rules, panel rule ----
fn hashU(a: u32, b: u32, c: u32, d: u32) -> u32 {
  var h = (a ^ 0x9e3779b9u) * 0x85ebca6bu;
  h = (h ^ (h >> 13u) ^ b) * 0xc2b2ae35u;
  h = (h ^ (h >> 16u) ^ c) * 0x27d4eb2fu;
  h = (h ^ (h >> 15u) ^ d) * 0x165667b1u;
  return h ^ (h >> 16u);
}
fn seed() -> u32 { return u32(u.misc.x); }
fn floorDiv(a: i32, b: i32) -> i32 { if (a >= 0) { return a / b; } return -((-a + b - 1) / b); }
fn lineWall(salt: u32, line: i32, along: i32) -> bool {
  let L = bitcast<u32>(line);
  let len = 2u + hashU(seed(), salt, L, 1u) % 5u;
  let off = hashU(seed(), salt, L, 2u) % len;
  let run = floorDiv(along + i32(off), i32(len));
  if (hashU(seed(), salt + 7u, L, bitcast<u32>(run)) >= ${DENSITY_U}u) { return false; }
  return hashU(seed(), salt + 13u, L, bitcast<u32>(along)) >= ${DOOR_U}u;
}
fn wallH(x: i32, z: i32) -> bool { return lineWall(101u, z, x); }
fn wallV(x: i32, z: i32) -> bool { return lineWall(202u, x, z); }
fn panelOn(c: vec2i) -> bool { return hashU(seed(), 303u, bitcast<u32>(c.x), bitcast<u32>(c.y)) < ${PANEL_U}u; }

// ---- light visibility. The line from a surface point to a light in a neighbouring cell crosses at
// most one vertical and one horizontal grid line; a wall on the edge it crosses blocks the light.
// Near the end of a wall the result fades over PEN metres, a soft shadow edge instead of a hard one.
const PEN = 0.35;
fn edgeVis(blocked0: bool, blockedN: bool, t: f32) -> f32 {
  let v0 = select(1.0, 0.0, blocked0); let vn = select(1.0, 0.0, blockedN);
  return mix(vn, v0, 0.5 + 0.5 * smoothstep(0.0, PEN, min(t, 1.0 - t) * CELL));
}
fn visV(X: i32, z: f32) -> f32 {          // crossing vertical line X at world z
  let r = z / CELL; let row = i32(floor(r)); let t = fract(r);
  return edgeVis(wallV(X, row), wallV(X, row + select(1, -1, t < 0.5)), t);
}
fn visH(Z: i32, x: f32) -> f32 {          // crossing horizontal line Z at world x
  let r = x / CELL; let col = i32(floor(r)); let t = fract(r);
  return edgeVis(wallH(col, Z), wallH(col + select(1, -1, t < 0.5), Z), t);
}

// ---- noise ----
fn h2(p: vec2i) -> f32 { return f32(hashU(bitcast<u32>(p.x), bitcast<u32>(p.y), 77u, 5u) >> 8u) / 16777216.0; }
fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p)); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2i(1, 0)), w.x), mix(h2(i + vec2i(0, 1)), h2(i + vec2i(1, 1)), w.x), w.y);
}
fn fbm(p: vec2f) -> f32 { return vnoise(p) * 0.5 + vnoise(p * 2.03 + 17.0) * 0.3 + vnoise(p * 4.07 + 41.0) * 0.2; }

// ---- surfaces. d = screen-space footprint in metres, used to fade patterns that would shimmer ----
fn wallpaper(along: f32, y: f32, side: f32, d: f32) -> vec3f {
  var c = vec3f(0.74, 0.64, 0.33);
  let s = along / 0.16;
  let aa = clamp(1.0 - d * 12.0, 0.0, 1.0);
  let line = 1.0 - smoothstep(0.015, 0.04, abs(fract(s) - 0.5));        // thin vertical pinstripe
  c *= 1.0 - line * 0.09 * aa;
  let du = abs(fract(s) - 0.5) * 0.16;                                    // small diamonds between stripes
  let dv = abs(fract(y / 0.32 + 0.5 * floor(s)) - 0.5) * 0.32;
  let dia = 1.0 - smoothstep(0.022, 0.03, (0.08 - du) * 1.2 + dv * 0.5);
  c *= 1.0 - dia * 0.07 * aa;
  let n = fbm(vec2f(along * 0.9 + side * 31.0, y * 0.9));
  let stain = smoothstep(0.5, 0.78, n * 0.85 + (y - HEIGHT + 0.8) * 0.45);  // water damage from the ceiling
  c = mix(c, c * vec3f(0.70, 0.60, 0.42), stain);
  let streak = smoothstep(0.72, 0.9, vnoise(vec2f(along * 5.0 + side * 7.0, y * 0.35))) * smoothstep(0.6, 2.2, y);
  c = mix(c, c * vec3f(0.80, 0.72, 0.55), streak * 0.6);
  c *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.6, y)) * n;                  // scuffs low on the wall
  if (y < 0.09) { c = vec3f(0.30, 0.23, 0.14) * (0.85 + 0.3 * smoothstep(0.07, 0.09, y)); }   // baseboard
  return c;
}

fn carpet(p: vec2f, d: f32) -> vec3f {
  var c = vec3f(0.52, 0.42, 0.21);
  let fiber = vnoise(p * 45.0) - 0.5;
  c *= 1.0 + fiber * 0.22 * clamp(1.0 - d * 40.0, 0.0, 1.0);
  c *= 0.88 + fbm(p * 0.7) * 0.24;
  let damp = smoothstep(0.6, 0.7, fbm(p * 0.12 + 5.0));                  // damp patches
  return mix(c, c * vec3f(0.62, 0.64, 0.46), damp * 0.85);
}

// ceiling tile colour; panel emission handled separately
fn ceiling(p: vec2f, d: f32) -> vec3f {
  let tile = vec2i(floor(p / 0.6));
  var c = vec3f(0.70, 0.66, 0.52) * (0.92 + h2(tile) * 0.1);
  c *= 0.95 + vnoise(p * 30.0) * 0.1 * clamp(1.0 - d * 30.0, 0.0, 1.0);   // pitted acoustic tile
  if (h2(tile + vec2i(913, 71)) < 0.035) {                                  // the odd stained tile
    let q = fract(p / 0.6) - 0.5 + (vec2f(vnoise(p * 6.0), vnoise(p * 6.0 + 9.0)) - 0.5) * 0.35;
    c = mix(c, c * vec3f(0.80, 0.70, 0.52), smoothstep(0.40, 0.12, length(q)));
  }
  let t = fract(p / 0.6);
  let g = min(min(t.x, 1.0 - t.x), min(t.y, 1.0 - t.y)) * 0.6;            // metal grid between tiles
  return mix(vec3f(0.55, 0.54, 0.50), c, smoothstep(0.008, 0.012 + d, g));
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let fw = fwidth(i.wp);                     // derivatives must be taken before any branching
  let n = normalize(i.n);
  let wall = abs(n.y) < 0.5;
  let alongX = abs(n.z) > 0.5;               // wall facing +-z runs along x
  let along = select(i.wp.z, i.wp.x, alongX);
  let dAlong = select(fw.z, fw.x, alongX);
  let dFloor = max(fw.x, fw.z);

  var albedo: vec3f;
  if (i.m < 0.5) { albedo = carpet(i.wp.xz, dFloor); }
  else if (i.m < 1.5) { albedo = ceiling(i.wp.xz, dFloor); }
  else { albedo = wallpaper(along, i.wp.y, n.x * 2.0 + n.z, dAlong); }

  let f = vec2i(floor(i.wp.xz / CELL));
  var light = vec3f(0.018, 0.016, 0.011);
  let up = select(0.0, 0.16, i.m > 0.5 && i.m < 1.5);   // the ceiling catches light bounced off the floor
  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = f + vec2i(dx, dz);
      if (!panelOn(c)) { continue; }
      let lp = vec3f((f32(c.x) + 0.5) * CELL, HEIGHT - 0.05, (f32(c.y) + 0.5) * CELL);
      var vis = 1.0;
      if (dx != 0) {
        let X = f.x + max(dx, 0); let t = (f32(X) * CELL - i.wp.x) / (lp.x - i.wp.x);
        vis *= visV(X, mix(i.wp.z, lp.z, t));
      }
      if (dz != 0) {
        let Z = f.y + max(dz, 0); let t = (f32(Z) * CELL - i.wp.z) / (lp.z - i.wp.z);
        vis *= visH(Z, mix(i.wp.x, lp.x, t));
      }
      if (vis <= 0.0) { continue; }
      let v = lp - i.wp;
      let d2 = dot(v, v);
      let ndl = max(dot(n, v * inverseSqrt(d2)), 0.0) + up;
      let hz = dot(v.xz, v.xz) / (1.5 * CELL * 1.5 * CELL);           // fades to 0 before the 3x3 window ends
      let win = max(1.0 - hz, 0.0);
      light += vec3f(1.0, 0.97, 0.86) * (3.6 * vis * ndl * win * win / (d2 + 0.8));
    }
  }
  var col = albedo * light;

  // fluorescent panel in the middle of this cell's ceiling (2 ft x 4 ft troffer)
  if (i.m > 0.5 && i.m < 1.5) {
    let l = (fract(i.wp.xz / CELL) - 0.5) * CELL;
    let e = vec2f(0.3, 0.6) - abs(l);
    if (min(e.x, e.y) > 0.0) {
      if (min(e.x, e.y) < 0.03) { col = vec3f(0.62, 0.62, 0.58) * light; }            // metal frame
      else if (panelOn(f)) {
        let grid = 0.94 + 0.06 * step(0.5, fract(l.x * 40.0)) * clamp(1.0 - dFloor * 60.0, 0.0, 1.0);
        col = vec3f(1.0, 0.98, 0.88) * 7.0 * grid * smoothstep(0.03, 0.09, min(e.x, e.y) + 0.03);
      } else { col = vec3f(0.16, 0.16, 0.15) * (light + 0.05); }                       // dead tube
    }
  }

  let dist = length(i.wp - u.cam.xyz);
  col = mix(col, vec3f(0.045, 0.038, 0.02), 1.0 - exp(-dist * 0.03));
  return vec4f(col, 1.0);
}
`;
