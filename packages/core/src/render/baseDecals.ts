/**
 * Decals laid into the base colour of what they land on, before it is lit: `setBaseDecals` and
 * `setBaseDecalImages`, packed into `uBaseDecals` for the lit stage's `BASE_DECALS` switch.
 *
 * **What they are for, and why `DecalProjector` is not it.** A projected decal multiplies the
 * finished pixel, so where the surface under it glows, a lettered floor or a lit panel, the mark
 * dims the glow too. A shadow a body throws on a lit floor, a footprint, a stain is a change in what
 * the surface *is*: it darkens the colour light falls on and leaves what the surface emits, how
 * rough it is and its normal as they are. So each of these is a box, as a `DecalBox` is, an image
 * read across its face, and the base colour moved toward the image's colour by its alpha.
 *
 * **The images ride in the fixture atlas**, a band of `BASE_DECAL_TILE` squares between the cookies
 * and the photometric profiles (`fixtureAtlas.ts`), because the lit stage has no texture binding
 * left (`textureUnitBudget.test.ts`). An image is that square, read as a picture: its colour is
 * decoded from sRGB and its alpha is as it is. Rewriting them once a frame is the use they are for,
 * and costs an upload of the squares; changing how many there are builds the atlas again.
 *
 * **What it gives up**: eight a frame, the uniforms they take being the limit (thirty-four vectors,
 * so WebGL2 refuses them, in words, on a part whose lit stage has no room); the GPU-driven pipeline
 * does not draw them; and a surface opts out by its material (`receivesDecals: false`), not by a
 * mask of what each decal may mark.
 */
import { worldToDecalMatrix, type DecalBox } from './decalProjector.ts';

/** Decals a frame. */
export const MAX_BASE_DECALS = 8;
/** Texels across an image's square in the atlas. */
export const BASE_DECAL_TILE = 128;
/** Floats in `uBaseDecals`: a header, then four vectors a decal. */
export const BASE_DECAL_FLOATS = (1 + MAX_BASE_DECALS * 4) * 4;

/** One decal: a box, which image it lays, and how much. */
export interface BaseDecal extends DecalBox {
  /** Which of `setBaseDecalImages`' images it lays, from 0. */
  readonly image: number;
  /** How much of the image's alpha lands, 0 to 1. Default 1. */
  readonly opacity?: number;
  /**
   * How far from facing back along `forward` a surface may be turned and still be marked, as a
   * cosine of the geometric normal against it. Default 0.2, so a floor is marked and the side of a
   * step it stands on is not smeared. -1 marks every surface in the box.
   */
  readonly facingCos?: number;
}

const MATRIX = new Float32Array(16);

/**
 * Pack `decals` against `images` laid in the atlas band starting at row `bandTop` into `out`, and
 * return why one was left out, or null where none was: past the eighth, an image there is none of,
 * or a box with no size or no orientation. The rest are packed in order.
 */
export function packBaseDecals(
  decals: readonly BaseDecal[],
  images: number,
  bandTop: number,
  out: Float32Array,
): string | null {
  out.fill(0);
  let refusal: string | null =
    decals.length > MAX_BASE_DECALS
      ? `${decals.length} base decals; a frame lays the first ${MAX_BASE_DECALS}`
      : null;
  let kept = 0;
  for (let i = 0; i < decals.length && kept < MAX_BASE_DECALS; i++) {
    const decal = decals[i] as BaseDecal;
    if (!(Number.isInteger(decal.image) && decal.image >= 0 && decal.image < images)) {
      refusal ??= `a base decal lays image ${decal.image} and there are ${images}`;
      continue;
    }
    try {
      worldToDecalMatrix(MATRIX, decal);
    } catch (cause) {
      refusal ??= cause instanceof Error ? cause.message : String(cause);
      continue;
    }
    const at = 4 + kept * 16;
    for (let row = 0; row < 3; row++) {
      out[at + row * 4] = MATRIX[row] as number;
      out[at + row * 4 + 1] = MATRIX[4 + row] as number;
      out[at + row * 4 + 2] = MATRIX[8 + row] as number;
      out[at + row * 4 + 3] = MATRIX[12 + row] as number;
    }
    out[at + 12] = decal.image;
    out[at + 13] = Math.min(1, Math.max(0, decal.opacity ?? 1));
    out[at + 14] = decal.facingCos ?? 0.2;
    kept += 1;
  }
  out[0] = kept;
  out[1] = bandTop;
  out[2] = BASE_DECAL_TILE;
  return refusal;
}
