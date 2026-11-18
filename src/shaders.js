// The look. Step 1: flat-coloured carpet, wallpaper and ceiling, lit by fluorescent panels that sit
// in the middle of each ceiling cell. Whether a panel is on comes from a hash of the seed and the
// cell (this moves to a light-state data grid in step 4, for flicker and dead zones).

export const SCENE = /* wgsl */ `
struct U { vp: mat4x4f, cam: vec4f, misc: vec4f };  // cam.xyz eye, cam.w time; misc.x seed
@group(0) @binding(0) var<uniform> u: U;

const CELL = 3.0;
const HEIGHT = 2.8;

struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) @interpolate(flat) m: f32 };

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) m: f32) -> VO {
  var o: VO;
  o.pos = u.vp * vec4f(p, 1.0);
  o.wp = p; o.n = n; o.m = m;
  return o;
}

fn hash3(x: i32, z: i32, s: u32) -> f32 {
  var h = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(z) * 0xd8163841u) ^ (s * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return f32(h) / 4294967296.0;
}
fn panelOn(c: vec2i) -> bool { return hash3(c.x, c.y, u32(u.misc.x)) < 0.8; }

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let n = normalize(i.n);
  var albedo = vec3f(0.80, 0.71, 0.40);                       // wallpaper
  if (i.m < 0.5) { albedo = vec3f(0.50, 0.42, 0.26); }        // carpet
  else if (i.m < 1.5) { albedo = vec3f(0.78, 0.76, 0.66); }   // ceiling tile

  let cell = vec2i(floor(i.wp.xz / CELL));
  var light = vec3f(0.05, 0.045, 0.03);
  for (var dz = -1; dz <= 1; dz++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = cell + vec2i(dx, dz);
      if (!panelOn(c)) { continue; }
      let lp = vec3f((vec2f(c) + 0.5).x * CELL, HEIGHT - 0.05, (vec2f(c) + 0.5).y * CELL);
      let v = lp - i.wp;
      let d2 = dot(v, v);
      let ndl = max(dot(n, v * inverseSqrt(d2)) * 0.85 + 0.15, 0.0);
      light += vec3f(1.0, 0.96, 0.82) * (3.2 * ndl / (d2 + 0.8));
    }
  }
  var col = albedo * light;

  if (i.m > 0.5 && i.m < 1.5) {
    let t = fract(i.wp.xz / 0.6);                               // 60 cm ceiling tile grid
    let g = min(min(t.x, 1.0 - t.x), min(t.y, 1.0 - t.y));
    col *= mix(0.55, 1.0, smoothstep(0.0, 0.03, g));
    let l = fract(i.wp.xz / CELL) - 0.5;                        // the panel in this cell
    if (abs(l.x) < 0.1 && abs(l.y) < 0.2) {
      col = select(vec3f(0.06, 0.06, 0.05), vec3f(3.2, 3.1, 2.7), panelOn(cell));
    }
  }

  let dist = length(i.wp - u.cam.xyz);
  col = mix(col, vec3f(0.09, 0.075, 0.04), 1.0 - exp(-dist * 0.035));
  col = 1.0 - exp(-col * 1.3);                                  // tone map
  return vec4f(pow(col, vec3f(1.0 / 2.2)), 1.0);
}
`;
