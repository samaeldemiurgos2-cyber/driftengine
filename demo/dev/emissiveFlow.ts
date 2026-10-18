/**
 * A material's glow moved and masked: `emissiveScroll` and `emissiveMaskLayer`.
 *
 *     /emissiveFlow.html                       the control: stripes glowing across the whole wall
 *     /emissiveFlow.html?mask=1                held to the left half by layer 1's alpha
 *     /emissiveFlow.html?scroll=0.25&t=1       moved a quarter of a repeat along u
 *     /emissiveFlow.html?scroll=0.25&t=4       moved a whole repeat, which is where it started
 *
 * **What it proves.** The wall's own coordinates run 0 to 1 and the material repeats its maps eight
 * times across it, so the stripes are eight to a wall while the mask, read at the wall's own
 * coordinates, splits it once down the middle: masked, the left half must draw what the control
 * draws and the right half no glow. Scrolled by a whole repeat the wall must draw the control, and
 * by a quarter it must not. The two backends must agree. Held at frame 30. Nothing under `src/` may
 * import this.
 */
import { Camera, createEnvironment, createRenderer } from '../../packages/core/src/index';
import type { MeshData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.05, 0.06, 0.08];
const FRAMES = 30;
const SIZE = 64;

/** A canvas of `SIZE` painted by `texel(x, y)`, four channels 0 to 255. */
function paint(
  texel: (x: number, y: number) => [number, number, number, number],
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('emissiveFlow: no 2D context');
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) image.data.set(texel(x, y), (y * SIZE + x) * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A wall four metres square facing the camera, its own coordinates 0 to 1, glowing everywhere. */
function wall(): MeshData {
  return {
    positions: new Float32Array([-2, 0, 0, 2, 0, 0, 2, 4, 0, -2, 4, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array(12).fill(0.2),
    emissive: new Float32Array([1, 1, 1, 1]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const masked = ASKED.get('mask') === '1';
  const scroll = Number(ASKED.get('scroll') ?? 0);
  const time = Number(ASKED.get('t') ?? 0);
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  /* Layer 0, the glow: two bright stripes a tile across u. Layer 1, the mask: its alpha keeps the
     left half of the image and nothing of the right. Its colour says nothing. */
  const emissive = renderer.createSurfaceTextureArray(
    [
      paint((x) => (Math.floor((x * 4) / SIZE) % 2 === 0 ? [255, 150, 40, 255] : [20, 10, 5, 255])),
      paint((x) => [0, 0, 0, x < SIZE / 2 ? 255 : 0]),
    ],
    { colorSpace: 'srgb' },
  );
  const mesh = renderer.createMesh(wall());
  await renderer.ready();

  const env = createEnvironment();
  env.directionalDir = [0, 0.5, 1];
  env.directionalColor = [0.3, 0.3, 0.3];
  env.ambient = [0.1, 0.1, 0.1];
  env.shadowStrength = 0;
  env.fogDensity = 0;
  /* Emission is multiplied by the night factor: at noon a lamp emits nothing. */
  env.nightFactor = 1;
  env.emissiveGain = 1;
  env.surfaceTime = time;
  const camera = new Camera();
  camera.fovYDeg = 45;
  camera.position[1] = 2;
  camera.position[2] = 6;
  camera.lookAt(0, 2, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  let frame = 0;
  const draw = (): void => {
    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.setMaterial({
      emissive,
      uScale: 8,
      vScale: 8,
      ...(scroll !== 0 ? { emissiveScroll: [scroll, 0] as const } : {}),
      ...(masked ? { emissiveMaskLayer: 1 } : {}),
    });
    renderer.drawMesh(mesh, identity);
    renderer.setMaterial(null);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · mask ${masked} · scroll ${scroll} · t ${time}`;
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
