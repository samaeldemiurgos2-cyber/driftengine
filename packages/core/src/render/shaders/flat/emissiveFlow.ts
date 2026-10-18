/**
 * A material's glow moved and masked: `SurfaceMaterial.emissiveScroll` and `emissiveMaskLayer`,
 * packed into `uEmissiveFlow` by `emissiveFlow.ts`, where what each gives up is said.
 *
 * **The scroll** is added to wherever the emissive map is read, the mesh's coordinates, a layer's
 * place or a projection's planes, as its own repeats a second times the surface clock, wrapped to
 * one repeat. **The mask** is the alpha of a layer of the emissive map's own array at the mesh's
 * first coordinates as they are: the vertex stage has already laid the material's repeat and offset
 * on `vUv`, so the second vector holds their inverse, which gives the mesh's own back.
 *
 * **A lit switch, `EMISSIVE_FLOW`**, off until a material first asks, declared after
 * `SURFACE_DETAIL` so each switch before it keeps its id. Compiled out, its two vectors are not
 * declared and the shift and the mask are constants.
 */
export function emissiveFlowGlsl(on: boolean): string {
  if (!on) {
    return /* glsl */ `
const bool EMISSIVE_FLOW = false;  // wgsl:override
vec2 emissiveShift() { return vec2(0.0); }
float emissiveMask() { return 1.0; }
`;
  }
  return /* glsl */ `
/* Whether this program moves and masks a material's glow. Off but where one has asked. */
const bool EMISSIVE_FLOW = true;  // wgsl:override
/*
 * Two vectors, as emissiveFlow.ts packs them: the scroll in repeats a second on u and v (x y) and
 * the mask's layer of the emissive array plus one, 0 for none (z); then what takes the material's
 * coordinates back to the mesh's own, a scale (x y) and an offset (z w).
 */
uniform vec4 uEmissiveFlow[2]; // wgsl:material

/* The emissive map's coordinates moved by the clock, wrapped to one repeat for precision. */
vec2 emissiveShift() {
  return fract(uEmissiveFlow[0].xy * uSurfaceScene.x);
}

/* The mask's alpha at the mesh's own coordinates, under the branch on a bound emissive map. */
float emissiveMask() {
  if (uEmissiveFlow[0].z < 0.5) return 1.0;
  vec2 own = vUv.xy * uEmissiveFlow[1].xy + uEmissiveFlow[1].zw;
  return texture(uEmissiveMap, vec3(own, uEmissiveFlow[0].z - 1.0)).a;
}
`;
}
