/**
 * The chunks an export carries as their own bytes, read back by the format's codec.
 *
 * **These are the ones nobody edits in a modelling tool**: a distance field, a navigation mesh, a
 * light volume, networks, decode programs and nested levels. Each is either derived from the
 * geometry by another step or authored by another tool, so the glTF has no object for it and an
 * artist has nothing to change in it. Their bytes ride in a buffer view and the codec
 * `@driftengine/drft` already has reads them back, so this file adds no second description of any
 * of them. The coarse outline is a mesh, and travels as one: see `OutlineRecord`.
 *
 * **Two tables, one a direction, in two files.** This is the reader's; `carriedOut.ts` is the
 * writer's, with the same chunk names in the same order, which a test holds them to. Kept apart
 * because `readModel` runs in a browser and should not carry the writer: one table holding both
 * directions, with the outline as a nested container, took a bare `readModel` bundle from 47.9 KB
 * gzipped to 74.1.
 *
 * **An editor that rewrites the binary loses them, and that is mostly right.** Blender drops a view
 * only `extras` names; the record's length and hash then fail to match and the bake says which chunk
 * it could not restore. A field or a volume measured from geometry that was edited is stale anyway,
 * and a bake rebuilds the outline and the field from the flags it is given.
 */

import type { DrftSource, MeshData } from '@driftengine/drft';
import {
  readDtex,
  readLightVolume,
  readNavm,
  readNgrf,
  readNnet,
  readSdfv,
} from '@driftengine/drft';

/** What a carried chunk restores: a `DrftSource` field, or the outline. */
export type CarriedFields = Partial<
  Pick<
    DrftSource,
    'fields' | 'networks' | 'graphs' | 'navigation' | 'lightVolume' | 'dtex' | 'levels'
  >
> & { readonly outline?: readonly MeshData[] };

const whole = (bytes: ArrayBuffer): [ArrayBuffer, number, number] => [bytes, 0, bytes.byteLength];

/**
 * In the order a `.drft` writes them. Each takes one payload and merges its fields over the ones
 * read before it.
 */
export const CARRIED_IN: readonly {
  readonly chunk: string;
  readonly give: (bytes: ArrayBuffer, into: CarriedFields) => CarriedFields;
}[] = [
  {
    chunk: 'SDFV',
    give: (bytes, into) => ({ ...into, fields: readSdfv(...whole(bytes)).entries }),
  },
  {
    chunk: 'NNET',
    give: (bytes, into) => ({ ...into, networks: readNnet(...whole(bytes)).networks }),
  },
  { chunk: 'NGRF', give: (bytes, into) => ({ ...into, graphs: readNgrf(...whole(bytes)) }) },
  { chunk: 'NAVM', give: (bytes, into) => ({ ...into, navigation: readNavm(...whole(bytes)) }) },
  {
    chunk: 'LVOL',
    give: (bytes, into) => ({ ...into, lightVolume: readLightVolume(...whole(bytes)) }),
  },
  {
    chunk: 'DTEX',
    give: (bytes, into) => ({ ...into, dtex: [...(into.dtex ?? []), readDtex(...whole(bytes))] }),
  },
  {
    chunk: 'LODF',
    give: (bytes, into) => ({ ...into, levels: [...(into.levels ?? []), new Uint8Array(bytes)] }),
  },
];
