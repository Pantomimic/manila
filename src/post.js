// Post-processing: bloom (threshold -> downsample chain -> additive upsample), then tone mapping,
// vignette and film grain onto the output. With the camcorder look on (pu.b.x), the final pass also
// smears colour sideways like VHS, wobbles lines, rolls a tracking band and tears the bottom edge.
export const POST = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var bloom: texture_2d<f32>;
struct PU { a: vec4f, b: vec4f, c: vec4f };   // a: time, exposure, bloom strength, grain; b: camcorder on, auto exposure; c: tan(fov/2) x and y, near, far
@group(0) @binding(3) var<uniform> pu: PU;
// ambient occlusion: r = how open the spot is (1 open, lower in corners and under things), g = view depth
@group(0) @binding(4) var aoT: texture_2d<f32>;
// the scene's depth buffer (multisampled; sample 0 is enough)
@group(0) @binding(5) var dep: texture_depth_multisampled_2d;

struct VO { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
  var o: VO; o.p = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0); o.uv = vec2f(x, y); return o;
}

fn box4(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src));
  return (textureSampleLevel(src, smp, uv + t * vec2f(-1.0, -1.0), 0.0).rgb + textureSampleLevel(src, smp, uv + t * vec2f(1.0, -1.0), 0.0).rgb
        + textureSampleLevel(src, smp, uv + t * vec2f(-1.0, 1.0), 0.0).rgb + textureSampleLevel(src, smp, uv + t * vec2f(1.0, 1.0), 0.0).rgb) * 0.25;
}
// first downsample: keep only what is brighter than 1 (the panels), soft knee, clamp fireflies
// (alpha: the view depth of one of the four pixels, from the depth buffer, for the AO pass, which reads
// this half-size copy. Writing depth from the scene pass itself cost 4 ms a frame on Intel graphics.)
@fragment fn fsPre(i: VO) -> @location(0) vec4f {
  let c = min(box4(i.uv), vec3f(40.0));
  let l = max(c.r, max(c.g, c.b));
  let z = textureLoad(dep, vec2i(i.uv * vec2f(textureDimensions(dep))), 0);
  let d = pu.c.z * pu.c.w / (pu.c.w - z * (pu.c.w - pu.c.z));       // depth buffer value -> metres from the camera
  return vec4f(c * (max(l - 1.0, 0.0) / max(l, 1e-4)), d);
}
@fragment fn fsDown(i: VO) -> @location(0) vec4f { return vec4f(box4(i.uv), 1.0); }
// tent filter from the smaller level, added onto the larger one
@fragment fn fsUp(i: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = textureSampleLevel(src, smp, i.uv, 0.0).rgb * 4.0;
  c += (textureSampleLevel(src, smp, i.uv + vec2f(t.x, 0.0), 0.0).rgb + textureSampleLevel(src, smp, i.uv - vec2f(t.x, 0.0), 0.0).rgb
      + textureSampleLevel(src, smp, i.uv + vec2f(0.0, t.y), 0.0).rgb + textureSampleLevel(src, smp, i.uv - vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  c += textureSampleLevel(src, smp, i.uv + t, 0.0).rgb + textureSampleLevel(src, smp, i.uv - t, 0.0).rgb
     + textureSampleLevel(src, smp, i.uv + vec2f(t.x, -t.y), 0.0).rgb + textureSampleLevel(src, smp, i.uv + vec2f(-t.x, t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}

// ---- ambient occlusion from the depth the scene pass leaves in alpha (read from fsPre's half-size copy) ----
// Corners, the foot of each wall and the floor under furniture get less of the light bouncing around
// the room. For each pixel: rebuild its position and normal from depth, then count how much nearby
// geometry sits in front of it within R metres (Alchemy-style estimator), from 10 spiral samples
// turned per pixel. fsBlur then smooths the noise without blurring across depth edges.
fn depthAt(p: vec2i) -> f32 { return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0).a; }
fn vpos(uv: vec2f, d: f32) -> vec3f { return vec3f((uv.x * 2.0 - 1.0) * pu.c.x * d, (1.0 - 2.0 * uv.y) * pu.c.y * d, -d); }
const AO_R = 0.5;
@fragment fn fsAO(i: VO) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(src));
  let fp = vec2i(i.uv * dims);
  let uv = (vec2f(fp) + 0.5) / dims;
  let d = depthAt(fp);
  if (d > 30.0) { return vec4f(1.0, d, 0.0, 1.0); }
  let p = vpos(uv, d);
  let px = 1.0 / dims;
  let dl = depthAt(fp - vec2i(1, 0)); let dr = depthAt(fp + vec2i(1, 0));
  let du = depthAt(fp - vec2i(0, 1)); let dd = depthAt(fp + vec2i(0, 1));
  let ex = select(p - vpos(uv - vec2f(px.x, 0.0), dl), vpos(uv + vec2f(px.x, 0.0), dr) - p, abs(dr - d) < abs(dl - d));
  let ey = select(p - vpos(uv - vec2f(0.0, px.y), du), vpos(uv + vec2f(0.0, px.y), dd) - p, abs(dd - d) < abs(du - d));
  let n = normalize(cross(ey, ex));
  let rad = min(vec2f(AO_R / (2.0 * pu.c.x * d), AO_R / (2.0 * pu.c.y * d)), vec2f(0.05));   // (capped: wide spreads thrash the texture cache)
  let ign = fract(52.9829189 * fract(dot(i.p.xy, vec2f(0.06711056, 0.00583715))));
  var sum = 0.0;
  for (var k = 0; k < 10; k++) {
    let a = (f32(k) + ign) * 2.39996;
    let r = sqrt((f32(k) + 0.5) / 10.0);
    let s = uv + vec2f(cos(a), sin(a)) * r * rad;
    let sp = vpos(s, depthAt(vec2i(s * dims)));
    let v = sp - p;
    let vv = dot(v, v);
    sum += max(0.0, dot(v, n) - 0.015 * d) / (vv + 0.03) * (1.0 - smoothstep(AO_R * AO_R, 4.0 * AO_R * AO_R, vv));
  }
  var ao = clamp(1.0 - 0.09 * sum, 0.3, 1.0);
  ao = mix(ao, 1.0, smoothstep(14.0, 28.0, d));
  return vec4f(ao, d, 0.0, 1.0);
}
@fragment fn fsBlur(i: VO) -> @location(0) vec4f {
  let dims = vec2i(textureDimensions(aoT));
  let c = vec2i(i.uv * vec2f(dims));
  let d0 = textureLoad(aoT, c, 0).g;
  var s = 0.0; var w = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let t = textureLoad(aoT, clamp(c + vec2i(x, y) * 2, vec2i(0), dims - 1), 0);   // (every other texel: wider, same cost)
      let k = exp(-abs(t.g - d0) / (0.03 * d0 + 0.01)) * (1.0 - 0.2 * f32(abs(x) + abs(y)));
      s += t.r * k; w += k;
    }
  }
  return vec4f(s / max(w, 1e-4), d0, 0.0, 1.0);
}

fn grainHash(p: vec2u, f: u32) -> f32 {
  var h = (p.x * 0x8da6b343u) ^ (p.y * 0xd8163841u) ^ (f * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return f32(h >> 8u) / 16777216.0;
}
fn tone(c0: vec3f) -> vec3f {
  let c = c0 * pu.a.y * pu.b.y;
  // filmic curve (ACES fit), slightly lifted toe so the dark zones keep some detail
  return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn scene(uv: vec2f) -> vec3f { return textureSampleLevel(src, smp, uv, 0.0).rgb * textureSampleLevel(aoT, smp, uv, 0.0).r + textureSampleLevel(bloom, smp, uv, 0.0).rgb * pu.a.z; }
fn yiq(c: vec3f) -> vec3f { return vec3f(dot(c, vec3f(0.299, 0.587, 0.114)), dot(c, vec3f(0.596, -0.274, -0.322)), dot(c, vec3f(0.211, -0.523, 0.312))); }
fn rgb(q: vec3f) -> vec3f { return vec3f(q.x + 0.956 * q.y + 0.621 * q.z, q.x - 0.272 * q.y - 0.647 * q.z, q.x - 1.106 * q.y + 1.703 * q.z); }
@fragment fn fsFinal(i: VO) -> @location(0) vec4f {
  let frame = u32(pu.a.x * 30.0);
  var c: vec3f;
  if (pu.b.x > 0.5) {
    // camcorder: 240 wobbling lines, a tracking band drifting up, a torn strip at the bottom
    let line = u32(i.uv.y * 240.0);
    var uv = i.uv;
    uv.x += (grainHash(vec2u(line, 7u), frame / 2u) - 0.5) * 0.0018;
    let band = fract(1.0 - pu.a.x * 0.045);
    let wob = 0.5 + 0.5 * sin(pu.a.x * 0.23) * sin(pu.a.x * 0.071 + 1.0);         // tracking drifts in and out
    let inBand = (1.0 - smoothstep(0.0, 0.035, abs(i.uv.y - band))) * (0.15 + 0.85 * smoothstep(0.7, 0.95, wob));
    uv.x += inBand * (grainHash(vec2u(line, 9u), frame) - 0.5) * 0.02;
    let tear = smoothstep(0.955, 1.0, i.uv.y);
    uv.x += tear * (0.03 + 0.02 * grainHash(vec2u(line, 3u), frame));
    // luma sharp-ish, chroma smeared wide and late (to the right)
    let px = 1.0 / f32(textureDimensions(src).x);
    let ly = yiq(tone(scene(uv))).x * 0.5 + (yiq(tone(scene(uv - vec2f(1.5 * px, 0.0)))).x + yiq(tone(scene(uv + vec2f(1.5 * px, 0.0)))).x) * 0.25;
    var ch = vec2f(0.0);
    for (var k = 0; k < 5; k++) { ch += yiq(tone(scene(uv - vec2f((f32(k) * 3.0 + 3.0) * px, 0.0)))).yz; }
    ch *= 0.2 * 0.8;
    c = clamp(rgb(vec3f(ly, ch)), vec3f(0.0), vec3f(1.0));
    c = mix(c, vec3f(0.06, 0.05, 0.07), 0.06);                         // lifted, slightly purple blacks
    c += inBand * (grainHash(vec2u(i.p.xy), frame) - 0.5) * 0.25;      // the band is noisy
    c += tear * (grainHash(vec2u(i.p.xy) / vec2u(3u, 1u), frame) - 0.5) * 0.4;
    if (grainHash(vec2u(line, 11u), frame) > 0.9985) {                 // the odd dropout streak
      c += vec3f(0.6) * smoothstep(0.0, 0.02, fract(i.uv.x * 3.0 + grainHash(vec2u(line, 12u), frame)) - 0.9);
    }
  } else { c = tone(scene(i.uv)); }
  let d = i.uv - 0.5;
  c *= 1.0 - dot(d, d) * select(0.55, 0.85, pu.b.x > 0.5);              // vignette
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  let g = grainHash(vec2u(i.p.xy), u32(pu.a.x * 24.0)) - 0.5;              // grain at 24 fps, also dithers banding
  return vec4f(c + g * pu.a.w * select(1.0, 2.2, pu.b.x > 0.5), 1.0);
}
`;
