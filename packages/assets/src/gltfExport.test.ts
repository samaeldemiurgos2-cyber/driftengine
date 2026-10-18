import { describe, expect, it } from 'vitest';
import type {
  AnimationClip,
  DrftLight,
  DrftMaterial,
  DrftNode,
  DrftSource,
  JointTrack,
  MeshData,
} from '@driftengine/drft';
import { CODEC_JPEG, CODEC_PNG, nnetWeightCount, readDrft, writeDrft } from '@driftengine/drft';
import { bakeModel } from './bake/model.ts';
import { CARRIED_OUT } from './carriedOut.ts';
import { CARRIED_IN } from './carriedPayloads.ts';
import { compose, multiply, quaternionMatrix } from './blendMatrix.ts';
import { exactJson } from './glbWrite.ts';
import { readGlb, gltfToMeshes } from './gltf.ts';
import { drftToGlb } from './gltfExport.ts';
import { readGltfSkins } from './gltfSkin.ts';
import { readModel } from './readModel.ts';

/**
 * The way back out: a `.drft` written, exported to glTF, read by the glTF reader, baked by the
 * baker's own function, and compared chunk by chunk with the file it started as.
 *
 * **Exact, every chunk, and that is a claim rather than a convenience.** Nothing on the path rounds:
 * every array goes out as the float32 the file held, a mesh at the identity is read back without
 * being transformed, influences already in order are not normalised again, and what glTF would round
 * or has no field for (a light's direction, a clip held past its last key, a material's engine-only
 * fields, the sign of a zero) rides in a record beside it. So no tolerance is stated, because none
 * is needed; a difference of one bit fails, and says which chunk.
 *
 * The fixtures are what the baker writes rather than what any writer could: welded, carrying no
 * attribute that never varies, with a frame where a material samples a normal map and influences
 * heaviest first. A file a bake would change is not a round trip's to preserve.
 */

const f32 = (values: readonly number[]): Float32Array => Float32Array.from(values);

/** A unit quaternion about an axis, rounded to float32 as a chunk stores it. */
function turn(
  axis: readonly [number, number, number],
  angle: number,
): [number, number, number, number] {
  const length = Math.hypot(...axis);
  const s = Math.sin(angle / 2) / length;
  return [
    Math.fround(axis[0] * s),
    Math.fround(axis[1] * s),
    Math.fround(axis[2] * s),
    Math.fround(Math.cos(angle / 2)),
  ];
}

/**
 * A strip of `count` distinct vertices, every attribute varying, so the weld merges nothing and the
 * bake drops nothing. Normals and tangents are unit in double and then rounded, which is exactly the
 * float32 a reader that renormalised would move.
 */
function strip(count: number, seed: number, extra: Partial<MeshData> = {}): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const tangents: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = seed + i * 0.7;
    positions.push(i * 0.25, Math.sin(a) * 0.5 + 1, Math.cos(a) * 0.3);
    const n = [Math.sin(a), 0.4, Math.cos(a)];
    const nl = Math.hypot(n[0] as number, n[1] as number, n[2] as number);
    normals.push((n[0] as number) / nl, (n[1] as number) / nl, (n[2] as number) / nl);
    colors.push(0.2 + 0.05 * i, 0.5, 0.9 - 0.04 * i);
    uvs.push(i / count, (i % 2) * 0.5);
    const t = [Math.cos(a), 0, -Math.sin(a)];
    tangents.push(t[0] as number, t[1] as number, t[2] as number, i % 3 === 0 ? -1 : 1);
  }
  const indices: number[] = [];
  for (let i = 0; i + 2 < count; i++) indices.push(i, i + 1, i + 2);
  return {
    positions: f32(positions),
    normals: f32(normals),
    colors: f32(colors),
    emissive: f32(positions.filter((_, k) => k % 3 === 0).map((x) => x * 0.1)),
    uvs: f32(uvs),
    tangents: f32(tangents),
    indices: Uint32Array.from(indices),
    ...extra,
  };
}

function material(name: string, fields: Partial<DrftMaterial> = {}): DrftMaterial {
  return {
    name,
    color: [Math.fround(0.6), Math.fround(0.45), Math.fround(0.3)],
    specular: Math.fround(0.25),
    roughness: Math.fround(0.7),
    emissive: 0,
    emissiveColor: [-1, -1, -1],
    opacity: 1,
    albedo: -1,
    normalMap: -1,
    ormMap: -1,
    emissiveMap: -1,
    roughnessScale: 1,
    metallicScale: 1,
    occlusionStrength: 0,
    reflectivity: 0,
    cutout: 0,
    blend: false,
    doubleSided: false,
    transmission: 0,
    frost: 0,
    tint: [1, 1, 1],
    ...fields,
  };
}

/** Enough of a PNG and a JPEG for their headers to say their size, which is all a bake reads. */
function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  return out;
}
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    17,
    8,
    0,
    height,
    0,
    width,
    3,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ]);
}

const JOINTS = [
  { name: 'root', parent: -1, at: [0, 0, 0] },
  { name: 'hips', parent: 0, at: [0, 1, 0] },
  { name: 'spine', parent: 1, at: [0, 1.3, 0] },
  { name: 'head', parent: 2, at: [0, 1.7, 0] },
  { name: 'upperArm.L', parent: 2, at: [0.2, 1.5, 0] },
  { name: 'hand.L', parent: 4, at: [0.6, 1.5, 0] },
  { name: 'upperArm.R', parent: 2, at: [-0.2, 1.5, 0] },
  { name: 'hand.R', parent: 6, at: [-0.6, 1.5, 0.1] },
] as const;

/** One key a frame for `frames` frames: every joint turning, and the root moving. */
function clip(name: string, frames: number, holdSec: number): AnimationClip {
  const times = f32(Array.from({ length: frames }, (_, k) => k / 30));
  const tracks: JointTrack[] = JOINTS.map((_, joint) => ({
    joint,
    path: 'rotation' as const,
    times,
    values: f32(
      Array.from({ length: frames }, (_, k) => turn([0.2, 1, 0.1 * joint], 0.1 * k + joint)).flat(),
    ),
  }));
  tracks.push({
    joint: 0,
    path: 'translation',
    times,
    values: f32(Array.from({ length: frames }, (_, k) => [0, 0, -0.05 * k]).flat()),
  });
  return { name, durationSec: Math.fround((frames - 1) / 30 + holdSec), tracks };
}

/**
 * A character: one skin whose joints are also `NODE` entries, as a rig read from glTF has them, an
 * attachment point parented to a hand, two skinned meshes (the second with eight influences and two
 * morph targets), a textured and a plain material, two clips, and a manifest.
 */
function character(withNodes: boolean): DrftSource {
  const inverseBind = new Float32Array(JOINTS.length * 16);
  JOINTS.forEach((joint, j) => {
    /* The bind pose is a translation, and the head's is turned too, so a transposed matrix shows. */
    const [c, s] = j === 3 ? [Math.cos(0.3), Math.sin(0.3)] : [1, 0];
    const [x, y, z] = joint.at;
    inverseBind.set(
      [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, -(c * x + s * z), -y, -(-s * x + c * z), 1],
      j * 16,
    );
  });
  const nodes: DrftNode[] = [
    {
      parent: -1,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      mesh: -1,
      name: 'Armature',
    },
    ...JOINTS.map((joint): DrftNode => ({
      parent: joint.parent + 1,
      translation: [Math.fround(joint.at[0] * 0.5), Math.fround(joint.at[1] * 0.5), -0],
      rotation: turn([0, 1, 0], 0.05 * joint.name.length),
      scale: [1, 1, 1],
      mesh: -1,
      name: joint.name,
    })),
    {
      parent: 8,
      translation: [0, -0.1, 0.05],
      rotation: turn([1, 0, 0], 1.2),
      scale: [1, 1, 1],
      mesh: -1,
      name: 'grip.R',
    },
    {
      parent: -1,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      mesh: -1,
      name: 'Body',
    },
  ];
  const body = strip(12, 0, {
    joints: f32(Array.from({ length: 12 }, (_, i) => [i % 8, (i + 1) % 8, (i + 2) % 8, 0]).flat()),
    weights: f32(Array.from({ length: 12 }, () => [0.5, 0.3, 0.2, 0]).flat()),
    specular: f32(Array.from({ length: 12 }, (_, i) => 0.1 + i * 0.02)),
    roughness: f32(Array.from({ length: 12 }, (_, i) => 0.9 - i * 0.03)),
    grain: f32(Array.from({ length: 12 }, (_, i) => (i % 4) * 0.25)),
  });
  /*
   * Eight influences a vertex as `writeInfluences` leaves them: heaviest first, each its share of the
   * sum rounded to float32. Normalising such a set again moves a weight in its last place for about
   * 75 vertices in 100,000, measured over random weights; vertex 0 holds one of them, found by that
   * search, since the others here all happen to survive a second normalisation unchanged.
   */
  const moved = [0.5413334004307787, 0.5316242983246335, 0.48504037292908897, 0.19046104009750348];
  const tail = [
    0.11819725908255077, 0.07354781919789864, 0.04370113883339853, 0.009581942115715678,
  ];
  const shares = Array.from({ length: 9 }, (_, i) => {
    const raw =
      i === 0
        ? [...moved, ...tail]
        : [8 + i, 5 + 0.3 * i, 3.3, 2.9 - 0.1 * i, 1.7, 1.3, 0.7 + 0.05 * i, 0.1];
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map((r) => Math.fround(r / sum));
  });
  const head = strip(9, 2, {
    joints: f32(Array.from({ length: 9 }, () => [3, 2, 1, 0]).flat()),
    weights: f32(shares.map((w) => w.slice(0, 4)).flat()),
    joints2: f32(Array.from({ length: 9 }, () => [4, 5, 6, 7]).flat()),
    weights2: f32(shares.map((w) => w.slice(4)).flat()),
    emissiveColor: f32(Array.from({ length: 9 }, (_, i) => [1, 0.5, i * 0.1]).flat()),
    relief: f32(Array.from({ length: 9 }, (_, i) => i * 0.05)),
    layers: f32(Array.from({ length: 9 }, (_, i) => i % 3)),
    channel: f32(Array.from({ length: 9 }, (_, i) => [i * 0.1, 1, 1, 0]).flat()),
    morphTargets: f32(Array.from({ length: 9 * 2 * 3 }, (_, k) => Math.sin(k) * 0.01)),
    morphTargetCount: 2,
  });
  return {
    head: { name: 'character', generator: 'drft bake' },
    meshes: [body, head],
    quantise: false,
    materials: [
      material('cloth', { albedo: 0, normalMap: 1, reflectivity: Math.fround(0.1) }),
      material('skin', {
        emissive: Math.fround(0.4),
        emissiveColor: [1, 0.5, 0],
        doubleSided: true,
      }),
    ],
    textures: [
      { name: 'cloth_albedo.png', codec: CODEC_PNG, width: 4, height: 2, bytes: png(4, 2) },
      { name: 'cloth_normal.jpg', codec: CODEC_JPEG, width: 8, height: 4, bytes: jpeg(8, 4) },
    ],
    substances: [{ material: 0, substance: 'cotton' }],
    skins: [{ joints: JOINTS.map((j) => ({ name: j.name, parent: j.parent })), inverseBind }],
    clips: [clip('idle', 6, 0), clip('wave', 9, 0.5)],
    ...(withNodes ? { nodes } : {}),
    entities: {
      version: 1,
      schemas: { Manifest: { fields: { height: 'f32', skin: 'string' } } },
      entities: [
        { components: { Manifest: { height: 1.8, skin: 'default', tags: [1, -0, null] } } },
      ],
    },
  };
}

/** A box of eight corners and twelve triangles, one component, at `at`. */
function box(at: readonly [number, number, number], size: number, painted: boolean): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (let c = 0; c < 8; c++) {
    const corner = [c & 1 ? 1 : -1, c & 2 ? 1 : -1, c & 4 ? 1 : -1];
    positions.push(...corner.map((v, k) => (at[k] as number) + v * size));
    const length = Math.hypot(...corner);
    normals.push(...corner.map((v) => v / length));
    colors.push(...(painted ? [0.1 * c, 0.5, 0.3] : [0.5, 0.5, 0.5]));
  }
  const faces = [
    0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5,
    7, 1, 7, 3,
  ];
  return {
    positions: f32(positions),
    normals: f32(normals),
    colors: f32(colors),
    emissive: new Float32Array(8),
    indices: Uint32Array.from(faces),
  };
}

/** Eight copies' matrices along x, one of them holding a negative zero, which JSON would lose. */
function copies(count: number, step: number): Float32Array {
  const out = new Float32Array(count * 16);
  for (let k = 0; k < count; k++)
    out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, k * step, 0, -0, 1], k * 16);
  return out;
}

/** The float32 rotation turning local -z onto `direction`, as an exporter of lamps would write it. */
function towards(direction: readonly [number, number, number]): [number, number, number, number] {
  const [x, y, z] = direction;
  if (z > 1 - 1e-9) return [0, 1, 0, 0];
  const norm = Math.hypot(y, x, 1 - z);
  return [Math.fround(y / norm), Math.fround(-x / norm), 0, Math.fround((1 - z) / norm)];
}

/**
 * A level: a floor painted one colour, a pillar drawn three times, one region with two levels of
 * detail, a prop, an occluder and a collision mesh, two colliders, three lamps, a hierarchy naming
 * its meshes, an outline, a distance field, and the spawn and boundary data in its manifest.
 *
 * `lamps` says where the lamps' own nodes are. `'entries'` adds a `NODE` entry for each lamp under
 * the level's root, standing where it stands and turned the way it points, which is how a scene read
 * from glTF holds the nodes its lamps hung on; `'elsewhere'` adds them with one standing a metre
 * off, which is a node of the lamp's name and not the lamp's; `'none'` adds nothing.
 */
function level(lamps: 'entries' | 'elsewhere' | 'none' = 'none'): DrftSource {
  const unit = (v: readonly number[]): [number, number, number] => {
    const l = Math.hypot(...v);
    return [
      Math.fround((v[0] as number) / l),
      Math.fround((v[1] as number) / l),
      Math.fround((v[2] as number) / l),
    ];
  };
  const lights: DrftLight[] = [
    {
      kind: 'point',
      name: 'lamp',
      position: [1, 2.5, -0],
      direction: [0, 0, -1],
      color: [1, 0.8, 0.6],
      intensity: 800,
      range: 12,
      innerConeRad: 0,
      outerConeRad: Math.fround(Math.PI / 4),
    },
    {
      kind: 'spot',
      name: 'beam',
      position: [-2, 4, 1],
      direction: unit([0.3, -1, 0.2]),
      color: [0.9, 0.9, 1],
      intensity: 1500,
      range: 0,
      innerConeRad: Math.fround(0.2),
      outerConeRad: Math.fround(0.6),
    },
    {
      kind: 'directional',
      name: 'sun',
      position: [0, 0, 0],
      direction: unit([0.4, -0.8, -0.3]),
      color: [1, 1, 0.95],
      intensity: 3,
      range: 0,
      innerConeRad: 0,
      outerConeRad: Math.fround(Math.PI / 4),
    },
  ];
  const outline = box([0, 0.5, 0], 3, false);
  /* Not a power of two, so the entry's position comes back through the chain rounded. */
  const raised = Math.fround(0.3);
  const lampNodes: DrftNode[] = lights.map((light) => ({
    parent: 0,
    translation: [
      lamps === 'elsewhere' && light.name === 'beam' ? light.position[0] + 1 : light.position[0],
      Math.fround(light.position[1] - raised),
      light.position[2],
    ],
    rotation: towards(light.direction),
    scale: [1, 1, 1],
    mesh: -1,
    name: light.name,
  }));
  return {
    head: { name: 'level', generator: 'drft bake', unitScale: Math.fround(0.01) },
    meshes: [
      box([0, -0.1, 0], 5, false),
      box([2, 1, 2], 0.3, true),
      box([8, 0, 0], 1, true),
      box([8, 0, 0], 1.1, false),
      box([0, 0, 0], 0.2, true),
    ],
    quantise: false,
    materials: [
      material('floor', { color: [0.5, 0.5, 0.5], roughness: Math.fround(0.9) }),
      material('stone', { cutout: 0.5 }),
      material('house', {
        blend: true,
        opacity: Math.fround(0.5),
        transmission: Math.fround(0.8),
        frost: 0.25,
        tint: [0.9, 1, 0.9],
      }),
      material('house far', { ormMap: -1, reflectivity: 0.5 }),
      /* An opacity on an opaque material, which glTF ignores and an editor may write as one. */
      material('crate', { opacity: Math.fround(0.65) }),
    ],
    nodes: [
      {
        parent: -1,
        translation: [0, raised, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        mesh: -1,
        name: 'Level',
      },
      {
        parent: 0,
        translation: [0, -0.1, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        mesh: 0,
        name: 'Floor',
      },
      {
        parent: 0,
        translation: [2, 1, 2],
        rotation: turn([0, 1, 0], 0.4),
        scale: [2, 2, 2],
        mesh: 1,
        name: 'Pillar',
      },
      ...(lamps === 'none' ? [] : lampNodes),
    ],
    instances: [{ mesh: 1, transforms: copies(3, 4) }],
    regions: [
      {
        id: 7,
        bounds: f32([6, -1, -2, 10, 2, 2]),
        levels: [
          { error: 0, meshes: [2] },
          { error: Math.fround(0.5), meshes: [3] },
        ],
        instances: [{ mesh: 4, transforms: copies(2, 1.5) }],
        occluders: f32([7, -1, -1, 9, 1, 1]),
        collision: {
          positions: f32([6, 0, -2, 10, 0, -2, 10, 0, 2, 6, 0, 2]),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        },
      },
    ],
    lods: [outline],
    colliders: [box([0, -0.1, 0], 5, false).positions, f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])],
    lights,
    fields: [
      {
        mesh: 0,
        dims: [2, 2, 2],
        bounds: f32([-5, -5.1, -5, 5, 4.9, 5]),
        field: f32([-1, -0.5, 0, 0.5, 1, 1.5, 2, -0]),
      },
    ],
    entities: {
      version: 1,
      schemas: {
        Spawn: { fields: { x: 'f32', z: 'f32' } },
        Boundary: { fields: { min: 'vec3', max: 'vec3' } },
      },
      entities: [
        { components: { Spawn: { x: 1, z: -2, facing: 0.5 } } },
        { components: { Boundary: { min: [-10, 0, -10], max: [10, 5, 10] } } },
      ],
    },
  };
}

/** Every chunk as §4.2 lays it out, read from the table rather than through this repository's reader. */
function chunks(
  buffer: ArrayBuffer,
): { code: string; index: number; flags: number; bytes: number[] }[] {
  const view = new DataView(buffer);
  const out: { code: string; index: number; flags: number; bytes: number[] }[] = [];
  for (let i = 0; i < view.getUint32(12, true); i++) {
    const entry = 32 + i * 16;
    const offset = view.getUint32(entry + 4, true);
    out.push({
      code: String.fromCharCode(...new Uint8Array(buffer, entry, 4)),
      index: view.getUint16(entry + 14, true),
      flags: view.getUint16(entry + 12, true),
      bytes: Array.from(new Uint8Array(buffer, offset, view.getUint32(entry + 8, true))),
    });
  }
  return out;
}

/** Export, read with the glTF reader, and bake with the baker's own steps, as `drft bake` would. */
async function roundTrip(
  original: ArrayBuffer,
  quantise: boolean,
): Promise<{ glb: Uint8Array; baked: ArrayBuffer }> {
  const { glb } = drftToGlb(readDrft(original));
  /* No tangents derived in the reader, which is what the command asks: see `GltfReadOptions`. */
  const imported = await readModel({ name: 'exported.glb', bytes: glb, deriveTangents: false });
  const source = await bakeModel(imported, { name: 'exported', quantise });
  return { glb, baked: writeDrft(source) };
}

/** Chunk by chunk, so a failure names the chunk that moved rather than a byte offset in the file. */
function expectSameChunks(baked: ArrayBuffer, original: ArrayBuffer): void {
  const before = chunks(original);
  const after = chunks(baked);
  expect(after.map((c) => `${c.code}${c.index}`)).toEqual(before.map((c) => `${c.code}${c.index}`));
  before.forEach((chunk, i) => {
    expect(after[i], `${chunk.code} ${chunk.index}`).toEqual(chunk);
  });
}

describe('a .drft exported to glTF and baked again', () => {
  it('A CHARACTER COMES BACK WITH EVERY CHUNK EQUAL, BIT FOR BIT', async () => {
    const original = writeDrft(character(true));
    const { baked } = await roundTrip(original, false);
    expectSameChunks(baked, original);
    expect(chunks(original).map((c) => c.code)).toEqual(
      expect.arrayContaining([
        'HEAD',
        'MATL',
        'NODE',
        'SKIN',
        'ANIM',
        'ENTS',
        'MORP',
        'MESH',
        'TEXS',
        'SUBS',
      ]),
    );
  });

  it('A LEVEL COMES BACK WITH EVERY CHUNK EQUAL, BIT FOR BIT', async () => {
    const original = writeDrft(level('entries'));
    const { glb, baked } = await roundTrip(original, false);
    expectSameChunks(baked, original);
    expect(chunks(original).map((c) => c.code)).toEqual(
      expect.arrayContaining(['LODM', 'NODE', 'INST', 'LITE', 'ENTS', 'REGN', 'SDFV', 'COLL']),
    );
    /* Each lamp on the entry it hung on, which is one object of its name in an editor. */
    const { json } = readGlb(glb.slice().buffer);
    for (const name of ['lamp', 'beam', 'sun']) {
      const holders = (json.nodes ?? []).filter((node) => node.name === name);
      expect(holders).toHaveLength(1);
      expect(holders[0]?.extensions?.KHR_lights_punctual).toBeDefined();
    }
  });

  it('hangs lamps on nodes of their own unless every one stands on its entry, and brings them back', async () => {
    for (const [lamps, beams] of [
      ['none', 1],
      ['elsewhere', 2],
    ] as const) {
      const original = writeDrft(level(lamps));
      const { glb, baked } = await roundTrip(original, false);
      expectSameChunks(baked, original);
      const { json } = readGlb(glb.slice().buffer);
      expect((json.nodes ?? []).filter((node) => node.name === 'beam')).toHaveLength(beams);
    }
  });

  it('carries every chunk nobody edits, each by its own codec and back', async () => {
    /*
     * The level with one of each chunk that rides as its own bytes, each built as the format's own
     * tests build it: a network, a graph, a way across, a light volume, a decode program and a
     * nested level of detail. Two tables carry them, one a direction, and they must name the same.
     */
    expect(CARRIED_IN.map((entry) => entry.chunk)).toEqual(CARRIED_OUT.map((entry) => entry.chunk));
    const weights = Float32Array.from(
      { length: nnetWeightCount(3, [4], 2) },
      (_, at) => (at % 13) * 0.375 - 2,
    );
    const light = new Float32Array(12 * 4);
    light.set([1.5, 0.25, 3, 1], 5 * 4);
    const latent = Uint8Array.from({ length: 8 * 8 * 2 }, (_, at) => (at * 37) & 0xff);
    const original = writeDrft({
      ...level('entries'),
      networks: [{ role: 'TEST', inputs: 3, hidden: [4], outputs: 2, weights }],
      graphs: [
        {
          role: 'DEPT',
          inputs: [{ name: 'image', shape: [3, 4, 4] }],
          outputs: ['depth'],
          nodes: [
            { op: 'conv2d', inputs: ['image', 'w'], output: 'depth', attributes: { stride: 2 } },
          ],
          tensors: [
            {
              name: 'w',
              shape: [1, 3, 2, 2],
              data: Float32Array.from({ length: 12 }, (_, i) => i / 8),
            },
          ],
        },
      ],
      navigation: {
        vertices: Int32Array.from([0, 0, 4, 0, 4, 4, 0, 4, 8, 0, 8, 4]),
        vertexCount: 6,
        polys: Int32Array.from([0, 1, 2, 3, 1, 4, 5, 2]),
        neighbours: Int32Array.from([-1, 1, -1, -1, -1, -1, -1, 0]),
        polyCount: 2,
        maxVertsPerPoly: 4,
        polyRegion: Int32Array.from([1, 1]),
        originX: 12.5,
        originZ: -7.25,
        cellSize: 0.3,
      },
      lightVolume: {
        origin: [-12, 0, 40],
        spacing: 8,
        dims: [3, 2, 2],
        light,
        direction: new Float32Array(12 * 4),
      },
      dtex: [
        {
          material: 2,
          texture: {
            latentWidth: 8,
            latentHeight: 8,
            latentComponents: 2,
            channels: Uint32Array.from([(1 << 4) | 0, (4 << 4) | 1]),
            nodes: Uint32Array.from([0, 0, 0, 0, 1, 0, 0, 1]),
            resultRegister: 1,
            addressMode: 0,
            networkInputs: 2,
            networkOutputs: 2,
            hidden: new Uint32Array(0),
            weights: Float32Array.from([0.5, -0.25, 0.75, 0.125, 0.1, 0.2]),
            tileOffset: new Uint32Array(0),
            tileLength: new Uint32Array(0),
            tileHash: new Uint32Array(0),
            tileSize: 0,
            latent,
          },
        },
      ],
      levels: [new Uint8Array(writeDrft({ meshes: [box([0, 0, 0], 1, false)] }))],
    });
    expect(chunks(original).map((c) => c.code)).toEqual(
      expect.arrayContaining(['NNET', 'NGRF', 'NAVM', 'LVOL', 'DTEX', 'LODF']),
    );
    const { baked } = await roundTrip(original, false);
    expectSameChunks(baked, original);
  });

  it('comes back equal through quantised geometry too, which a second quantising does not move', async () => {
    for (const source of [character(true), level('entries')]) {
      const original = writeDrft({ ...source, quantise: true });
      const { baked } = await roundTrip(original, true);
      expectSameChunks(baked, original);
    }
  });

  it('comes back with no NODE when the joints were never entries, and the skin made up for glTF', async () => {
    const original = writeDrft(character(false));
    const { glb, baked } = await roundTrip(original, false);
    expectSameChunks(baked, original);
    const { json } = readGlb(glb.slice().buffer);
    expect(json.nodes?.filter((node) => node.name === 'hand.R')).toHaveLength(1);
    /*
     * The joints were made up for an editor, so they must stand where the rig is bound: each joint's
     * transform composed down its chain, times its inverse bind, is the identity. Within 1e-5, since
     * the pose is recovered from the inverse bind by an inversion and a decomposition in double.
     */
    const nodes = json.nodes ?? [];
    const joints = json.skins?.[0]?.joints ?? [];
    const parentOf = new Map<number, number>();
    nodes.forEach((node, at) => node.children?.forEach((child) => parentOf.set(child, at)));
    const world = (at: number): number[] => {
      const node = nodes[at];
      const [x = 0, y = 0, z = 0, w = 1] = node?.rotation ?? [];
      const local = compose(
        node?.translation ?? [0, 0, 0],
        quaternionMatrix([w, x, y, z]),
        node?.scale ?? [1, 1, 1],
      );
      const parent = parentOf.get(at);
      return parent === undefined ? local : multiply(world(parent), local);
    };
    const inverseBind = character(false).skins?.[0]?.inverseBind ?? new Float32Array(0);
    joints.forEach((node, j) => {
      const bound = multiply(world(node), Array.from(inverseBind.subarray(j * 16, j * 16 + 16)));
      bound.forEach((value, k) =>
        expect(Math.abs(value - (k % 5 === 0 ? 1 : 0))).toBeLessThan(1e-5),
      );
    });
  });
});

describe('the exported glTF, read by the glTF reader', () => {
  const exported = (): { json: ReturnType<typeof readGlb>['json']; binary: Uint8Array } => {
    const { json, binary } = readGlb(
      drftToGlb(readDrft(writeDrft(character(true)))).glb.slice().buffer,
    );
    if (binary === null) throw new Error('the export wrote no binary chunk');
    return { json, binary };
  };

  it('gives an armature the bone names and nesting the game binds by', () => {
    const { json, binary } = exported();
    const { skins, clips } = readGltfSkins(json, [binary]);
    expect(skins).toHaveLength(1);
    expect(skins[0]?.joints).toEqual(JOINTS.map((j) => ({ name: j.name, parent: j.parent })));
    expect(clips.map((c) => c.name)).toEqual(['idle', 'wave']);
  });

  it('hangs the attachment point from the joint it follows, and keeps the hierarchy as entries', () => {
    const { json, binary } = exported();
    const nodes = json.nodes ?? [];
    const hand = nodes.findIndex((node) => node.name === 'hand.R');
    const grip = nodes.findIndex((node) => node.name === 'grip.R');
    expect(json.skins?.[0]?.joints).toContain(hand);
    expect(nodes[hand]?.children).toEqual([grip]);
    const read = gltfToMeshes(json, [binary]);
    expect(read.nodes.map((n) => [n.name, read.nodes[n.parent]?.name ?? null])).toEqual(
      character(true).nodes?.map((n, _, all) => [n.name, all[n.parent]?.name ?? null]),
    );
  });
});

describe('a record restores only what nothing changed', () => {
  /** The exported document, with `edit` applied to its JSON, packed again around the same binary. */
  function edited(source: DrftSource, edit: (json: Record<string, unknown>) => void): Uint8Array {
    const { json, binary } = readGlb(drftToGlb(readDrft(writeDrft(source))).glb.slice().buffer);
    edit(json as unknown as Record<string, unknown>);
    /* The export's own serialiser, since `JSON.stringify` writes a negative zero as zero. */
    const text = new TextEncoder().encode(exactJson(json));
    const jsonLength = (text.length + 3) & ~3;
    const bin = binary ?? new Uint8Array(0);
    const out = new Uint8Array(20 + jsonLength + 8 + bin.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, out.length, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.set(text, 20);
    out.fill(0x20, 20 + text.length, 20 + jsonLength);
    view.setUint32(20 + jsonLength, bin.length, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    out.set(bin, 28 + jsonLength);
    return out;
  }

  it('puts meshes and nodes an editor saved in another order back where they were', async () => {
    /* Blender 5.2 saves a scene's objects and a node's children in an order of its own, measured;
       here both are reversed, and every region, placement, link and parent naming one by its
       position must still name it. */
    const original = writeDrft(level('entries'));
    const glb = edited(level('entries'), (json) => {
      const scene = (json['scenes'] as { nodes: number[] }[])[0] as { nodes: number[] };
      scene.nodes = [...scene.nodes.slice(0, 5).reverse(), ...scene.nodes.slice(5)];
      const nodes = json['nodes'] as { name?: string; children?: number[] }[];
      const root = nodes.find((node) => node.name === 'Level');
      if (root?.children === undefined) throw new Error('the level has no root with children');
      root.children.reverse();
    });
    const imported = await readModel({ name: 'edited.glb', bytes: glb, deriveTangents: false });
    expect(imported.warnings).toEqual([]);
    expectSameChunks(
      writeDrft(await bakeModel(imported, { name: 'x', quantise: false })),
      original,
    );
  });

  it("keeps a lamp's range when an editor with no field for one leaves it out", async () => {
    /* Blender 5.2 has no range, measured: it saves every lamp without one. */
    const original = writeDrft(level('entries'));
    const glb = edited(level('entries'), (json) => {
      const extensions = json['extensions'] as {
        KHR_lights_punctual: { lights: { range?: number }[] };
      };
      for (const light of extensions.KHR_lights_punctual.lights) delete light.range;
    });
    const imported = await readModel({ name: 'edited.glb', bytes: glb, deriveTangents: false });
    expect(imported.warnings).toEqual([]);
    expectSameChunks(
      writeDrft(await bakeModel(imported, { name: 'x', quantise: false })),
      original,
    );
  });

  it("keeps a record when an editor writes an opaque material's ignored alpha as one", async () => {
    /* What Blender 5.2 does, measured: glTF gives an `OPAQUE` material's alpha no meaning. */
    const original = writeDrft(level());
    const glb = edited(level(), (json) => {
      const crate = (
        json['materials'] as { pbrMetallicRoughness: { baseColorFactor: number[] } }[]
      )[4];
      if (crate === undefined) throw new Error('the fixture has no fifth material');
      crate.pbrMetallicRoughness.baseColorFactor[3] = 1;
    });
    const imported = await readModel({ name: 'edited.glb', bytes: glb, deriveTangents: false });
    expect(imported.warnings).toEqual([]);
    expectSameChunks(
      writeDrft(await bakeModel(imported, { name: 'x', quantise: false })),
      original,
    );
  });

  it('reads a material an editor recoloured from its glTF fields, and says so', async () => {
    const glb = edited(level(), (json) => {
      const materials = json['materials'] as {
        pbrMetallicRoughness: { baseColorFactor: number[] };
      }[];
      (
        materials[0] as { pbrMetallicRoughness: { baseColorFactor: number[] } }
      ).pbrMetallicRoughness.baseColorFactor = [1, 0, 0, 1];
    });
    const imported = await readModel({ name: 'edited.glb', bytes: glb, deriveTangents: false });
    expect(imported.materials?.[0]?.color).toEqual([1, 0, 0]);
    expect(imported.materials?.[0]?.specular).not.toBe(Math.fround(0.25));
    expect(imported.materials?.[1]?.specular).toBe(Math.fround(0.25));
    expect(imported.warnings.join('\n')).toMatch(/material "floor" was edited after export/);
  });

  it('leaves out an outline whose mesh an editor renumbered, and names it', async () => {
    /* An editor drops a mesh no node draws and renumbers the rest, so the record can point at a
       real mesh of the model; here it is pointed at the first. */
    const glb = edited(level(), (json) => {
      const scenes = json['scenes'] as { extras: { drift: string } }[];
      const scene = scenes[0] as { extras: { drift: string } };
      const record = JSON.parse(scene.extras.drift) as { outline: { mesh: number }[] };
      for (const level of record.outline) level.mesh = 0;
      scene.extras.drift = JSON.stringify(record);
    });
    const imported = await readModel({ name: 'edited.glb', bytes: glb, deriveTangents: false });
    expect(imported.carried?.outline).toBeUndefined();
    expect(imported.carried?.fields).toHaveLength(1);
    expect(imported.warnings.join('\n')).toMatch(/the carried outline is not among the meshes/);
  });

  it('leaves out a carried chunk whose bytes an editor rewrote, and names it', async () => {
    const glb = edited(level(), (json) => {
      const scenes = json['scenes'] as { extras: { drift: string } }[];
      const record = JSON.parse((scenes[0] as { extras: { drift: string } }).extras.drift) as {
        payloads: { chunk: string; hash: number }[];
      };
      for (const payload of record.payloads) if (payload.chunk === 'SDFV') payload.hash ^= 1;
      (scenes[0] as { extras: { drift: string } }).extras.drift = JSON.stringify(record);
    });
    const imported = await readModel({ name: 'edited.glb', bytes: glb, deriveTangents: false });
    expect(imported.carried?.fields).toBeUndefined();
    expect(imported.carried?.outline).toHaveLength(1);
    expect(imported.warnings.join('\n')).toMatch(/the carried SDFV is not in the buffer/);
  });
});
