/**
 * Reading back the records a `.drft` export left on glTF's nodes, meshes, materials, lights and
 * animations: what `gltf.ts` and `gltfSkin.ts` consult for a document this engine wrote.
 *
 * Each function returns the reading it was given wherever there is no record, so a document from any
 * other exporter reads exactly as it always has. Where there is one, it restores what glTF rounds or
 * has no field for, and only while the glTF fields beside it still say what the export wrote: the
 * rule `driftExtras.ts` states and every function here applies to its own object.
 *
 * A record that does not parse, or names something of the wrong type, is refused by name. Records
 * are only ever written by the export, so a damaged one is a damaged file.
 */

import type { DrftLight, DrftMaterial, MeshData } from '@driftengine/drft';
import { ENGINE_ATTRIBUTES, LIGHT_ROUNDING, malformed, readRecord, within } from './driftExtras.ts';
import type { EngineAttribute, LightRecord, MeshRecord, NodeRecord } from './driftExtras.ts';
import type { GltfDocument, GltfMaterial } from './gltf.ts';
import { accessorFloats } from './gltfAccessor.ts';
import { gltfMaterialOf, sameStandardFields } from './gltfMaterialOut.ts';

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function triple(value: unknown, where: string, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isNumber)) {
    throw malformed(where, `${field} is not three numbers`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function number(value: unknown, where: string, field: string): number {
  if (!isNumber(value)) throw malformed(where, `${field} is not a number`);
  return value;
}

/** A node's record: whether the export invented it, the mesh it names, and a light's direction. */
export function nodeRecord(extras: unknown, index: number): NodeRecord | undefined {
  const where = `node ${index}`;
  const raw = readRecord(extras, where);
  if (raw === undefined) return undefined;
  const invented = raw['invented'];
  if (
    invented !== undefined &&
    invented !== 'mesh' &&
    invented !== 'joint' &&
    invented !== 'light'
  ) {
    throw malformed(where, `"${String(invented)}" is not a role the export invents`);
  }
  const mesh = raw['mesh'];
  if (mesh !== undefined && !(Number.isInteger(mesh) && (mesh as number) >= 0)) {
    throw malformed(where, 'its mesh is not an ordinal');
  }
  const entry = raw['entry'];
  if (entry !== undefined && !(Number.isInteger(entry) && (entry as number) >= 0)) {
    throw malformed(where, 'its entry is not a position');
  }
  const light = raw['light'] as Record<string, unknown> | undefined;
  const lightRecord: LightRecord | undefined =
    light === undefined
      ? undefined
      : {
          ordinal: number(light['ordinal'], where, 'ordinal'),
          position: triple(light['position'], where, 'position'),
          direction: triple(light['direction'], where, 'direction'),
          innerConeRad: number(light['innerConeRad'], where, 'innerConeRad'),
          outerConeRad: number(light['outerConeRad'], where, 'outerConeRad'),
          range: number(light['range'], where, 'range'),
        };
  return {
    ...(invented === undefined ? {} : { invented }),
    ...(entry === undefined ? {} : { entry: entry as number }),
    ...(mesh === undefined ? {} : { mesh: mesh as number }),
    ...(lightRecord === undefined ? {} : { light: lightRecord }),
  };
}

/** A mesh's record: the engine attributes its primitive was written with. */
export function meshRecord(extras: unknown, index: number): MeshRecord | undefined {
  const where = `mesh ${index}`;
  const raw = readRecord(extras, where);
  if (raw === undefined) return undefined;
  const listed = raw['attributes'];
  const known = new Set<string>(ENGINE_ATTRIBUTES.map((entry) => entry.name));
  if (!Array.isArray(listed) || !listed.every((name) => known.has(name as string))) {
    throw malformed(where, 'its attributes are not the engine attributes');
  }
  const ordinal = raw['ordinal'];
  if (!Number.isInteger(ordinal) || (ordinal as number) < 0) {
    throw malformed(where, 'its ordinal is not one');
  }
  return { ordinal: ordinal as number, attributes: listed as EngineAttribute[] };
}

/**
 * The engine attributes a record lists, read from their underscore accessors, or null where any is
 * missing or short.
 *
 * Null rather than a partial set, because an editor that dropped one may have dropped them all for
 * a reason the reader cannot see, and the material's own reading is then the honest one; the caller
 * says so. An attribute the record does not list is absent, as it was in the file, rather than
 * filled from the material, which would add an array the file never had.
 */
export function carriedAttributes(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  attributes: Readonly<Record<string, number>>,
  record: MeshRecord,
  vertices: number,
  label: string,
): Partial<MeshData> | null {
  if (!record.attributes.includes('emissive')) return null;
  const out: Record<string, Float32Array> = {};
  for (const entry of ENGINE_ATTRIBUTES) {
    if (!record.attributes.includes(entry.name)) continue;
    const accessor = attributes[entry.gltf];
    if (accessor === undefined) return null;
    const values = accessorFloats(doc, buffers, accessor, `${label} ${entry.gltf}`);
    const width = entry.type === 'SCALAR' ? 1 : entry.type === 'VEC3' ? 3 : 4;
    if (values.length !== vertices * width) return null;
    out[entry.name] = values;
  }
  return out as Partial<MeshData>;
}

/**
 * The material a record carries, where the glTF fields still say what the export made of it;
 * otherwise `standard`, the reading `gltf.ts` makes of those fields.
 *
 * The name is glTF's either way, since renaming a material is an edit that changes nothing else.
 */
export function restoreMaterial(
  gltf: GltfMaterial | undefined,
  standard: DrftMaterial,
  where: string,
  warnings: string[],
): DrftMaterial {
  if (gltf === undefined) return standard;
  const raw = readRecord(gltf.extras, where);
  if (raw === undefined) return standard;
  const carried = materialFrom(raw['material'], where);
  const vertexColours = raw['vertexColours'];
  if (typeof vertexColours !== 'boolean') throw malformed(where, 'vertexColours is not a flag');
  if (!sameStandardFields(gltf, gltfMaterialOf(carried, vertexColours))) {
    warnings.push(`${where} was edited after export, so it is read from its glTF fields alone`);
    return standard;
  }
  return { ...carried, name: gltf.name ?? carried.name };
}

function materialFrom(value: unknown, where: string): DrftMaterial {
  if (typeof value !== 'object' || value === null) throw malformed(where, 'it holds no material');
  const m = value as Record<string, unknown>;
  const flag = (field: string): boolean | undefined => {
    const v = m[field];
    if (v !== undefined && typeof v !== 'boolean') throw malformed(where, `${field} is not a flag`);
    return v;
  };
  if (typeof m['name'] !== 'string') throw malformed(where, 'name is not text');
  const blend = flag('blend');
  const doubleSided = flag('doubleSided');
  const n = (field: string): number => number(m[field], where, field);
  return {
    name: m['name'],
    color: triple(m['color'], where, 'color'),
    specular: n('specular'),
    roughness: n('roughness'),
    emissive: n('emissive'),
    emissiveColor: triple(m['emissiveColor'], where, 'emissiveColor'),
    opacity: n('opacity'),
    albedo: n('albedo'),
    normalMap: n('normalMap'),
    ormMap: n('ormMap'),
    emissiveMap: n('emissiveMap'),
    roughnessScale: n('roughnessScale'),
    metallicScale: n('metallicScale'),
    occlusionStrength: n('occlusionStrength'),
    reflectivity: n('reflectivity'),
    cutout: n('cutout'),
    ...(blend === undefined ? {} : { blend }),
    ...(doubleSided === undefined ? {} : { doubleSided }),
    ...(m['transmission'] === undefined ? {} : { transmission: n('transmission') }),
    ...(m['frost'] === undefined ? {} : { frost: n('frost') }),
    ...(m['tint'] === undefined ? {} : { tint: triple(m['tint'], where, 'tint') }),
  };
}

/**
 * A light with the placement and cone its record carries, where glTF still places it there.
 *
 * Compared where the reader placed it, in the asset's space, so a lamp moved by moving its parent is
 * an edit like any other, and within `LIGHT_ROUNDING`, which is what composing its node's transforms
 * moves it by. A point or directional light's cone has no glTF field at all, so the record's always
 * stands, and a spot's is glTF's own. A range glTF leaves out is the record's, since an editor that
 * has no field for one, as Blender has none, leaves it out of what it saves.
 */
export function restoreLight(placed: DrftLight, record: LightRecord | undefined): DrftLight {
  if (record === undefined) return placed;
  const unmoved = record.position.every((value, i) =>
    within(value, placed.position[i] ?? 0, LIGHT_ROUNDING.position),
  );
  const unturned = record.direction.every(
    (value, i) => Math.abs(value - (placed.direction[i] ?? 0)) <= LIGHT_ROUNDING.direction,
  );
  return {
    ...placed,
    position: unmoved ? record.position : placed.position,
    direction: unturned ? record.direction : placed.direction,
    range: placed.range > 0 ? placed.range : record.range,
    ...(placed.kind === 'spot'
      ? {}
      : { innerConeRad: record.innerConeRad, outerConeRad: record.outerConeRad }),
  };
}

/**
 * A clip's duration: the record's where it holds past the last key, which glTF cannot say, and the
 * last key's time otherwise. A record shorter than the keys is one an editor outgrew.
 */
export function restoreDuration(extras: unknown, lastKey: number, where: string): number {
  const raw = readRecord(extras, where);
  if (raw === undefined) return lastKey;
  const duration = number(raw['durationSec'], where, 'durationSec');
  return Math.fround(duration) >= Math.fround(lastKey) ? duration : lastKey;
}

/**
 * Whether two influence sets are already what `writeInfluences` makes: heaviest first across both,
 * none negative, and every weighted vertex summing to one.
 *
 * A mesh this engine wrote is, so it is taken as it is rather than normalised again, which rounds a
 * sum that was one in float32 into a different float32. A set an editor reordered is not, and goes
 * through `writeInfluences` like any other file's.
 */
export function inContract(sets: readonly { weights: Float32Array }[]): boolean {
  const first = sets[0]?.weights;
  if (first === undefined) return false;
  for (let v = 0; v < first.length / 4; v++) {
    let previous = Infinity;
    let sum = 0;
    for (const set of sets) {
      for (let k = 0; k < 4; k++) {
        const weight = set.weights[v * 4 + k] as number;
        if (weight < 0 || weight > previous) return false;
        previous = weight;
        sum += weight;
      }
    }
    if (sum > 0 && Math.abs(sum - 1) > 1e-3) return false;
  }
  return true;
}
