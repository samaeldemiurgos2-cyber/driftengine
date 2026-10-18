/**
 * A material's glow moved and masked: `SurfaceMaterial.emissiveScroll` and `emissiveMaskLayer`,
 * packed into `uEmissiveFlow` for the lit stage's `EMISSIVE_FLOW` switch. Both backends pack it
 * here and only upload it, so they cannot disagree about which layer a mask is.
 *
 * **What it is for**: lava in a rock's cracks, a sign's lettering, a glow repeated with a surface's
 * first layer and drifting across it, held to where the surface glows by a map that spans the mesh
 * once. Folded into each vertex's emission instead, the glow spreads across whole faces of a coarse
 * mesh where it should follow the cracks.
 *
 * **The mask is the alpha of a layer of the emissive map's own array**, read at the mesh's first
 * coordinates as they are, before the material's repeat, offset, layers or projection: alpha is
 * never decoded as sRGB, so it is the number it was written as in either colour space, and no
 * texture binding is spent, since the lit stage has none left (`textureUnitBudget.test.ts`). What
 * that gives up is a mask of its own size: a layer of an array is the array's size.
 *
 * **The scroll moves the emissive map alone**, by `Environment.surfaceTime`, in its own repeats a
 * second, wrapped to one so a long-running clock keeps its precision; the albedo and every other map
 * stay where they are.
 */

/**
 * Floats in `uEmissiveFlow`: the scroll on u and v, the mask's layer plus one (0, none) and one
 * unused; then the scale and offset that take the material's coordinates back to the mesh's own.
 */
export const EMISSIVE_FLOW_FLOATS = 8;

/** What a material says about its glow's flow, and the repeat and offset its coordinates carry. */
export interface EmissiveFlowMaterial {
  readonly emissiveScroll?: readonly [number, number] | null;
  readonly emissiveMaskLayer?: number | null;
  readonly uScale?: number;
  readonly vScale?: number;
  readonly uOffset?: number;
  readonly vOffset?: number;
}

/**
 * Pack a material's flow into `out` and say whether it asks for one: a scroll that moves, or a mask
 * that is a whole layer. A scroll that is not a number is still; a layer that is not a whole number
 * at or above zero is no mask.
 */
export function packEmissiveFlow(
  material: EmissiveFlowMaterial | null,
  out: Float32Array,
): boolean {
  const scroll = material?.emissiveScroll ?? null;
  const u = scroll !== null && Number.isFinite(scroll[0]) ? scroll[0] : 0;
  const v = scroll !== null && Number.isFinite(scroll[1]) ? scroll[1] : 0;
  const layer = material?.emissiveMaskLayer ?? null;
  const masked = layer !== null && Number.isInteger(layer) && layer >= 0;
  out[0] = u;
  out[1] = v;
  /* Plus one, so an unwritten zero is no mask rather than a mask of layer 0. */
  out[2] = masked ? layer + 1 : 0;
  out[3] = 0;
  /* The vertex stage laid `uv · scale + offset`; this undoes it. A scale of zero has no inverse,
     and every texel of such a surface is the one coordinate, so the mesh's own is taken as 0. */
  const uScale = material?.uScale ?? 1;
  const vScale = material?.vScale ?? 1;
  out[4] = uScale === 0 ? 0 : 1 / uScale;
  out[5] = vScale === 0 ? 0 : 1 / vScale;
  out[6] = uScale === 0 ? 0 : -(material?.uOffset ?? 0) / uScale;
  out[7] = vScale === 0 ? 0 : -(material?.vOffset ?? 0) / vScale;
  return u !== 0 || v !== 0 || masked;
}
