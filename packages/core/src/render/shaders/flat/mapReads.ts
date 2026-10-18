/**
 * Where each of a material's maps is read: a layered material's blend (`layered.ts`), the three
 * planes of a triplanar projection (`worldUv.ts`), or the map itself at the surface's coordinates.
 *
 * **Functions rather than branches in `main`, for the bundle's sake.** The generated WGSL stores an
 * item once however many of the sixteen permutations share it, and `main` differs in every one, so
 * a line there is paid sixteen times and a line here once. Called from the same uniform branches the
 * reads stood in, so their implicit levels are as legal as they were: AGENTS.md 2026-08-07.
 */
export const MAP_READS_GLSL = /* glsl */ `
/* The surface's coordinates moved onto the world's horizontal plane where a material projects them,
   with the frame's coordinates and the mesh's tangents, which no longer run along them, set aside. */
void projectSurface(inout vec3 at, inout vec2 frameAt, inout int frameTangents) {
  if (WORLD_UVS && projected()) {
    at.xy = planarAt();
    frameAt = at.xy;
    frameTangents = 0;
  }
}

vec4 albedoTexel(vec3 at) {
  if (LAYERED && layered()) return layeredAlbedo();
  if (WORLD_UVS && triplanar()) return triplanarAlbedo(at.z);
  return texture(uAlbedo, at);
}

vec3 ormTexel(vec3 at) {
  if (LAYERED && layered()) return layeredOrm();
  if (WORLD_UVS && triplanar()) return triplanarOrm(at.z);
  return texture(uOrmMap, at).rgb;
}

/* The emissive map, moved by its scroll wherever it is read: emissiveFlow.ts. Behind its switch,
   which a WebGPU pipeline built before a material asked has off, so the mask and the scroll come
   on together rather than the scroll a few frames ahead. */
vec3 emissiveTexel(vec3 at) {
  vec2 shift = EMISSIVE_FLOW ? emissiveShift() : vec2(0.0);
  if (LAYERED && layered() && layeredGlows()) return layeredEmissive(shift);
  if (WORLD_UVS && triplanar()) return triplanarEmissive(at.z, shift);
  return texture(uEmissiveMap, vec3(at.xy + shift, at.z)).rgb;
}
`;
