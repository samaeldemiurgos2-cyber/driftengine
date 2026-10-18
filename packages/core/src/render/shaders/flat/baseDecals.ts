/**
 * Decals laid into a surface's base colour before it is lit: `setBaseDecals`, packed into
 * `uBaseDecals` by `baseDecals.ts`, where what they are for and what they give up is said, and the
 * material's own refusal in `uDecalReceiver` (`SurfaceMaterial.receivesDecals`).
 *
 * **Each decal is a test and a fetch**: the world point taken into the box by three rows, outside
 * it or turned too far from the projection and nothing, else the image read across the box's face
 * from its square in the fixture atlas, its colour decoded from sRGB and laid over the base colour
 * by its alpha and the decal's opacity. The geometric normal decides the facing, so a normal map's
 * bump does not cut a mark. The loop is over a count in a uniform and the fetch is `textureLod`, as
 * every read of the atlas is, so neither needs uniform control flow: AGENTS.md 2026-08-07.
 *
 * **A lit switch, `BASE_DECALS`**, off until a frame first lays one, declared after
 * `IRIDESCENT_OVERLAY` so each switch before it keeps its id. Compiled out, its thirty-four vectors
 * are not declared and the call is a constant.
 */
export function baseDecalsGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool BASE_DECALS = false;  // wgsl:override
vec3 baseDecals(vec3 base, vec3 world, vec3 geometric) { return base; }
`;
  }
  return /* glsl */ `
/* Whether this program lays decals into base colours. Off but where a frame has laid one. */
const bool BASE_DECALS = true;  // wgsl:override
/*
 * A header, how many decals, the atlas row their band starts at and its squares' side (0); then
 * four vectors a decal, eight decals: the three rows taking a world point into its box, x across,
 * y up the image, z along the projection, and its image, opacity and facing cosine.
 */
uniform vec4 uBaseDecals[33]; // wgsl:material
/* x 1 where the material refuses decals, so an unwritten zero receives them. */
uniform vec4 uDecalReceiver; // wgsl:material

vec3 decalLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 baseDecals(vec3 base, vec3 world, vec3 geometric) {
  if (uDecalReceiver.x > 0.5) return base;
  int count = int(uBaseDecals[0].x + 0.5);
  vec2 atlas = vec2(textureSize(uFixtureAtlas, 0));
  float span = uBaseDecals[0].z;
  /* Half a texel of a square, so a bilinear read at its edge cannot reach the next one. */
  float inset = 0.5 / span;
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    vec4 across = uBaseDecals[1 + i * 4];
    vec4 up = uBaseDecals[2 + i * 4];
    vec4 along = uBaseDecals[3 + i * 4];
    vec4 laid = uBaseDecals[4 + i * 4];
    vec3 local = vec3(
      dot(across.xyz, world) + across.w,
      dot(up.xyz, world) + up.w,
      dot(along.xyz, world) + along.w
    );
    if (any(greaterThan(abs(local), vec3(1.0)))) continue;
    if (dot(geometric, -normalize(along.xyz)) < laid.z) continue;
    vec2 face = vec2(local.x, -local.y) * 0.5 + 0.5;
    vec2 at = vec2(
      (laid.x + clamp(face.x, inset, 1.0 - inset)) * span / atlas.x,
      (uBaseDecals[0].y + clamp(face.y, inset, 1.0 - inset) * span) / atlas.y
    );
    vec4 texel = textureLod(uFixtureAtlas, at, 0.0);
    base = mix(base, decalLinear(texel.rgb), clamp(texel.a * laid.y, 0.0, 1.0));
  }
  return base;
}
`;
}
