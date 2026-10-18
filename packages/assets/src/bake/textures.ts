/**
 * The pictures a bake embeds: which images a material can reach, how one is identified, and what
 * stands in for one nobody could find.
 *
 * The host decides where a named picture is looked for, which is a filesystem for the command and
 * nothing at all for a caller holding a `.glb`; everything here is the part both share, so a picture
 * the model carried is embedded the same way whichever of them baked it.
 */

import type { DrftMaterial, DrftTextureSource } from '@driftengine/drft';
import { CODEC_RAW } from '@driftengine/drft';
import type { AssetReference } from '../assetPath.ts';
import { describeImage } from '../imageInfo.ts';

/**
 * An image wrapped for embedding, identified by its own header, or a white texel where the header
 * says nothing this format knows, with the reason in `warnings`.
 *
 * The bytes are identified rather than trusted: glTF's `mimeType` is optional and wrong often enough
 * that the image's own header is the only reliable answer.
 */
export function identifyTexture(
  name: string,
  bytes: Uint8Array,
  warnings: string[],
): DrftTextureSource {
  try {
    const info = describeImage(bytes);
    return { name, codec: info.codec, width: info.width, height: info.height, bytes };
  } catch (error) {
    warnings.push(`texture "${name}": ${error instanceof Error ? error.message : String(error)}`);
    return placeholderTexture(name);
  }
}

/**
 * One white texel under the name a material asked for.
 *
 * It keeps every material's index meaning what it meant: dropping the entry instead would renumber
 * every texture after it and repaint the model.
 */
export function placeholderTexture(name: string): DrftTextureSource {
  return {
    name,
    codec: CODEC_RAW,
    width: 1,
    height: 1,
    bytes: new Uint8Array([255, 255, 255, 255]),
  };
}

/**
 * The images a model carried inside itself, embedded; a white texel for each it only named.
 *
 * What a bake does when it has nowhere to look, which is a `.glb` handed over as bytes. The command
 * looks beside the model first and falls back to the same placeholder, with the same words.
 */
export function embedCarried(
  refs: readonly AssetReference[],
  warnings: string[],
): DrftTextureSource[] {
  return refs.map((reference) => {
    if (reference.bytes !== undefined) {
      return identifyTexture(reference.name, reference.bytes, warnings);
    }
    warnings.push(
      `texture "${reference.name}" was not found beside the model; it will draw untextured`,
    );
    return placeholderTexture(reference.name);
  });
}

/**
 * Drop the images no material samples, and renumber the ones that stay.
 *
 * **A reader keeps every image the file declared, on purpose**: `gltf.ts` indexes by *texture*
 * rather than by image so a material's index means what the file said it meant, and `readModel`
 * leaves a reference that resolved to nothing in the list for the same reason. That invariant is
 * about the *read*. By the time a `.drft` is written the four ordinals in `MATL` are the only
 * things that can reach `TEXS` at all, so an entry nothing points at is bytes a browser downloads
 * and never decodes.
 *
 * It was measured at a whole model: a car written in glTF's archived specular-glossiness model
 * imported with **20 textures embedded and none of them bound**, the largest a 10 MB body map. The
 * reader now binds them, and the ones that stay unreachable — a specular-glossiness map, whose
 * channels no rearrangement fits into an ORM one — are what this drops.
 *
 * **Renumbering is the whole difficulty and the reason this is one function.** Compacting the list
 * without rewriting the ordinals repaints the model, which is exactly why both the embedding and
 * `readModel` refuse to drop an entry on their own; the two halves have to happen together or
 * neither may happen.
 *
 * **What it gives up**: an image no material samples is no longer in the asset, so
 * `TextureSet.get` cannot return it and a consumer holding a name for one gets the throw that
 * lookup exists to give. That is the documented behaviour — `HANDBOOK` §3 had promised *only
 * images a material actually reaches are embedded* for longer than it had been true — and the
 * alternative is every asset carrying its source's whole texture folder. **What would make it wrong**: a
 * consumer that wants an unsampled image out of the container for its own use, which would need a
 * way to say so rather than the accident of it having been left in.
 *
 * An ordinal already past the end of the list is left exactly where it is. It is a broken import
 * either way and `readDrft` refuses it by name; renumbering it would turn that refusal into a
 * silently wrong texture.
 */
export function reachableTextures(
  refs: readonly AssetReference[],
  materials: readonly DrftMaterial[] | undefined,
): {
  refs: readonly AssetReference[];
  materials: readonly DrftMaterial[] | undefined;
  dropped: readonly AssetReference[];
} {
  const reached = new Set<number>();
  for (const material of materials ?? []) {
    for (const index of [
      material.albedo,
      material.normalMap,
      material.ormMap,
      material.emissiveMap,
    ]) {
      if (index >= 0 && index < refs.length) reached.add(index);
    }
  }
  if (reached.size === refs.length) return { refs, materials, dropped: [] };

  const at = new Int32Array(refs.length).fill(-1);
  const kept: AssetReference[] = [];
  const dropped: AssetReference[] = [];
  for (let i = 0; i < refs.length; i++) {
    const reference = refs[i] as AssetReference;
    if (reached.has(i)) {
      at[i] = kept.length;
      kept.push(reference);
    } else {
      dropped.push(reference);
    }
  }
  const through = (index: number): number =>
    index >= 0 && index < refs.length ? (at[index] as number) : index;

  return {
    refs: kept,
    materials: materials?.map((material) => ({
      ...material,
      albedo: through(material.albedo),
      normalMap: through(material.normalMap),
      ormMap: through(material.ormMap),
      emissiveMap: through(material.emissiveMap),
    })),
    dropped,
  };
}

/** One line naming what was left out, because an image silently missing from a bake is not a saving. */
export function describeDropped(dropped: readonly AssetReference[]): string | null {
  if (dropped.length === 0) return null;
  const carried = dropped.reduce((sum, reference) => sum + (reference.bytes?.length ?? 0), 0);
  const names = dropped.map((reference) => reference.name);
  const listed =
    names.length > 6
      ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`
      : names.join(', ');
  /* KB under a megabyte: this line exists to show what was saved, and `0.0 MB` shows nothing. */
  const size =
    carried >= 1024 * 1024
      ? `${(carried / 1024 / 1024).toFixed(1)} MB`
      : `${(carried / 1024).toFixed(0)} KB`;
  return (
    `  ${dropped.length} image${dropped.length === 1 ? '' : 's'} no material samples, not embedded: ${listed}` +
    (carried === 0 ? '' : ` (${size} the model carried)`)
  );
}
