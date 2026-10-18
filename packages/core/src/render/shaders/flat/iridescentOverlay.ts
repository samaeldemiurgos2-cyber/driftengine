/**
 * A surface's iridescent overlay on its base colour, before it is lit:
 * `SurfaceMaterial.iridescentOverlay`, packed into `uIridescence` by `iridescentOverlay.ts`, whose
 * `iridescentBase` is this arithmetic on the CPU and says what each term is and what it gives up.
 *
 * **Called once the normal is mapped and turned to the viewer**, so the view term reads the surface
 * a pixel shows, and before any light is added, so the lights below read the colour it makes. The
 * mask is read in uniform control flow, under the lighting branch and this switch's, so its implicit
 * level is legal: AGENTS.md 2026-08-07.
 *
 * **A lit switch, `IRIDESCENT_OVERLAY`**, off until a material first asks, declared after
 * `EMISSIVE_FLOW` so each switch before it keeps its id. Compiled out, its thirty-six vectors are
 * not declared and the call is a constant.
 */
export function iridescentOverlayGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool IRIDESCENT_OVERLAY = false;  // wgsl:override
bool iridescent() { return false; }
vec3 iridescentBase(vec3 base, vec3 n, vec2 uv) { return base; }
`;
  }
  return /* glsl */ `
/* Whether this program lays an iridescent overlay. Off but where a material has asked. */
const bool IRIDESCENT_OVERLAY = true;  // wgsl:override
/*
 * Thirty-six vectors, as iridescentOverlay.ts packs them: the direction toward the sheen and the
 * blend (0); the contrast, the tiling, the weight and 1 for on (1); the mask's array, 0 none, 1 ORM,
 * 2 model, 3 albedo, 4 emissive, its layer and its channel (2); what takes the material's
 * coordinates back to the mesh's own (3); then the ramp, thirty-two colours.
 */
uniform vec4 uIridescence[36]; // wgsl:material

bool iridescent() { return uIridescence[1].w > 0.5; }

/* The mask's channel at the material's coordinates; 1 where it names no array. */
float iridescentMask(vec2 uv) {
  float source = uIridescence[2].x;
  if (source < 0.5) return 1.0;
  vec3 at = vec3(uv, uIridescence[2].y);
  vec4 texel = source < 1.5 ? texture(uOrmMap, at)
    : source < 2.5 ? texture(uModelMap, at)
    : source < 3.5 ? texture(uAlbedo, at)
    : texture(uEmissiveMap, at);
  return texel[int(uIridescence[2].z + 0.5)];
}

vec3 iridescentBase(vec3 base, vec3 n, vec2 uv) {
  vec3 toEye = normalize(uCameraPos - vWorldPos);
  vec3 halfway = toEye + uIridescence[0].xyz;
  float span = length(halfway);
  float nh = span > 0.0 ? dot(n, halfway / span) : 0.0;
  float sheen = nh > 0.0 ? clamp(pow(nh, uIridescence[1].x), 0.0, 1.0) : 0.0;
  float nv = dot(n, toEye);
  vec2 own = vUv.xy * uIridescence[3].xy + uIridescence[3].zw;
  float x = nv + own.x + uIridescence[0].w * (sheen - nv);
  float t = clamp(fract(x * uIridescence[1].y), 0.0, 1.0);
  float at = t * 31.0;
  int below = min(int(floor(at)), 30);
  vec3 o = mix(uIridescence[4 + below].rgb, uIridescence[5 + below].rgb, at - float(below));
  vec3 blended = mix(2.0 * base * o, 1.0 - 2.0 * (1.0 - base) * (1.0 - o), step(0.5, base));
  return base + (blended - base) * (x * iridescentMask(uv) * uIridescence[1].z);
}
`;
}
