/**
 * A `.drft` asset's lamps as `KHR_lights_punctual` lights, each hung on the node it came from where
 * the hierarchy still has it, and on a node of its own where it does not.
 *
 * **On its own entry where it can be.** A scene read from glTF keeps the node a lamp hung on as a
 * `NODE` entry of the lamp's name, standing where the lamp stands and pointing where it points. A
 * lamp hung beside that entry instead is two objects of one name, and Blender 5.2 renames the second
 * on import, measured: every lamp came back named `.001`, which a game looking lamps up by name
 * would not find. So each lamp goes back on its entry, when every lamp has one, in the order the
 * lamps are listed; otherwise each gets a node of its own, which keeps that order and costs the name
 * only through an editor.
 *
 * **Placement rides in the light's record either way**, because a node's rotation is a float32
 * quaternion and a lamp's direction comes back from it rounded; see `restoreLight`.
 */

import type { DrftLight, DrftNode } from '@driftengine/drft';
import { compose, multiply, quaternionMatrix } from './blendMatrix.ts';
import type { Mat4 } from './blendMatrix.ts';
import { LIGHT_ROUNDING, recordExtras, within } from './driftExtras.ts';
import type { LightRecord, NodeRecord } from './driftExtras.ts';

type Json = Record<string, unknown>;

/**
 * Hang each light on its entry or on a node of its own, in `nodes` and `roots`.
 *
 * `offset` is where the entries start in `nodes`, and `depthFirst` whether they read back in their
 * own order, without which a lamp on an entry would come back out of turn.
 */
export function placeLights(
  lights: readonly DrftLight[],
  entries: readonly DrftNode[],
  nodes: Json[],
  roots: number[],
  offset: number,
  depthFirst: boolean,
): void {
  const homes = depthFirst ? entryHomes(lights, entries) : null;
  lights.forEach((light, i) => {
    const record: LightRecord = {
      ordinal: i,
      position: light.position,
      direction: light.direction,
      innerConeRad: light.innerConeRad,
      outerConeRad: light.outerConeRad,
      range: light.range,
    };
    const home = homes?.[i];
    if (home !== undefined) {
      const entry = entries[home] as DrftNode;
      const node = nodes[offset + home] as Json;
      node['extensions'] = { KHR_lights_punctual: { light: i } };
      node['extras'] = recordExtras({
        entry: home,
        ...(entry.mesh < 0 ? {} : { mesh: entry.mesh }),
        light: record,
      } satisfies NodeRecord);
      return;
    }
    roots.push(nodes.length);
    nodes.push({
      name: light.name,
      translation: [...light.position],
      rotation: rotationToward(light.direction),
      extensions: { KHR_lights_punctual: { light: i } },
      extras: recordExtras({ invented: 'light', light: record } satisfies NodeRecord),
    });
  });
}

/**
 * The entry each light hangs on, ascending, or null unless every light has one.
 *
 * An entry is a light's when it alone bears the light's name and stands and points where the light
 * does, within half the rounding the reader forgives, so the reader restores the record from it.
 */
function entryHomes(lights: readonly DrftLight[], entries: readonly DrftNode[]): number[] | null {
  if (lights.length === 0) return null;
  const worlds: (Mat4 | undefined)[] = [];
  const world = (k: number): Mat4 => {
    const known = worlds[k];
    if (known !== undefined) return known;
    const entry = entries[k] as DrftNode;
    /* `quaternionMatrix` takes Blender's order, `w` first; a `NODE` rotation is glTF's, `w` last. */
    const [x, y, z, w] = entry.rotation;
    const local = compose(entry.translation, quaternionMatrix([w, x, y, z]), entry.scale);
    const made = entry.parent < 0 ? local : multiply(world(entry.parent), local);
    worlds[k] = made;
    return made;
  };
  const homes: number[] = [];
  for (const light of lights) {
    const named = entries.flatMap((entry, k) => (entry.name === light.name ? [k] : []));
    const home = named[0];
    if (named.length !== 1 || home === undefined || home <= (homes[homes.length - 1] ?? -1)) {
      return null;
    }
    const m = world(home);
    const z = Math.hypot(m[8] ?? 0, m[9] ?? 0, m[10] ?? 0) || 1;
    const stands = light.position.every((value, c) =>
      within(value, m[12 + c] ?? 0, LIGHT_ROUNDING.position / 2),
    );
    const points = light.direction.every(
      (value, c) => Math.abs(value + (m[8 + c] ?? 0) / z) <= LIGHT_ROUNDING.direction / 2,
    );
    if (!stands || !points) return null;
    homes.push(home);
  }
  return homes;
}

/**
 * The rotation that turns a node's local −z, which is where glTF points a light, onto `direction`.
 *
 * Rounded to float32, because an editor keeps a rotation in float32, so an unedited save writes back
 * the rotation written here and the direction it encodes stays within the rounding `gltfCarried.ts`
 * allows the light's record. The half turn about y for a light pointing along +z is chosen rather
 * than derived, since every axis perpendicular to the two is an answer there.
 */
function rotationToward(
  direction: readonly [number, number, number],
): [number, number, number, number] {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return [0, 0, 0, 1];
  const x = direction[0] / length;
  const y = direction[1] / length;
  const z = direction[2] / length;
  /* From (0, 0, -1) to (x, y, z): the axis is their cross product and the half-angle form avoids a
     trigonometric call. */
  const w = 1 - z;
  if (w < 1e-9) return [0, 1, 0, 0];
  const norm = Math.hypot(y, x, w);
  return [Math.fround(y / norm), Math.fround(-x / norm), 0, Math.fround(w / norm)];
}

/** `KHR_lights_punctual`'s light objects, in `LITE` order, which the nodes name by index. */
export function lightsJson(lights: readonly DrftLight[]): Json[] {
  return lights.map((light) => ({
    type: light.kind,
    name: light.name,
    color: [...light.color],
    intensity: light.intensity,
    /* The extension defines a range only above zero, and `LITE` writes zero for none. */
    ...(light.range > 0 ? { range: light.range } : {}),
    ...(light.kind === 'spot'
      ? { spot: { innerConeAngle: light.innerConeRad, outerConeAngle: light.outerConeRad } }
      : {}),
  }));
}
