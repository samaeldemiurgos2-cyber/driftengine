/**
 * One `.drft` mesh as one glTF primitive: the attributes glTF has a name for under that name, and
 * the engine's own under an underscore.
 *
 * **One primitive a glTF mesh, and the mesh's ordinal is its position.** A `.drft` pairs a material,
 * a morph chunk, an instance group and a region's level with a mesh by ordinal, so the export keeps
 * one glTF mesh per `.drft` mesh in the same order, and `gltf.ts` reads them back in that order.
 *
 * **Every value goes out as the float32 the file held.** A mesh this engine wrote is already welded,
 * normalised and sorted, so the record this module leaves tells the reader to take its arrays as
 * written rather than to normalise them again, which would round.
 */

import type { DrftMaterial, MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import { ENGINE_ATTRIBUTES, recordExtras } from './driftExtras.ts';
import type { EngineAttribute, MeshRecord } from './driftExtras.ts';
import { FLOAT, UNSIGNED_BYTE, UNSIGNED_INT, UNSIGNED_SHORT, addAccessor } from './glbWrite.ts';
import type { GlbParts } from './glbWrite.ts';

/** A glTF mesh as written, with the one fact the material needs from its vertices. */
export interface WrittenMesh {
  readonly json: Record<string, unknown>;
  /** Whether the colours went out as `COLOR_0`, which leaves `baseColorFactor` white. */
  readonly vertexColours: boolean;
}

/**
 * `mesh` into `parts`, as glTF mesh JSON naming material `ordinal` when the file has `material`.
 *
 * The colour a mesh is compared with is the material's, or white for a file with no materials,
 * which is what the reader paints a mesh with no `COLOR_0`.
 */
export function writeMesh(
  parts: GlbParts,
  mesh: MeshData,
  ordinal: number,
  name: string,
  material: DrftMaterial | undefined,
): WrittenMesh {
  const vertices = mesh.positions.length / 3;
  const attributes: Record<string, number> = {
    POSITION: addAccessor(parts, mesh.positions, 'VEC3', FLOAT, 'vertex', true),
    NORMAL: addAccessor(parts, mesh.normals, 'VEC3', FLOAT, 'vertex'),
  };
  const colour = material?.color ?? [1, 1, 1];
  /*
   * Left out where every vertex holds the material's colour, which is a mesh the reader painted from
   * its material in the first place: the factor then carries it, and an artist recolours the surface
   * by changing one field rather than every vertex.
   */
  const vertexColours = !uniformColour(mesh.colors, colour);
  if (vertexColours)
    attributes['COLOR_0'] = addAccessor(parts, mesh.colors, 'VEC3', FLOAT, 'vertex');
  /* One set of coordinates: `MESH` has no bit for a second, so a mesh read from a file never holds
     a lightmap's, and `docs/CAPABILITIES.md` keeps that absence under a sentinel. */
  if (mesh.uvs !== undefined) {
    attributes['TEXCOORD_0'] = addAccessor(parts, mesh.uvs, 'VEC2', FLOAT, 'vertex');
  }
  if (mesh.tangents !== undefined) {
    attributes['TANGENT'] = addAccessor(parts, mesh.tangents, 'VEC4', FLOAT, 'vertex');
  }
  if (mesh.joints !== undefined && mesh.weights !== undefined) {
    const type = jointType(mesh, ordinal);
    attributes['JOINTS_0'] = addAccessor(parts, mesh.joints, 'VEC4', type, 'vertex');
    attributes['WEIGHTS_0'] = addAccessor(parts, mesh.weights, 'VEC4', FLOAT, 'vertex');
    if (mesh.joints2 !== undefined && mesh.weights2 !== undefined) {
      attributes['JOINTS_1'] = addAccessor(parts, mesh.joints2, 'VEC4', type, 'vertex');
      attributes['WEIGHTS_1'] = addAccessor(parts, mesh.weights2, 'VEC4', FLOAT, 'vertex');
    }
  }
  const carried: EngineAttribute[] = [];
  for (const entry of ENGINE_ATTRIBUTES) {
    const values = mesh[entry.name];
    if (values === undefined) continue;
    attributes[entry.gltf] = addAccessor(parts, values, entry.type, FLOAT, 'vertex');
    carried.push(entry.name);
  }

  /* `0xFFFF` is the restart value for 16-bit indices, which glTF forbids an index to hold. */
  const narrow = vertices < 0xffff;
  const indices = addAccessor(
    parts,
    mesh.indices,
    'SCALAR',
    narrow ? UNSIGNED_SHORT : UNSIGNED_INT,
    'index',
  );
  const primitive: Record<string, unknown> = {
    attributes,
    indices,
    ...(material === undefined ? {} : { material: ordinal }),
    ...morphTargets(parts, mesh, vertices),
  };
  const record: MeshRecord = { ordinal, attributes: carried };
  return {
    json: { name, primitives: [primitive], extras: recordExtras(record) },
    vertexColours,
  };
}

function uniformColour(colors: Float32Array, colour: readonly number[]): boolean {
  const r = Math.fround(colour[0] as number);
  const g = Math.fround(colour[1] as number);
  const b = Math.fround(colour[2] as number);
  for (let i = 0; i < colors.length; i += 3) {
    if (colors[i] !== r || colors[i + 1] !== g || colors[i + 2] !== b) return false;
  }
  return true;
}

/**
 * The narrowest unsigned type every joint index fits, checked whole on the way.
 *
 * `MeshData` holds joints as floats, and glTF holds them as integers, so a fractional or negative
 * one has no glTF form: it is a damaged mesh, and refusing it names the mesh where a truncation would
 * quietly move a vertex to another joint.
 */
function jointType(mesh: MeshData, ordinal: number): number {
  let largest = 0;
  for (const set of [mesh.joints, mesh.joints2]) {
    if (set === undefined) continue;
    for (let i = 0; i < set.length; i++) {
      const joint = set[i] as number;
      if (!Number.isInteger(joint) || joint < 0 || joint > 0xffff) {
        throw new DrftError(`mesh ${ordinal} names joint ${joint}, which no glTF index can hold`);
      }
      if (joint > largest) largest = joint;
    }
  }
  return largest < 0x100 ? UNSIGNED_BYTE : UNSIGNED_SHORT;
}

/** The largest joint index a mesh names, which decides the skin it can be deformed by. */
export function largestJoint(mesh: MeshData): number {
  let largest = -1;
  for (const set of [mesh.joints, mesh.joints2]) {
    if (set === undefined) continue;
    for (let i = 0; i < set.length; i++) largest = Math.max(largest, set[i] as number);
  }
  return largest;
}

/**
 * Morph deltas, one `POSITION` accessor a target as glTF stores them.
 *
 * `MeshData` interleaves them by vertex, every target of one vertex adjacent, because the shader
 * fetches them together; glTF keeps one array a target. This is the transposition `gltf.ts` undoes.
 */
function morphTargets(
  parts: GlbParts,
  mesh: MeshData,
  vertices: number,
): { targets?: Record<string, number>[] } {
  const count = mesh.morphTargetCount ?? 0;
  if (mesh.morphTargets === undefined || count === 0) return {};
  const targets: Record<string, number>[] = [];
  for (let t = 0; t < count; t++) {
    const deltas = new Float32Array(vertices * 3);
    for (let v = 0; v < vertices; v++) {
      const from = (v * count + t) * 3;
      deltas[v * 3] = mesh.morphTargets[from] as number;
      deltas[v * 3 + 1] = mesh.morphTargets[from + 1] as number;
      deltas[v * 3 + 2] = mesh.morphTargets[from + 2] as number;
    }
    targets.push({ POSITION: addAccessor(parts, deltas, 'VEC3', FLOAT, 'vertex', true) });
  }
  return { targets };
}
