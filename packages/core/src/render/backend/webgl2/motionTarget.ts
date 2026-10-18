/**
 * Where every mover was last frame, on WebGL2: the motion its temporal resolve follows.
 *
 * **What it is for.** The resolve reprojects last frame's picture by the camera's motion, read
 * back from the depth, which is exact for a world standing still and wrong for whatever moved: a
 * head turning or a boot in a kick leaves a trail of its earlier pixels. WebGPU's reconstruction
 * follows each mover's own motion through `shaders/recon/motion.wgsl.ts`; this is the same idea
 * for the other backend. The frame's movers are recorded as they are drawn and drawn again at the
 * end of the frame into a target of their own, each texel saying where the surface it shows stood
 * last frame: the offset to it on screen, its distance from last frame's eye, and that it is a
 * mover's. The resolve reads it where a mover's texel is and the camera's reprojection everywhere
 * else.
 *
 * **Three kinds**, as `recordDrawMotion` on WebGPU decides them: a rigid mesh under last frame's
 * model; a skinned one under last frame's palette as well; and a mesh rewritten in place, whose
 * last frame's positions `Mesh.keepPrevious` copied before the first rewrite of the frame. A cloth
 * draw and an instanced batch keep the camera's motion here, which the renderer says once.
 *
 * **Drawn against the frame's own depth**, attached and never written, with the test passing at its
 * own surface and a nudge toward the eye to forgive the last bit of arithmetic: rasterised through
 * the frame's jittered matrix so it covers the pixels the surface did, its motion taken between the
 * unjittered ones. **What it gives up**: a mover hidden behind glass or seen in a mirror keeps the
 * camera's motion; a multisampled frame keeps it everywhere; and a morph target's change of shape
 * is not followed.
 */
import { MORPH_DELTA_TEXTURE_UNIT, SKIN_PALETTE_TEXTURE_UNIT } from '../../lightBudget.ts';
import { compileProgram, uniformLocations } from '../../shader.ts';
import { SkinPaletteTexture } from './skinPaletteTexture.ts';
import type { Mesh } from '../../mesh.ts';

const RIGID = 0;
const SKINNED = 1;
const DYNAMIC = 2;
type Kind = typeof RIGID | typeof SKINNED | typeof DYNAMIC;

/** The vertex stage for one kind, skinned with eight influences where `eight` says. */
function vertexSource(kind: Kind, eight: boolean): string {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aWas;
layout(location = 11) in vec4 aJoints;
layout(location = 12) in vec4 aWeights;
layout(location = 14) in vec4 aJoints2;
layout(location = 15) in vec4 aWeights2;
uniform mat4 uModel;
uniform mat4 uWasModel;
uniform mat4 uJittered;
uniform mat4 uViewProj;
uniform mat4 uWasViewProj;
uniform highp sampler2D uPaletteNow;
uniform highp sampler2D uPaletteWas;
out vec4 vNow;
out vec4 vWas;

mat4 joint(highp sampler2D palette, float index) {
  int x = int(index) * 4;
  return mat4(
    texelFetch(palette, ivec2(x, 0), 0),
    texelFetch(palette, ivec2(x + 1, 0), 0),
    texelFetch(palette, ivec2(x + 2, 0), 0),
    texelFetch(palette, ivec2(x + 3, 0), 0));
}

/* The same blend as skinning.ts, joint by joint, so a skinned mover lands where its draw did. */
mat4 skin(highp sampler2D palette) {
  mat4 m = joint(palette, aJoints.x) * aWeights.x + joint(palette, aJoints.y) * aWeights.y
    + joint(palette, aJoints.z) * aWeights.z + joint(palette, aJoints.w) * aWeights.w;
  ${
    eight
      ? `m += joint(palette, aJoints2.x) * aWeights2.x + joint(palette, aJoints2.y) * aWeights2.y
    + joint(palette, aJoints2.z) * aWeights2.z + joint(palette, aJoints2.w) * aWeights2.w;`
      : ''
  }
  return m;
}

void main() {
  vec4 now = vec4(aPosition, 1.0);
  vec4 was = now;
  ${
    kind === SKINNED
      ? 'was = skin(uPaletteWas) * now;\n  now = skin(uPaletteNow) * now;'
      : kind === DYNAMIC
        ? 'was = vec4(aWas, 1.0);'
        : ''
  }
  vec4 world = uModel * now;
  gl_Position = uJittered * world;
  vNow = uViewProj * world;
  vWas = uWasViewProj * (uWasModel * was);
}
`;
}

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec4 vNow;
in vec4 vWas;
out vec4 motion;
/* The offset on screen to where this surface stood, its distance from last frame's eye, and 1. */
void main() {
  vec2 now = vNow.xy / vNow.w * 0.5 + 0.5;
  vec2 was = vWas.xy / max(vWas.w, 1e-6) * 0.5 + 0.5;
  motion = vec4(was - now, vWas.w, 1.0);
}
`;

interface Program {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation>;
}

export class GlMotionPass {
  private readonly programs = new Map<number, Program>();
  private texture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;
  private depth: WebGLTexture | null = null;
  /** This frame's palette and last frame's, uploaded record by record. */
  private readonly paletteNow = new SkinPaletteTexture();
  private readonly paletteWas = new SkinPaletteTexture();

  /** The frame's movers: mesh, kind, two matrices, two palettes. Grown, never shrunk. */
  private readonly meshes: Mesh[] = [];
  private kinds = new Uint8Array(16);
  private matrices = new Float32Array(16 * 32);
  private readonly palettes: (Float32Array | null)[] = [];
  private readonly wasPalettes: (Float32Array | null)[] = [];
  private count = 0;

  /** A frame states its movers afresh. */
  reset(): void {
    this.count = 0;
  }

  get recorded(): number {
    return this.count;
  }

  /** A rigid mover under last frame's model. */
  recordRigid(mesh: Mesh, model: ArrayLike<number>, wasModel: ArrayLike<number>): void {
    this.take(mesh, RIGID, model, wasModel, null, null);
  }

  /** A skinned mover under last frame's model and palette. */
  recordSkinned(
    mesh: Mesh,
    model: ArrayLike<number>,
    wasModel: ArrayLike<number>,
    palette: Float32Array,
    wasPalette: Float32Array,
  ): void {
    this.take(mesh, SKINNED, model, wasModel, palette, wasPalette);
  }

  /** A mesh rewritten this frame, under last frame's positions and model. */
  recordDynamic(mesh: Mesh, model: ArrayLike<number>, wasModel: ArrayLike<number>): void {
    this.take(mesh, DYNAMIC, model, wasModel, null, null);
  }

  private take(
    mesh: Mesh,
    kind: Kind,
    model: ArrayLike<number>,
    wasModel: ArrayLike<number>,
    palette: Float32Array | null,
    wasPalette: Float32Array | null,
  ): void {
    const at = this.count;
    if (at >= this.kinds.length) {
      const kinds = new Uint8Array(this.kinds.length * 2);
      kinds.set(this.kinds);
      this.kinds = kinds;
      const matrices = new Float32Array(this.matrices.length * 2);
      matrices.set(this.matrices);
      this.matrices = matrices;
    }
    this.meshes[at] = mesh;
    this.kinds[at] = kind;
    this.matrices.set(model, at * 32);
    this.matrices.set(wasModel, at * 32 + 16);
    this.palettes[at] = palette;
    this.wasPalettes[at] = wasPalette;
    this.count = at + 1;
  }

  /**
   * Draw the recorded movers into the motion target against `depth`, and return the target; null
   * where nothing was recorded. Leaves the framebuffer, program and array unbound, the depth test on
   * with the frame's compare and writes on, no offset, and the palette units holding its palettes.
   */
  draw(
    gl: WebGL2RenderingContext,
    depth: WebGLTexture,
    width: number,
    height: number,
    reversedDepth: boolean,
    jittered: Float32Array,
    viewProj: Float32Array,
    wasViewProj: Float32Array,
  ): WebGLTexture | null {
    if (this.count === 0) return null;
    this.ensureTarget(gl, depth, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(reversedDepth ? gl.GEQUAL : gl.LEQUAL);
    /* Toward the eye, which is a larger depth when depth is reversed. */
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(reversedDepth ? 1 : -1, reversedDepth ? 4 : -4);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    for (let i = 0; i < this.count; i++) {
      const mesh = this.meshes[i] as Mesh;
      const kind = this.kinds[i] as Kind;
      const eight = kind === SKINNED && mesh.isSkinnedEight;
      const { program, uniforms } = this.programFor(gl, kind, eight);
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms['uJittered'] ?? null, false, jittered);
      gl.uniformMatrix4fv(uniforms['uViewProj'] ?? null, false, viewProj);
      gl.uniformMatrix4fv(uniforms['uWasViewProj'] ?? null, false, wasViewProj);
      gl.uniformMatrix4fv(uniforms['uModel'] ?? null, false, this.matrices, i * 32, 16);
      gl.uniformMatrix4fv(uniforms['uWasModel'] ?? null, false, this.matrices, i * 32 + 16, 16);
      if (kind === SKINNED) {
        /* On the units a skinned draw binds its palette and morph on, which every one binds again
           for itself: nothing the lit pass keeps across frames is moved. */
        gl.activeTexture(gl.TEXTURE0 + SKIN_PALETTE_TEXTURE_UNIT);
        this.paletteNow.update(gl, this.palettes[i] as Float32Array);
        gl.activeTexture(gl.TEXTURE0 + MORPH_DELTA_TEXTURE_UNIT);
        this.paletteWas.update(gl, this.wasPalettes[i] as Float32Array);
        gl.uniform1i(uniforms['uPaletteNow'] ?? null, SKIN_PALETTE_TEXTURE_UNIT);
        gl.uniform1i(uniforms['uPaletteWas'] ?? null, MORPH_DELTA_TEXTURE_UNIT);
      }
      mesh.drawMotion(gl, kind === DYNAMIC);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.depthMask(true);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.texture;
  }

  private programFor(gl: WebGL2RenderingContext, kind: Kind, eight: boolean): Program {
    const key = kind * 2 + (eight ? 1 : 0);
    const held = this.programs.get(key);
    if (held !== undefined) return held;
    const program = compileProgram(gl, vertexSource(kind, eight), FRAGMENT, `motion.${key}`);
    const made = { program, uniforms: uniformLocations(gl, program, `motion.${key}`) };
    this.programs.set(key, made);
    return made;
  }

  /** An `RGBA16F` target the frame's size, its depth the frame's own attachment. */
  private ensureTarget(
    gl: WebGL2RenderingContext,
    depth: WebGLTexture,
    width: number,
    height: number,
  ): void {
    if (this.texture !== null && this.width === width && this.height === height) {
      if (this.depth === depth) return;
    } else {
      if (this.texture !== null) gl.deleteTexture(this.texture);
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.width = width;
      this.height = height;
    }
    this.framebuffer ??= gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.depth = depth;
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const { program } of this.programs.values()) gl.deleteProgram(program);
    this.programs.clear();
    if (this.texture !== null) gl.deleteTexture(this.texture);
    if (this.framebuffer !== null) gl.deleteFramebuffer(this.framebuffer);
    this.texture = null;
    this.framebuffer = null;
  }
}
