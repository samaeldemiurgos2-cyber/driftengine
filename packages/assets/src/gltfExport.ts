/**
 * A `.drft` back out to glTF 2.0, so an asset baked for the engine can be opened in a modelling
 * tool, improved, and baked again.
 *
 * `docs/FORMAT.md` §3 runs the pipeline one way, from what an artist exports to what a game streams.
 * This is the step back. What glTF has a field for goes in that field, so a viewer and an editor see
 * the meshes, materials, skeleton, clips, attachment points and lamps they expect; what it has no
 * field for rides in `extras.drift` records that `gltf.ts` and the baker read back to the chunks they
 * came from. `driftExtras.ts` says why extras and not an extension, and what a record may override.
 *
 * **Refused rather than half-written**, as the readers refuse rather than half-import: a world built
 * from kit pieces and a Gaussian splat capture have no glTF form here, and an export that left them
 * out would bake back as a different asset with nothing in it to say so.
 */

import type { DrftAsset, DrftMaterial } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import { meshDigest, recordExtras } from './driftExtras.ts';
import type { MaterialRecord } from './driftExtras.ts';
import { FLOAT, addAccessor, createGlbParts, packGlb } from './glbWrite.ts';
import { largestJoint, writeMesh } from './gltfExportMesh.ts';
import { buildAnimations } from './gltfExportClips.ts';
import { buildNodeGraph } from './gltfExportRig.ts';
import { lightsJson } from './gltfExportLights.ts';
import { sceneRecord, writeTextures } from './gltfExportScene.ts';
import type { PngEncoder } from './gltfExportScene.ts';
import { gltfMaterialOf } from './gltfMaterialOut.ts';

export type { PngEncoder } from './gltfExportScene.ts';

/** What an export may need from its host. */
export interface GlbExportOptions {
  /**
   * PNG bytes for an RGBA image, needed only for a texture held as raw texels or BC blocks, which
   * glTF has no image type for. Optional because nothing else needs it, and because an encoder is
   * the host's to choose: the baker's command passes the Node one, and a page can pass its own.
   */
  readonly encodePng?: PngEncoder;
}

/** A `.glb`, and what the export could carry only approximately, one sentence each. */
export interface GlbExport {
  readonly glb: Uint8Array;
  readonly warnings: readonly string[];
}

/**
 * Write `asset` as a glTF 2.0 binary.
 *
 * Every `MESH` becomes one glTF mesh in the same order, so the ordinals that materials, morphs,
 * instance groups and regions name survive. `drft bake` reads the result back to an equivalent
 * `.drft`; `docs/FORMAT.md` §3.4 lists what is exact, what rounds, and what is not carried.
 */
export function drftToGlb(asset: DrftAsset, options: GlbExportOptions = {}): GlbExport {
  if (asset.kit.length > 0 || asset.assemblies.size > 0) {
    throw new DrftError(
      'this file builds meshes from kit pieces, which glTF has no form for here; exporting the ' +
        'assembled meshes would bake back as a different asset',
    );
  }
  if (asset.splats !== null) {
    throw new DrftError(
      'this file carries a Gaussian splat capture, which glTF 2.0 has no form for',
    );
  }
  if (asset.meshes.length === 0) throw new DrftError('this file holds no mesh to export');
  const warnings: string[] = [];
  if (asset.skipped.length > 0) {
    warnings.push(
      `chunks this reader does not understand are not carried: ${asset.skipped.join(', ')}`,
    );
  }

  const parts = createGlbParts();
  const pictures = writeTextures(parts, asset.textures, options.encodePng, warnings);
  const names = asset.meshes.map((_, m) => meshName(asset.materials[m], m));
  const meshes = asset.meshes.map((mesh, m) =>
    writeMesh(parts, mesh, m, names[m] as string, asset.materials[m]),
  );
  /*
   * The outline after the meshes, as meshes no node names: a viewer draws none of them over the
   * model, and the reader finds them by the scene record alone.
   */
  const outline = asset.lods.map((lod, k) => ({
    json: writeMesh(parts, lod, k, `outline ${k}`, undefined).json,
    record: { mesh: asset.meshes.length + k, hash: meshDigest(lod) },
  }));
  const materials = asset.materials.map((material, m) =>
    materialJson(material, meshes[m]?.vertexColours ?? false, substanceOf(asset, m)),
  );

  const skinOf = asset.meshes.map((mesh, m) => {
    if (mesh.joints === undefined) return -1;
    const needed = largestJoint(mesh);
    const skin = asset.skins.findIndex((s) => s.joints.length > needed);
    if (skin < 0) {
      throw new DrftError(`mesh ${m} is weighted to joint ${needed}, and no skin has that many`);
    }
    return skin;
  });
  const graph = buildNodeGraph(names, skinOf, asset.nodes, asset.skins, asset.lights, warnings);
  const skins = asset.skins.map((skin, s) => ({
    name: `skin ${s}`,
    joints: graph.joints[s],
    inverseBindMatrices: addAccessor(parts, skin.inverseBind, 'MAT4', FLOAT, 'other'),
  }));
  const animations = buildAnimations(parts, asset.clips, graph.joints[0], warnings);

  const used = [
    ...(asset.lights.length > 0 ? ['KHR_lights_punctual'] : []),
    ...(materials.some((m) => m['extensions'] !== undefined) ? ['KHR_materials_transmission'] : []),
    ...(pictures.webp ? ['EXT_texture_webp'] : []),
  ];
  const document: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'DriftEngine drft export' },
    ...(used.length === 0 ? {} : { extensionsUsed: used }),
    ...(pictures.webp ? { extensionsRequired: ['EXT_texture_webp'] } : {}),
    scene: 0,
    scenes: [
      {
        name: asset.head.name,
        nodes: graph.roots,
        extras: recordExtras(
          sceneRecord(
            asset,
            parts,
            outline.map((level) => level.record),
          ),
        ),
      },
    ],
    nodes: graph.nodes,
    meshes: [...meshes.map((mesh) => mesh.json), ...outline.map((level) => level.json)],
    ...(materials.length === 0 ? {} : { materials }),
    ...(pictures.images.length === 0
      ? {}
      : { images: pictures.images, textures: pictures.textures }),
    ...(skins.length === 0 ? {} : { skins }),
    ...(animations.length === 0 ? {} : { animations }),
    ...(asset.lights.length === 0
      ? {}
      : { extensions: { KHR_lights_punctual: { lights: lightsJson(asset.lights) } } }),
  };
  return { glb: packGlb(document, parts), warnings };
}

/** A glTF mesh's name: its material's, which is what an artist recognises, or its ordinal. */
function meshName(material: DrftMaterial | undefined, ordinal: number): string {
  return material !== undefined && material.name.length > 0 ? material.name : `mesh ${ordinal}`;
}

function substanceOf(asset: DrftAsset, material: number): string | undefined {
  return asset.substances.find((entry) => entry.material === material)?.substance;
}

/**
 * A material as glTF fields plus its record, and its substance where the file labels one.
 *
 * `extras.substance` is where `gltf.ts` has always read a substance label from, so a label goes back
 * to the field an artist would have typed it in.
 */
function materialJson(
  material: DrftMaterial,
  vertexColours: boolean,
  substance: string | undefined,
): Record<string, unknown> {
  const record: MaterialRecord = { material, vertexColours };
  return {
    ...gltfMaterialOf(material, vertexColours),
    extras: { ...recordExtras(record), ...(substance === undefined ? {} : { substance }) },
  };
}
