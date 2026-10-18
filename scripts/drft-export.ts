/**
 * `drft export` — a `.drft` back out to a glTF 2.0 binary, so a baked asset can be opened in a
 * modelling tool, improved, and baked again.
 *
 *   npm run export -- model.drft -o model.glb
 *   npm run export -- model.drft --to glb
 *
 * The step `docs/FORMAT.md` §3 draws back up the pipeline. The work is `drftToGlb` in
 * `@driftengine/assets`, which says what goes where; this is the file in, the file out, and the one
 * capability the export may need from Node, a PNG encoder for a texture glTF has no image type for.
 *
 * **Everything it writes, it says.** The summary counts the parts a modelling tool will show and the
 * data riding in the scene's record, and every approximation is a warning, so a person sees what a
 * round trip will and will not bring back before they edit anything.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { drftToGlb } from '@driftengine/assets';
import { DrftError, readDrft } from '@driftengine/drft';
import { encodePng } from '../packages/core/scripts/png.mjs';

function main(): void {
  const args = process.argv.slice(2);
  const input = args[0];
  if (input === undefined || input.startsWith('-')) {
    console.error('usage: export <file.drft> [-o out.glb] [--to glb]');
    process.exit(1);
  }
  const toIndex = args.indexOf('--to');
  const to = toIndex === -1 ? 'glb' : args[toIndex + 1];
  /* One target, named anyway, so a second one is a value and not a new flag. */
  if (to !== 'glb') {
    console.error(`--to ${to ?? ''}: the export writes glb, a glTF 2.0 binary`);
    process.exit(1);
  }
  const outIndex = args.indexOf('-o');
  const output =
    outIndex === -1
      ? `${path.basename(input, path.extname(input))}.glb`
      : (args[outIndex + 1] as string);

  const bytes = readFileSync(input);
  const asset = readDrft(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const { glb, warnings } = drftToGlb(asset, {
    encodePng: (width, height, rgba) => new Uint8Array(encodePng(width, height, rgba)),
  });
  for (const warning of warnings) console.warn(`  warning: ${warning}`);
  writeFileSync(output, glb);

  const joints = asset.skins.reduce((sum, skin) => sum + skin.joints.length, 0);
  const parts = [
    `${asset.meshes.length} mesh${asset.meshes.length === 1 ? '' : 'es'}`,
    `${asset.materials.length} materials`,
    `${asset.textures.length} textures`,
    ...(asset.skins.length === 0 ? [] : [`${asset.skins.length} skin, ${joints} joints`]),
    ...(asset.clips.length === 0 ? [] : [`${asset.clips.length} clips`]),
    ...(asset.nodes.length === 0 ? [] : [`${asset.nodes.length} nodes`]),
    ...(asset.lights.length === 0 ? [] : [`${asset.lights.length} lights`]),
  ];
  const carried = [
    ...(asset.entities === null ? [] : ['ENTS']),
    ...(asset.colliders.length === 0 ? [] : ['COLL']),
    ...(asset.regions.length === 0 ? [] : ['REGN']),
    ...(asset.instances.length === 0 ? [] : ['INST']),
    ...(asset.lods.length === 0 ? [] : ['LODM']),
    ...(asset.fields.length === 0 ? [] : ['SDFV']),
    ...(asset.navigation === null ? [] : ['NAVM']),
    ...(asset.lightVolume === null ? [] : ['LVOL']),
    ...(asset.networks.length === 0 ? [] : ['NNET']),
    ...(asset.graphs.length === 0 ? [] : ['NGRF']),
    ...(asset.dtex.length === 0 ? [] : ['DTEX']),
    ...(asset.levels.length === 0 ? [] : ['LODF']),
  ];
  console.log(`${parts.join(', ')} → ${output} (${(glb.length / 1024).toFixed(1)} KB)`);
  if (carried.length > 0) {
    console.log(`  what glTF has no field for, carried in extras.drift: ${carried.join(', ')}`);
  }
}

try {
  main();
} catch (error: unknown) {
  /* A refusal names what the export could not write, so it prints as one line. */
  console.error(error instanceof DrftError ? error.message : error);
  process.exit(1);
}
