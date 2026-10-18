/**
 * What a `.drft` holds besides geometry, a rig and its lamps, as glTF writes it: the pictures, and
 * the scene record carrying everything glTF has no object for.
 *
 * **The scene record is the one place an asset's own data lives**: the entity manifest, the
 * colliders, the regions and the meshes drawn many times, as JSON a person can read in the file, and
 * the chunks nobody edits as buffer views beside it. It sits on the scene because the scene is the
 * object every editor keeps; see `driftExtras.ts` for the measurement behind that.
 */

import type { DrftAsset, DrftTexture } from '@driftengine/drft';
import {
  CODEC_BC,
  CODEC_JPEG,
  CODEC_PNG,
  CODEC_RAW,
  CODEC_WEBP,
  DrftError,
} from '@driftengine/drft';
import { codecName, readBcPayload } from '@driftengine/drft';
import { decodeBcImage } from './bcImage.ts';
import { CARRIED_OUT } from './carriedOut.ts';
import { DRIFT_EXTRAS_VERSION, payloadHash } from './driftExtras.ts';
import type {
  GroupRecord,
  OutlineRecord,
  PayloadRecord,
  RegionRecord,
  SceneRecord,
} from './driftExtras.ts';
import { addView } from './glbWrite.ts';
import type { GlbParts } from './glbWrite.ts';

type Json = Record<string, unknown>;

/** PNG bytes for an RGBA image: the one capability an export may need from its host. */
export type PngEncoder = (width: number, height: number, rgba: Uint8Array) => Uint8Array;

/**
 * The asset's own data, as the record its scene carries. Payload chunks are added to `parts`;
 * `outline` names the glTF meshes the outline was written as.
 */
export function sceneRecord(
  asset: DrftAsset,
  parts: GlbParts,
  outline: readonly OutlineRecord[],
): SceneRecord {
  const payloads: PayloadRecord[] = [];
  for (const payload of CARRIED_OUT) {
    for (const bytes of payload.take(asset)) {
      payloads.push({
        chunk: payload.chunk,
        view: addView(parts, bytes),
        length: bytes.length,
        hash: payloadHash(bytes),
      });
    }
  }
  const group = (mesh: number, transforms: Float32Array): GroupRecord => ({
    mesh,
    transforms: Array.from(transforms),
  });
  const regions = asset.regions.map((region): RegionRecord => ({
    id: region.id,
    bounds: Array.from(region.bounds),
    levels: region.levels.map((level) => ({ error: level.error, meshes: [...level.meshes] })),
    instances: region.instances.map((g) => group(g.mesh, g.transforms)),
    occluders: Array.from(region.occluders),
    ...(region.collision === null
      ? {}
      : {
          collision: {
            positions: Array.from(region.collision.positions),
            indices: Array.from(region.collision.indices),
          },
        }),
  }));
  return {
    version: DRIFT_EXTRAS_VERSION,
    name: asset.head.name,
    unitScale: asset.head.unitScale,
    ...(asset.materials.length === 0 ? { noMaterials: true } : {}),
    ...(outline.length === 0 ? { noOutline: true } : { outline }),
    ...(asset.entities === null ? {} : { entities: asset.entities }),
    ...(asset.colliders.length === 0
      ? {}
      : { colliders: asset.colliders.map((c) => Array.from(c)) }),
    ...(regions.length === 0 ? {} : { regions }),
    ...(asset.instances.length === 0
      ? {}
      : { instances: asset.instances.map((g) => group(g.mesh, g.transforms)) }),
    ...(payloads.length === 0 ? {} : { payloads }),
  };
}

/** The pictures, one image and one texture each, in `TEXS` order so a material's index still holds. */
export function writeTextures(
  parts: GlbParts,
  textures: readonly DrftTexture[],
  encodePng: PngEncoder | undefined,
  warnings: string[],
): { images: Json[]; textures: Json[]; webp: boolean } {
  const images: Json[] = [];
  const out: Json[] = [];
  let webp = false;
  textures.forEach((texture, i) => {
    const { bytes, mimeType } = imageOf(texture, encodePng, warnings);
    images.push({ name: texture.name, mimeType, bufferView: addView(parts, bytes) });
    /* glTF's core names two image types; WebP is an extension, and with no fallback image beside it
       the extension is required, which is what a reader that cannot decode WebP needs to be told. */
    if (texture.codec === CODEC_WEBP) {
      webp = true;
      out.push({ extensions: { EXT_texture_webp: { source: i } } });
    } else {
      out.push({ source: i });
    }
  });
  return { images, textures: out, webp };
}

/**
 * A texture's bytes as an image glTF can hold.
 *
 * PNG, JPEG and WebP go out as they are, so a bake reads back the same bytes. Raw texels and BC
 * blocks have no glTF image type, so they go out as PNG of their pixels, the top level only, and a
 * bake embeds that PNG: the picture survives and the codec does not, which is said once per texture.
 */
function imageOf(
  texture: DrftTexture,
  encodePng: PngEncoder | undefined,
  warnings: string[],
): { bytes: Uint8Array; mimeType: string } {
  if (texture.codec === CODEC_PNG) return { bytes: texture.bytes, mimeType: 'image/png' };
  if (texture.codec === CODEC_JPEG) return { bytes: texture.bytes, mimeType: 'image/jpeg' };
  if (texture.codec === CODEC_WEBP) return { bytes: texture.bytes, mimeType: 'image/webp' };
  if (texture.codec !== CODEC_RAW && texture.codec !== CODEC_BC) {
    throw new DrftError(`texture "${texture.name}" has codec ${texture.codec}, which has no image`);
  }
  if (encodePng === undefined) {
    throw new DrftError(
      `texture "${texture.name}" is ${codecName(texture.codec)}, which glTF holds only as PNG; ` +
        'pass encodePng to write it',
    );
  }
  const rgba =
    texture.codec === CODEC_RAW
      ? texture.bytes
      : bcPixels(texture.width, texture.height, texture.bytes);
  warnings.push(
    `texture "${texture.name}": ${codecName(texture.codec)} has no glTF image, so it is written as ` +
      'PNG of its pixels and a bake embeds that PNG',
  );
  return { bytes: encodePng(texture.width, texture.height, rgba), mimeType: 'image/png' };
}

function bcPixels(width: number, height: number, bytes: Uint8Array): Uint8Array {
  const image = readBcPayload(width, height, bytes);
  const top = image.levels[0];
  if (top === undefined) throw new DrftError('a BC texture holds no level');
  return decodeBcImage(image.format, width, height, top);
}
