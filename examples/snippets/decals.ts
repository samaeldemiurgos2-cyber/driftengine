/**
 * Marks on surfaces: one baked into a mesh once, one projected every frame onto whatever is
 * there, and one laid into the base colour of what it lands on.
 *
 * A snippet, typechecked with the examples and quoted by the manual's decals chapter.
 */
import { DecalProjector, projectDecal } from '@driftengine/core';
import type { BaseDecal, MeshData, RendererApi } from '@driftengine/core';

// #region baked
/** A scorch mark on a road: the road's own triangles, clipped to a box and lifted off it. */
export function scorch(renderer: RendererApi, road: MeshData, x: number, y: number, z: number) {
  return renderer.createMesh(
    projectDecal(road, {
      center: [x, y, z],
      halfExtents: [1.2, 1.2, 0.6],
      forward: [0, -1, 0],
      up: [0, 0, 1],
      color: [0.2, 0.18, 0.16],
    }),
  );
}
// #endregion

// #region projected
/** A wet patch that follows a moving thing, decided each frame from the depth already drawn. */
const wet = new DecalProjector({
  center: [0, 0, 0],
  halfExtents: [1.2, 1.2, 0.6],
  forward: [0, -1, 0],
  up: [0, 0, 1],
  color: [0.55, 0.6, 0.7],
  softness: 0.6,
});

/** After the opaque geometry it lands on, before `endFrame`. */
export function drawWetPatch(renderer: RendererApi, x: number, y: number, z: number): void {
  wet.setPose([x, y + 0.3, z], [0, -1, 0], [0, 0, 1]);
  renderer.drawDecal(wet);
}
// #endregion

// #region base
/** A shadow under something standing on the floor, its box moved in place each frame. */
const under: [number, number, number] = [0, 0.2, 0];
const shadow: BaseDecal & { opacity: number } = {
  center: under,
  halfExtents: [0.3, 0.4, 0.5],
  forward: [0, -1, 0],
  up: [0, 0, -1],
  image: 0,
  opacity: 1,
};
const laid: BaseDecal[] = [shadow];

/** Once a frame, before the draws it marks: its image redrawn, its box moved, fading with height. */
export function layShadow(
  renderer: RendererApi,
  images: readonly HTMLCanvasElement[],
  x: number,
  z: number,
  height: number,
): void {
  under[0] = x;
  under[2] = z;
  shadow.opacity = Math.max(0, 1 - height);
  renderer.setBaseDecalImages(images);
  renderer.setBaseDecals(laid);
}
// #endregion
