/**
 * A surface's iridescent overlay: a hue that shifts with the view, laid over the base colour before
 * it is lit. `SurfaceMaterial.iridescentOverlay`, packed into `uIridescence` for the lit stage's
 * `IRIDESCENT_OVERLAY` switch, and the same arithmetic on the CPU, which the tests hold the shader to.
 *
 * Per pixel, with `N` the mapped normal, `V` toward the eye and `uv` the mesh's own first
 * coordinates, as many material systems shade a sheen on cloth or a coat:
 *
 *     h = saturate((N·H)^contrast), 0 where N·H ≤ 0, H = normalize(V + direction)
 *     x = N·V + uv.x + blend · (h − N·V)
 *     t = saturate(fract(x · tiling))
 *     base' = base + (overlay(base, ramp(t)) − base) · x · mask · weight
 *
 * where `overlay` is the usual blend, `a < ½ ? 2ao : 1 − 2(1 − a)(1 − o)` per channel.
 *
 * **The ramp is uniforms, thirty-two colours, and not a texture**, because the lit stage has no
 * texture binding left (`textureUnitBudget.test.ts`): a caller's ramp of any length is resampled to
 * thirty-two on the way in and read back between neighbours. What that gives up is a ramp with
 * detail finer than a thirty-second of its length, which a smooth spectrum does not have. **The
 * mask is a channel of a layer of one of the material's own arrays**, for the same reason, read at
 * the material's coordinates; alpha is linear in every array, and a colour channel of an sRGB array
 * is decoded before it is read.
 *
 * Thirty-six vectors, so WebGL2 refuses it, in words, on a part whose lit stage has no room, as it
 * refuses a material's tiled detail.
 */
/** Three numbers, read and never written. */
type Three = readonly [number, number, number];

/** Colours the ramp is resampled to. */
export const IRIDESCENT_RAMP = 32;
/** Floats in `uIridescence`: four vectors of numbers, then the ramp a vector a colour. */
export const IRIDESCENT_FLOATS = (4 + IRIDESCENT_RAMP) * 4;

/** Which of a material's arrays holds the mask. */
export type IridescentMaskMap = 'orm' | 'model' | 'albedo' | 'emissive';

/** `SurfaceMaterial.iridescentOverlay`. */
export interface IridescentOverlay {
  /**
   * The overlay colour along `t`, linear, three floats a colour, at least two colours, the first at
   * `t = 0` and the last at `t = 1`. Resampled to thirty-two.
   */
  readonly ramp: ArrayLike<number>;
  /** A fixed direction in the world the sheen turns toward, `S`. Need not be unit length. */
  readonly direction: Three;
  /** How far the view's term is turned toward the sheen, 0 to 1. Default 0.6. */
  readonly blend?: number;
  /** The sheen's exponent. Default 1. */
  readonly contrast?: number;
  /** How many times the ramp repeats across `x`. Default 2. */
  readonly tiling?: number;
  /** How much of the overlay is laid on. Default 0.25. */
  readonly weight?: number;
  /** Where it is laid: a channel of a layer of one of the material's arrays. Absent, everywhere. */
  readonly mask?: {
    readonly map: IridescentMaskMap;
    readonly layer: number;
    /** 0 red, 1 green, 2 blue, 3 alpha. */
    readonly channel: 0 | 1 | 2 | 3;
  } | null;
}

const MASK_SOURCE: Readonly<Record<IridescentMaskMap, number>> = {
  orm: 1,
  model: 2,
  albedo: 3,
  emissive: 4,
};

/** Why an overlay cannot be drawn, or null where it can. */
export function iridescentRefusal(overlay: IridescentOverlay): string | null {
  const values = overlay.ramp.length;
  if (values < 6 || values % 3 !== 0) {
    return `a ramp of ${values} numbers; it is three a colour, at least two colours`;
  }
  const [x, y, z] = overlay.direction;
  if (
    !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) ||
    x * x + y * y + z * z === 0
  ) {
    return 'a direction that is not one';
  }
  const mask = overlay.mask ?? null;
  if (mask !== null && !(Number.isInteger(mask.layer) && mask.layer >= 0)) {
    return `a mask layer of ${mask.layer}; a layer is a whole number from 0`;
  }
  return null;
}

/**
 * Pack an overlay into `out`, with the scale and offset that take the material's coordinates back
 * to the mesh's own; all zeros, which the shader reads as none, for null. Refuse what
 * `iridescentRefusal` refuses before calling this.
 */
export function packIridescentOverlay(
  overlay: IridescentOverlay | null,
  uv: { uScale?: number; vScale?: number; uOffset?: number; vOffset?: number },
  out: Float32Array,
): void {
  out.fill(0);
  if (overlay === null) return;
  const [x, y, z] = overlay.direction;
  const length = Math.hypot(x, y, z);
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
  out[3] = overlay.blend ?? 0.6;
  out[4] = overlay.contrast ?? 1;
  out[5] = overlay.tiling ?? 2;
  out[6] = overlay.weight ?? 0.25;
  /* On: a zero here, which an unwritten block is, is none. */
  out[7] = 1;
  const mask = overlay.mask ?? null;
  out[8] = mask === null ? 0 : MASK_SOURCE[mask.map];
  out[9] = mask === null ? 0 : mask.layer;
  out[10] = mask === null ? 0 : mask.channel;
  const uScale = uv.uScale ?? 1;
  const vScale = uv.vScale ?? 1;
  out[12] = uScale === 0 ? 0 : 1 / uScale;
  out[13] = vScale === 0 ? 0 : 1 / vScale;
  out[14] = uScale === 0 ? 0 : -(uv.uOffset ?? 0) / uScale;
  out[15] = vScale === 0 ? 0 : -(uv.vOffset ?? 0) / vScale;
  /* The ramp, resampled to thirty-two colours between its own neighbours. */
  const colours = overlay.ramp.length / 3;
  for (let i = 0; i < IRIDESCENT_RAMP; i++) {
    const at = (i / (IRIDESCENT_RAMP - 1)) * (colours - 1);
    const below = Math.min(Math.floor(at), colours - 2);
    const share = at - below;
    for (let c = 0; c < 3; c++) {
      const a = overlay.ramp[below * 3 + c] as number;
      const b = overlay.ramp[(below + 1) * 3 + c] as number;
      out[16 + i * 4 + c] = a + (b - a) * share;
    }
  }
}

/**
 * The base colour with the overlay laid on, as the lit stage computes it from a packed block: `n`
 * and `toEye` unit length, `uv` the mesh's own coordinates, `mask` the texel's channel. Into `out`.
 */
export function iridescentBase(
  packed: ArrayLike<number>,
  base: Three,
  n: Three,
  toEye: Three,
  uv: readonly [number, number],
  mask: number,
  out: [number, number, number],
): [number, number, number] {
  const p = (i: number): number => packed[i] as number;
  let hx = toEye[0] + p(0);
  let hy = toEye[1] + p(1);
  let hz = toEye[2] + p(2);
  const hl = Math.hypot(hx, hy, hz) || 1;
  hx /= hl;
  hy /= hl;
  hz /= hl;
  const nh = n[0] * hx + n[1] * hy + n[2] * hz;
  const h = nh > 0 ? Math.min(1, Math.max(0, nh ** p(4))) : 0;
  const nv = n[0] * toEye[0] + n[1] * toEye[1] + n[2] * toEye[2];
  const x = nv + uv[0] + p(3) * (h - nv);
  const scaled = x * p(5);
  const t = Math.min(1, Math.max(0, scaled - Math.floor(scaled)));
  const at = t * (IRIDESCENT_RAMP - 1);
  const below = Math.min(Math.floor(at), IRIDESCENT_RAMP - 2);
  const share = at - below;
  const amount = x * mask * p(6);
  for (let c = 0; c < 3; c++) {
    const o0 = p(16 + below * 4 + c);
    const o = o0 + (p(16 + (below + 1) * 4 + c) - o0) * share;
    const a = base[c] as number;
    const blended = a < 0.5 ? 2 * a * o : 1 - 2 * (1 - a) * (1 - o);
    out[c] = a + (blended - a) * amount;
  }
  return out;
}
