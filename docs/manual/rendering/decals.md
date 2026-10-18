---
title: Decals
description: Marks on surfaces two ways: baked into a mesh once from its own triangles, or projected every frame onto whatever was drawn.
packages: ['@driftengine/core']
---

# Decals

A mark on a surface, such as a scorch, a puddle, a stain or a painted line, can be made two ways, and
which one you want depends on whether the surface it lands on changes.

## Baked into a mesh

```ts sample=snippets/decals.ts#baked
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
```

`projectDecal` clips the receiving mesh's own triangles to a projector box and returns new mesh data,
lifted a couple of millimetres off the surface. It is exact, it is lit exactly as the surface is lit,
and after the frame that built it, it costs one ordinary draw. It is decided once, against the mesh
as it stood, so it suits anything static: road markings, stains on a wall, a crater.

The box is a centre, half extents across, up and along the projection, the direction the mark is
projected along, and which way is up in the mark. `facingCos` limits how far a surface may turn away
from the projector and still be marked, so a mark on a floor doesn't smear down the side of a step.

## Projected every frame

```ts sample=snippets/decals.ts#projected
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
```

A `DecalProjector` stays alive, and `drawDecal` marks whatever the frame has drawn inside its box,
from the depth buffer. That is what a surface that deforms, streams in, or has no geometry on the CPU
needs: cloth, a heightfield being rewritten, a skinned character, an instanced crowd. `setPose` and
`setSize` move it without allocating, so a mark can follow something every frame.

A projected mark **multiplies** what is under it: it darkens and tints, takes the receiver's
lighting, and cannot brighten. White marks nothing and black is a hole. Its shape is a soft-edged
ellipse, and `softness` sets how much of its radius is edge.

It needs `screenEffects`, because it reads the frame's depth; without it, the renderer says so on the
console and draws no marks. A frame draws at most thirty-two.

## Laid into the base colour

A projected mark multiplies the finished pixel, so where the surface under it glows, a lettered
floor or a lit panel, the mark dims the glow as well. A shadow a body throws on a lit floor, a
footprint or a stain changes what the surface is instead: it darkens the colour light falls on and
leaves what the surface emits, its roughness and its normal as they are. `setBaseDecals` lays such
marks, each a box like a projector's, an image read across its face, and how much of it lands:

```ts sample=snippets/decals.ts#base
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
```

The base colour moves toward the image's colour by its alpha times `opacity`, before any light is
added, and the surface is then lit and glows as it would. An image is a square of
`BASE_DECAL_TILE` texels, 128, read as a picture: its colour is decoded from sRGB and its alpha is
as it is. Rewriting the images once a frame is what they are for and costs an upload of the
squares; changing how many there are costs more. The decals are held until the next call, across
passes, so a reflection shows them too. `facingCos`, 0.2 by default, keeps a mark aimed at a floor
off the sides of what stands on it, judged by the geometric normal so a normal map's bump does not
cut it. A surface that stands in a decal's box and is not what it lands on, such as a body over its
own shadow, says `receivesDecals: false` in its material.

A frame lays at most eight. They take thirty-four of the lit shader's uniform vectors, so WebGL2
refuses them, saying so once, on a part that has no room, and the GPU-driven pipeline does not draw
them.

## Which to use

|                | Baked, `projectDecal`             | Projected, `drawDecal`                         | Base colour, `setBaseDecals`            |
| -------------- | --------------------------------- | ---------------------------------------------- | --------------------------------------- |
| Surface        | Static mesh you hold the data for | Anything drawn, including moving and deforming | Anything drawn by the lit pass          |
| Cost per frame | One draw                          | One pass over the box's pixels                 | A test per decal in every lit pixel     |
| Look           | Any colour, lit, can glow         | Multiplies only; an ellipse                    | An image, lit, leaves the glow as it is |
| Needs          | The mesh data                     | `screenEffects`                                | Room for 34 uniform vectors on WebGL2   |
| Limit          | None                              | 32 a frame                                     | 8 a frame                               |

For marks that must survive a replay, such as a scorch left by a weapon that a replay must reproduce,
the writable texture overlay records every mark in the game's input log; see the Worlds section.
