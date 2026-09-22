// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/CloudsResolveNode.ts

import {
  HalfFloatType,
  LinearFilter,
  NoBlending,
  RenderTarget,
  RGBAFormat
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
  uniformArray,
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

import { bayerIndices } from '../bayer'
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

// WebGL cloudsResolve.frag does NOT define VARIANCE_9_SAMPLES, so
// varianceClipping.glsl uses the 4-neighbour cross (+ current = 5).
// Shadow resolve keeps the 9-sample neighbourhood separately.
const varianceOffsets: Array<readonly [number, number]> = [
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
]

const bayerPhaseNodes = /*#__PURE__*/ uniformArray(
  Array.from(bayerIndices),
  'int'
).setName('cloudsBayerIndices')

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
        // WebGL: lowResCoord = coord / 4 (integer)
        const lowResCoord = ivec2(
          coord.x.div(int(4)),
          coord.y.div(int(4))
        ).toConst()
        const current = owner.inputNode.load(lowResCoord).toConst()

        // flat[y*4+x] — same layout as WebGL bayerIndices[x%4][y%4] when
        // screen Y is already top-left (march jitter Y flip is separate).
        const phaseIndex = coord.y
          .mod(int(4))
          .mul(int(4))
          .add(coord.x.mod(int(4)))
          .toConst()
        const currentPhase = bayerPhaseNodes.element(phaseIndex)
        const framePhase = owner.frame.mod(int(16))
        const isCurrentPhase = currentPhase.equal(framePhase)

        // Shared by both Bayer phases. Phase pixels used to hard-assign
        // `current`, which re-injected one raw STBN sample every 16 frames.
        const closest = sampleClosestCloudVelocity(
          owner.velocityNode,
          lowResCoord
        ).toConst()
        const prevUv = screenUV.sub(closest.gb).toConst()
        const inside = prevUv
          .greaterThanEqual(0)
          .all()
          .and(prevUv.lessThanEqual(1).all())

        const historyReproj = texture(owner.historyNode, prevUv, int(0))
        // Variance-clip history; on miss fall back to current (not same-UV
        // history — that leaves infinite motion trails). Filtered UV reads,
        // 4-neighbour cross (+ current = 5).
        const inputTexelSize = vec2(textureSize(owner.inputNode)).reciprocal()
        const clipped = varianceClip({
          offsets: varianceOffsets,
          current,
          history: historyReproj,
          gamma: owner.varianceGamma,
          sampleNeighbor: (x, y) =>
            texture(
              owner.inputNode,
              screenUV.add(vec2(x, y).mul(inputTexelSize)),
              int(0)
            )
        })
        // Hard-cut ghosts. OOB -> current; fast UV motion -> lean to
        // current (gamma=2 keeps soft stills). Prove Y with debugOutput=velocity.
        const motion = motionFactor(closest.gb)
        const historySample = inside.select(
          mix(clipped, current, motion),
          current
        )

        If(isCurrentPhase, () => {
          // EMA the fresh sample into history so STBN grain averages out.
          const temporal = mix(clipped, current, owner.temporalUpscaleAlpha)
          const motionSafe = mix(temporal, current, motion)
          const withHistory = inside.select(motionSafe, current)
          outputColor.assign(mix(current, withHistory, owner.historyValid))
        }).Else(() => {
          outputColor.assign(mix(current, historySample, owner.historyValid))
        })
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
 * Cloud-specific temporal resolve. It reconstructs one quarter-resolution Bayer
 * phase per frame, or performs same-resolution TAA when upscaling is off.
 */
export class CloudsResolveNode extends TempNode {
  static get type(): string {
    return 'CloudsResolveNode'
  }

  readonly inputNode: TextureNode
  readonly velocityNode: TextureNode
  readonly frame = uniform(0, 'int').setName('cloudsResolveFrame')
  readonly temporalAlpha = uniform(0.1).setName('cloudsTemporalAlpha')
  /**
   * TAAU phase-pixel blend toward the fresh sample. 1 restores the hard
   * 1/16 replacement; lower values let history average the STBN grain.
   */
  readonly temporalUpscaleAlpha = uniform(0.2).setName(
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
