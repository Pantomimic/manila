// Post-processing: bloom (threshold -> downsample chain -> additive upsample), then tone mapping,
// vignette and film grain onto the output.
export const POST = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var<uniform> pu: vec4f;      // x time, y exposure, z bloom strength, w grain

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
@fragment fn fsPre(i: VO) -> @location(0) vec4f {
  let c = min(box4(i.uv), vec3f(40.0));
  let l = max(c.r, max(c.g, c.b));
  return vec4f(c * (max(l - 1.0, 0.0) / max(l, 1e-4)), 1.0);
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

fn grainHash(p: vec2u, f: u32) -> f32 {
  var h = (p.x * 0x8da6b343u) ^ (p.y * 0xd8163841u) ^ (f * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return f32(h >> 8u) / 16777216.0;
}
@fragment fn fsFinal(i: VO) -> @location(0) vec4f {
  var c = textureSampleLevel(src, smp, i.uv, 0.0).rgb + textureSampleLevel(bloom, smp, i.uv, 0.0).rgb * pu.z;
  c *= pu.y;
  // filmic curve (ACES fit), slightly lifted toe so the dark zones keep some detail
  c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
  let d = i.uv - 0.5;
  c *= 1.0 - dot(d, d) * 0.55;                                            // vignette
  c = pow(c, vec3f(1.0 / 2.2));
  let g = grainHash(vec2u(i.p.xy), u32(pu.x * 24.0)) - 0.5;               // grain at 24 fps, also dithers banding
  return vec4f(c + g * pu.w, 1.0);
}
`;
