import { describe, expect, it } from 'vitest';

import { EMISSIVE_FLOW_FLOATS, packEmissiveFlow } from './emissiveFlow.ts';

describe("a material's glow moved and masked", () => {
  /*
   * **What it is for**: a glow repeated with a surface's first layer and drifting across it, held to
   * the cracks by a mask that spans the mesh once. The mask is read at the mesh's own coordinates,
   * which the vertex stage has already scaled and offset, so the second vector undoes that.
   */
  it('PACKS THE SCROLL, THE MASK’S LAYER PLUS ONE, AND THE WAY BACK TO THE MESH’S OWN COORDINATES', () => {
    const out = new Float32Array(EMISSIVE_FLOW_FLOATS);
    const asks = packEmissiveFlow(
      {
        emissiveScroll: [0.02, 0],
        emissiveMaskLayer: 2,
        uScale: 8,
        vScale: 4,
        uOffset: 1,
        vOffset: 2,
      },
      out,
    );
    expect(asks).toBe(true);
    /* A coordinate the vertex stage made, 8 · 0.25 + 1 = 3 across and 4 · 0.5 + 2 = 4 down, comes
       back as (0.25, 0.5): 3/8 − 1/8 and 4/4 − 2/4. */
    expect(Array.from(out)).toEqual([0.02, 0, 3, 0, 0.125, 0.25, -0.125, -0.5].map(Math.fround));
    expect(3 * (out[4] as number) + (out[6] as number)).toBeCloseTo(0.25, 6);
    expect(4 * (out[5] as number) + (out[7] as number)).toBeCloseTo(0.5, 6);
  });

  it('asks for nothing where nothing moves and no layer masks, and layer 0 is a mask', () => {
    const out = new Float32Array(EMISSIVE_FLOW_FLOATS);
    expect(packEmissiveFlow(null, out)).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 1, 1, -0, -0]);
    expect(packEmissiveFlow({ emissiveScroll: [0, 0] }, out)).toBe(false);
    /* A scroll down v alone moves too. */
    expect(packEmissiveFlow({ emissiveScroll: [0, 0.1] }, out)).toBe(true);
    expect(packEmissiveFlow({ emissiveMaskLayer: 0 }, out)).toBe(true);
    expect(out[2]).toBe(1);
    /* A layer that is not a whole number at or above zero is none, and a scroll not a number still. */
    expect(packEmissiveFlow({ emissiveMaskLayer: 1.5 }, out)).toBe(false);
    expect(packEmissiveFlow({ emissiveMaskLayer: -1 }, out)).toBe(false);
    expect(packEmissiveFlow({ emissiveScroll: [Number.NaN, 0] }, out)).toBe(false);
    /* A scale of zero has no inverse; the mesh's own coordinate is then taken as zero. */
    packEmissiveFlow({ emissiveMaskLayer: 0, uScale: 0 }, out);
    expect([out[4], out[6]]).toEqual([0, 0]);
  });
});
