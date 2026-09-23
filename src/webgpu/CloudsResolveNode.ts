// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/CloudsResolveNode.ts

import {
  HalfFloatType,
  LinearFilter,
  NoBlending,
  RenderTarget,
  RGBAFormat,
  Vector2
} from 'three'
import {
  Fn,
  float,
  If,
  int,
  ivec2,
  mix,
  positionGeometry,
  screenCoordinate,
  screenUV,
  texture,
  textureSize,
  uniform,
  vec2,
  vec4
} from 'three/tsl'
import {
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
  closestDepthVelocity,
  motionFactor,
  varianceClip
} from './temporalResolve'

const { resetRendererState, restoreRendererState } = RendererUtils

const closestOffsets: Array<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 0],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
]

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

function cloudHistoryExtent(): Node<'vec4'> {
  return vec4(0, 0, 0, float(HISTORY_ALPHA_EXTENT_FLOOR))
}

function sampleClosestCloudVelocity(
  velocityNode: TextureNode,
  coord: Node<'ivec2'>
): Node<'vec4'> {
  const maxCoord = ivec2(textureSize(velocityNode)).sub(1).toConst()
  return closestDepthVelocity({
    offsets: closestOffsets,
    initial: vec4(1e7, 0, 0, 0),
    sample: (x, y) => {
      const neighborCoord = coord
        .add(ivec2(x, y))
        .clamp(ivec2(0), maxCoord)
        .toConst()
      return velocityNode.load(neighborCoord)
    }
  })
}

class CloudsResolveColorNode extends TempNode {
  static get type(): string {
    return 'CloudsResolveColorNode'
  }

  constructor(private readonly owner: CloudsResolveNode) {
    super('vec4')
  }

  override setup(): ThreeNode | null | undefined {
    const owner = this.owner

    return Fn(() => {
      const coord = ivec2(screenCoordinate.xy)
      const outputColor = vec4(0).toVar()

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

        const closest = sampleClosestCloudVelocity(
          owner.velocityNode,
          nearestBlock
        ).toConst()
        const prevUv = screenUV.sub(closest.gb).toConst()
        const inside = prevUv
          .greaterThanEqual(0)
          .all()
          .and(prevUv.lessThanEqual(1).all())

        const historyReproj = texture(owner.historyNode, prevUv, int(0))
        // 3x3 around the reconstruction sample (+ center = 9). Still pixels
        // widen the box; motion falls back to varianceGamma.
        const motion = motionFactor(closest.gb)
        const gamma = mix(
          owner.varianceGamma.mul(TEMPORAL_UPSCALE_STATIC_GAMMA),
          owner.varianceGamma,
          motion
        )
        const inputTexelSize = lowResSize.reciprocal()
        const clipped = varianceClip({
          offsets: upscaleVarianceOffsets,
          current: recon,
          history: historyReproj,
          gamma,
          clipAlpha: true,
          minExtent: cloudHistoryExtent,
          sampleNeighbor: (x, y) =>
            texture(
              owner.inputNode,
              reconUv.add(vec2(x, y).mul(inputTexelSize))
            )
        })
        // OOB or fast motion falls back to the reconstruction, not a block texel.
        const temporal = mix(
          clipped,
          recon,
          owner.temporalUpscaleAlpha.mul(weight)
        )
        const motionSafe = mix(temporal, recon, motion)
        const withHistory = inside.select(motionSafe, recon)
        outputColor.assign(mix(recon, withHistory, owner.historyValid))
      }).Else(() => {
        const current = owner.inputNode.load(coord).toConst()
        const closest = sampleClosestCloudVelocity(
          owner.velocityNode,
          coord
        ).toConst()
        const prevUv = screenUV.sub(closest.gb).toConst()
        const inside = prevUv
          .greaterThanEqual(0)
          .all()
          .and(prevUv.lessThanEqual(1).all())

        const history = texture(owner.historyNode, prevUv, int(0))
        const maxCoord = ivec2(textureSize(owner.inputNode)).sub(1).toConst()
        const clipped = varianceClip({
          offsets: varianceOffsets,
          current,
          history,
          gamma: float(1),
          clipAlpha: true,
          minExtent: cloudHistoryExtent,
          sampleNeighbor: (x, y) =>
            owner.inputNode.load(
              coord.add(ivec2(x, y)).clamp(ivec2(0), maxCoord)
            )
        })
        // Same motion hard-cut on the full-res TAA path.
        const motion = motionFactor(closest.gb)
        const temporal = mix(clipped, current, owner.temporalAlpha)
        const motionSafe = mix(temporal, current, motion)
        const withHistory = inside.select(motionSafe, current)
        outputColor.assign(mix(current, withHistory, owner.historyValid))
      })

      return outputColor
    })()
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
  readonly temporalAlpha = uniform(0.1).setName('cloudsTemporalAlpha')
  /**
   * TAAU blend toward the fresh reconstruction, scaled by distance to this
   * frame's Bayer sample. 1 replaces the phase pixel outright.
   */
  readonly temporalUpscaleAlpha = uniform(0.22).setName(
    'cloudsTemporalUpscaleAlpha'
  )
  readonly varianceGamma = uniform(2).setName('cloudsVarianceGamma')
  readonly temporalUpscaleNode = uniform(1).setName('cloudsTemporalUpscale')
  readonly historyValid = uniform(0).setName('cloudsHistoryValid')

  private resolveTarget = this.createTarget('CloudsResolve')
  private historyTarget = this.createTarget('CloudsHistory')
  private readonly material = new NodeMaterial()
  private readonly mesh: QuadMesh
  private readonly textureNode: TextureNode
  readonly historyNode = texture(this.historyTarget.texture)
  private rendererState?: RendererUtils.RendererState
  private needsClearHistory = true
  private _temporalUpscale = true
  /** When false, history is never reused (forces current-only resolve). */
  historyEnabled = true

  constructor(inputNode: TextureNode, velocityNode: TextureNode) {
    super('vec4')
    this.inputNode = inputNode
    this.velocityNode = velocityNode
    this.updateBeforeType = NodeUpdateType.NONE

    this.textureNode = outputTexture(this, this.historyTarget.texture)
    this.material.name = 'CloudsResolve'
    this.material.blending = NoBlending
    this.material.depthTest = false
    this.material.depthWrite = false
    this.material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    this.material.fragmentNode = new CloudsResolveColorNode(this)
    this.material.needsUpdate = true
    this.mesh = new QuadMesh(this.material)
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private createTarget(name: string): RenderTarget {
    const target = new RenderTarget(1, 1, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    target.texture.minFilter = LinearFilter
    target.texture.magFilter = LinearFilter
    target.texture.generateMipmaps = false
    target.texture.name = name
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
    this.mesh.geometry.dispose()
    super.dispose()
  }
}
