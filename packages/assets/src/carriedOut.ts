/**
 * The chunks an export carries as their own bytes, written by the format's codec: the writer's half
 * of `carriedPayloads.ts`, which says what they are and why they travel this way.
 *
 * Same chunk names, same order, and a test holds the two tables to that.
 */

import type { DrftAsset } from '@driftengine/drft';
import {
  buildDtex,
  buildLightVolume,
  buildNavm,
  buildNgrf,
  buildNnet,
  buildSdfv,
} from '@driftengine/drft';

/** In the order a `.drft` writes them: the payloads `asset` holds of each chunk, empty for none. */
export const CARRIED_OUT: readonly {
  readonly chunk: string;
  readonly take: (asset: DrftAsset) => readonly Uint8Array[];
}[] = [
  {
    chunk: 'SDFV',
    take: (asset) => (asset.fields.length === 0 ? [] : [buildSdfv({ entries: asset.fields })]),
  },
  {
    chunk: 'NNET',
    take: (asset) => (asset.networks.length === 0 ? [] : [buildNnet({ networks: asset.networks })]),
  },
  { chunk: 'NGRF', take: (asset) => (asset.graphs.length === 0 ? [] : [buildNgrf(asset.graphs)]) },
  {
    chunk: 'NAVM',
    take: (asset) => (asset.navigation === null ? [] : [buildNavm(asset.navigation)]),
  },
  {
    chunk: 'LVOL',
    take: (asset) => (asset.lightVolume === null ? [] : [buildLightVolume(asset.lightVolume)]),
  },
  { chunk: 'DTEX', take: (asset) => asset.dtex.map((entry) => buildDtex(entry)) },
  { chunk: 'LODF', take: (asset) => asset.levels },
];
