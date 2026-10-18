/**
 * Meshes, nodes and lamps put back in the order a `.drft` export recorded, after the glTF walk read
 * them in whatever order an editor saved.
 *
 * Its own module because it acts on what the whole walk read rather than on one object's record, and
 * because the order is load-bearing: materials, instance groups, regions and entry links name meshes
 * by ordinal, and a manifest may name an entry or a lamp by its position. Blender 5.2 saves meshes and
 * a node's children in an order of its own, measured, so without this an unedited round trip through
 * it would hand every such name to another mesh.
 */

import type { DrftLight, DrftMaterial, DrftNode, MeshData } from '@driftengine/drft';

/**
 * The order meshes or nodes read back in, as the old position of each new one, or null where nothing
 * moves.
 *
 * Recorded ones go back to their positions and anything an editor added follows them, in the order
 * it was read. Where the recorded positions are not exactly the first so many, an editor added,
 * removed or duplicated one, and every position past that point names another than it did; `shifted`
 * is then said, because what names a mesh or a node by its position has nothing else to notice by.
 */
export function recordedOrder(
  positions: readonly (number | undefined)[],
  warnings: string[],
  shifted: string,
): number[] | null {
  const recorded = positions.filter((position) => position !== undefined);
  if (recorded.length === 0) return null;
  const order = positions
    .map((position, at) => ({ key: position ?? Infinity, at }))
    .sort((a, b) => a.key - b.key || a.at - b.at)
    .map((entry) => entry.at);
  const exact = [...recorded].sort((a, b) => a - b).every((position, i) => position === i);
  if (!exact || recorded.length !== positions.length) warnings.push(shifted);
  return order.every((from, to) => from === to) ? null : order;
}

/** What the glTF walk read, and beside it in the same order what a `.drft` export recorded of it. */
export interface WalkedScene {
  readonly meshes: MeshData[];
  readonly materials: DrftMaterial[];
  readonly substances: { material: number; substance: string }[];
  readonly nodes: DrftNode[];
  /** Each mesh's recorded ordinal. */
  readonly ordinals: readonly (number | undefined)[];
  /** Each node's recorded position in `NODE`. */
  readonly positions: readonly (number | undefined)[];
  /** The mesh each node's record names, or -1. */
  readonly links: readonly number[];
  readonly lights: DrftLight[];
  /** Each light's recorded position in `LITE`. */
  readonly lightOrdinals: readonly (number | undefined)[];
}

/**
 * Put back what a `.drft` export recorded, in place: meshes at their ordinals, each entry's mesh,
 * lights and entries at their positions. A document with no records is left exactly as it was
 * walked.
 *
 * In that order, because each step names what the one before settled. Materials and substance labels
 * travel with their meshes and a node holding geometry follows its mesh; an entry's link names an
 * ordinal, which means something only once the meshes are back at theirs; and a node's parent follows
 * it to its position. A link past the last mesh is dropped with a word rather than left naming
 * nothing.
 */
export function restoreRecorded(scene: WalkedScene, warnings: string[]): void {
  const { meshes, materials, substances, nodes } = scene;
  const order = recordedOrder(
    scene.ordinals,
    warnings,
    'meshes were added, removed or duplicated since export, so a region, instance group or node ' +
      'naming a mesh by its ordinal may name another one',
  );
  if (order !== null) {
    const moved = inverse(order);
    meshes.splice(0, meshes.length, ...order.map((from) => meshes[from] as MeshData));
    materials.splice(0, materials.length, ...order.map((from) => materials[from] as DrftMaterial));
    for (const label of substances) label.material = moved[label.material] as number;
    substances.sort((a, b) => a.material - b.material);
    nodes.forEach((node, at) => {
      if (node.mesh >= 0) nodes[at] = { ...node, mesh: moved[node.mesh] as number };
    });
  }
  scene.links.forEach((mesh, at) => {
    const node = nodes[at] as DrftNode;
    if (mesh < 0 || node.mesh >= 0) return;
    if (mesh < meshes.length) nodes[at] = { ...node, mesh };
    else
      warnings.push(`node "${node.name}" names mesh ${mesh}, and the scene has ${meshes.length}`);
  });
  const placed = recordedOrder(
    scene.positions,
    warnings,
    'nodes were added, removed or duplicated since export, so the hierarchy comes back renumbered',
  );
  const lamps = recordedOrder(
    scene.lightOrdinals,
    warnings,
    'lights were added, removed or duplicated since export, so they come back renumbered',
  );
  if (lamps !== null) {
    scene.lights.splice(
      0,
      scene.lights.length,
      ...lamps.map((from) => scene.lights[from] as DrftLight),
    );
  }
  if (placed === null) return;
  const moved = inverse(placed);
  const reordered = placed.map((from) => {
    const node = nodes[from] as DrftNode;
    return { ...node, parent: node.parent < 0 ? -1 : (moved[node.parent] as number) };
  });
  nodes.splice(0, nodes.length, ...reordered);
}

/** Where each old position went, from the old position of each new one. */
function inverse(order: readonly number[]): Int32Array {
  const moved = new Int32Array(order.length);
  order.forEach((from, to) => (moved[from] = to));
  return moved;
}
