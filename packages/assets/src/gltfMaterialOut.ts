/**
 * A `.drft` material as the glTF fields a viewer or an editor reads, and the test that those fields
 * are still the ones the export wrote.
 *
 * Both halves live here because the second is defined by the first: a material's record is restored
 * only where its glTF fields equal what this function makes of the record, so the writer and the
 * reader have to make the same thing of it, and one function is how they do.
 *
 * **The glTF fields are for whoever opens the file, not for the round trip.** `MATL` holds things
 * glTF has no field for (a dielectric highlight, a grain, a frost) and the record carries every one
 * of them exactly. What is written here is the nearest metallic-roughness reading, so an editor shows
 * the surface roughly as the engine draws it and an artist edits something meaningful. What it gives
 * up is a viewer's exact picture of an engine-only field, which no glTF field could have given.
 */

import type { DrftMaterial } from '@driftengine/drft';
import type { GltfMaterial, GltfPbrMetallicRoughness } from './gltf.ts';

const unit = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The glTF material standing for `material`.
 *
 * `vertexColours` is whether the mesh's colours go out as `COLOR_0`. glTF multiplies that attribute
 * by `baseColorFactor` while `MESH` holds the product already, so the factor is then white and the
 * colour itself is the record's to carry; a mesh painted one colour sends it as the factor, which is
 * the field an artist recolours.
 */
export function gltfMaterialOf(material: DrftMaterial, vertexColours: boolean): GltfMaterial {
  const mapped = material.ormMap >= 0;
  const pbr: GltfPbrMetallicRoughness = {
    baseColorFactor: vertexColours
      ? [1, 1, 1, material.opacity]
      : [material.color[0], material.color[1], material.color[2], material.opacity],
    /* A map's factors scale it, which is what `metallicScale` and `roughnessScale` are; without one
       the reflectivity is the nearest thing glTF's metalness means. */
    metallicFactor: unit(mapped ? material.metallicScale : material.reflectivity),
    roughnessFactor: unit(mapped ? material.roughnessScale : material.roughness),
    ...(material.albedo >= 0 ? { baseColorTexture: { index: material.albedo } } : {}),
    ...(mapped ? { metallicRoughnessTexture: { index: material.ormMap } } : {}),
  };
  const emission = emissionOf(material);
  const transmission = material.transmission ?? 0;
  return {
    name: material.name,
    pbrMetallicRoughness: pbr,
    ...(material.normalMap >= 0 ? { normalTexture: { index: material.normalMap } } : {}),
    ...(mapped && material.occlusionStrength > 0
      ? { occlusionTexture: { index: material.ormMap, strength: material.occlusionStrength } }
      : {}),
    ...(material.emissiveMap >= 0 ? { emissiveTexture: { index: material.emissiveMap } } : {}),
    ...(emission === null ? {} : { emissiveFactor: emission }),
    ...(material.blend === true
      ? { alphaMode: 'BLEND' }
      : material.cutout > 0
        ? { alphaMode: 'MASK', alphaCutoff: material.cutout }
        : {}),
    ...(material.doubleSided === true ? { doubleSided: true } : {}),
    ...(transmission > 0
      ? { extensions: { KHR_materials_transmission: { transmissionFactor: unit(transmission) } } }
      : {}),
  };
}

/**
 * The colour a material emits, as glTF's factor, or null for one that emits nothing.
 *
 * `emissiveColor` already carries the strength where it names a colour, which is how the reader made
 * it; a negative one inherits the albedo, so the factor is the albedo scaled. Clamped, because glTF's
 * factor stops at one and a brighter emitter needs an extension a viewer may not read.
 */
function emissionOf(material: DrftMaterial): number[] | null {
  if (!(material.emissive > 0)) return null;
  const named = material.emissiveColor[0] >= 0;
  const source = named ? material.emissiveColor : material.color;
  const scale = named ? 1 : material.emissive;
  return [unit(source[0] * scale), unit(source[1] * scale), unit(source[2] * scale)];
}

/**
 * Whether `actual` still says what the export wrote as `expected`, field for field.
 *
 * Compared through each field's default rather than as written, because an editor that saves an
 * unedited material may spell a default out or leave it implied, and neither is an edit. Alpha is
 * compared only where glTF gives it a meaning, which `OPAQUE` does not: Blender 5.2 saves an opaque
 * material's alpha as one whatever it read. The name is left out: renaming a material changes no
 * number the record carries, so a renamed material keeps its record and takes its new name.
 */
export function sameStandardFields(actual: GltfMaterial, expected: GltfMaterial): boolean {
  return JSON.stringify(standardFields(actual)) === JSON.stringify(standardFields(expected));
}

function standardFields(material: GltfMaterial): unknown[] {
  const pbr = material.pbrMetallicRoughness;
  const masked = material.alphaMode === 'MASK';
  const [r = 1, g = 1, b = 1, a = 1] = pbr?.baseColorFactor ?? [];
  const opaque = (material.alphaMode ?? 'OPAQUE') === 'OPAQUE';
  return [
    [r, g, b, opaque ? 1 : a],
    pbr?.metallicFactor ?? 1,
    pbr?.roughnessFactor ?? 1,
    pbr?.baseColorTexture?.index ?? -1,
    pbr?.metallicRoughnessTexture?.index ?? -1,
    material.normalTexture?.index ?? -1,
    material.occlusionTexture?.index ?? -1,
    material.occlusionTexture?.strength ?? 1,
    material.emissiveTexture?.index ?? -1,
    material.emissiveFactor ?? [0, 0, 0],
    material.alphaMode ?? 'OPAQUE',
    masked ? (material.alphaCutoff ?? 0.5) : 0,
    material.doubleSided === true,
    material.extensions?.KHR_materials_transmission?.transmissionFactor ?? 0,
  ];
}
