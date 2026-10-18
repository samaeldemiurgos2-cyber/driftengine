/**
 * `drft bake` as a function: what a reader found, turned into what `writeDrft` writes.
 *
 * **One bake, whoever runs it.** `scripts/bake.ts` is the command, and owns what only a command
 * knows: which file in a bundle to read, where on disk a named picture is, the flags, and the file it
 * writes. Everything between the read and the write is here, so a test that bakes a model, or a host
 * with no filesystem, runs the steps the command runs rather than a copy that could drift from them.
 *
 * The steps, in order: weld, derive a tangent frame where a material samples a normal map, drop
 * what never varies, find copies merged into one mesh, stand the model up, embed what the materials
 * reach, build the coarse outline, and gather what a `.drft` export carried back to the chunks it
 * came from. Each is argued where it is defined; the order is argued here, beside each step.
 */

import type {
  DrftInstanceGroup,
  DrftMaterial,
  DrftSource,
  DrftTextureSource,
  MeshData,
} from '@driftengine/drft';
import { DrftError } from '@driftengine/drft';
import type { AssetReference } from '../assetPath.ts';
import type { UpAxis } from '../orient.ts';
import {
  describeUpAxis,
  orientLights,
  orientMeshes,
  orientNodes,
  orientTransforms,
} from '../orient.ts';
import type { ModelImport } from '../readModel.ts';
import type { Repeats } from '../repeats.ts';
import { dropDefaultAttributes, weldMesh } from '../weld.ts';
import {
  carriedChunks,
  carriesPlacements,
  findAllRepeats,
  outline,
  sceneFieldOf,
  simplified,
  upsideDownWarning,
  withTangentsIfMapped,
} from './steps.ts';
import { describeDropped, embedCarried, reachableTextures } from './textures.ts';

/** What the command's flags decide. Every field is optional and absent means the command's default. */
export interface BakeModelOptions {
  /** `HEAD`'s name, unless the file carries its own: the source's name without its extension. */
  readonly name: string;
  /** `--up`: which way is up in the source, over what the file declares. */
  readonly up?: UpAxis | null;
  /**
   * The outline: `null` writes none, a number builds one at that many cells, and absent keeps the
   * one a `.drft` export carried or builds one at the default.
   */
  readonly lodCells?: number | null;
  /** `--no-instances` is false: write merged copies as they came. */
  readonly findInstances?: boolean;
  /** `--no-quantise` is false. */
  readonly quantise?: boolean;
  /** `--blend-as-cutout`. */
  readonly blendAsCutout?: boolean;
  /** `--simplify m`. */
  readonly simplify?: number;
  /** `--sdf m`. */
  readonly sdf?: number;
}

/** What only the host can do. Each is optional, and each default is the one a host with no disk wants. */
export interface BakeModelHooks {
  /** A line worth printing; the command prints it. */
  readonly log?: (line: string) => void;
  /** A line that is a warning. */
  readonly warn?: (line: string) => void;
  /**
   * The pictures the materials reach, embedded, in the order given. `warnings` is the bake's own
   * list, so a picture that was not found is said with the rest. The default embeds what the model
   * carried and stands a white texel in for what it only named.
   */
  readonly textures?: (
    refs: readonly AssetReference[],
    materials: readonly DrftMaterial[] | undefined,
    warnings: string[],
  ) => Promise<DrftTextureSource[]>;
  /** Separate levels of detail the host found beside the model, each a whole `.drft`. */
  readonly levels?: () => Promise<Uint8Array[]>;
  /**
   * Colliders the host was asked for, from the meshes as they will be written, or undefined where it
   * was asked for none, in which case any a `.drft` export carried stand.
   */
  readonly colliders?: (meshes: readonly MeshData[]) => Promise<Float32Array[] | undefined>;
}

/** Bake what a reader found into the source `writeDrft` takes. */
export async function bakeModel(
  imported: ModelImport,
  options: BakeModelOptions,
  hooks: BakeModelHooks = {},
): Promise<DrftSource> {
  const log = hooks.log ?? ((): void => {});
  const warn = hooks.warn ?? ((): void => {});
  const { meshes: raw, notes, declaredUp, substances, unitScale, skins, clips, nodes } = imported;
  const carried = imported.carried;
  const warnings = [...imported.warnings];
  /* A file exported with no materials comes back with glTF's defaults, which it never had. */
  const read = carried?.noMaterials === true ? undefined : imported.materials;
  /*
   * `--blend-as-cutout`: every blended material becomes a cutout at glTF's own default of 0.5.
   * Foliage is authored `BLEND` as often as `MASK`, and a leaf drawn blended is sorted, soft-edged
   * and writes no depth; nothing in the file says which the author meant, so the bake is told. Each
   * one converted is printed, so a pane of glass converted by mistake is seen.
   */
  const materials =
    options.blendAsCutout === true
      ? read?.map((material) => {
          if (material.blend !== true) return material;
          log(
            `  material "${material.name}": blended, baked as a cutout at 0.5 (--blend-as-cutout)`,
          );
          return { ...material, blend: false, cutout: 0.5 };
        })
      : read;
  for (const note of notes) log(`  ${note}`);
  for (const warning of warnings) warn(`  warning: ${warning}`);
  const warned = warnings.length;

  /*
   * Weld, then drop what never varies. Importers emit one vertex per triangle corner because the
   * source formats index attributes separately, so a real model arrives several times larger than
   * it is — and an attribute holding one repeated number costs four bytes a vertex to say nothing.
   * The frame is derived between the two, on the welded mesh: see `withTangentsIfMapped`.
   */
  const before = raw.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  const welded = raw.map((mesh, at) =>
    dropDefaultAttributes(withTangentsIfMapped(weldMesh(mesh), materials?.[at])),
  );
  /*
   * **Copies an export merged into one mesh, found again.** A scene that shipped ten thousand
   * candles as one mesh of nineteen million triangles is one candle and ten thousand matrices, and
   * `findRepeats` says so only when every copy is a rigid move of the first, attribute for
   * attribute. Found here, on the welded meshes, and written at the end: the outline, the colliders
   * and the hierarchy below are all measured from every copy, and only what is written is the
   * prototype. A mesh a `.drft` export already placed many times is its own prototype, and its
   * placements come back with the rest of what the export carried.
   */
  const placedBefore = new Set((carried?.instances ?? []).map((group) => group.mesh));
  const repeats: (Repeats | null)[] =
    options.findInstances === false ? [] : findAllRepeats(welded, placedBefore, log);
  const after = welded.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  if (after < before) {
    log(
      `  welded ${before} corners to ${after} vertices (${(100 - (after / before) * 100).toFixed(0)}% fewer)`,
    );
  }

  /*
   * Stand it up. `--up` wins over what the file declared, because the reason to type it is having
   * looked at a model whose file was wrong — and when the two disagree, both are printed, so an
   * override is never mistaken for what the file said. After welding rather than before: the turn
   * is rigid, so it cannot change which vertices merge, and doing it here touches the deduplicated
   * set rather than every corner.
   */
  const up = options.up ?? declaredUp ?? null;
  if (up !== null && up !== '+y' && carriesPlacements(carried)) {
    throw new DrftError(
      `--up ${up} would turn the geometry and leave the colliders, regions and placements this ` +
        'export carried where they were; bake it without --up',
    );
  }
  const meshes = up === null || up === '+y' ? welded : orientMeshes(welded, up);
  if (options.up != null && declaredUp !== undefined && declaredUp !== options.up) {
    log(`  the file declares up is ${declaredUp}; --up ${options.up} overrides it`);
  }
  if (up !== null && up !== '+y') {
    const source = options.up == null ? 'the file declares' : '--up';
    log(`  ${source} ${up}: ${describeUpAxis(up)}, into the engine's Y-up frame`);
  }
  /* The hierarchy turns with the geometry, or the two disagree about where every part is. */
  const turnedNodes = nodes === undefined || up === null ? nodes : orientNodes(nodes, up);
  if (turnedNodes !== undefined && turnedNodes.length > 0) {
    const transforms = turnedNodes.filter((node) => node.mesh < 0).length;
    log(
      `  hierarchy: ${turnedNodes.length} nodes, ${transforms} of them transforms only, ` +
        'written as NODE beside world-space meshes',
    );
  }
  const upsideDown = upsideDownWarning(meshes);
  if (upsideDown !== null) warn(upsideDown);

  /* Textures last, because a reference is only worth resolving once the meshes that name it have
     survived the read. */
  const reached = reachableTextures(imported.textures ?? [], materials);
  const dropped = describeDropped(reached.dropped);
  if (dropped !== null) log(dropped);
  const embedded =
    reached.refs.length === 0
      ? []
      : hooks.textures === undefined
        ? embedCarried(reached.refs, warnings)
        : await hooks.textures(reached.refs, reached.materials, warnings);
  for (const warning of warnings.slice(warned)) warn(`  warning: ${warning}`);

  const lods = outline(meshes, options.lodCells, carried, log);
  const found = hooks.levels === undefined ? [] : await hooks.levels();
  const levels = found.length > 0 ? found : (carried?.levels ?? []);
  const asked = hooks.colliders === undefined ? undefined : await hooks.colliders(meshes);
  const colliders = asked ?? carried?.colliders;
  if (asked === undefined && colliders !== undefined) {
    log(`  collider: ${colliders.length} hulls, as the export carried them`);
  }

  /*
   * What is written: the prototype in place of each mesh found to be copies, welded again (a
   * prototype found through its triangles is one vertex a corner) and stood up like the rest, and
   * its placements turned into the same frame.
   */
  const instances: DrftInstanceGroup[] = [...(carried?.instances ?? [])];
  const placed = meshes.map((mesh, at) => {
    const repeat = repeats[at];
    if (repeat === undefined || repeat === null) return mesh;
    const prototype = dropDefaultAttributes(weldMesh(repeat.prototype));
    const turned =
      up === null || up === '+y' ? prototype : (orientMeshes([prototype], up)[0] as MeshData);
    instances.push({
      mesh: at,
      transforms:
        up === null || up === '+y' ? repeat.transforms : orientTransforms(repeat.transforms, up),
    });
    return turned;
  });
  const written = simplified(placed, options.simplify, materials, log);
  const field = sceneFieldOf(placed, options.sdf, instances, reached.materials, log);

  return {
    meshes: written,
    quantise: options.quantise !== false,
    ...(field === null
      ? carried?.fields === undefined
        ? {}
        : { fields: carried.fields }
      : { fields: [field] }),
    ...(instances.length === 0 ? {} : { instances }),
    ...(lods.length === 0 ? {} : { lods }),
    head: {
      name: carried?.name ?? options.name,
      generator: 'drft bake',
      ...(carried === undefined
        ? unitScale === undefined
          ? {}
          : { unitScale }
        : { unitScale: carried.unitScale }),
    },
    ...(reached.materials === undefined ? {} : { materials: [...reached.materials] }),
    /* Spread conditionally like every optional field beside it, so a model with none of a thing
       writes exactly the bytes it always did — which is what keeps `bake:check` meaningful. */
    ...(substances === undefined || substances.length === 0 ? {} : { substances }),
    ...(colliders === undefined || colliders.length === 0 ? {} : { colliders }),
    ...(skins === undefined || skins.length === 0 ? {} : { skins }),
    ...(clips === undefined || clips.length === 0 ? {} : { clips }),
    ...(turnedNodes === undefined || turnedNodes.length === 0 ? {} : { nodes: turnedNodes }),
    ...(imported.lights === undefined || imported.lights.length === 0
      ? {}
      : {
          lights: up === null || up === '+y' ? imported.lights : orientLights(imported.lights, up),
        }),
    ...(levels.length === 0 ? {} : { levels }),
    ...(embedded.length === 0 ? {} : { textures: embedded }),
    ...carriedChunks(carried),
  };
}
