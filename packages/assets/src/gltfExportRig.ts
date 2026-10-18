/**
 * A `.drft` asset's hierarchy and skins as glTF nodes and skins.
 *
 * **Four kinds of node, and only one of them is the asset's.** A `NODE` entry becomes a node of the
 * same name, transform and parent, which is the hierarchy an artist edits. The other three are made
 * up by the export and marked so in their record, and the reader leaves them out of the hierarchy it
 * builds: a node per mesh to hang it on, a node per joint where the joints are not entries, and a
 * node per lamp where the lamps are not.
 *
 * **Every mesh hangs on a node of its own at the root, at the identity.** `MESH` is in the asset's own
 * space, so geometry under a `NODE` entry's transform would be moved a second time, and putting it
 * back in the entry's local space would round every vertex twice. What it gives up is an editor's
 * parenting of a part under its node; the entry names its mesh in its record instead, which is
 * where the reader takes the link from. What would change it is a `MESH` stored in its node's space.
 *
 * **A joint is an entry where one says it is.** A rig read from glTF carries its joints as entries,
 * named as the skin names them and nested as the skin nests them, and an attachment point is an entry
 * parented to one. Where every joint finds exactly one entry of its name, nested the same way, the
 * skin points at those entries, so an attachment point hangs from the bone it follows. Otherwise the
 * export makes the joints up from the inverse binds, which is the bind pose by definition.
 */

import type { DrftLight, DrftNode, DrftSkin } from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import { invert, multiply } from './blendMatrix.ts';
import type { Mat4 } from './blendMatrix.ts';
import { recordExtras } from './driftExtras.ts';
import type { NodeRecord } from './driftExtras.ts';
import { placeLights } from './gltfExportLights.ts';

type Json = Record<string, unknown>;

/** The node graph as written: the nodes in index order, the roots in the order the reader walks them. */
export interface NodeGraph {
  readonly nodes: Json[];
  readonly roots: number[];
  /** The glTF node each joint of each skin is, by skin. */
  readonly joints: readonly (readonly number[])[];
}

/**
 * The nodes for `meshes` hung each on its own, then `entries`, then joints the entries are not, then
 * the lights, on their entries or on nodes of their own; see `gltfExportLights.ts`.
 *
 * `skinOf[m]` is the skin mesh `m` is deformed by, or -1. Mesh nodes come first and in order because
 * the reader numbers meshes in the order it walks the roots, which is what keeps every ordinal.
 */
export function buildNodeGraph(
  meshNames: readonly string[],
  skinOf: readonly number[],
  entries: readonly DrftNode[],
  skins: readonly DrftSkin[],
  lights: readonly DrftLight[],
  warnings: string[],
): NodeGraph {
  const nodes: Json[] = [];
  const roots: number[] = [];
  meshNames.forEach((name, m) => {
    const skin = skinOf[m] ?? -1;
    nodes.push({
      name,
      mesh: m,
      ...(skin < 0 ? {} : { skin }),
      extras: recordExtras({ invented: 'mesh' } satisfies NodeRecord),
    });
    roots.push(m);
  });

  const offset = nodes.length;
  checkHierarchy(entries);
  entries.forEach((entry, k) => {
    nodes.push({
      name: entry.name,
      translation: [...entry.translation],
      rotation: [...entry.rotation],
      scale: [...entry.scale],
      extras: recordExtras({
        entry: k,
        ...(entry.mesh < 0 ? {} : { mesh: entry.mesh }),
      } satisfies NodeRecord),
    });
  });
  /* Linked once every entry exists, since a file may list a child before its parent. */
  entries.forEach((entry, k) => {
    if (entry.parent < 0) roots.push(offset + k);
    else childOf(nodes[offset + entry.parent] as Json, offset + k);
  });
  const depthFirst = isDepthFirst(entries);
  if (!depthFirst) {
    warnings.push(
      'NODE is not listed depth first, and glTF is read back depth first: the same tree returns ' +
        'with its entries renumbered',
    );
  }

  const joints = skins.map((skin) => {
    const onEntries = jointsOnEntries(skin, entries);
    if (onEntries !== null) return onEntries.map((k) => offset + k);
    return inventJoints(skin, nodes, roots, warnings);
  });
  placeLights(lights, entries, nodes, roots, offset, depthFirst);
  return { nodes, roots, joints };
}

function childOf(parent: Json, child: number): void {
  const children = (parent['children'] as number[] | undefined) ?? [];
  children.push(child);
  parent['children'] = children;
}

/** Parents inside the list and no cycle, which is all a glTF node graph needs of them. */
function checkHierarchy(entries: readonly DrftNode[]): void {
  entries.forEach((entry, k) => {
    let at = k;
    for (let steps = 0; at >= 0; steps++) {
      const parent = (entries[at] as DrftNode).parent;
      if (parent >= entries.length || parent === at || steps > entries.length) {
        throw new DrftError(`NODE entry ${k} ("${entry.name}") has no root above it`);
      }
      at = parent;
    }
  });
}

function isDepthFirst(entries: readonly DrftNode[]): boolean {
  let next = 0;
  const visit = (k: number): boolean => {
    if (k !== next) return false;
    next++;
    for (let c = k + 1; c < entries.length; c++) {
      if ((entries[c] as DrftNode).parent === k && !visit(c)) return false;
    }
    return true;
  };
  for (let k = 0; k < entries.length; k++) {
    if ((entries[k] as DrftNode).parent < 0 && !visit(k)) return false;
  }
  return next === entries.length;
}

/** Each joint's entry, or null where any joint has no single entry or the nesting disagrees. */
function jointsOnEntries(skin: DrftSkin, entries: readonly DrftNode[]): number[] | null {
  const named = new Map<string, number[]>();
  entries.forEach((entry, k) => named.set(entry.name, [...(named.get(entry.name) ?? []), k]));
  const found: number[] = [];
  for (const joint of skin.joints) {
    const matches = named.get(joint.name);
    if (matches?.length !== 1) return null;
    found.push(matches[0] as number);
  }
  const inSkin = new Set(found);
  if (inSkin.size !== found.length) return null;
  for (let j = 0; j < skin.joints.length; j++) {
    const parent = skin.joints[j]?.parent ?? -1;
    const above = (entries[found[j] as number] as DrftNode).parent;
    if (parent >= 0 ? above !== found[parent] : inSkin.has(above)) return null;
  }
  return found;
}

/** Joint nodes at the bind pose the inverse binds describe, nested as the skin nests them. */
function inventJoints(
  skin: DrftSkin,
  nodes: Json[],
  roots: number[],
  warnings: string[],
): number[] {
  const base = nodes.length;
  const binds: Mat4[] = skin.joints.map((_, j) => [
    ...skin.inverseBind.subarray(j * 16, j * 16 + 16),
  ]);
  skin.joints.forEach((joint, j) => {
    const world = invert(binds[j] as Mat4);
    const local = joint.parent < 0 ? world : multiply(binds[joint.parent] as Mat4, world);
    const pose = poseOf(local);
    if (pose === null)
      warnings.push(`joint "${joint.name}" has a singular bind; it stands at rest`);
    nodes.push({
      name: joint.name,
      ...pose,
      extras: recordExtras({ invented: 'joint' } satisfies NodeRecord),
    });
    if (joint.parent < 0) roots.push(base + j);
    else childOf(nodes[base + joint.parent] as Json, base + j);
  });
  return skin.joints.map((_, j) => base + j);
}

/** A matrix as glTF's translation, rotation and scale, or null for one that has no rotation in it. */
function poseOf(m: Mat4): { translation: number[]; rotation: number[]; scale: number[] } | null {
  const column = (c: number): number[] => [m[c * 4] ?? 0, m[c * 4 + 1] ?? 0, m[c * 4 + 2] ?? 0];
  const axes = [column(0), column(1), column(2)];
  const lengths = axes.map((a) => Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0));
  if (lengths.some((l) => !(l > 1e-12))) return null;
  const [x, y, z] = axes as [number[], number[], number[]];
  const det =
    (x[0] ?? 0) * ((y[1] ?? 0) * (z[2] ?? 0) - (y[2] ?? 0) * (z[1] ?? 0)) -
    (y[0] ?? 0) * ((x[1] ?? 0) * (z[2] ?? 0) - (x[2] ?? 0) * (z[1] ?? 0)) +
    (z[0] ?? 0) * ((x[1] ?? 0) * (y[2] ?? 0) - (x[2] ?? 0) * (y[1] ?? 0));
  /* A mirror is a negative scale on one axis, which glTF's scale can say and a rotation cannot. */
  if (det < 0) lengths[0] = -(lengths[0] as number);
  const r = axes.map((a, i) => a.map((v) => v / (lengths[i] as number)));
  const at = (row: number, col: number): number => r[col]?.[row] ?? 0;
  const trace = at(0, 0) + at(1, 1) + at(2, 2);
  let q: number[];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(at(2, 1) - at(1, 2)) / s, (at(0, 2) - at(2, 0)) / s, (at(1, 0) - at(0, 1)) / s, s / 4];
  } else if (at(0, 0) > at(1, 1) && at(0, 0) > at(2, 2)) {
    const s = Math.sqrt(1 + at(0, 0) - at(1, 1) - at(2, 2)) * 2;
    q = [s / 4, (at(0, 1) + at(1, 0)) / s, (at(0, 2) + at(2, 0)) / s, (at(2, 1) - at(1, 2)) / s];
  } else if (at(1, 1) > at(2, 2)) {
    const s = Math.sqrt(1 + at(1, 1) - at(0, 0) - at(2, 2)) * 2;
    q = [(at(0, 1) + at(1, 0)) / s, s / 4, (at(1, 2) + at(2, 1)) / s, (at(0, 2) - at(2, 0)) / s];
  } else {
    const s = Math.sqrt(1 + at(2, 2) - at(0, 0) - at(1, 1)) * 2;
    q = [(at(0, 2) + at(2, 0)) / s, (at(1, 2) + at(2, 1)) / s, s / 4, (at(1, 0) - at(0, 1)) / s];
  }
  return { translation: [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0], rotation: q, scale: lengths };
}
