/**
 * A surface's iridescent overlay: `SurfaceMaterial.iridescentOverlay`.
 *
 *     /iridescence.html?mode=probe       a square whose own coordinates are one point, so every term
 *                                        of the overlay is the same across it
 *     /iridescence.html?mode=expected    the control: that square drawn with no overlay, its colour
 *                                        the CPU's answer for the same numbers (iridescentBase)
 *     /iridescence.html?mode=sphere      a sphere wearing the overlay, its hue turning with the view
 *     ...&overlay=0                      the sphere without it
 *     ...&weight=0                       the sphere with it laid on at nothing
 *     /iridescence.html?mode=mask        a wall whose overlay a mask in the ORM array keeps on the left
 *
 * **What it proves.** Under the probe the device's colour must be the CPU's, to the pixel: the ramp,
 * the overlay blend, the tiling, the weight and the way back to the mesh's own coordinates are all
 * in it, with a contrast of 0 so the sheen is 1 wherever the surface faces the eye. On the sphere a
 * weight of 0 must draw what no overlay draws, and the overlay must not; masked, the right half must
 * draw what no overlay draws and the left must not. The two backends must agree. Nothing under
 * `src/` may import this.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type {
  IridescentOverlay,
  MeshData,
  RendererApi,
  SurfaceMaterial,
  SurfaceTextureHandle,
  Vec3,
} from '../../packages/core/src/index';
import {
  IRIDESCENT_FLOATS,
  iridescentBase,
  packIridescentOverlay,
} from '../../packages/core/src/render/iridescentOverlay';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 30;
const BASE: Vec3 = [0.3, 0.45, 0.6];

/** A spectrum: red, yellow, green, cyan, blue, magenta and back, eight colours. */
const RAMP = [1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0.2, 1, 0.1, 0];

/** A square two metres across facing +z; its own coordinates `uv` at every corner, or 0 to 1. */
function square(colour: Vec3, uv: readonly [number, number] | null): MeshData {
  const corner = (u: number, v: number): number[] => (uv === null ? [u, v] : [uv[0], uv[1]]);
  return {
    positions: new Float32Array([-1, 0, 0, 1, 0, 0, 1, 2, 0, -1, 2, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([...colour, ...colour, ...colour, ...colour]),
    emissive: new Float32Array(4),
    uvs: new Float32Array([...corner(0, 1), ...corner(1, 1), ...corner(1, 0), ...corner(0, 0)]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

/** A sphere of radius one about (0, 1, 0), latitude and longitude, coordinates around and up. */
function sphere(): MeshData {
  const rings = 48;
  const sides = 96;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= sides; s++) {
      const theta = (s / sides) * Math.PI * 2;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      positions.push(n[0] as number, (n[1] as number) + 1, n[2] as number);
      normals.push(...n);
      uvs.push(s / sides, r / rings);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * (sides + 1) + s;
      const b = a + sides + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(count * 3).map((_, i) => BASE[i % 3] as number),
    emissive: new Float32Array(count),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const mode = ASKED.get('mode') ?? 'sphere';
  const on = ASKED.get('overlay') !== '0';
  const weight = Number(ASKED.get('weight') ?? 0.5);
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* The probe's numbers: a contrast of 0 makes the sheen 1 wherever N·H > 0, and with a blend of 1
     x is then u + 1; the square's own u is 0.3 at every corner, under a repeat of 4 offset by 1. */
  const probe: IridescentOverlay = {
    ramp: RAMP,
    direction: [0, 0.2, 1],
    blend: 1,
    contrast: 0,
    tiling: 1.7,
    weight: 0.4,
  };
  const packed = new Float32Array(IRIDESCENT_FLOATS);
  packIridescentOverlay(probe, {}, packed);
  const expected: [number, number, number] = [0, 0, 0];
  /* The normal and the eye only enter through N·H > 0 and N·V, which a blend of 1 cancels. */
  iridescentBase(packed, BASE, [0, 0, 1], [0, 0, 1], [0.3, 0], 1, expected);

  /* For the mask: an ORM array whose layer 1 keeps the left half in its alpha. */
  const orm = await (async (): Promise<SurfaceTextureHandle> => {
    const paint = (left: number, right: number): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext('2d');
      if (ctx === null) throw new Error('iridescence: no 2D context');
      const image = ctx.createImageData(64, 64);
      for (let i = 0; i < 64 * 64; i++) {
        image.data.set([255, 255, 255, i % 64 < 32 ? left : right], i * 4);
      }
      ctx.putImageData(image, 0, 0);
      return c;
    };
    return renderer.createSurfaceTextureArray([paint(255, 255), paint(255, 0)], {
      colorSpace: 'linear',
    });
  })();

  let mesh;
  let material: SurfaceMaterial<SurfaceTextureHandle> | null = null;
  if (mode === 'probe') {
    mesh = renderer.createMesh(square(BASE, [0.3, 0.3]));
    material = { uScale: 4, vScale: 4, uOffset: 1, vOffset: 1, iridescentOverlay: probe };
  } else if (mode === 'expected') {
    mesh = renderer.createMesh(square(expected, [0.3, 0.3]));
  } else if (mode === 'mask') {
    mesh = renderer.createMesh(square(BASE, null));
    material = on
      ? {
          orm,
          iridescentOverlay: { ...probe, weight: 1, mask: { map: 'orm', layer: 1, channel: 3 } },
        }
      : { orm };
  } else {
    mesh = renderer.createMesh(sphere());
    material = on
      ? { iridescentOverlay: { ramp: RAMP, direction: [0.3, 0.6, 1], tiling: 2, weight } }
      : null;
  }
  await renderer.ready();

  const env = createEnvironment();
  env.directionalDir = [0.2, 0.6, 1];
  env.directionalColor = [0.9, 0.9, 0.9];
  env.ambient = [0.35, 0.35, 0.35];
  env.ambientGround = [0.35, 0.35, 0.35];
  env.shadowStrength = 0;
  env.fogDensity = 0;
  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.position[1] = 1;
  camera.position[2] = 4.5;
  camera.lookAt(0, 1, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  let frame = 0;
  const draw = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    renderer.setMaterial(material);
    renderer.drawMesh(mesh, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · ${mode} · overlay ${on} · weight ${weight} · expected ${expected.map((v) => v.toFixed(4)).join(',')}`;
    /* The first frame asks for the switch; the lit pipelines it rebuilds land before the rest. */
    if (frame === 1) void renderer.ready().then(() => requestAnimationFrame(draw));
    else if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
