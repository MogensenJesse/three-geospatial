// src/webgpu/ShadowMarchNode.ts

import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  RenderTarget,
  RGBAFormat,
  Vector2,
  Vector3,
  type Camera,
  type Texture
} from 'three'
import { positionGeometry, screenUV, texture, vec4 } from 'three/tsl'
import {
  MRTNode,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  TempNode,
  type NodeBuilder,
  type NodeFrame,
  type TextureNode
} from 'three/webgpu'

import { CascadedShadowMaps } from '../CascadedShadowMaps'
import { defaults } from '../qualityPresets'
import type { CloudsEnvironment } from './CloudsEnvironment'
import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'
import {
  MAX_SHADOW_CASCADES,
  ShadowMarchParameters,
  shadowMipLevels,
  ShadowParameterNodes
} from './shadowParameters'
import { ShadowResolveNode } from './ShadowResolveNode'
import {
  setupShadowMarchColor,
  setupShadowMarchVelocity,
  type ShadowMarchColorContext
} from './shadowSampling'

const { resetRendererState, restoreRendererState } = RendererUtils

/**
 * Deferred MRT graph. Must derive from {@link MRTNode} (an `OutputStructNode`):
 * `NodeMaterial.setupFragment()` only skips its `vec4()` wrapper when
 * `fragmentNode.isOutputStructNode === true`. A plain `TempNode` wrapper around
 * `mrt()` hides that flag, so the builder emits `output.m0 = …` without
 * declaring the `OutputType` struct (WGSL error "struct member m0 not found")
 * and every attachment lands as zeros — with no visible console error.
 *
 * Deferring also keeps the heavy If/Loop stack expanding in this pass's builder
 * rather than the parent compose builder. Output 0 is the shadow color, output
 * 1 the depth-velocity buffer.
 */
class ShadowMarchColorNode extends MRTNode {
  static override get type(): string {
    return 'ShadowMarchColorNode'
  }

  constructor(private readonly owner: ShadowMarchNode) {
    super({})
  }

  override setup(builder: NodeBuilder): unknown {
    const context: ShadowMarchColorContext = {
      parameters: this.owner.parameters,
      layers: this.owner.layers,
      shadow: this.owner.shadow,
      march: this.owner.march,
      environment: this.owner.environment
    }
    const color = setupShadowMarchColor(context, screenUV)
    const velocity = setupShadowMarchVelocity(context, screenUV, color)
    // MRTNode.setup() resolves each output to a color attachment by name.
    this.outputNodes = { output: color, velocity }
    return super.setup(builder)
  }
}

/**
 * Sun-view Beer shadow map march. One render target per cascade, each with a
 * color attachment plus a depth-velocity attachment.
 *
 * Cascades are rendered as separate passes rather than layers of a single array
 * texture: the WebGPU backend binds a layered render target as one `2d-array`
 * view and ignores the layer argument to `setRenderTarget`, so layered writes
 * would all land on the same layer.
 */
export class ShadowMarchNode extends TempNode {
  static override get type(): string {
    return 'ShadowMarchNode'
  }

  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  readonly shadow = new ShadowParameterNodes()
  readonly march = new ShadowMarchParameters()
  readonly shadowMaps: CascadedShadowMaps
  /** Rebuilt when the cascade count changes; see {@link buildResolveNode}. */
  resolveNode!: ShadowResolveNode

  enabled = true

  private renderTargets: RenderTarget[] = []
  /** Horizontal atlas of resolved cascades for cheap march sampling. */
  private atlasTarget: RenderTarget | null = null
  private atlasNode: TextureNode | null = null
  private readonly atlasDst = new Vector3()
  private readonly textureNodes: TextureNode[] = []
  private readonly velocityNodes: TextureNode[] = []
  private readonly materials: NodeMaterial[] = []
  private readonly meshes: QuadMesh[] = []
  /**
   * Stable array holding the current resolved cascade texture nodes. Consumers
   * (the clouds march, debug view) keep a reference to this array; contents are
   * swapped in place when cascades are rebuilt so the reference stays valid.
   */
  private readonly bufferNodes: TextureNode[] = []
  private rendererState?: RendererUtils.RendererState
  private readonly sunDirectionWorld = new Vector3()
  /** NaN x means "no previous sample yet" (skip first-frame reset). */
  private readonly previousSunDirection = new Vector3(Number.NaN, 0, 0)
  private mapSize: number
  /** Cascade matrices from the previous frame, for shadow-map reprojection. */
  private readonly previousShadowMatrices = Array.from(
    { length: MAX_SHADOW_CASCADES },
    () => new Matrix4()
  )

  constructor(
    readonly environment: CloudsEnvironment,
    parameters: CloudParameterNodes,
    layers: CloudLayerParameterNodes,
    options?: { cascadeCount?: number; mapSize?: number }
  ) {
    super('vec4')
    this.parameters = parameters
    this.layers = layers
    this.updateBeforeType = NodeUpdateType.NONE

    const cascadeCount = options?.cascadeCount ?? defaults.shadow.cascadeCount
    this.mapSize = options?.mapSize ?? defaults.shadow.mapSize.x
    this.shadowMaps = new CascadedShadowMaps({
      cascadeCount,
      mapSize: new Vector2(this.mapSize, this.mapSize),
      maxFar: 1e5
    })
    this.shadow.cascadeCount.value = cascadeCount
    this.shadow.shadowTexelSize.value.set(1 / this.mapSize, 1 / this.mapSize)
    this.march.resolution.value.set(this.mapSize, this.mapSize)

    this.buildTargets(cascadeCount, this.mapSize)
  }

  // The resolve consumes the depth-velocity attachment, not the color one.
  private buildResolveNode(cascadeCount: number): void {
    this.resolveNode?.dispose()
    this.resolveNode = new ShadowResolveNode(
      this.textureNodes,
      this.velocityNodes,
      cascadeCount,
      this.mapSize
    )
    this.bufferNodes.length = 0
    this.bufferNodes.push(...this.resolveNode.getTextureNodes())
  }

  private buildTargets(cascadeCount: number, mapSize: number): void {
    for (const target of this.renderTargets) {
      target.dispose()
    }
    this.renderTargets = []
    this.textureNodes.length = 0
    this.velocityNodes.length = 0
    this.materials.length = 0
    this.meshes.length = 0

    for (const matrix of this.shadow.reprojectionMatrices.array) {
      ;(matrix as Matrix4).identity()
    }

    for (let i = 0; i < cascadeCount; ++i) {
      const target = new RenderTarget(mapSize, mapSize, {
        count: 2,
        depthBuffer: false,
        type: HalfFloatType,
        format: RGBAFormat
      })
      for (const texture of target.textures) {
        texture.minFilter = LinearFilter
        texture.magFilter = LinearFilter
        texture.generateMipmaps = false
      }
      // Attachment names must match the mrt() output keys: the MRT node
      // resolves each output to a color attachment by texture name.
      target.textures[0].name = 'output'
      target.textures[1].name = 'velocity'
      this.renderTargets.push(target)
      this.textureNodes.push(texture(target.textures[0]))
      this.velocityNodes.push(texture(target.textures[1]))

      const material = new NodeMaterial()
      material.name = `CloudsShadowMarch.${i}`
      material.vertexNode = vec4(positionGeometry.xy, 0, 1)
      material.fragmentNode = new ShadowMarchColorNode(this)
      material.needsUpdate = true
      this.materials.push(material)
      this.meshes.push(new QuadMesh(material))
    }

    this.buildResolveNode(cascadeCount)
    this.rebuildAtlas(cascadeCount, mapSize)
  }

  private rebuildAtlas(cascadeCount: number, mapSize: number): void {
    this.atlasTarget?.dispose()
    // Horizontal strip: [c0 | c1 | c2] — one sample texture for the march.
    this.atlasTarget = new RenderTarget(mapSize * cascadeCount, mapSize, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    this.atlasTarget.texture.minFilter = LinearFilter
    this.atlasTarget.texture.magFilter = LinearFilter
    this.atlasTarget.texture.generateMipmaps = false
    this.atlasTarget.texture.name = 'CloudsShadowAtlas'
    this.atlasNode = texture(this.atlasTarget.texture)
  }

  /** Single atlas texture for clouds-march BSM sampling. */
  getAtlasNode(): TextureNode | null {
    return this.atlasNode
  }

  private packAtlas(renderer: NonNullable<NodeFrame['renderer']>): void {
    if (this.atlasTarget == null || this.atlasNode == null) return
    // Ensure destination exists on the GPU before copyTextureToTexture.
    const init = (renderer as { initTexture?: (t: import('three').Texture) => void }).initTexture
    if (typeof init === 'function') {
      init.call(renderer, this.atlasTarget.texture)
    }
    const mapSize = this.mapSize
    const count = this.shadowMaps.cascadeCount
    for (let i = 0; i < count; ++i) {
      const src = this.resolveNode.getTextureNode(i).value
      this.atlasDst.set(i * mapSize, 0, 0)
      renderer.copyTextureToTexture(src, this.atlasTarget.texture, null, this.atlasDst)
    }
  }

  /** Raw cascade color texture at `index` (cascade 0 first). */
  getTexture(index = 0): Texture {
    return this.renderTargets[index].textures[0]
  }

  /** Resolved cascade texture node at `index` (cascade 0 first). */
  getTextureNode(index = 0): TextureNode {
    return this.resolveNode.getTextureNode(index)
  }

  /** Resolved cascade textures for the clouds march (cascade 0 first). */
  getBufferNodes(): TextureNode[] {
    return this.bufferNodes
  }

  setMapSize(size: number): this {
    if (this.mapSize !== size) {
      this.mapSize = size
      for (const target of this.renderTargets) {
        target.setSize(size, size)
      }
      this.resolveNode.setSize(size)
      this.resolveNode.reset()
      this.shadowMaps.mapSize.set(size, size)
      this.shadow.shadowTexelSize.value.set(1 / size, 1 / size)
      this.march.resolution.value.set(size, size)
    }
    return this
  }

  setCascadeCount(count: number): this {
    const clamped = Math.max(1, Math.min(MAX_SHADOW_CASCADES, count))
    if (clamped !== this.shadowMaps.cascadeCount) {
      this.shadowMaps.cascadeCount = clamped
      this.shadow.cascadeCount.value = clamped
      // buildTargets rebuilds the resolve (which resets history) too.
      this.buildTargets(clamped, this.mapSize)
    }
    return this
  }

  /**
   * Update cascades and render each layer. Called from {@link CloudsNode} before
   * the camera clouds march.
   */
  renderShadowMaps(frame: NodeFrame, camera: Camera): void {
    if (!this.enabled || frame.renderer == null) {
      return
    }
    if (!(camera instanceof PerspectiveCamera)) {
      return
    }

    const { renderer } = frame
    this.sunDirectionWorld.copy(this.environment.sunDirection).normalize()

    // Clear temporal history after discontinuous sun jumps (Phase 5).
    if (
      Number.isNaN(this.previousSunDirection.x) ||
      this.previousSunDirection.distanceToSquared(this.sunDirectionWorld) > 1e-4
    ) {
      if (!Number.isNaN(this.previousSunDirection.x)) {
        this.resolveNode.reset()
      }
      this.previousSunDirection.copy(this.sunDirectionWorld)
    }

    // Keep the reconstructed sun ray above the complete flat slab, including
    // low-angle lighting. Cascade coverage remains camera-frustum based.
    const worldScale = this.environment.worldUnitsPerMeter
    const slabHeight =
      Math.max(this.layers.shadowTopHeight.value, 1) * worldScale
    const distance =
      (Math.max(camera.far, slabHeight) * 2) /
      Math.max(Math.abs(this.sunDirectionWorld.y), 0.05)

    // Remember the previous frame's matrices before overwriting them.
    for (let i = 0; i < MAX_SHADOW_CASCADES; ++i) {
      this.previousShadowMatrices[i].copy(
        this.shadow.shadowMatrices.array[i] as Matrix4
      )
    }

    this.shadowMaps.update(camera, this.sunDirectionWorld, distance)

    this.shadow.shadowCameraNear.value = camera.near
    this.shadow.shadowFar.value = this.shadowMaps.far

    const { cascades } = this.shadowMaps
    for (let i = 0; i < MAX_SHADOW_CASCADES; ++i) {
      if (i < cascades.length) {
        ;(this.shadow.shadowMatrices.array[i] as Matrix4).copy(
          cascades[i].matrix
        )
        ;(this.shadow.inverseShadowMatrices.array[i] as Matrix4).copy(
          cascades[i].inverseMatrix
        )
        ;(this.shadow.shadowIntervals.array[i] as Vector2).copy(
          cascades[i].interval
        )
        ;(this.shadow.reprojectionMatrices.array[i] as Matrix4).copy(
          this.previousShadowMatrices[i]
        )
      }
    }

    this.rendererState = resetRendererState(renderer, this.rendererState!)

    const cascadeCount = this.shadowMaps.cascadeCount
    for (let i = 0; i < cascadeCount; ++i) {
      this.march.cascadeIndex.value = i
      this.march.mipLevel.value = shadowMipLevels[i] ?? 2
      renderer.setRenderTarget(this.renderTargets[i])
      renderer.setClearColor(0, 0)
      renderer.clear()
      this.meshes[i].render(renderer)
    }

    restoreRendererState(renderer, this.rendererState)
    this.resolveNode.render(frame)
    if (renderer != null) this.packAtlas(renderer)
  }

  override updateBefore(frame: NodeFrame): void {
    if (frame.renderer == null) {
      return
    }
    const camera = this.environment.camera
    if (camera == null) {
      return
    }
    this.renderShadowMaps(frame, camera)
  }

  override setup(builder: NodeBuilder): unknown {
    this.resolveNode.build(builder)
    // Return the live resolve node: its texture target is ping-ponged each
    // frame by render(), so a captured OutputTextureNode would go stale.
    return this.resolveNode.getTextureNode(0)
  }

  override dispose(): void {
    for (const target of this.renderTargets) {
      target.dispose()
    }
    this.resolveNode.dispose()
    for (const material of this.materials) {
      material.dispose()
    }
    super.dispose()
  }
}

export const shadowMarch = (
  ...args: ConstructorParameters<typeof ShadowMarchNode>
): ShadowMarchNode => new ShadowMarchNode(...args)
