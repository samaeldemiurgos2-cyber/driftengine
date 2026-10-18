/**
 * The steps `bakeModel` runs, each on its own: the frame, the copies, the warning about a model
 * standing below its origin, the outline, simplification and the distance field.
 *
 * Kept apart from the pipeline so `model.ts` reads as the order of a bake and this file as what each
 * step does. Each prints through the `log` it is handed, so the command's output is the same lines
 * in the same order whichever host runs the bake.
 */

import type { DrftInstanceGroup, DrftMaterial, DrftSource, MeshData } from '@driftengine/drft';
import { buildCoarseLevel, DEFAULT_COARSE_CELLS, isOutlineWorthWriting } from '../coarseLevel.ts';
import type { ModelImport } from '../readModel.ts';
import { componentCount, findRepeats } from '../repeats.ts';
import type { Repeats } from '../repeats.ts';
import { deriveTangentsFor } from '../tangentOrder.ts';
import { bakeSceneField } from './sceneField.ts';
import { simplifyMesh } from './simplify.ts';

/**
 * Derive a tangent frame for a welded mesh whose material declares a normal map.
 *
 * **Deliberately here and not in the reader.** A frame exists to sample a normal map, and there is
 * one place in this engine that reads one, so a material with no map wants no frame. What was wrong
 * before 3.30.0 is the *order*: `generateTangents` accumulates per index, and a file storing one
 * vertex per triangle corner gives every corner one triangle's frame, so no two corners at a point
 * agree and `weldMesh` — which keys on the frame — merges none of them. Measured on a rotationally
 * unwrapped corner soup: 9,600 corners weld to 1,681 vertices with no frame and to 9,482 with one
 * derived per corner.
 */
export function withTangentsIfMapped(mesh: MeshData, material: DrftMaterial | undefined): MeshData {
  if (material === undefined || material.normalMap < 0) return mesh;
  return deriveTangentsFor(mesh);
}

export function findAllRepeats(
  welded: readonly MeshData[],
  skip: ReadonlySet<number>,
  log: (line: string) => void,
): (Repeats | null)[] {
  const counts = welded.map((mesh) => componentCount(mesh));
  return welded.map((mesh, at) => {
    if (skip.has(at)) return null;
    const found = findRepeats(mesh, counts);
    if (found !== null) {
      const saved = mesh.positions.length / 3 - found.prototype.positions.length / 3;
      log(
        `  mesh ${at}: ${found.count} copies of one ${found.prototype.indices.length / 3}-triangle ` +
          `shape, written once with ${found.count} placements (${saved} vertices fewer)`,
      );
    }
    return found;
  });
}

/**
 * Say so when a model has ended up standing below its own origin.
 *
 * **A container's declared up axis can simply be wrong, and this tool believes it.** The sign of the
 * y range is the check that works: a model that sits almost entirely under y=0 has its origin on top
 * of it, which for anything meant to stand on a floor is upside down. A *warning* rather than a
 * rotation, because every rule for measuring which way is up is wrong on something ordinary. Nine
 * tenths below the origin rather than merely more than half: a model centred on its own middle is
 * ordinary and must not warn.
 */
export function upsideDownWarning(meshes: readonly MeshData[]): string | null {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const mesh of meshes) {
    for (let at = 1; at < mesh.positions.length; at += 3) {
      const y = mesh.positions[at] as number;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minY) || maxY <= minY) return null;
  if (-minY / (maxY - minY) < 0.9) return null;
  return (
    `  warning: this model spans y=${minY.toFixed(2)}..${maxY.toFixed(2)}, so it sits below its ` +
    `origin.\n           If it looks upside down, try --up -y.`
  );
}

/**
 * The coarse outline, from the meshes as they will be written rather than as they were read: welded
 * and stood up, so it lands in the same frame as the model it stands for. One a `.drft` export
 * carried is kept unless a resolution was asked for, since the bake that made it may have used one
 * this bake was not told.
 */
export function outline(
  meshes: readonly MeshData[],
  cells: number | null | undefined,
  carried: ModelImport['carried'],
  log: (line: string) => void,
): MeshData[] {
  if (cells === null) {
    log('  no outline: --no-lod, so a load of this file opens on an empty scene');
    return [];
  }
  if (cells === undefined && carried?.outline !== undefined) {
    log(`  outline: ${carried.outline.length} level as the export carried it`);
    return [...carried.outline];
  }
  if (cells === undefined && carried?.noOutline === true) {
    log('  no outline: the exported file had none');
    return [];
  }
  const resolution = cells ?? DEFAULT_COARSE_CELLS;
  const built = buildCoarseLevel(meshes, { cells: resolution });
  /* An outline bigger than the model it stands for is not one: see `isOutlineWorthWriting`. */
  if (built !== null && isOutlineWorthWriting(built, meshes)) {
    const bytes =
      built.positions.length * 4 * 3 + built.emissive.length * 4 + built.indices.length * 4;
    log(
      `  outline at ${resolution} cells: ${built.positions.length / 3} vertices, ` +
        `${built.indices.length / 3} triangles (${(bytes / 1024).toFixed(0)} KB), which is what ` +
        'arrives first. Look at it before shipping it.',
    );
    return [built];
  }
  if (built !== null) {
    log(
      `  no outline: the grid gives ${built.indices.length / 3} triangles for a model of ` +
        `${meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0)}, so it would cost more than it saves`,
    );
  } else {
    log('  no outline: this asset has no extent to lay a grid over, so the parts arrive first');
  }
  return [];
}

/**
 * `--simplify m`: every mesh brought down to the triangles its shape needs. After the copies are
 * found, so a prototype is simplified once for all its placements, and after the outline and the
 * colliders, which are measured from what the author made.
 */
export function simplified(
  placed: MeshData[],
  error: number | undefined,
  materials: readonly DrftMaterial[] | undefined,
  log: (line: string) => void,
): MeshData[] {
  if (error === undefined) return placed;
  return placed.map((mesh, at) => {
    const simpler = simplifyMesh(mesh, { maxError: error });
    const from = mesh.indices.length / 3;
    const to = simpler.indices.length / 3;
    if (to < from) {
      const name = materials?.[at]?.name ?? `mesh ${at}`;
      log(`  simplified ${name}: ${from} triangles to ${to} (${Math.round((100 * to) / from)}%)`);
    }
    return simpler;
  });
}

/**
 * `--sdf m`: one distance field over the static geometry. Static means drawn once and neither
 * blended nor cut out: walls and floors, not foliage, cloth or the copies of a candle.
 */
export function sceneFieldOf(
  placed: readonly MeshData[],
  voxel: number | undefined,
  instances: readonly DrftInstanceGroup[],
  materials: readonly DrftMaterial[] | undefined,
  log: (line: string) => void,
): ReturnType<typeof bakeSceneField> {
  if (voxel === undefined) return null;
  const copied = new Set(instances.map((group) => group.mesh));
  const field = bakeSceneField(placed, voxel, (at) => {
    if (copied.has(at)) return false;
    const material = materials?.[at];
    return material === undefined || (material.cutout <= 0 && material.blend !== true);
  });
  if (field !== null) {
    const [nx, ny, nz] = field.dims;
    log(
      `  field: ${nx}x${ny}x${nz} at ${String(voxel)} m, ${((nx * ny * nz * 4) / 1e6).toFixed(1)} MB`,
    );
  }
  return field;
}

/** Whether an export carried anything placed in the asset's space, which a turn would leave behind. */
export function carriesPlacements(carried: ModelImport['carried']): boolean {
  if (carried === undefined) return false;
  return [
    carried.colliders,
    carried.regions,
    carried.instances,
    carried.fields,
    carried.navigation,
    carried.lightVolume,
    carried.outline,
  ].some((value) => value !== undefined);
}

/** The chunks a `.drft` export carried that no step of a bake makes, as `writeDrft` takes them. */
export function carriedChunks(carried: ModelImport['carried']): Partial<DrftSource> {
  if (carried === undefined) return {};
  return {
    ...(carried.entities === undefined ? {} : { entities: carried.entities }),
    ...(carried.regions === undefined ? {} : { regions: carried.regions }),
    ...(carried.networks === undefined ? {} : { networks: carried.networks }),
    ...(carried.graphs === undefined ? {} : { graphs: carried.graphs }),
    ...(carried.navigation === undefined ? {} : { navigation: carried.navigation }),
    ...(carried.lightVolume === undefined ? {} : { lightVolume: carried.lightVolume }),
    ...(carried.dtex === undefined ? {} : { dtex: carried.dtex }),
  };
}
