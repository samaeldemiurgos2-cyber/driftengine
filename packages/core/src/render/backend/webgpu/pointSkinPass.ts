/**
 * A point skin on WebGPU: its points, joints and normals in storage buffers made once, and a pose
 * recorded as one compute dispatch into the dynamic mesh's own position and normal buffers. What a
 * point skin is, and why it poses into a mesh rather than in a vertex stage, is `pointSkin.ts`.
 *
 * **Each skin owns its joints buffer**, so two skins posed in one frame read their own: a write to
 * one buffer between two dispatches would hand both the last, the per-draw rule `AGENTS.md` keeps
 * for every resource a later write in the frame overwrites. A skin posed twice in a frame draws its
 * last pose everywhere, as a mesh rewritten twice with `updateMesh` does.
 */
import { reachOf, widenReach, type PointSkinData, type PointSkinReach } from '../../pointSkin.ts';
import type { GpuMesh } from './buffers.ts';
import { POINT_SKIN_WGSL, POINT_SKIN_WORKGROUP } from './shaders/pointSkin.wgsl.ts';

const STORAGE = 0x0080;
const UNIFORM = 0x0040;
const COPY_DST = 0x0008;

/** The pipeline every skin on a device poses with, made at the first skin. */
export function createPointSkinPipeline(device: GPUDevice): GPUComputePipeline {
  return device.createComputePipeline({
    label: 'pointSkin.pose',
    layout: 'auto',
    compute: {
      module: device.createShaderModule({ label: 'pointSkin.pose', code: POINT_SKIN_WGSL }),
      entryPoint: 'posePoints',
    },
  });
}

export class GpuPointSkin {
  readonly mesh: GpuMesh;
  /** Widened by each rewrite, never narrowed: see `widenReach`. */
  reach: PointSkinReach;
  private readonly count: number;
  private readonly pipeline: GPUComputePipeline;
  private joints: GPUBuffer;
  /** Params, points with their weights, joints named, normals: in that order. */
  private readonly buffers: readonly GPUBuffer[];
  private group: GPUBindGroup;
  /** A rewrite's vertices laid out as the buffers hold them, grown to the largest rewrite. */
  private scratch = {
    points: new Float32Array(0),
    named: new Uint32Array(0),
    normals: new Float32Array(0),
  };

  constructor(device: GPUDevice, pipeline: GPUComputePipeline, mesh: GpuMesh, data: PointSkinData) {
    this.mesh = mesh;
    this.pipeline = pipeline;
    this.reach = reachOf(data);
    const count = data.weights.length / 4;
    this.count = count;

    const { points, named, normals } = laidOut(data, count, {
      points: new Float32Array(count * 16),
      named: new Uint32Array(count * 4),
      normals: new Float32Array(count * 4),
    });
    const params = new Uint32Array([count, 0, 0, 0]);

    const made = (
      label: string,
      contents: Float32Array | Uint32Array,
      usage: number,
    ): GPUBuffer => {
      const buffer = device.createBuffer({
        label,
        size: Math.max(16, contents.byteLength),
        usage: usage | COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, contents);
      return buffer;
    };
    this.joints = jointBuffer(device, this.reach.joints);
    this.buffers = [
      made('pointSkin.params', params, UNIFORM),
      made('pointSkin.points', points, STORAGE),
      made('pointSkin.named', named, STORAGE),
      made('pointSkin.normals', normals, STORAGE),
    ];
    this.group = this.bind(device);
  }

  private bind(device: GPUDevice): GPUBindGroup {
    const buffers = this.buffers;
    const [positionsOut, normalsOut] = this.mesh.vertexBuffers as [GPUBuffer, GPUBuffer];
    return device.createBindGroup({
      label: 'pointSkin.pose',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers[0] as GPUBuffer } },
        { binding: 1, resource: { buffer: this.joints } },
        { binding: 2, resource: { buffer: buffers[1] as GPUBuffer } },
        { binding: 3, resource: { buffer: buffers[2] as GPUBuffer } },
        { binding: 4, resource: { buffer: buffers[3] as GPUBuffer } },
        { binding: 5, resource: { buffer: positionsOut } },
        { binding: 6, resource: { buffer: normalsOut } },
      ],
    });
  }

  /**
   * Rewrite vertices `first` onward, as many as `data` holds, in place: three queue writes at their
   * offsets. **A queue write reaches every dispatch submitted after it**, so the renderer submits a
   * pose already recorded before calling this, and the rewrite reaches the next pose alone, as it
   * does on WebGL2. A joint none of the skin named before grows the joints buffer, which is made
   * again with its bind group; the old one goes once the work already submitted is done with it.
   */
  rewrite(device: GPUDevice, first: number, data: PointSkinData): void {
    const count = data.weights.length / 4;
    const scratch = this.scratch;
    if (scratch.named.length < count * 4) {
      this.scratch = {
        points: new Float32Array(count * 16),
        named: new Uint32Array(count * 4),
        normals: new Float32Array(count * 4),
      };
    }
    const { points, named, normals } = laidOut(data, count, this.scratch);
    const buffers = this.buffers;
    device.queue.writeBuffer(buffers[1] as GPUBuffer, first * 64, points, 0, count * 16);
    device.queue.writeBuffer(buffers[2] as GPUBuffer, first * 16, named, 0, count * 4);
    device.queue.writeBuffer(buffers[3] as GPUBuffer, first * 16, normals, 0, count * 4);
    const joints = this.reach.joints;
    this.reach = widenReach(this.reach, data);
    if (Math.max(1, this.reach.joints) > Math.max(1, joints)) {
      this.joints.destroy();
      this.joints = jointBuffer(device, this.reach.joints);
      this.group = this.bind(device);
    }
  }

  /** Write the pose's joints and record the dispatch that poses every vertex into `encoder`. */
  pose(device: GPUDevice, encoder: GPUCommandEncoder, matrices: Float32Array): void {
    if (this.reach.joints > 0) {
      device.queue.writeBuffer(this.joints, 0, matrices, 0, this.reach.joints * 16);
    }
    const pass = encoder.beginComputePass({ label: 'pointSkin.pose' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(this.count / POINT_SKIN_WORKGROUP));
    pass.end();
  }

  dispose(): void {
    this.joints.destroy();
    for (const buffer of this.buffers) buffer.destroy();
  }
}

function jointBuffer(device: GPUDevice, joints: number): GPUBuffer {
  return device.createBuffer({
    label: 'pointSkin.joints',
    size: Math.max(1, joints) * 64,
    usage: STORAGE | COPY_DST,
  });
}

/**
 * `count` vertices of `data` as the buffers hold them, into `out`'s leading entries: each influence
 * a vec4 of its point and its weight in w, the joints as integers, each normal a vec4.
 */
function laidOut(
  data: PointSkinData,
  count: number,
  out: { points: Float32Array; named: Uint32Array; normals: Float32Array },
): { points: Float32Array; named: Uint32Array; normals: Float32Array } {
  for (let i = 0; i < count * 4; i++) {
    out.points[i * 4] = data.points[i * 3] as number;
    out.points[i * 4 + 1] = data.points[i * 3 + 1] as number;
    out.points[i * 4 + 2] = data.points[i * 3 + 2] as number;
    out.points[i * 4 + 3] = data.weights[i] as number;
    out.named[i] = data.joints[i] as number;
  }
  for (let v = 0; v < count; v++) {
    out.normals[v * 4] = data.normals[v * 3] as number;
    out.normals[v * 4 + 1] = data.normals[v * 3 + 1] as number;
    out.normals[v * 4 + 2] = data.normals[v * 3 + 2] as number;
  }
  return out;
}
