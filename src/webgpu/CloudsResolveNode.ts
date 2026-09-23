// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/CloudsResolveNode.ts

import {
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NoBlending,
  RenderTarget,
  RGFormat,
  RGBAFormat,
  Vector2
} from 'three'
import {
  Fn,
  float,
  If,
  int,
  ivec2,
  max,
  min,
  mix,
  screenCoordinate,
  screenUV,
  struct,
  texture,
  textureSize,
  uniform,
  vec2,
  vec4
} from 'three/tsl'
import {
  MRTNode,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  TempNode,
  type TextureNode
} from 'three/webgpu'

import { bayerOffsets } from '../bayer'
import { computeCloudsSizes } from './cloudsSizes'
import type { Node } from './internal/node'
import { outputTexture } from './internal/OutputTextureNode'
import {
  closestDepthVelocityRange,
  closestNeighbourOffsets,
  cloudVarianceClip,
  motionFactor
} from './temporalResolve'

const { resetRendererState, restoreRendererState } = RendererUtils

// Full-res TAA keeps the 4-neighbour cross (+ current = 5).
const varianceOffsets: Array<readonly [number, number]> = [
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
]

// TAAU clips against the full 3x3 around the reconstruction sample.
const upscaleVarianceOffsets: Array<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
]

/** Full-res pixels. w = 1 on this frame's Bayer sample, ~0.19 one pixel away. */
const TEMPORAL_UPSCALE_SIGMA = 0.55
/** Still pixels use varianceGamma * this, so a noisy low-res box does not clip history. */
const TEMPORAL_UPSCALE_STATIC_GAMMA = 2
/** Alpha half-extent floor. Only alpha is clamped; rgb stays on the original box. */
const HISTORY_ALPHA_EXTENT_FLOOR = 1 / 64
/** Depth reject stays off until the pixel is actually moving. */
const DEPTH_REJECT_MOTION = 0.02

const resolveMrtStruct = /*#__PURE__*/ struct(
  { color: 'vec4', confidence: 'vec2' },
  'CloudsResolveMrt'
)

function sampleClosestCloudVelocity(
  velocityNode: TextureNode,
  coord: Node<'ivec2'>
): {
  closest: Node<'vec4'>
  center: Node<'vec4'>
  minDepth: Node<'float'>
  maxDepth: Node<'float'>
} {
  const maxCoord = ivec2(textureSize(velocityNode)).sub(1).toConst()
  const loadAt = (x: number, y: number): Node<'vec4'> => {
    const neighborCoord = coord
      .add(ivec2(x, y))
      .clamp(ivec2(0), maxCoord)
      .toConst()
    return velocityNode.load(neighborCoord)
  }
  return closestDepthVelocityRange({
    offsets: closestNeighbourOffsets,
    center: loadAt(0, 0),
    sample: loadAt
  })
}

/**
 * Deferred resolve MRT. This must remain an {@link MRTNode}; a plain TempNode
 * does not emit the WGSL output struct and silently clears both attachments.
 */
class CloudsResolveColorNode extends MRTNode {
  static get type(): string {
    return 'CloudsResolveColorNode'
  }

  constructor(private readonly owner: CloudsResolveNode) {
    super({})
  }

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    const owner = this.owner
    const result = Fn(() => {
      const coord = ivec2(screenCoordinate.xy)
      const outputColor = vec4(0).toVar()
      const meta = vec2(0).toVar()
      // Front depth jitters between Bayer samples even when the camera is still.
      // A 15% window treated that as a disocclusion and capped N on cloud edges,
      // which brought the grain back. Reject only a real ratio miss, and only
      // once the pixel is moving.
      const depthIsStale = (
        histDepth: Node<'float'>,
        depthMin: Node<'float'>,
        depthMax: Node<'float'>,
        motion: Node<'float'>
      ): Node<'bool'> => {
        const scale = float(1).add(owner.depthRejectTolerance)
        return histDepth
          .lessThan(depthMin.div(scale))
          .or(histDepth.greaterThan(depthMax.mul(scale)))
          .and(motion.greaterThan(float(DEPTH_REJECT_MOTION)))
      }
      const readHistoryState = (
        neighborhood: ReturnType<typeof sampleClosestCloudVelocity>,
        prevUv: Node<'vec2'>
      ): {
        histMeta: Node<'vec4'>
        motion: Node<'float'>
        depthReject: Node<'bool'>
        ownDepth: Node<'float'>
      } => {
        const depthMin = neighborhood.minDepth.div(owner.cameraFar)
        const depthMax = neighborhood.maxDepth.div(owner.cameraFar)
        const ownDepth = neighborhood.center.r.div(owner.cameraFar)
        const histMeta = texture(owner.historyMetaNode, prevUv, int(0))
        const motion = motionFactor(neighborhood.closest.gb)
        return {
          histMeta,
          motion,
          depthReject: depthIsStale(histMeta.g, depthMin, depthMax, motion),
          ownDepth
        }
      }
      // N is history confidence before this sample. Saturated N (Nmax = 1/a)
      // makes alpha = a*w, today's blend. OOB, depth reject and motion only
      // lower N, so those pixels converge faster and fall back toward the
      // neighbourhood mean instead of the raw reconstruction.
      const resolveTemporal = (options: {
        recon: Node<'vec4'>
        clipped: Node<'vec4'>
        mean: Node<'vec4'>
        inside: Node<'bool'>
        weight: Node<'float'>
        freshAlpha: Node<'float'>
        motion: Node<'float'>
        ownDepth: Node<'float'>
        depthReject: Node<'bool'>
        histMeta: Node<'vec4'>
      }): void => {
        const {
          recon,
          clipped,
          mean,
          inside,
          weight,
          freshAlpha,
          motion,
          ownDepth,
          depthReject,
          histMeta
        } = options
        const nMax = max(freshAlpha, float(1e-4)).reciprocal()
        const histN = inside
          .select(histMeta.r, float(0))
          .mul(owner.historyValid)
        const nDepth = depthReject.select(
          min(histN, owner.rejectConfidence),
          histN
        )
        const N = min(
          nDepth,
          mix(nMax, owner.motionConfidenceFloor, motion)
        )
        const reconFallback = mix(
          mean,
          recon,
          N.div(max(owner.fallbackConfidence, float(1e-4))).saturate()
        )
        const alpha = max(
          freshAlpha.mul(weight),
          // 1e-4 left the farthest Bayer pixel (w ~ 1e-6) on stale history
          // during a hard motion cut. 1e-8 still ignores a true zero weight.
          weight.div(max(N.add(weight), float(1e-8)))
        )
        const temporal = mix(clipped, reconFallback, alpha)
        const withHistory = inside.select(temporal, reconFallback)
        outputColor.assign(mix(recon, withHistory, owner.historyValid))
        meta.assign(vec2(min(N.add(weight), nMax), ownDepth))
      }

      If(owner.temporalUpscaleNode.greaterThan(0), () => {
        // Full-res pixel center relative to this frame's Bayer sample lattice.
        // jitterOffset is bayerOffsets[frame] * 4 (unflipped, Y-down), so d is
        // 0 exactly where the old phase test was true.
        const pixelCenter = vec2(coord).add(0.5)
        const rel = pixelCenter.sub(owner.jitterOffset).toConst()
        const nearest = rel.div(4).add(0.5).floor()
        const nearestBlock = ivec2(nearest).toConst()
        const delta = rel.sub(nearest.mul(4)).toConst()
        const sigma2 = float(TEMPORAL_UPSCALE_SIGMA * TEMPORAL_UPSCALE_SIGMA)
        const weight = delta.dot(delta).div(sigma2.mul(2)).negate().exp()

        // Tent filter on the jittered low-res lattice. Equals the point sample
        // on a phase pixel; blends neighbours elsewhere (no 4x4 blocks).
        const lowResSize = vec2(textureSize(owner.inputNode)).toConst()
        const reconUv = rel.div(4).add(0.5).div(lowResSize).toConst()
        const recon = texture(owner.inputNode, reconUv).toConst()

        const neighborhood = sampleClosestCloudVelocity(
          owner.velocityNode,
          nearestBlock
        )
        const closest = neighborhood.closest.toConst()
        const prevUv = screenUV.sub(closest.gb).toConst()
        const inside = prevUv
          .greaterThanEqual(0)
          .all()
          .and(prevUv.lessThanEqual(1).all())

        const historyReproj = texture(owner.historyNode, prevUv, int(0))
        const historyState = readHistoryState(neighborhood, prevUv)
        // 3x3 around the reconstruction sample (+ center = 9). Still pixels
        // widen the box; motion falls back to varianceGamma. A moving depth
        // mismatch uses the tight reject gamma instead.
        const gamma = historyState.depthReject.select(
          owner.varianceGammaReject,
          mix(
            owner.varianceGamma.mul(owner.varianceGammaStatic),
            owner.varianceGamma,
            historyState.motion
          )
        )
        const inputTexelSize = lowResSize.reciprocal()
        const clip = cloudVarianceClip({
          offsets: upscaleVarianceOffsets,
          current: recon,
          history: historyReproj,
          gamma,
          alphaExtentFloor: HISTORY_ALPHA_EXTENT_FLOOR,
          sampleNeighbor: (x, y) =>
            texture(
              owner.inputNode,
              reconUv.add(vec2(x, y).mul(inputTexelSize))
            )
        })
        resolveTemporal({
          recon,
          clipped: clip.color,
          mean: clip.mean,
          inside,
          weight,
          freshAlpha: owner.temporalUpscaleAlpha,
          motion: historyState.motion,
          ownDepth: historyState.ownDepth,
          depthReject: historyState.depthReject,
          histMeta: historyState.histMeta
        })
      }).Else(() => {
        // Full-res TAA. Same confidence, depth reject and mean fallback as the
        // upscale path, with w = 1 and gamma = 1 unless the depth test tightens
        // it. The colour neighbourhood stays the 4-cross.
        const current = owner.inputNode.load(coord).toConst()
        const neighborhood = sampleClosestCloudVelocity(
          owner.velocityNode,
          coord
        )
        const closest = neighborhood.closest.toConst()
        const prevUv = screenUV.sub(closest.gb).toConst()
        const inside = prevUv
          .greaterThanEqual(0)
          .all()
          .and(prevUv.lessThanEqual(1).all())

        const history = texture(owner.historyNode, prevUv, int(0))
        const historyState = readHistoryState(neighborhood, prevUv)
        const maxCoord = ivec2(textureSize(owner.inputNode)).sub(1).toConst()
        const clip = cloudVarianceClip({
          offsets: varianceOffsets,
          current,
          history,
          gamma: historyState.depthReject.select(
            owner.varianceGammaReject,
            float(1)
          ),
          alphaExtentFloor: HISTORY_ALPHA_EXTENT_FLOOR,
          sampleNeighbor: (x, y) =>
            owner.inputNode.load(
              coord.add(ivec2(x, y)).clamp(ivec2(0), maxCoord)
            )
        })
        resolveTemporal({
          recon: current,
          clipped: clip.color,
          mean: clip.mean,
          inside,
          weight: float(1),
          freshAlpha: owner.temporalAlpha,
          motion: historyState.motion,
          ownDepth: historyState.ownDepth,
          depthReject: historyState.depthReject,
          histMeta: historyState.histMeta
        })
      })

      return resolveMrtStruct(outputColor, meta)
    })()
    this.outputNodes = {
      output: result.get('color'),
      confidence: result.get('confidence')
    }
    return super.setup(builder) as ThreeNode | null | undefined
  }
}

/**
 * Cloud-specific temporal resolve. With upscaling it reconstructs the
 * quarter-resolution Bayer lattice and accumulates it. Otherwise it performs
 * same-resolution TAA.
 */
export class CloudsResolveNode extends TempNode {
  static get type(): string {
    return 'CloudsResolveNode'
  }

  readonly inputNode: TextureNode
  readonly velocityNode: TextureNode
  readonly frame = uniform(0, 'int').setName('cloudsResolveFrame')
  /** This frame's Bayer sample, in full-res pixels (Y-down). Set in render(). */
  readonly jitterOffset = uniform(new Vector2()).setName(
    'cloudsResolveJitterOffset'
  )
  /**
   * Full-res TAA blend toward the current sample. Also sets Nmax = 1 / alpha
   * on that path. Unused while temporal upscaling is on.
   */
  readonly temporalAlpha = uniform(0.1).setName('cloudsTemporalAlpha')
  /**
   * Upscale-path blend toward the fresh reconstruction, scaled by distance to
   * this frame's Bayer sample. 1 replaces the phase pixel outright. Also sets
   * Nmax = 1 / alpha on that path. Unused while temporal upscaling is off.
   */
  readonly temporalUpscaleAlpha = uniform(0.22).setName(
    'cloudsTemporalUpscaleAlpha'
  )
  /** Upscale-path neighbourhood gamma. Full-res TAA uses 1. */
  readonly varianceGamma = uniform(2).setName('cloudsVarianceGamma')
  /** Still upscale pixels use varianceGamma * this. Default 2, so the box gamma stays 4. */
  readonly varianceGammaStatic = uniform(TEMPORAL_UPSCALE_STATIC_GAMMA).setName(
    'cloudsVarianceGammaStatic'
  )
  /**
   * History depth may fall this far outside the 3x3 range and still match.
   * 1 accepts from min/2 to max*2. Same-surface Bayer jitter stays inside;
   * a cloud against the sky does not.
   */
  readonly depthRejectTolerance = uniform(1).setName(
    'cloudsDepthRejectTolerance'
  )
  /** Box gamma used when history depth falls outside that range. */
  readonly varianceGammaReject = uniform(1).setName('cloudsVarianceGammaReject')
  /** Confidence cap on a depth reject. 1 keeps a short tail; 0 is a hard reset. */
  readonly rejectConfidence = uniform(1).setName('cloudsRejectConfidence')
  /**
   * Fast-motion confidence cap. 0 drops history and shows the neighbourhood
   * mean, which is the rotation test that shipped. 1 would hold N at 1 and
   * can smear, so it stays at 0.
   */
  readonly motionConfidenceFloor = uniform(0).setName(
    'cloudsMotionConfidenceFloor'
  )
  /** Below this confidence, the fresh sample blends toward the neighbourhood mean. */
  readonly fallbackConfidence = uniform(1).setName('cloudsFallbackConfidence')
  readonly temporalUpscaleNode = uniform(1).setName('cloudsTemporalUpscale')
  readonly historyValid = uniform(0).setName('cloudsHistoryValid')
  /** March camera far. History depth is stored as depth / this. */
  readonly cameraFar: Node<'float'>

  private resolveTarget = this.createTarget()
  private historyTarget = this.createTarget()
  private readonly material = new NodeMaterial()
  private readonly mesh: QuadMesh
  private readonly textureNode: TextureNode
  private readonly confidenceNode: TextureNode
  readonly historyNode = texture(this.historyTarget.texture)
  readonly historyMetaNode = texture(this.historyTarget.textures[1])
  private rendererState?: RendererUtils.RendererState
  private needsClearHistory = true
  private _temporalUpscale = true
  /** When false, history is never reused (forces current-only resolve). */
  historyEnabled = true

  constructor(
    inputNode: TextureNode,
    velocityNode: TextureNode,
    cameraFar: Node<'float'>
  ) {
    super('vec4')
    this.inputNode = inputNode
    this.velocityNode = velocityNode
    this.cameraFar = cameraFar
    this.updateBeforeType = NodeUpdateType.NONE

    this.textureNode = outputTexture(this, this.historyTarget.texture)
    this.confidenceNode = outputTexture(this, this.historyTarget.textures[1])
    this.material.name = 'CloudsResolve'
    this.material.blending = NoBlending
    this.material.depthTest = false
    this.material.depthWrite = false
    this.material.fragmentNode = new CloudsResolveColorNode(this)
    this.material.needsUpdate = true
    this.mesh = new QuadMesh(this.material)
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private createTarget(): RenderTarget {
    const target = new RenderTarget(1, 1, {
      count: 2,
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    const [color, meta] = target.textures
    color.name = 'output'
    color.minFilter = LinearFilter
    color.magFilter = LinearFilter
    color.generateMipmaps = false
    // MRT name must match the output key. `meta` is reserved in WGSL.
    // RG16F keeps N and normalized depth; nearest avoids blending them.
    meta.name = 'confidence'
    meta.format = RGFormat
    meta.type = HalfFloatType
    meta.minFilter = NearestFilter
    meta.magFilter = NearestFilter
    meta.generateMipmaps = false
    return target
  }

  get temporalUpscale(): boolean {
    return this._temporalUpscale
  }

  set temporalUpscale(value: boolean) {
    if (value !== this._temporalUpscale) {
      this._temporalUpscale = value
      this.temporalUpscaleNode.value = value ? 1 : 0
      this.reset()
    }
  }

  get width(): number {
    return this.resolveTarget.width
  }

  get height(): number {
    return this.resolveTarget.height
  }

  getTextureNode(): TextureNode {
    return this.textureNode
  }

  /** Confidence history: r = N, g = view distance / cameraFar. */
  get historyConfidenceNode(): TextureNode {
    return this.confidenceNode
  }

  /**
   * Resolved colour target after {@link render} (the ping-pong buffer just
   * written). Demo readback only; the public image is {@link getTextureNode}.
   */
  get outputTarget(): RenderTarget {
    return this.historyTarget
  }

  setSize(width: number, height: number): this {
    const { outputWidth, outputHeight } = computeCloudsSizes(
      width,
      height,
      1,
      false
    )
    if (
      outputWidth !== this.resolveTarget.width ||
      outputHeight !== this.resolveTarget.height
    ) {
      this.resolveTarget.setSize(outputWidth, outputHeight)
      this.historyTarget.setSize(outputWidth, outputHeight)
      this.reset()
    }
    return this
  }

  reset(): this {
    this.needsClearHistory = true
    this.historyValid.value = 0
    return this
  }

  private clearHistory(frame: NodeFrame): void {
    const { renderer } = frame
    if (renderer == null) {
      return
    }
    renderer.setClearColor(0, 0)
    renderer.setRenderTarget(this.resolveTarget)
    renderer.clear()
    renderer.setRenderTarget(this.historyTarget)
    renderer.clear()
    this.needsClearHistory = false
  }

  private swapBuffers(): void {
    const previousResolve = this.resolveTarget
    this.resolveTarget = this.historyTarget
    this.historyTarget = previousResolve
    this.historyNode.value = this.historyTarget.texture
    this.textureNode.value = this.historyTarget.texture
    this.historyMetaNode.value = this.historyTarget.textures[1]
    this.confidenceNode.value = this.historyTarget.textures[1]
  }

  render(frame: NodeFrame): void {
    const { renderer } = frame
    if (renderer == null) {
      return
    }

    this.rendererState = resetRendererState(renderer, this.rendererState!)
    if (this.needsClearHistory) {
      this.clearHistory(frame)
    }

    const phase = ((this.frame.value % 16) + 16) % 16
    const offset = bayerOffsets[phase]
    this.jitterOffset.value.set(offset.x * 4, offset.y * 4)

    renderer.setRenderTarget(this.resolveTarget)
    renderer.setClearColor(0, 0)
    renderer.clear()
    if (!this.historyEnabled) {
      this.historyValid.value = 0
    }
    this.mesh.render(renderer)
    restoreRendererState(renderer, this.rendererState!)

    this.swapBuffers()
    this.historyValid.value = this.historyEnabled ? 1 : 0
  }

  override setup(_builder: NodeBuilder): ThreeNode | null | undefined {
    return this.textureNode
  }

  override dispose(): void {
    this.resolveTarget.dispose()
    this.historyTarget.dispose()
    this.material.dispose()
    super.dispose()
  }
}
