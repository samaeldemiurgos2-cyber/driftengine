import { describe, expect, it } from 'vitest';

import {
  IRIDESCENT_FLOATS,
  IRIDESCENT_RAMP,
  iridescentBase,
  iridescentRefusal,
  packIridescentOverlay,
} from './iridescentOverlay.ts';
import type { IridescentOverlay } from './iridescentOverlay.ts';

/** Black to white: a ramp whose colour at `t` is `t`, so the hand arithmetic can read it off. */
const GREY: IridescentOverlay = { ramp: [0, 0, 0, 1, 1, 1], direction: [0, 0, 1] };

function packed(overlay: IridescentOverlay): Float32Array {
  const out = new Float32Array(IRIDESCENT_FLOATS);
  packIridescentOverlay(overlay, {}, out);
  return out;
}

describe("a surface's iridescent overlay", () => {
  /*
   * **Head on, with the sheen behind the eye.** N, V and S all along z, so H is too: N·H = 1, the
   * sheen h = 1, and x = N·V + u + blend · (h − N·V) = 1 + 0.1 + 0 = 1.1. Twice across, t is the
   * fraction of 2.2, 0.2, and the grey ramp gives 0.2. Laid on by x · mask · weight = 0.275: a
   * channel of 0.2 overlays to 2 · 0.2 · 0.2 = 0.08 and moves to 0.2 − 0.12 · 0.275 = 0.167; 0.5 is
   * past the half and overlays to 1 − 2 · 0.5 · 0.8 = 0.2, moving to 0.4175; 0.8 overlays to
   * 1 − 2 · 0.2 · 0.8 = 0.68 and moves to 0.767.
   */
  it('LAYS THE RAMP OVER THE BASE BY THE VIEW, THE SHEEN AND THE MESH’S OWN U', () => {
    const out: [number, number, number] = [0, 0, 0];
    iridescentBase(packed(GREY), [0.2, 0.5, 0.8], [0, 0, 1], [0, 0, 1], [0.1, 0], 1, out);
    expect(out[0]).toBeCloseTo(0.167, 6);
    expect(out[1]).toBeCloseTo(0.4175, 6);
    expect(out[2]).toBeCloseTo(0.767, 6);
  });

  /*
   * **The sheen turned away is none.** N along x, V along z, S along −x: H is (−1, 0, 1)/√2 and
   * N·H is −0.707, so h is 0 and not 0.707 raised to anything. N·V is 0, so x is u alone, 0.25, and
   * t is 0.5. A red-to-blue ramp gives (0.5, 0, 0.5) there: red and blue overlay 0.2 to itself and
   * green overlays it to 0, moving by 0.2 · x · mask · weight = 0.2 · 0.0625 to 0.1875.
   */
  it('takes no sheen where N·H is at or below zero', () => {
    const out: [number, number, number] = [0, 0, 0];
    const turned = packed({ ramp: [1, 0, 0, 0, 0, 1], direction: [-1, 0, 0] });
    iridescentBase(turned, [0.2, 0.2, 0.2], [1, 0, 0], [0, 0, 1], [0.25, 0], 1, out);
    expect(out[0]).toBeCloseTo(0.2, 6);
    expect(out[1]).toBeCloseTo(0.1875, 6);
    expect(out[2]).toBeCloseTo(0.2, 6);
  });

  /*
   * A sheen at N·H = 0.707 with a contrast of 2 is 0.5; x = 1 + 0 + 0.6 · (0.5 − 1) = 0.7, once
   * across, so t = 0.7 and the grey ramp 0.7; half masked and wholly weighted, 0.35 of the way:
   * 0.3 overlays to 0.42 and moves to 0.342.
   */
  it('raises the sheen to its contrast and scales by the mask and the weight', () => {
    const out: [number, number, number] = [0, 0, 0];
    const lit = packed({ ...GREY, direction: [1, 0, 0], contrast: 2, tiling: 1, weight: 1 });
    iridescentBase(lit, [0.3, 0.3, 0.3], [0, 0, 1], [0, 0, 1], [0, 0], 0.5, out);
    expect(out[0]).toBeCloseTo(0.342, 5);
  });

  it('packs the numbers, the mask and the way back to the mesh’s own coordinates, ramp last', () => {
    const out = new Float32Array(IRIDESCENT_FLOATS);
    packIridescentOverlay(
      {
        ramp: [0, 0, 0, 1, 1, 1, 0, 0, 0],
        direction: [2, 3, 6],
        blend: 0.5,
        contrast: 3,
        tiling: 4,
        weight: 0.1,
        mask: { map: 'model', layer: 2, channel: 3 },
      },
      { uScale: 4, uOffset: 1 },
      out,
    );
    expect(Array.from(out.subarray(0, 16))).toEqual(
      [2 / 7, 3 / 7, 6 / 7, 0.5, 3, 4, 0.1, 1, 2, 2, 3, 0, 0.25, 1, -0.25, -0].map(Math.fround),
    );
    /* Up and down again: the ends are the ramp's ends, and the middle pair straddles its peak. */
    expect(out[16]).toBe(0);
    expect(out[16 + (IRIDESCENT_RAMP - 1) * 4]).toBe(0);
    expect(out[16 + 15 * 4]).toBeCloseTo(Math.fround(30 / 31), 6);
    /* None is all zeros, which the shader reads as off. */
    packIridescentOverlay(null, {}, out);
    expect(out.every((value) => value === 0)).toBe(true);
  });

  it('refuses a ramp that is not colours, a direction that is not one, and a layer that is not', () => {
    expect(iridescentRefusal({ ...GREY, ramp: [0, 0, 0, 1, 1] })).toMatch(/ramp of 5 numbers/);
    expect(iridescentRefusal({ ...GREY, ramp: [0, 0, 0] })).toMatch(/at least two colours/);
    expect(iridescentRefusal({ ...GREY, direction: [0, 0, 0] })).toMatch(/direction/);
    expect(iridescentRefusal({ ...GREY, mask: { map: 'orm', layer: -1, channel: 0 } })).toMatch(
      /mask layer of -1/,
    );
    expect(iridescentRefusal(GREY)).toBeNull();
  });
});
