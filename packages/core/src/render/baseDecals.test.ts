import { describe, expect, it } from 'vitest';

import {
  BASE_DECAL_FLOATS,
  BASE_DECAL_TILE,
  MAX_BASE_DECALS,
  packBaseDecals,
} from './baseDecals.ts';
import type { BaseDecal } from './baseDecals.ts';
import { fixtureAtlasLayout } from './fixtureAtlas.ts';
import { IES_ATLAS_WIDTH } from './iesProfile.ts';
import { COOKIE_TILE } from './lightBudget.ts';

/** A mark on the ground at (2, 0, 3): a metre across, half a metre up, projected straight down. */
const FLOOR: BaseDecal = {
  center: [2, 0, 3],
  halfExtents: [1, 0.5, 0.25],
  forward: [0, -1, 0],
  up: [0, 0, 1],
  image: 1,
};

describe('decals laid into the base colour', () => {
  /*
   * **The box as the lit stage reads it**: three rows taking a world point into [-1, 1] on each
   * axis, x across, y up the image, z along the projection. Down with +z up, across is up × forward,
   * (0, 0, 1) × (0, −1, 0) = (1, 0, 0). A point at the centre comes out at the origin; one a metre
   * along +x at the edge across; one 0.5 m along +z at the image's top; one 0.25 m below at the far
   * end of the projection.
   */
  it('PACKS EACH BOX AS THE ROWS THAT TAKE A WORLD POINT INTO ITS UNIT BOX, AND ITS IMAGE', () => {
    const out = new Float32Array(BASE_DECAL_FLOATS);
    expect(packBaseDecals([FLOOR], 2, 128, out)).toBeNull();
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 128, BASE_DECAL_TILE, 0]);
    const local = (p: [number, number, number]): number[] =>
      [0, 1, 2].map(
        (row) =>
          (out[4 + row * 4] as number) * p[0] +
          (out[5 + row * 4] as number) * p[1] +
          (out[6 + row * 4] as number) * p[2] +
          (out[7 + row * 4] as number),
      );
    expect(local([2, 0, 3])).toEqual([0, 0, 0]);
    expect(local([3, 0, 3])).toEqual([1, 0, 0]);
    expect(local([2, 0, 3.5])).toEqual([0, 1, 0]);
    expect(local([2, -0.25, 3])).toEqual([0, 0, 1]);
    /* The image, the opacity it lands at and the facing it asks: 1, and 0.2 by default. */
    expect(Array.from(out.subarray(16, 20))).toEqual([1, 1, Math.fround(0.2), 0]);
  });

  /*
   * **Turned 45° about the vertical**, so no term of the rows is zero and a row read as a column
   * would show. Up (1, 0, 1)/√2 and down give across = up × forward = (1, 0, −1)/√2 and up again
   * forward × across = (1, 0, 1)/√2: a point two metres along across comes out at the edge across,
   * half a metre along up at the image's top.
   */
  it('takes a turned box into its unit box by its own axes', () => {
    const out = new Float32Array(BASE_DECAL_FLOATS);
    const r = Math.SQRT1_2;
    packBaseDecals(
      [{ ...FLOOR, center: [0, 0, 0], halfExtents: [2, 0.5, 0.25], up: [1, 0, 1] }],
      2,
      0,
      out,
    );
    const local = (p: [number, number, number]): number[] =>
      [0, 1, 2].map(
        (row) =>
          (out[4 + row * 4] as number) * p[0] +
          (out[5 + row * 4] as number) * p[1] +
          (out[6 + row * 4] as number) * p[2] +
          (out[7 + row * 4] as number),
      );
    const across = local([2 * r, 0, -2 * r]);
    const up = local([0.5 * r, 0, 0.5 * r]);
    [1, 0, 0].forEach((v, i) => expect(across[i]).toBeCloseTo(v, 6));
    [0, 1, 0].forEach((v, i) => expect(up[i]).toBeCloseTo(v, 6));
  });

  it('leaves out what it cannot lay, says why, and packs the rest in order', () => {
    const out = new Float32Array(BASE_DECAL_FLOATS);
    const many = Array.from({ length: MAX_BASE_DECALS + 2 }, () => FLOOR);
    expect(packBaseDecals(many, 2, 0, out)).toMatch(/10 base decals; a frame lays the first 8/);
    expect(out[0]).toBe(MAX_BASE_DECALS);
    expect(packBaseDecals([{ ...FLOOR, image: 2 }, FLOOR], 2, 0, out)).toMatch(
      /lays image 2 and there are 2/,
    );
    expect(out[0]).toBe(1);
    expect(packBaseDecals([{ ...FLOOR, halfExtents: [0, 1, 1] }], 2, 0, out)).toMatch(
      /halfExtents must be positive/,
    );
    expect(out[0]).toBe(0);
    /* Opacity held to 0 to 1. */
    packBaseDecals([{ ...FLOOR, opacity: 3 }], 2, 0, out);
    expect(out[17]).toBe(1);
  });
});

describe('the fixture atlas with decal images in it', () => {
  /*
   * Cookies are found from the top and profiles from the bottom, so a band between them moves
   * neither lookup: the decals' images start where the cookies end and the profiles start after.
   */
  it('PUTS THE DECALS’ BAND BETWEEN THE COOKIES AND THE PROFILES', () => {
    const layout = fixtureAtlasLayout(3, 2, 5);
    expect(layout.decalTop).toBe(COOKIE_TILE);
    expect(layout.decalRows).toBe(BASE_DECAL_TILE);
    expect(layout.iesTop).toBe(COOKIE_TILE + BASE_DECAL_TILE);
    expect(layout.height).toBe(COOKIE_TILE + BASE_DECAL_TILE + 3);
    expect(layout.width).toBe(Math.max(IES_ATLAS_WIDTH, 5 * BASE_DECAL_TILE));
    /* None asked, and the atlas is as it was. */
    expect(fixtureAtlasLayout(3, 2)).toMatchObject({ decalRows: 0, iesTop: COOKIE_TILE });
  });
});
