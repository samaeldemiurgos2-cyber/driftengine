import { describe, expect, it } from 'vitest';

import { createBounds } from '../math/bounds.ts';
import {
  poseBounds,
  reachOf,
  validatePointSkin,
  validatePointSkinRange,
  validatePose,
  widenReach,
} from './pointSkin.ts';
import type { PointSkinData } from './pointSkin.ts';

/*
 * Two vertices on two joints, posed by hand. Joint 0 is moved to (1, 2, 3) and turns nothing; joint
 * 1 sits at the origin, scaled by 2. Vertex 0 is (1, 0, 0) on joint 0 alone: posed, (2, 2, 3).
 * Vertex 1 is half (0, 1, 0) on joint 1 and half (0, 0, 1) on joint 0: posed, half (0, 2, 0) and
 * half (1, 2, 4), which is (0.5, 2, 2).
 */
const skin: PointSkinData = {
  joints: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0]),
  weights: new Float32Array([1, 0, 0, 0, 0.5, 0.5, 0, 0]),
  points: new Float32Array([
    1, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  ]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1]),
};
const pose = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1,
]);

describe('a point skin', () => {
  it("KEEPS EVERY POSED VERTEX INSIDE A BOX OF EACH JOINT'S REACH, WITHOUT SEEING ONE", () => {
    const reach = reachOf(skin);
    expect(reach.joints).toBe(2);
    /* The 9s are an influence of weight 0, which reaches nothing. */
    expect(Array.from(reach.reach)).toEqual([1, 1]);
    const bounds = createBounds();
    poseBounds(pose, reach, bounds);
    /* Joint 0: a sphere of 1 about (1, 2, 3). Joint 1: a sphere of 1 · 2 about the origin. */
    expect(Array.from(bounds.min)).toEqual([-2, -2, -2]);
    expect(Array.from(bounds.max)).toEqual([2, 3, 4]);
    for (const posed of [
      [2, 2, 3],
      [0.5, 2, 2],
    ]) {
      posed.forEach((value, axis) => {
        expect(value).toBeGreaterThanOrEqual(bounds.min[axis] as number);
        expect(value).toBeLessThanOrEqual(bounds.max[axis] as number);
      });
    }
    expect(Array.from(bounds.centre)).toEqual([0, 0.5, 1]);
  });

  it('widens the box by the most a vertex weighs, where weights sum past one', () => {
    const heavy = { ...skin, weights: new Float32Array([2, 0, 0, 0, 0.5, 0.5, 0, 0]) };
    const reach = reachOf(heavy);
    expect(reach.sums).toEqual([1, 2]);
    const bounds = createBounds();
    poseBounds(pose, reach, bounds);
    /* Vertex 0 posed is 2 · (2, 2, 3) = (4, 4, 6), past the unscaled box. */
    expect(Array.from(bounds.max)).toEqual([4, 6, 8]);
    expect(Array.from(bounds.min)).toEqual([-4, -4, -4]);
  });

  it('names its first joint whatever it weighs, since that joint turns the normal', () => {
    /* Its own weights: a spread shares the array, and zeroing it would change every test after. */
    const silent = {
      ...skin,
      joints: new Float32Array([0, 0, 0, 0, 3, 1, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0, 0, 0.5, 0, 0]),
    };
    expect(reachOf(silent).joints).toBe(4);
  });

  it('refuses arrays that disagree with the mesh, a joint that is not one, and a short pose', () => {
    expect(() => validatePointSkin(skin, 3)).toThrow(/joints holds 2 vertices and the mesh has 3/);
    expect(() =>
      validatePointSkin({ ...skin, joints: new Float32Array([0.5, 0, 0, 0, 1, 0, 0, 0]) }, 2),
    ).toThrow(/vertex 0 names joint 0.5/);
    expect(() =>
      validatePointSkin({ ...skin, joints: new Float32Array([512, 0, 0, 0, 1, 0, 0, 0]) }, 2),
    ).toThrow(/joint 512/);
    expect(() => validatePose(new Float32Array(16), reachOf(skin))).toThrow(
      /a pose of 1 joints for a skin that names 2/,
    );
    expect(() => validatePointSkin(skin, 2)).not.toThrow();
  });

  /*
   * **What a rewrite in part is for**: a hand that changes shape moves a few hundred vertices, and
   * a skin made again whole for each change was the largest part of a character's drawing. The
   * vertex rewritten here moves to joint 3, which nothing named before, five units out.
   */
  it('WIDENS ITS REACH TO HOLD A REWRITTEN VERTEX, AND NEVER NARROWS IT', () => {
    const rewrite: PointSkinData = {
      joints: new Float32Array([3, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0]),
      points: new Float32Array([0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      normals: new Float32Array([0, 0, 1]),
    };
    const reach = widenReach(reachOf(skin), rewrite);
    expect(reach.joints).toBe(4);
    /* Joint 2 is named by nobody; the old reach of joints 0 and 1 stays though vertex 1 left. */
    expect(Array.from(reach.reach)).toEqual([1, 1, -1, 5]);
    expect(reach.sums).toEqual([1, 1]);
    /* Joints 2 and 3 placed: 2 where it was, 3 moved to (0, 10, 0). */
    const four = new Float32Array(64);
    four.set(pose);
    four.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 32);
    four.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1], 48);
    const bounds = createBounds();
    poseBounds(four, reach, bounds);
    /* The rewritten vertex posed is (0, 10, 5), on the edge of joint 3's sphere. */
    expect(Array.from(bounds.min)).toEqual([-5, -2, -5]);
    expect(Array.from(bounds.max)).toEqual([5, 15, 5]);
    /* A vertex whose weights are taken away pulls the least sum to zero, which holds the origin. */
    const gone = { ...rewrite, joints: new Float32Array(4), weights: new Float32Array(4) };
    expect(widenReach(reachOf(skin), gone).sums).toEqual([0, 1]);
    expect(Array.from(widenReach(reachOf(skin), gone).reach)).toEqual([1, 1]);
  });

  it('refuses a rewrite that does not fit inside the mesh, naming its vertices', () => {
    const one: PointSkinData = {
      joints: new Float32Array([0, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0]),
      points: new Float32Array(12),
      normals: new Float32Array(3),
    };
    expect(() => validatePointSkinRange(one, 1, 2)).not.toThrow();
    expect(() => validatePointSkinRange(one, 2, 2)).toThrow(
      /a rewrite of 1 vertices from vertex 2 for a mesh of 2/,
    );
    expect(() => validatePointSkinRange(one, -1, 2)).toThrow(/from vertex -1/);
    expect(() => validatePointSkinRange(one, 0.5, 2)).toThrow(/from vertex 0.5/);
    expect(() => validatePointSkinRange({ ...one, normals: new Float32Array(6) }, 0, 2)).toThrow(
      /normals holds 2 vertices and the weights hold 1/,
    );
    expect(() =>
      validatePointSkinRange({ ...one, joints: new Float32Array([600, 0, 0, 0]) }, 1, 2),
    ).toThrow(/vertex 1 names joint 600/);
  });
});
