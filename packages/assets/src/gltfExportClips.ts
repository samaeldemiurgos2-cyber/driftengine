/**
 * A `.drft` asset's clips as glTF animations: one channel and one sampler a track, over the joint
 * nodes `gltfExportRig.ts` laid out.
 *
 * glTF says how long a clip is only by its last key, and `ANIM` stores a duration of its own, which
 * a clip holding its last pose runs past; that one number rides in the animation's record.
 */

import type { AnimationClip } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import { recordExtras } from './driftExtras.ts';
import type { ClipRecord } from './driftExtras.ts';
import { FLOAT, addAccessor } from './glbWrite.ts';
import type { GlbParts } from './glbWrite.ts';

type Json = Record<string, unknown>;

/**
 * Each clip as a glTF animation over the first skin's joint nodes.
 *
 * **The first skin, because a track names a joint by its index and not by its skin.** A file whose
 * skins share one skeleton, which is what a character exported as several skinned parts is, means the
 * same joint whichever skin is asked; a file whose skins differ has clips no reader can attribute.
 * Linear, which is how `@driftengine/animation` samples every track.
 */
export function buildAnimations(
  parts: GlbParts,
  clips: readonly AnimationClip[],
  joints: readonly number[] | undefined,
  warnings: string[],
): Json[] {
  const out: Json[] = [];
  for (const clip of clips) {
    if (joints === undefined) {
      throw new DrftError(`clip "${clip.name}" animates joints, and the file carries no skin`);
    }
    if (clip.tracks.length === 0) {
      warnings.push(
        `clip "${clip.name}" has no tracks, and a glTF animation needs one; not written`,
      );
      continue;
    }
    const samplers: Json[] = [];
    const channels: Json[] = [];
    let lastKey = 0;
    for (const track of clip.tracks) {
      const node = joints[track.joint];
      if (node === undefined) {
        throw new DrftError(
          `clip "${clip.name}" animates joint ${track.joint}, and the first skin has ${joints.length}`,
        );
      }
      lastKey = Math.max(lastKey, track.times[track.times.length - 1] ?? 0);
      channels.push({ sampler: samplers.length, target: { node, path: track.path } });
      samplers.push({
        input: addAccessor(parts, track.times, 'SCALAR', FLOAT, 'other', true),
        output: addAccessor(
          parts,
          track.values,
          track.path === 'rotation' ? 'VEC4' : 'VEC3',
          FLOAT,
          'other',
        ),
        interpolation: 'LINEAR',
      });
    }
    /* glTF's duration is its last key; a clip that holds past it says so in its record. */
    const record: ClipRecord | null =
      Math.fround(lastKey) === Math.fround(clip.durationSec)
        ? null
        : { durationSec: clip.durationSec };
    out.push({
      name: clip.name,
      samplers,
      channels,
      ...(record === null ? {} : { extras: recordExtras(record) }),
    });
  }
  return out;
}
