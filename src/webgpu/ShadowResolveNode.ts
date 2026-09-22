// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/ShadowResolveNode.ts

import {
  HalfFloatType,
  LinearFilter,
  RenderTarget,
  RGBAFormat,
  Vector2
} from 'three'
import {
  ivec2,
  max,
  mix,
  positionGeometry,
  screenCoordinate,
  screenUV,
  sqrt,
  texture,
  uniform,
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

import { FnVar } from './internal/FnVar'
import type { Node } from './internal/node'
import { outputTexture } from './internal/OutputTextureNode'

const { resetRendererState, restoreRendererState } = RendererUtils

const varianceOffsets: Array<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
]

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

// Reference: https://github.com/playdeadgames/temporal
const clipAABB = /*#__PURE__*/ FnVar(
  (
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    minColor: Node<'vec4'>,
    maxColor: Node<'vec4'>
  ): Node<'vec4'> => {
    const pClip = maxColor.rgb.add(minColor.rgb).mul(0.5).toConst()
    const eClip = maxColor.rgb.sub(minColor.rgb).mul(0.5).add(1e-7)
    const vClip = history.sub(vec4(pClip, current.a)).toConst()
    const vUnit = vClip.xyz.div(eClip)
    const maxUnit = max(
      vUnit.abs().x,
      max(vUnit.abs().y, vUnit.abs().z)
    ).toConst()
    return maxUnit
      .greaterThan(1)
      .select(vec4(pClip, current.a).add(vClip.div(maxUnit)), history)
  }
)

/**
 * Variance clipping of a history sample against the 3x3 neighbourhood of the
 * current cascade buffer. Port of `varianceClipping` in
 * `varianceClipping.glsl`.
 */
const varianceClipping = /*#__PURE__*/ FnVar(
  (
    inputNode: TextureNode,
    coord: Node<'ivec2'>,
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    gamma: Node<'float'>
  ): Node<'vec4'> => {
    const moment1 = current.toVar()
    const moment2 = current.pow2().toVar()
    for (const [x, y] of varianceOffsets) {
      const neighbor = inputNode.load(coord.add(ivec2(x, y))).toConst()
      moment1.addAssign(neighbor)
      moment2.addAssign(neighbor.pow2())
    }
    const N = varianceOffsets.length + 1
    const mean = moment1.div(N).toConst()
    const variance = sqrt(moment2.div(N).sub(mean.pow2()).max(0))
      .mul(gamma)
      .toConst()
    const minColor = mean.sub(variance).toConst()
    const maxColor = mean.add(variance).toConst()
    return clipAABB(mean.clamp(minColor, maxColor), history, minColor, maxColor)
  }
)

/** Per-cascade resolve state. One material per cascade avoids select chains. */
class CascadeResolve {
  readonly material = new NodeMaterial()
  readonly mesh: QuadMesh

  constructor(
    readonly inputNode: TextureNode,
    readonly velocityNode: TextureNode,
    public historyTarget: RenderTarget,
    public resolveTarget: RenderTarget,
    readonly textureNode: TextureNode,
    readonly historyTextureNode: ReturnType<typeof texture>,
    temporalAlpha: Node<'float'>,
    varianceGamma: Node<'float'>,
    texelSize: Node<'vec2'>
  ) {
    this.material.name = 'CloudsShadowResolve'
    this.material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    this.material.fragmentNode = new ShadowResolveColorNode(
      inputNode,
      velocityNode,
      historyTextureNode,
      temporalAlpha,
      varianceGamma,
      texelSize
    )
    this.material.needsUpdate = true
    this.mesh = new QuadMesh(this.material)
  }
}

class ShadowResolveColorNode extends TempNode {
  static get type(): string {
    return 'ShadowResolveColorNode'
  }

  constructor(
    private readonly inputNode: TextureNode,
    private readonly velocityNode: TextureNode,
    private readonly historyNode: TextureNode,
    private readonly temporalAlpha: Node<'float'>,
    private readonly varianceGamma: Node<'float'>,
    private readonly texelSize: Node<'vec2'>
  ) {
    super('vec4')
  }

  override setup(): ThreeNode | null | undefined {
    const coord = ivec2(screenCoordinate.xy)
    const current = this.inputNode.load(coord)

    // The closest fragment in the 3x3 neighbourhood supplies the cloud front
    // depth used for reprojection (mirrors WebGL getClosestFragment). Velocity
    // is stored in texels, so `texelSize` converts it to UV.
    const closest = this.velocityNode.load(coord).toVar()
    for (const [x, y] of closestOffsets) {
      const neighbor = this.velocityNode.load(coord.add(ivec2(x, y)))
      closest.assign(neighbor.r.lessThan(closest.r).select(neighbor, closest))
    }

    const velocity = closest.gb.mul(this.texelSize)
    const prevUv = screenUV.sub(velocity)
    const inside = prevUv.x
      .greaterThanEqual(0)
      .and(prevUv.x.lessThanEqual(1))
      .and(prevUv.y.greaterThanEqual(0))
      .and(prevUv.y.lessThanEqual(1))

    const history = this.historyNode.sample(prevUv)
    const clipped = varianceClipping(
      this.inputNode,
      coord,
      current,
      history,
      this.varianceGamma
    )
    return inside.select(mix(clipped, current, this.temporalAlpha), current)
  }
}

/**
 * Temporal resolve for cascaded Beer shadow maps. Port of `shadowResolve.frag`:
 * reprojects each cascade texel by the depth-velocity written by the shadow
 * march, variance-clips the history, and blends.
 *
 * Rendering is per cascade: WebGPU binds a layered render target as a single
 * `2d-array` view and ignores the layer argument to `setRenderTarget`, so each
 * cascade owns a separate resolve / history pair and a dedicated material.
 */
export class ShadowResolveNode extends TempNode {
  static get type(): string {
    return 'ShadowResolveNode'
  }

  readonly cascadeCount: number
  readonly temporalAlpha = uniform(0.01).setName('shadowTemporalAlpha')
  readonly varianceGamma = uniform(1).setName('shadowVarianceGamma')
  readonly texelSize = uniform(new Vector2(1, 1)).setName('shadowTexelSize')

  private readonly cascades: CascadeResolve[] = []
  private rendererState?: RendererUtils.RendererState
  private needsClearHistory = true

  constructor(
    inputTextures: TextureNode[],
    velocityTextures: TextureNode[],
    cascadeCount: number,
    mapSize: number
  ) {
    super('vec4')
    this.cascadeCount = cascadeCount
    this.updateBeforeType = NodeUpdateType.NONE
    this.texelSize.value.set(1 / mapSize, 1 / mapSize)

    for (let i = 0; i < cascadeCount; ++i) {
      const resolveTarget = this.createTarget(`ShadowResolve.${i}`)
      const historyTarget = this.createTarget(`ShadowHistory.${i}`)
      resolveTarget.setSize(mapSize, mapSize)
      historyTarget.setSize(mapSize, mapSize)
      const historyTextureNode = texture(historyTarget.texture)
      this.cascades.push(
        new CascadeResolve(
          inputTextures[i],
          velocityTextures[i],
          historyTarget,
          resolveTarget,
          outputTexture(this, historyTarget.texture),
          historyTextureNode,
          this.temporalAlpha,
          this.varianceGamma,
          this.texelSize
        )
      )
    }
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

  /** Resolved cascade texture node at `index` (cascade 0 first). */
  getTextureNode(index: number): TextureNode {
    return this.cascades[index].textureNode
  }

  getTextureNodes(): TextureNode[] {
    return this.cascades.map(cascade => cascade.textureNode)
  }

  setSize(size: number): this {
    for (const cascade of this.cascades) {
      cascade.resolveTarget.setSize(size, size)
      cascade.historyTarget.setSize(size, size)
    }
    this.texelSize.value.set(1 / size, 1 / size)
    this.needsClearHistory = true
    return this
  }

  reset(): this {
    this.needsClearHistory = true
    return this
  }

  render(frame: NodeFrame): void {
    const renderer = frame.renderer
    if (renderer == null) {
      return
    }

    this.rendererState = resetRendererState(renderer, this.rendererState!)

    if (this.needsClearHistory) {
      for (const cascade of this.cascades) {
        renderer.setRenderTarget(cascade.historyTarget)
        renderer.clear()
      }
      this.needsClearHistory = false
    }

    for (const cascade of this.cascades) {
      renderer.setRenderTarget(cascade.resolveTarget)
      renderer.clear()
      cascade.mesh.render(renderer)
    }

    // Ping-pong so the resolved output becomes next frame's history.
    for (const cascade of this.cascades) {
      const previousResolve = cascade.resolveTarget
      cascade.resolveTarget = cascade.historyTarget
      cascade.historyTarget = previousResolve
      cascade.historyTextureNode.value = cascade.historyTarget.texture
      cascade.textureNode.value = cascade.historyTarget.texture
    }

    restoreRendererState(renderer, this.rendererState)
  }

  override setup(_builder: NodeBuilder): ThreeNode | null | undefined {
    return this.cascades[0]?.textureNode ?? vec4(0)
  }

  override dispose(): void {
    for (const cascade of this.cascades) {
      cascade.resolveTarget.dispose()
      cascade.historyTarget.dispose()
      cascade.material.dispose()
      cascade.mesh.geometry.dispose()
    }
    super.dispose()
  }
}
