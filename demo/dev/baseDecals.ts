/**
 * Decals laid into the base colour before it is lit: `setBaseDecals` and `setBaseDecalImages`.
 *
 *     /baseDecals.html?mode=control    a grey floor with a glowing stripe across it, and a block
 *     /baseDecals.html?mode=decal      two decals on it: a black one at 60% over the stripe on the
 *                                      left, an opaque orange one on the right; the block refuses
 *     /baseDecals.html?mode=expected   the control: no decals, the floor under them built in the
 *                                      colours they make, the stripe glowing as it did
 *     /baseDecals.html?mode=receive    as `decal`, the block's top receiving the black one
 *
 * **What it proves.** Under a decal the floor must be the colour the decal makes and lit as such,
 * so `decal` must draw what `expected` draws, to the pixel inside the boxes; and where the stripe
 * runs under the black decal it must glow as it did, which a decal multiplying the finished pixel
 * cannot do. The block standing in the left box is marked on its top only where it receives, and
 * on no side, which faces across the projection. The two backends must agree. Nothing under `src/`
 * may import this.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { BaseDecal, MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 30;
const GREY = 0.5;
const ORANGE: [number, number, number] = [200, 100, 50];
const BLACK_ALPHA = 153;

/** An sRGB byte as linear, the decode the lit stage gives a decal's colour. */
const linear = (byte: number): number => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** A square the size of a decal's image, one colour and one alpha. */
function image(rgb: readonly [number, number, number], alpha: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('baseDecals: no 2D context');
  const data = ctx.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) data.data.set([...rgb, alpha], i * 4);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

const LEFT: BaseDecal = {
  center: [-1.5, 0.5, 0],
  halfExtents: [1, 1, 1],
  forward: [0, -1, 0],
  up: [0, 0, -1],
  image: 0,
};
const RIGHT: BaseDecal = { ...LEFT, center: [1.5, 0.5, 0], image: 1 };

/**
 * The floor as cells, each its own colour and glow: grey, the stripe glowing where |z| < 0.5, and in
 * `expected` the cells under each decal in the colour it makes, the stripe's glow named as it was.
 */
function floor(expected: boolean): MeshData {
  const xs = [-4, -2.5, -0.5, 0.5, 2.5, 4];
  const zs = [-4, -1, -0.5, 0.5, 1, 4];
  const positions: number[] = [];
  const colors: number[] = [];
  const emissive: number[] = [];
  const glow: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const [x0, x1, z0, z1] = [xs[i], xs[i + 1], zs[j], zs[j + 1]] as number[];
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const inZ = Math.abs(cz) < 1;
      const left = expected && inZ && cx > -2.5 && cx < -0.5;
      const right = expected && inZ && cx > 0.5 && cx < 2.5;
      const stripe = Math.abs(cz) < 0.5;
      const colour = left
        ? [
            GREY * (1 - BLACK_ALPHA / 255),
            GREY * (1 - BLACK_ALPHA / 255),
            GREY * (1 - BLACK_ALPHA / 255),
          ]
        : right
          ? ORANGE.map(linear)
          : [GREY, GREY, GREY];
      const base = positions.length / 3;
      for (const [x, z] of [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ] as [number, number][]) {
        positions.push(x, 0, z);
        colors.push(...colour);
        emissive.push(stripe ? 1 : 0);
        /* The glow's colour named only where the cell's own colour was changed for it. */
        glow.push(...(stripe && (left || right) ? [GREY, GREY, GREY] : [-1, -1, -1]));
      }
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(count * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)),
    colors: new Float32Array(colors),
    emissive: new Float32Array(emissive),
    ...(expected ? { emissiveColor: new Float32Array(glow) } : {}),
    indices: new Uint32Array(indices),
  };
}

/** A block 0.6 m on a side standing in the left decal's box. */
function block(): MeshData {
  const h = 0.3;
  const [cx, cy, cz] = [-1.5, 0.3, 0.2];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: [Vec3, Vec3, Vec3][] = [
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ],
    [
      [0, 0, -1],
      [1, 0, 0],
      [0, 1, 0],
    ],
  ];
  for (const [n, a, b] of faces) {
    const base = positions.length / 3;
    for (const [s, t] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      positions.push(
        cx + (n[0] + a[0] * s + b[0] * t) * h,
        cy + (n[1] + a[1] * s + b[1] * t) * h,
        cz + (n[2] + a[2] * s + b[2] * t) * h,
      );
      normals.push(...n);
    }
    indices.push(
      base,
      base + 1,
      base + 2,
      base,
      base + 2,
      base + 3,
      base,
      base + 2,
      base + 1,
      base,
      base + 3,
      base + 2,
    );
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(count * 3).fill(0.6),
    emissive: new Float32Array(count),
    indices: new Uint32Array(indices),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const mode = ASKED.get('mode') ?? 'decal';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;
  const ground = renderer.createMesh(floor(mode === 'expected'));
  const box = renderer.createMesh(block());
  const decals = mode === 'decal' || mode === 'receive';
  const images = [image([0, 0, 0], BLACK_ALPHA), image(ORANGE, 255)];
  await renderer.ready();

  const env = createEnvironment();
  env.directionalDir = [0.3, 0.8, 0.4];
  env.directionalColor = [0.8, 0.78, 0.75];
  env.ambient = [0.3, 0.3, 0.32];
  env.ambientGround = [0.3, 0.3, 0.32];
  env.shadowStrength = 0;
  env.fogDensity = 0;
  /* Emission is multiplied by the night factor. */
  env.nightFactor = 1;
  env.emissiveGain = 1;
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.position[1] = 6;
  camera.position[2] = 6;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  let frame = 0;
  const draw = (): void => {
    if (decals) {
      /* Once a frame, as a game redrawing its decals' images would. */
      renderer.setBaseDecalImages(images);
      renderer.setBaseDecals([LEFT, RIGHT]);
    }
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setSurfaceGrain(0);
    renderer.setMaterial(null);
    renderer.drawMesh(ground, identity);
    renderer.setMaterial({ receivesDecals: mode === 'receive' });
    renderer.drawMesh(box, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · ${mode}`;
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
