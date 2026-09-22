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
  max,
  mix,
  positionGeometry,
  screenCoordinate,
  screenUV,
  sqrt,
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
import { FnVar } from './internal/FnVar'
import type { Node } from './internal/node'
import { outputTexture } from './internal/OutputTextureNode'

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

export function getCloudsBayerPhase(x: number, y: number): number {
  const column = ((x % 4) + 4) % 4
  const row = ((y % 4) + 4) % 4
  return bayerIndices[row * 4 + column]
}

const clipAABB = /*#__PURE__*/ FnVar(
  (
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    minColor: Node<'vec4'>,
    maxColor: Node<'vec4'>
  ): Node<'vec4'> => {
    const center = maxColor.rgb.add(minColor.rgb).mul(0.5).toConst()
    const extent = maxColor.rgb.sub(minColor.rgb).mul(0.5).add(1e-7)
    const delta = history.sub(vec4(center, current.a)).toConst()
    const unit = delta.xyz.div(extent).abs().toConst()
    const maximum = max(unit.x, max(unit.y, unit.z)).toConst()
    return maximum
      .greaterThan(1)
      .select(vec4(center, current.a).add(delta.div(maximum)), history)
  }
)

/**
 * UV-based variance clipping for the low-resolution input. The WebGL TAAU path
 * samples this neighbourhood with filtered texture reads rather than integer
 * texel loads.
 */
const varianceClippingUV = /*#__PURE__*/ FnVar(
  (
    inputNode: TextureNode,
    uv: Node<'vec2'>,
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    gamma: Node<'float'>
  ): Node<'vec4'> => {
    const inputTexelSize = vec2(textureSize(inputNode)).reciprocal()
    const moment1 = current.toVar()
    const moment2 = current.pow2().toVar()

    for (const [x, y] of varianceOffsets) {
      const neighbor = texture(
        inputNode,
        uv.add(vec2(x, y).mul(inputTexelSize)),
        int(0)
      ).toConst()
      moment1.addAssign(neighbor)
      moment2.addAssign(neighbor.pow2())
    }

    const sampleCount = varianceOffsets.length + 1
    const mean = moment1.div(sampleCount).toConst()
    const deviation = sqrt(moment2.div(sampleCount).sub(mean.pow2()).max(0))
      .mul(gamma)
      .toConst()
    const minColor = mean.sub(deviation).toConst()
    const maxColor = mean.add(deviation).toConst()
    // WebGL: clipAABB(clamp(mean, min, max), history, ...) — not current.
    return clipAABB(mean.clamp(minColor, maxColor), history, minColor, maxColor)
  }
)

const varianceClippingLoad = /*#__PURE__*/ FnVar(
  (
    inputNode: TextureNode,
    coord: Node<'ivec2'>,
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    gamma: Node<'float'>
  ): Node<'vec4'> => {
    const maxCoord = ivec2(textureSize(inputNode)).sub(1).toConst()
    const moment1 = current.toVar()
    const moment2 = current.pow2().toVar()

    for (const [x, y] of varianceOffsets) {
      const neighborCoord = coord
        .add(ivec2(x, y))
        .clamp(ivec2(0), maxCoord)
        .toConst()
      const neighbor = inputNode.load(neighborCoord).toConst()
      moment1.addAssign(neighbor)
      moment2.addAssign(neighbor.pow2())
    }

    const sampleCount = varianceOffsets.length + 1
    const mean = moment1.div(sampleCount).toConst()
    const deviation = sqrt(moment2.div(sampleCount).sub(mean.pow2()).max(0))
      .mul(gamma)
      .toConst()
    const minColor = mean.sub(deviation).toConst()
    const maxColor = mean.add(deviation).toConst()
    // WebGL: clipAABB(clamp(mean, min, max), history, ...) — not current.
    return clipAABB(mean.clamp(minColor, maxColor), history, minColor, maxColor)
  }
)

function getClosestDepthVelocity(
  velocityNode: TextureNode,
  coord: Node<'ivec2'>
): Node<'vec4'> {
  const closest = vec4(1e7, 0, 0, 0).toVar()
  const maxCoord = ivec2(textureSize(velocityNode)).sub(1).toConst()
  for (const [x, y] of closestOffsets) {
    const neighborCoord = coord
      .add(ivec2(x, y))
      .clamp(ivec2(0), maxCoord)
      .toConst()
    const neighbor = velocityNode.load(neighborCoord)
    closest.assign(neighbor.r.lessThan(closest.r).select(neighbor, closest))
  }
  return closest
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

        If(isCurrentPhase, () => {
          outputColor.assign(current)
        }).Else(() => {
          // historyValid as mix factor stays live in WGSL (avoids bool fold).
          const closest = getClosestDepthVelocity(
            owner.velocityNode,
            lowResCoord
          ).toConst()
          const prevUv = screenUV.sub(closest.gb).toConst()
          const inside = prevUv
            .greaterThanEqual(0)
            .all()
            .and(prevUv.lessThanEqual(1).all())

          const historyReproj = texture(owner.historyNode, prevUv, int(0))
          // WebGL TAAU: variance-clip history; on miss fall back to current
          // (not same-UV history - that leaves infinite motion trails).
          const clipped = varianceClippingUV(
            owner.inputNode,
            screenUV,
            current,
            historyReproj,
            owner.varianceGamma
          )
          // Phase 1b: hard-cut ghosts. OOB -> current; fast UV motion -> lean to
          // current (gamma=2 keeps soft stills). Prove Y with debugOutput=velocity.
          const speed = closest.g.abs().add(closest.b.abs())
          const motion = speed
            .smoothstep(float(0.002), float(0.014))
            .mul(speed.smoothstep(float(0.002), float(0.014))) // 1b follow-up: harder linger cut
          const historySample = inside.select(
            mix(clipped, current, motion),
            current
          )
          outputColor.assign(mix(current, historySample, owner.historyValid))
        })
      }).Else(() => {
        const current = owner.inputNode.load(coord).toConst()
        const closest = getClosestDepthVelocity(
          owner.velocityNode,
          coord
        ).toConst()
        const prevUv = screenUV.sub(closest.gb).toConst()
        const inside = prevUv
          .greaterThanEqual(0)
          .all()
          .and(prevUv.lessThanEqual(1).all())

        const history = texture(owner.historyNode, prevUv, int(0))
        const clipped = varianceClippingLoad(
          owner.inputNode,
          coord,
          current,
          history,
          float(1)
        )
        // Phase 1b: same motion hard-cut on full-res TAA path.
        const speed = closest.g.abs().add(closest.b.abs())
        const motion = speed
          .smoothstep(float(0.002), float(0.014))
          .mul(speed.smoothstep(float(0.002), float(0.014))) // 1b follow-up: harder linger cut
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
  readonly varianceGamma = uniform(2).setName('cloudsVarianceGamma') // Phase 1a: match WebGL CloudsResolveMaterial
  readonly texelSize = uniform(new Vector2(1, 1)).setName(
    'cloudsResolveTexelSize'
  )
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
    const w = Math.max(Math.round(width), 1)
    const h = Math.max(Math.round(height), 1)
    if (w !== this.resolveTarget.width || h !== this.resolveTarget.height) {
      this.resolveTarget.setSize(w, h)
      this.historyTarget.setSize(w, h)
      this.texelSize.value.set(1 / w, 1 / h)
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

export const cloudsResolve = (
  ...args: ConstructorParameters<typeof CloudsResolveNode>
): CloudsResolveNode => new CloudsResolveNode(...args)
