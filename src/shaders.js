// The look: wallpaper, carpet, drop ceiling and fluorescent panels, all generated in the shader from
// world position. Output is linear HDR; post.js adds bloom, tone mapping, vignette and grain.
import { CELL, HEIGHT, DENSITY_U, DOOR_U, ZONE, LIGHT_U } from './gen.js';

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

// ---- exact copy of gen.js: hashU, wall rules, light rules ----
fn hashU(a: u32, b: u32, c: u32, d: u32) -> u32 {
  var h = (a ^ 0x9e3779b9u) * 0x85ebca6bu;
  h = (h ^ (h >> 13u) ^ b) * 0xc2b2ae35u;
  h = (h ^ (h >> 16u) ^ c) * 0x27d4eb2fu;
  h = (h ^ (h >> 15u) ^ d) * 0x165667b1u;
  return h ^ (h >> 16u);
}
fn seed() -> u32 { return u32(u.misc.x); }
fn floorDiv(a: i32, b: i32) -> i32 { if (a >= 0) { return a / b; } return -((-a + b - 1) / b); }
// 0 open, 1 wall, 2 doorway
fn lineKind(salt: u32, line: i32, along: i32) -> i32 {
  let L = bitcast<u32>(line);
  let len = 2u + hashU(seed(), salt, L, 1u) % 5u;
  let off = hashU(seed(), salt, L, 2u) % len;
  let run = floorDiv(along + i32(off), i32(len));
  if (hashU(seed(), salt + 7u, L, bitcast<u32>(run)) >= ${DENSITY_U}u) { return 0; }
  return select(2, 1, hashU(seed(), salt + 13u, L, bitcast<u32>(along)) >= ${DOOR_U}u);
}
fn unitf(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }
// the opening in an edge: (lo, hi) along it as 0..1, lintel/spring height, arch crown. x < 0: solid wall
fn edgeSpan(salt: u32, line: i32, along: i32) -> vec4f {
  let k = lineKind(salt, line, along);
  if (k == 1) { return vec4f(-1.0); }
  if (k == 0) { return vec4f(0.0, 1.0, 99.0, 99.0); }
  let L = bitcast<u32>(line); let A = bitcast<u32>(along);
  let r = unitf(hashU(seed(), salt + 21u, L, A)); let u2 = unitf(hashU(seed(), salt + 22u, L, A)); let u3 = unitf(hashU(seed(), salt + 23u, L, A));
  if (r < 0.4) { let t = 2.05 + 0.3 * u2; return vec4f(0.0, 1.0, t, t); }
  var w: f32; var top: f32; var apex: f32;
  if (r < 0.75) { w = 1.0 + 0.6 * u2; top = 2.05 + 0.15 * u3; apex = top; }
  else { w = 1.4 + 1.0 * u2; top = 1.75 + 0.2 * u3; apex = min(HEIGHT - 0.12, top + w * 0.35); }
  let c = 0.5 * CELL + (unitf(hashU(seed(), salt + 24u, L, A)) - 0.5) * (CELL - w - 0.6);
  return vec4f((c - w * 0.5) / CELL, (c + w * 0.5) / CELL, top, apex);
}

fn hc(salt: u32, c: vec2i) -> u32 { return hashU(seed(), salt, bitcast<u32>(c.x), bitcast<u32>(c.y)); }
fn unit(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }
// 0 dead, 1 on, 2 flickering, 3 broken cover, 4 hanging
fn lightKind(c: vec2i) -> i32 {
  let h = hc(303u, c);
  let zc = vec2i(floorDiv(c.x, ${ZONE}), floorDiv(c.y, ${ZONE}));
  if (hc(500u, zc) < ${LIGHT_U.darkZone}u) { return select(0, 2, h < ${LIGHT_U.darkFlicker}u); }
  if (h < ${LIGHT_U.dead}u) { return 0; }
  let k = hc(304u, c);
  if (k < ${LIGHT_U.flicker}u) { return 2; }
  if (k < ${LIGHT_U.broken}u) { return 3; }
  if (k < ${LIGHT_U.hang}u) { return 4; }
  return 1;
}
fn lightLevel(c: vec2i, kind: i32) -> f32 {
  if (kind == 0) { return 0.0; }
  let base = 0.82 + 0.18 * unit(hc(306u, c));
  if (kind != 2 && !(kind == 4 && (hc(305u, c) & 1u) == 1u)) { return base; }
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
  var top = s.z;
  if (s.w > s.z + 0.01) { let q = (t - (s.x + s.y) * 0.5) / ((s.y - s.x) * 0.5); top = s.z + (s.w - s.z) * sqrt(max(0.0, 1.0 - q * q)); }
  return across * (1.0 - smoothstep(top - 0.12, top + 0.12, y));
}
fn crossVis(salt: u32, line: i32, a: f32, y: f32) -> f32 {
  let r = a / CELL; let i = i32(floor(r)); let t = fract(r);
  let nb = select(1, -1, t < 0.5);
  return min(1.0, through(edgeSpan(salt, line, i), t, y) + through(edgeSpan(salt, line, i + nb), t - f32(nb), y));
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
  let s = along / 0.16;
  let aa = clamp(1.0 - d * 12.0, 0.0, 1.0);
  let line = 1.0 - smoothstep(0.015, 0.04, abs(fract(s) - 0.5));        // thin vertical pinstripe
  c *= 1.0 - line * 0.09 * aa;
  let du = abs(fract(s) - 0.5) * 0.16;                                    // small diamonds between stripes
  let dv = abs(fract(y / 0.32 + 0.5 * floor(s)) - 0.5) * 0.32;
  let dia = 1.0 - smoothstep(0.022, 0.03, (0.08 - du) * 1.2 + dv * 0.5);
  c *= 1.0 - dia * 0.07 * aa;
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
  if (y < 0.09) { c = vec3f(0.30, 0.23, 0.14) * (0.85 + 0.3 * smoothstep(0.07, 0.09, y)); }   // baseboard
  return c;
}

fn carpet(p: vec2f, d: f32, g: f32) -> vec3f {
  var c = vec3f(0.52, 0.42, 0.21);
  let fiber = vnoise(p * 45.0) - 0.5;
  c *= 1.0 + fiber * 0.22 * clamp(1.0 - d * 40.0, 0.0, 1.0);
  c *= 0.88 + fbm(p * 0.7) * 0.24;
  let damp = smoothstep(0.6, 0.7, fbm(p * 0.12 + 5.0) + (g - 0.5) * 0.25);                  // damp patches
  return mix(c, c * vec3f(0.62, 0.64, 0.46), damp * 0.85);
}

// ceiling tile colour; panel emission handled separately
fn ceiling(p: vec2f, d: f32, g: f32) -> vec3f {
  let tile = vec2i(floor(p / 0.6));
  var c = vec3f(0.70, 0.66, 0.52) * (0.92 + h2(tile) * 0.1);
  c *= 0.95 + vnoise(p * 30.0) * 0.1 * clamp(1.0 - d * 30.0, 0.0, 1.0);   // pitted acoustic tile
  if (h2(tile + vec2i(913, 71)) < 0.005 + 0.07 * g) {                                  // the odd stained tile
    let q = fract(p / 0.6) - 0.5 + (vec2f(vnoise(p * 6.0), vnoise(p * 6.0 + 9.0)) - 0.5) * 0.35;
    c = mix(c, c * vec3f(0.80, 0.70, 0.52), smoothstep(0.40, 0.12, length(q)));
  }
  let t = fract(p / 0.6);
  let gr = min(min(t.x, 1.0 - t.x), min(t.y, 1.0 - t.y)) * 0.6;           // metal grid between tiles
  return mix(vec3f(0.55, 0.54, 0.50), c, smoothstep(0.008, 0.012 + d, gr));
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let fw = fwidth(i.wp);                     // derivatives must be taken before any branching
  let n = normalize(i.n);
  let wall = abs(n.y) < 0.5;
  let alongX = abs(n.z) > 0.5;               // wall facing +-z runs along x
  let along = select(i.wp.z, i.wp.x, alongX);
  let dAlong = select(fw.z, fw.x, alongX);
  let dFloor = max(fw.x, fw.z);

  let g = smoothstep(0.3, 0.7, vnoise(i.wp.xz * 0.028 + 11.0));   // grime, in patches tens of metres wide
  var albedo: vec3f;
  if (i.m < 0.5) { albedo = carpet(i.wp.xz, dFloor, g); }
  else if (i.m < 1.5) { albedo = ceiling(i.wp.xz, dFloor, g); }
  else if (i.m < 2.5) { albedo = wallpaper(along, i.wp.y, select(2.0 * sign(n.x), sign(n.z), alongX), dAlong, g); }
  else if (i.m < 4.5) { albedo = vec3f(0.55, 0.55, 0.52); }   // light housing
  else { albedo = vec3f(0.05, 0.05, 0.05); }                  // cable

  let f = vec2i(floor(i.wp.xz / CELL));
  var light = vec3f(0.018, 0.016, 0.011);
  let up = 0.16 * clamp(-n.y, 0.0, 1.0);    // downward faces (ceiling, lintels, arch soffits) catch light bounced off the floor
  // Light occlusion is worked out from a point in front of a wall face, so a bowed wall that bulges
  // across its grid line is still lit from the side it faces.
  let po = select(i.wp, i.wp + vec3f(n.x, 0.0, n.z) * 0.75, i.m > 1.5 && i.m < 2.5);
  let fo = vec2i(floor(po.xz / CELL));
  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = fo + vec2i(dx, dz);
      let kind = lightKind(c);
      let level = lightLevel(c, kind);
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
      let tint = select(vec3f(1.0, 0.97, 0.86), vec3f(0.93, 1.0, 0.95), kind == 3);   // bare tubes run cold and green
      light += tint * (3.6 * level * vis * ndl * win * win / (d2 + 0.8));
    }
  }
  var col = albedo * light;

  // fluorescent panel in the middle of this cell's ceiling (2 ft x 4 ft troffer)
  if (i.m > 0.5 && i.m < 1.5) {
    let l = (fract(i.wp.xz / CELL) - 0.5) * CELL;
    let e = vec2f(0.3, 0.6) - abs(l);
    if (min(e.x, e.y) > 0.0) {
      let kind = lightKind(f);
      let level = lightLevel(f, kind);
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
        col = vec3f(1.0, 0.98, 0.88) * 7.0 * level * grid * smoothstep(0.03, 0.09, min(e.x, e.y) + 0.03);
      } else { col = vec3f(0.16, 0.16, 0.15) * (light + 0.05); }                          // dead (or flickered off)
    }
  }
  // the diffuser of a hanging panel
  if (i.m > 3.5 && i.m < 4.5) {
    let level = lightLevel(f, 4);
    col = select(vec3f(0.16, 0.16, 0.15) * (light + 0.05), vec3f(1.0, 0.98, 0.88) * 6.0 * level, level > 0.05);
  }

  let dist = length(i.wp - u.cam.xyz);
  col = mix(col, vec3f(0.045, 0.038, 0.02), 1.0 - exp(-dist * 0.03));
  return vec4f(col, 1.0);
}
`;
