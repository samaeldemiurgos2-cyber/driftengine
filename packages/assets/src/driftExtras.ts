/**
 * The records a `.drft` exported to glTF leaves in `extras.drift`, as both directions read them.
 *
 * `gltfExport*.ts` writes these and `gltfCarried*.ts` read them back, so the names, the shapes and
 * the hashes live here once and the two halves cannot disagree about a key.
 *
 * **Extras rather than a `DRIFT_*` extension, and that was measured rather than assumed.** Blender
 * 5.2's glTF importer keeps `extras` on scenes, nodes, meshes and materials as custom properties and
 * its exporter writes them back when asked to (`export_extras`); it drops every extension it does not
 * know, and it keeps a mesh's underscore attributes. So an artist who opens an exported
 * asset, improves it and exports it again hands the baker back the entity manifest, the colliders and
 * the regions, which an extension would have lost on the first save. What it gives up is a
 * validator's knowledge of the shape, which an extension's schema would have given.
 *
 * **Every record is one string of JSON under one key.** A custom property is a typed value of
 * Blender's own, with no null and a list of numbers kept as one array type, while a string comes back
 * byte for byte, measured; a consumer's entity components are whatever that consumer wrote, so only
 * the string is safe for them, and one rule for every record is simpler than two.
 *
 * **A record is a copy and never an authority.** It restores what glTF rounds or has no field for,
 * and only where the glTF fields written beside it still say what the exporter wrote. An edit made in
 * an editor that keeps extras therefore wins over the copy, and the copy is used only where nothing
 * changed. What would make that wrong is an editor that rewrites an unedited field, which costs the
 * copy rather than the edit.
 */

import type { DrftMaterial, MeshData } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import { exactJson } from './glbWrite.ts';

/** The key every record sits under, in whichever object's `extras` it belongs to. */
export const DRIFT_EXTRAS = 'drift';

/** This mapping's version. A scene record from a newer one is read for what this version knows. */
export const DRIFT_EXTRAS_VERSION = 1;

/**
 * The engine's own per-vertex attributes, which glTF has no semantic for, as application-specific
 * attributes. The underscore is the specification's prefix for exactly this, and it is what Blender
 * keeps as a generic attribute. The order is `MeshData`'s, which is the order they are written in.
 */
export const ENGINE_ATTRIBUTES = [
  { name: 'emissive', gltf: '_EMISSIVE', type: 'SCALAR' },
  { name: 'specular', gltf: '_SPECULAR', type: 'SCALAR' },
  { name: 'emissiveColor', gltf: '_EMISSIVE_COLOR', type: 'VEC3' },
  { name: 'roughness', gltf: '_ROUGHNESS', type: 'SCALAR' },
  { name: 'grain', gltf: '_GRAIN', type: 'SCALAR' },
  { name: 'relief', gltf: '_RELIEF', type: 'SCALAR' },
  { name: 'layers', gltf: '_LAYERS', type: 'SCALAR' },
  { name: 'channel', gltf: '_CHANNEL', type: 'VEC4' },
] as const;

export type EngineAttribute = (typeof ENGINE_ATTRIBUTES)[number]['name'];

/** A mesh this engine wrote: which engine attributes its primitive carries. */
export interface MeshRecord {
  /**
   * The `.drft` ordinal it was written from. Blender 5.2 saves meshes in an order of its own, and a
   * material, an instance group, a region and a node all name a mesh by its ordinal, so the reader
   * puts recorded meshes back in this order.
   */
  readonly ordinal: number;
  readonly attributes: readonly EngineAttribute[];
}

/** A node the export made up, which is no `NODE` entry and is left out of the hierarchy read back. */
export type InventedRole = 'mesh' | 'joint' | 'light';

/**
 * A light's placement and cone, which a node's transform rounds and a point light's fields lack.
 *
 * Restored where glTF still places the light within `LIGHT_ROUNDING` of it, since that is what
 * composing the node's matrix moves: a light on a node of its own at the root differs only in the
 * sign of a zero, and one on its entry by the rounding of that entry's chain of transforms.
 */
export interface LightRecord {
  /** Its position in `LITE`, which follows the walk otherwise, and an editor's order of children. */
  readonly ordinal: number;
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly innerConeRad: number;
  readonly outerConeRad: number;
  /** Where the light is cut off, which Blender 5.2 has no field for and leaves out of what it saves. */
  readonly range: number;
}

/**
 * How far glTF may place a light from its record and still be the record's, rounded.
 *
 * `direction` is absolute: a float32 quaternion is within 2^-24 of the exact one in each component,
 * which moves the direction it encodes by about 2.4e-7, and composing a chain of float32 transforms
 * adds as much again a link. `position` is relative to the larger of one and the coordinate, for the
 * same chain. Both are far below any move an artist makes, so a light this close is the record's and
 * anything further is an edit. The export hangs a light on an entry only within half of each, which
 * leaves the reader's own arithmetic the other half.
 */
export const LIGHT_ROUNDING = { direction: 1e-6, position: 1e-6 } as const;

/** Equal to within `relative` of the larger magnitude, or of one where both are near zero. */
export function within(a: number, b: number, relative: number): boolean {
  return Math.abs(a - b) <= relative * Math.max(1, Math.abs(a), Math.abs(b));
}

/** A node: a `NODE` entry naming its mesh, or one the export invented. */
export interface NodeRecord {
  /**
   * An entry's position in `NODE`. Blender 5.2 saves a node's children in an order of its own, and
   * the reader puts recorded entries back in this one, so a consumer holding an entry's index, as a
   * manifest may, still holds the same entry.
   */
  readonly entry?: number;
  readonly mesh?: number;
  readonly invented?: InventedRole;
  readonly light?: LightRecord;
}

/** A material: every field `MATL` holds, and whether its glTF colour was left to the vertices. */
export interface MaterialRecord {
  readonly material: DrftMaterial;
  readonly vertexColours: boolean;
}

/** A clip whose duration is not its last key's time, which is all glTF can say about one. */
export interface ClipRecord {
  readonly durationSec: number;
}

/** A chunk carried as its own bytes in a buffer view, with what proves the view still holds it. */
export interface PayloadRecord {
  /** The FourCC it is restored as. */
  readonly chunk: string;
  readonly view: number;
  readonly length: number;
  readonly hash: number;
}

/**
 * One level of the coarse outline, as a glTF mesh no node draws, with what proves it still is one.
 *
 * A mesh rather than a nested container, because the export already writes meshes and the reader
 * already reads them, where reading a container would put the whole of `readDrft` into every
 * `readModel` bundle for the sake of one chunk. A viewer draws no mesh a node does not name, which is
 * right for a preview of the model sitting over the model.
 */
export interface OutlineRecord {
  readonly mesh: number;
  /** `meshDigest` of the level, since an editor drops a mesh no node names and renumbers the rest. */
  readonly hash: number;
}

/** Meshes drawn many times, as `INST` holds them. */
export interface GroupRecord {
  readonly mesh: number;
  readonly transforms: readonly number[];
}

/** One region of a streamed world, as `REGN` holds it. */
export interface RegionRecord {
  readonly id: number;
  readonly bounds: readonly number[];
  readonly levels: readonly { readonly error: number; readonly meshes: readonly number[] }[];
  readonly instances: readonly GroupRecord[];
  readonly occluders: readonly number[];
  readonly collision?: {
    readonly positions: readonly number[];
    readonly indices: readonly number[];
  };
}

/** What the asset holds that no glTF object has a place for. On the scene, which every editor keeps. */
export interface SceneRecord {
  readonly version: number;
  /** `HEAD`'s name and unit scale; the bounds are measured again from the geometry. */
  readonly name: string;
  readonly unitScale: number;
  /** Set when the file named no materials, so a bake does not invent a `MATL` for it. */
  readonly noMaterials?: true;
  /** Set when the file had no coarse outline, so a bake does not build one it never had. */
  readonly noOutline?: true;
  readonly outline?: readonly OutlineRecord[];
  readonly entities?: unknown;
  readonly colliders?: readonly (readonly number[])[];
  readonly regions?: readonly RegionRecord[];
  readonly instances?: readonly GroupRecord[];
  readonly payloads?: readonly PayloadRecord[];
}

/** `extras` holding one record, ready to spread beside any other extras an object has. */
export function recordExtras(record: object): { [DRIFT_EXTRAS]: string } {
  return { [DRIFT_EXTRAS]: exactJson(record) };
}

/**
 * The record in an object's `extras`, parsed, or undefined where there is none.
 *
 * Text that is not JSON is refused rather than skipped: a record is only ever written by the export,
 * so one that does not parse is a damaged file, and reading on without it would quietly drop what the
 * record carried.
 */
export function readRecord(extras: unknown, where: string): Record<string, unknown> | undefined {
  if (typeof extras !== 'object' || extras === null) return undefined;
  const text = (extras as Record<string, unknown>)[DRIFT_EXTRAS];
  if (typeof text !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw malformed(where, (error as Error).message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformed(where, 'it is not an object');
  }
  return parsed as Record<string, unknown>;
}

/** The refusal every reader of a record shares, so each names the object it was reading. */
export function malformed(where: string, why: string): DrftError {
  return new DrftError(`gltf: the drift record on ${where} is malformed: ${why}`);
}

/**
 * FNV-1a over a payload's bytes, which is how a carried chunk proves its view still holds it.
 *
 * Blender drops a buffer view that only `extras` names, and renumbers the rest, so a record that
 * survives an editor can point at a view now holding somebody else's bytes. A length and a hash catch
 * that; a cryptographic hash would catch a forger, and nobody is forging a level.
 */
export function payloadHash(bytes: Uint8Array, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < bytes.length; i++) {
    hash = Math.imul(hash ^ (bytes[i] as number), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The same hash over a mesh's positions and then its indices: enough to tell one mesh from another,
 * which is all an outline's record asks of it, and nothing an attribute an editor adds can move.
 */
export function meshDigest(mesh: MeshData): number {
  const { positions, indices } = mesh;
  const seed = payloadHash(
    new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength),
  );
  return payloadHash(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), seed);
}
