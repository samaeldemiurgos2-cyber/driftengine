/**
 * A glTF 2.0 binary being written: one buffer grown view by view, the accessors over it, and the
 * two chunks a `.glb` packs them into.
 *
 * The counterpart of `readGlb` in `gltf.ts`, and kept to the container on purpose: nothing here knows
 * what a mesh or a skin is, so the export's modules decide what to write and this decides only how
 * the bytes are laid out. Offline work, so it allocates where that is clearer.
 *
 * **Every view starts on a four-byte boundary.** An accessor's offset must be a multiple of its
 * component's size, and four covers every type written here; it is also what lets a reader that views
 * rather than copies, as this engine's own does, build a `Float32Array` over the bytes it fetched.
 */

/** The glTF component types this writer emits. */
export const FLOAT = 5126;
export const UNSIGNED_BYTE = 5121;
export const UNSIGNED_SHORT = 5123;
export const UNSIGNED_INT = 5125;

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** Bytes per component, by component type. */
const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  [FLOAT]: 4,
  [UNSIGNED_BYTE]: 1,
  [UNSIGNED_SHORT]: 2,
  [UNSIGNED_INT]: 4,
};

/** Components per element, by accessor type. */
const TYPE_WIDTH: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

export interface GlbAccessor {
  readonly bufferView: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly min?: number[];
  readonly max?: number[];
}

export interface GlbBufferView {
  readonly buffer: 0;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly target?: number;
}

/** The binary half of a document under construction. */
export interface GlbParts {
  readonly accessors: GlbAccessor[];
  readonly bufferViews: GlbBufferView[];
  /** The views' bytes, in order, each already padded to four. */
  readonly chunks: Uint8Array[];
  length: number;
}

export function createGlbParts(): GlbParts {
  return { accessors: [], bufferViews: [], chunks: [], length: 0 };
}

/** One view over a copy of `bytes`, answering its index. */
export function addView(parts: GlbParts, bytes: Uint8Array, target?: number): number {
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  parts.bufferViews.push({
    buffer: 0,
    byteOffset: parts.length,
    byteLength: bytes.length,
    ...(target === undefined ? {} : { target }),
  });
  parts.chunks.push(padded);
  parts.length += padded.length;
  return parts.bufferViews.length - 1;
}

/** What an accessor is for, which decides its view's target and whether it states its range. */
export type AccessorUse = 'vertex' | 'index' | 'other';

/**
 * An accessor over `values`, stored as `componentType`, answering its index.
 *
 * `bounded` writes `min` and `max`, which glTF requires of a `POSITION` and of an animation's input
 * and which a viewer uses to fit the camera. Integer types are written by truncation, so a caller
 * hands them whole numbers: a joint index that is not one is a corrupt file, refused by the caller
 * where the message can name the mesh.
 */
export function addAccessor(
  parts: GlbParts,
  values: ArrayLike<number>,
  type: string,
  componentType: number,
  use: AccessorUse,
  bounded = false,
): number {
  const width = TYPE_WIDTH[type] ?? 1;
  const size = COMPONENT_BYTES[componentType] ?? 4;
  const count = values.length / width;
  const bytes = new Uint8Array(values.length * size);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as number;
    if (componentType === FLOAT) view.setFloat32(i * 4, value, true);
    else if (componentType === UNSIGNED_INT) view.setUint32(i * 4, value, true);
    else if (componentType === UNSIGNED_SHORT) view.setUint16(i * 2, value, true);
    else view.setUint8(i, value);
  }
  const target =
    use === 'vertex' ? ARRAY_BUFFER : use === 'index' ? ELEMENT_ARRAY_BUFFER : undefined;
  const bufferView = addView(parts, bytes, target);
  let range: { min: number[]; max: number[] } | undefined;
  if (bounded && count > 0) {
    /* The float32 the reader will see, so a stated bound is exactly the stored extreme. */
    const min = new Array<number>(width).fill(Infinity);
    const max = new Array<number>(width).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < width; c++) {
        const value = Math.fround(values[i * width + c] as number);
        if (value < (min[c] as number)) min[c] = value;
        if (value > (max[c] as number)) max[c] = value;
      }
    }
    range = { min, max };
  }
  parts.accessors.push({ bufferView, componentType, count, type, ...range });
  return parts.accessors.length - 1;
}

/**
 * JSON text in which a negative zero stays negative.
 *
 * `JSON.stringify(-0)` writes `0`, so a float32 whose sign bit was set comes back with it clear: a
 * different bit pattern in the chunk a value lands in, and an asset that no longer round-trips to
 * the same bytes. `-0` is valid JSON and `JSON.parse` reads it back as negative zero, so this writes
 * that and is otherwise `JSON.stringify` for the plain data an export holds: no `toJSON`, no typed
 * arrays, and keys whose value is `undefined` left out as `JSON.stringify` leaves them.
 */
export function exactJson(value: unknown): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : exactJson(item))).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const fields: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) fields.push(`${JSON.stringify(key)}:${exactJson(item)}`);
    }
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The finished `.glb`: the document as UTF-8 JSON padded with spaces, then the buffer padded with
 * zeroes, which are the two paddings the specification names.
 */
export function packGlb(document: Record<string, unknown>, parts: GlbParts): Uint8Array {
  const json = new TextEncoder().encode(
    exactJson({
      ...document,
      ...(parts.accessors.length === 0 ? {} : { accessors: parts.accessors }),
      ...(parts.bufferViews.length === 0 ? {} : { bufferViews: parts.bufferViews }),
      ...(parts.length === 0 ? {} : { buffers: [{ byteLength: parts.length }] }),
    }),
  );
  const jsonLength = (json.length + 3) & ~3;
  const binaryChunk = parts.length === 0 ? 0 : 8 + parts.length;
  const total = 12 + 8 + jsonLength + binaryChunk;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLength);
  if (parts.length > 0) {
    let at = 20 + jsonLength;
    view.setUint32(at, parts.length, true);
    view.setUint32(at + 4, 0x004e4942, true);
    at += 8;
    for (const chunk of parts.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
  }
  return out;
}
