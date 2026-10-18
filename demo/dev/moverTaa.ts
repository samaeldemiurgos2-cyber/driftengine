/**
 * Movers under WebGL2's temporal antialiasing: a rigid block, a skinned bar and an arm posed from
 * points in its joints' spaces, moving under a still camera.
 *
 *     /moverTaa.html?backend=webgl2&taa=1&mover=1   each drawn with its `Mover`: the resolve follows it
 *     /moverTaa.html?backend=webgl2&taa=1&mover=0   no movers: the camera's motion alone, the trails
 *     /moverTaa.html?backend=webgl2&taa=0           the reference, no temporal resolve at all
 *     ...&still=1                                   nothing moves, where the two must agree
 *
 * **What it proves.** A surface close in colour to what it crosses is not rejected by the resolve's
 * neighbourhood clip, so with the camera's motion alone it leaves its earlier pixels behind it.
 * Followed by its mover, the frame must come back near the reference, and far nearer than without:
 * the measurement counts the pixels a long way from the reference. With nothing moving, followed and
 * not followed must be the same frame. Held at frame 60 of a fixed clock. Nothing under `src/` may
 * import this.
 */
import { mat4 } from 'gl-matrix';

import {
  Camera,
  createEnvironment,
  createMover,
  createRenderer,
} from '../../packages/core/src/index';
import type { MeshData, PointSkinData, RendererApi, Vec3 } from '../../packages/core/src/index';
import { DEV_RENDERER, askedQuality } from './askedQuality';

const ASKED = new URLSearchParams(location.search);
const CLEAR: Vec3 = [0.42, 0.42, 0.44];
const FRAMES = 60;

/** A box of `half` extents about the origin, one colour, as a mesh. */
function box(half: Vec3, colour: Vec3, extra: Partial<MeshData> = {}): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: [Vec3, Vec3, Vec3][] = [
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
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
        (n[0] + a[0] * s + b[0] * t) * half[0],
        (n[1] + a[1] * s + b[1] * t) * half[1],
        (n[2] + a[2] * s + b[2] * t) * half[2],
      );
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const count = positions.length / 3;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(count * 3).map((_, i) => colour[i % 3] as number),
    emissive: new Float32Array(count),
    indices: new Uint32Array(indices),
    ...extra,
  };
}

/** A bar along x, 0 to 2, on two joints blended across its middle. */
function bar(): MeshData {
  const data = box([1, 0.15, 0.15], [0.5, 0.5, 0.52]);
  const count = data.positions.length / 3;
  const joints = new Float32Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    data.positions[v * 3] = (data.positions[v * 3] as number) + 1;
    const x = data.positions[v * 3] as number;
    const share = Math.min(1, Math.max(0, (x - 0.6) / 0.8));
    joints.set([0, 1, 0, 0], v * 4);
    weights.set([1 - share, share, 0, 0], v * 4);
  }
  return { ...data, joints, weights };
}

/** A box posed from points in one joint's space: every vertex its own point, weight one. */
function pointBox(): { mesh: MeshData; skin: PointSkinData } {
  const mesh = box([0.35, 0.35, 0.35], [0.46, 0.47, 0.5]);
  const count = mesh.positions.length / 3;
  const points = new Float32Array(count * 12);
  for (let v = 0; v < count; v++) points.set(mesh.positions.subarray(v * 3, v * 3 + 3), v * 12);
  const weights = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) weights[v * 4] = 1;
  return {
    mesh,
    skin: { joints: new Float32Array(count * 4), weights, points, normals: mesh.normals.slice() },
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const stats = document.getElementById('stats') as HTMLElement;
  const movers = ASKED.get('mover') !== '0';
  const still = ASKED.get('still') === '1';
  const created = await createRenderer(canvas, askedQuality(), DEV_RENDERER);
  await created.renderer.ready();
  const renderer: RendererApi = created.renderer;

  const block = renderer.createMesh(box([0.4, 0.4, 0.4], [0.47, 0.47, 0.5]));
  const skinned = renderer.createMesh(bar());
  const { mesh: pointMesh, skin } = pointBox();
  const posed = renderer.createMesh(pointMesh, { dynamic: true });
  const pointSkin = renderer.createPointSkin(posed, skin);
  const wall = renderer.createMesh(box([8, 5, 0.1], [0.45, 0.45, 0.48]));
  await renderer.ready();

  const env = createEnvironment();
  env.directionalDir = [0.3, 0.6, 1];
  env.directionalColor = [0.6, 0.6, 0.6];
  env.ambient = [0.45, 0.45, 0.47];
  env.ambientGround = [0.45, 0.45, 0.47];
  env.shadowStrength = 0;
  env.fogDensity = 0;
  const camera = new Camera();
  camera.fovYDeg = 40;
  camera.position[2] = 7;
  camera.lookAt(0, 0, 0);
  renderer.resize();
  camera.updateMatrices(canvas.height > 0 ? canvas.width / canvas.height : 1);

  const blockMover = createMover();
  const barMover = createMover();
  const pointMover = createMover();
  const blockModel = mat4.create();
  const barModel = mat4.create();
  const pointModel = mat4.create();
  const wallModel = mat4.fromTranslation(mat4.create(), [0, 0, -1]);
  const palette = new Float32Array(32);
  const joint = new Float32Array(16);

  let frame = 0;
  const draw = (): void => {
    const t = still ? 0 : frame / 60;
    /* The block slides across, the bar bends, the posed box turns where it travels. */
    mat4.fromTranslation(blockModel, [-2.6 + Math.sin(t * 3) * 1.2, 1.1, 0]);
    mat4.fromTranslation(barModel, [-0.9, -1.2, 0]);
    palette.set(mat4.create(), 0);
    mat4.fromZRotation(joint as unknown as mat4, Math.sin(t * 4) * 0.9);
    palette.set(joint, 16);
    mat4.fromTranslation(pointModel, [2.2 + Math.sin(t * 2.5) * 0.8, 0.6, 0]);
    mat4.fromRotation(joint as unknown as mat4, t * 2, [0.3, 1, 0.2]);
    renderer.posePointSkin(pointSkin, joint);

    renderer.beginFrame(CLEAR);
    renderer.bindMeshPass(camera, env);
    renderer.drawMesh(wall, wallModel);
    renderer.drawMesh(block, blockModel, 0, null, movers ? blockMover : null);
    renderer.setSkinPalette(palette);
    renderer.drawMesh(skinned, barModel, 0, null, movers ? barMover : null);
    renderer.setSkinPalette(null);
    renderer.drawMesh(posed, pointModel, 0, null, movers ? pointMover : null);
    renderer.endFrame();
    frame += 1;
    stats.textContent = `${created.backend} · movers ${movers} · still ${still}`;
    if (frame < FRAMES) requestAnimationFrame(draw);
    else (globalThis as unknown as { __drawn?: boolean }).__drawn = true;
  };
  requestAnimationFrame(draw);
}

main().catch((error: unknown) => {
  const box = document.getElementById('error');
  if (box !== null)
    box.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
