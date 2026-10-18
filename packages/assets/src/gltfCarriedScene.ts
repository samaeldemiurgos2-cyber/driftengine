/**
 * The scene record of a document a `.drft` export wrote, read back to what a bake writes: the
 * asset's name and scale, its entity manifest, colliders, regions and instance groups, and the
 * chunks carried as their own bytes.
 *
 * **Shapes are checked here, meanings by the codec.** A region or an instance group goes through
 * `writeDrft`'s own checks when the bake writes it, and the manifest through the `ENTS` codec here,
 * so this module refuses only what could not be a number where a number belongs. A carried chunk is
 * restored only if its view still holds the bytes the record's length and hash describe; otherwise
 * the bake is told which chunk it lost, since an editor that rewrote the binary is the usual cause and
 * not a damaged file.
 */

import type { DrftInstanceGroup, DrftRegion, EntsScene, MeshData } from '@driftengine/drft';
import { buildEnts, readEnts } from '@driftengine/drft';
import { CARRIED_IN } from './carriedPayloads.ts';
import type { CarriedFields } from './carriedPayloads.ts';
import {
  DRIFT_EXTRAS_VERSION,
  malformed,
  meshDigest,
  payloadHash,
  readRecord,
} from './driftExtras.ts';
import type { GltfDocument } from './gltf.ts';

/** What a document carried for the asset as a whole, in the terms a bake writes. */
export interface DrftCarried extends CarriedFields {
  /** `HEAD`'s name and unit scale, as the exported file had them. */
  readonly name: string;
  readonly unitScale: number;
  /** The file named no materials, so none should be written. */
  readonly noMaterials: boolean;
  /** The file had no outline, so none should be built. */
  readonly noOutline: boolean;
  readonly entities?: EntsScene;
  readonly colliders?: readonly Float32Array[];
  readonly regions?: readonly DrftRegion[];
  readonly instances?: readonly DrftInstanceGroup[];
}

const WHERE = 'the scene';

function numbers(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw malformed(WHERE, `${field} is not a list of numbers`);
  }
  return value as number[];
}

function list(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw malformed(WHERE, `${field} is not a list`);
  return value;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function group(value: unknown, at: string): DrftInstanceGroup {
  const mesh = field(value, 'mesh');
  if (!Number.isInteger(mesh)) throw malformed(WHERE, `${at} names no mesh`);
  return {
    mesh: mesh as number,
    transforms: Float32Array.from(numbers(field(value, 'transforms'), `${at} transforms`)),
  };
}

function region(value: unknown, at: number): DrftRegion {
  const name = `region ${at}`;
  const id = field(value, 'id');
  if (!Number.isInteger(id)) throw malformed(WHERE, `${name} has no id`);
  const collision = field(value, 'collision');
  return {
    id: id as number,
    bounds: numbers(field(value, 'bounds'), `${name} bounds`),
    levels: list(field(value, 'levels'), `${name} levels`).map((level, l) => ({
      error: numbers([field(level, 'error')], `${name} level ${l} error`)[0] as number,
      meshes: numbers(field(level, 'meshes'), `${name} level ${l} meshes`),
    })),
    instances: list(field(value, 'instances'), `${name} instances`).map((g, i) =>
      group(g, `${name} group ${i}`),
    ),
    occluders: Float32Array.from(numbers(field(value, 'occluders'), `${name} occluders`)),
    collision:
      collision === undefined
        ? null
        : {
            positions: Float32Array.from(
              numbers(field(collision, 'positions'), `${name} collision`),
            ),
            indices: Uint32Array.from(numbers(field(collision, 'indices'), `${name} collision`)),
          },
  };
}

/** The scene's record read back, or undefined for a document no `.drft` export wrote. */
export function readCarried(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  warnings: string[],
  /** A glTF mesh no node names, as the reader reads any mesh, or null where it is not one. */
  readMesh: (index: number) => MeshData | null,
): DrftCarried | undefined {
  const raw = readRecord(doc.scenes?.[doc.scene ?? 0]?.extras, WHERE);
  if (raw === undefined) return undefined;
  const version = raw['version'];
  if (typeof version !== 'number' || version > DRIFT_EXTRAS_VERSION) {
    warnings.push(
      `the scene record is version ${String(version)}, newer than ${DRIFT_EXTRAS_VERSION}; ` +
        'what this reader knows of it is read',
    );
  }
  const name = raw['name'];
  if (typeof name !== 'string') throw malformed(WHERE, 'name is not text');
  const entities = raw['entities'];
  let carried: DrftCarried = {
    name,
    unitScale: numbers([raw['unitScale']], 'unitScale')[0] as number,
    noMaterials: raw['noMaterials'] === true,
    noOutline: raw['noOutline'] === true,
    /* Through the chunk's own codec, so a manifest the bake could not write is refused here. */
    ...(entities === undefined ? {} : { entities: readEntsOf(entities) }),
    ...(raw['colliders'] === undefined
      ? {}
      : {
          colliders: list(raw['colliders'], 'colliders').map((hull, h) =>
            Float32Array.from(numbers(hull, `collider ${h}`)),
          ),
        }),
    ...(raw['regions'] === undefined
      ? {}
      : { regions: list(raw['regions'], 'regions').map((r, at) => region(r, at)) }),
    ...(raw['instances'] === undefined
      ? {}
      : {
          instances: list(raw['instances'], 'instances').map((g, at) => group(g, `group ${at}`)),
        }),
  };
  for (const payload of list(raw['payloads'], 'payloads')) {
    carried = restorePayload(doc, buffers, payload, carried, warnings);
  }
  const outline = outlineOf(list(raw['outline'], 'outline'), readMesh, warnings);
  return outline === null ? carried : { ...carried, outline };
}

/**
 * The outline's levels, read from the meshes the record names, or null where there are none or
 * any is no longer the mesh it was written as. All or nothing, since an outline missing a level is a
 * different outline, and a bake then builds its own from what it holds.
 */
function outlineOf(
  records: readonly unknown[],
  readMesh: (index: number) => MeshData | null,
  warnings: string[],
): MeshData[] | null {
  if (records.length === 0) return null;
  const levels: MeshData[] = [];
  for (const [k, record] of records.entries()) {
    const [mesh, hash] = numbers([field(record, 'mesh'), field(record, 'hash')], `outline ${k}`);
    const level = readMesh(mesh as number);
    if (level === null || meshDigest(level) !== hash) {
      warnings.push(
        'the carried outline is not among the meshes it was written as, which an editor that drops ' +
          'a mesh no node draws does; it is not restored',
      );
      return null;
    }
    levels.push(level);
  }
  return levels;
}

function readEntsOf(scene: unknown): EntsScene {
  const bytes = buildEnts(scene as EntsScene);
  return readEnts(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

function restorePayload(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  payload: unknown,
  into: DrftCarried,
  warnings: string[],
): DrftCarried {
  const chunk = field(payload, 'chunk');
  const codec = CARRIED_IN.find((entry) => entry.chunk === chunk);
  const [view, length, hash] = numbers(
    [field(payload, 'view'), field(payload, 'length'), field(payload, 'hash')],
    `payload ${String(chunk)}`,
  );
  if (codec === undefined) throw malformed(WHERE, `"${String(chunk)}" is not a carried chunk`);
  const entry = doc.bufferViews?.[view as number];
  const buffer = entry === undefined ? undefined : buffers[entry.buffer];
  const at = entry?.byteOffset ?? 0;
  const bytes = buffer?.subarray(at, at + (entry?.byteLength ?? 0));
  if (bytes === undefined || bytes.length !== length || payloadHash(bytes) !== hash) {
    warnings.push(
      `the carried ${codec.chunk} is not in the buffer it was written to, which an editor that ` +
        'rewrote the binary does; it is not restored',
    );
    return into;
  }
  /* Copied to a buffer of its own, so its views start aligned whatever the host's buffer is. */
  return { ...into, ...codec.give(bytes.slice().buffer, into) };
}
