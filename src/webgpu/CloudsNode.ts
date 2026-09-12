// src/webgpu/CloudsNode.ts

import { Vector2, Vector3 } from 'three'
import {
  NodeUpdateType,
  TempNode,
  type NodeBuilder,
  type NodeFrame,
  type TextureNode
} from 'three/webgpu'

import { CloudLayers } from '../CloudLayers'
import {
  CloudsEnvironment,
  type CloudsEnvironmentOptions
} from './CloudsEnvironment'
import { CloudShapeDetailNode } from './CloudShapeDetailNode'
import { CloudShapeNode } from './CloudShapeNode'
import { CloudsMarchNode } from './CloudsMarchNode'
import { CloudsResolveNode } from './CloudsResolveNode'
import { LocalWeatherNode } from './LocalWeatherNode'
import { CloudLayerParameterNodes, CloudParameterNodes } from './parameters'
import { ShadowDebugNode } from './ShadowDebugNode'
import { ShadowMarchNode } from './ShadowMarchNode'
import { TurbulenceNode } from './TurbulenceNode'
import { updateCloudLayerParameters } from './updateCloudLayerParameters'

/**
 * Orchestrates procedural textures + layer packing + clouds march. Exposes an
 * overlay texture for {@link AerialPerspectiveNode.overlayNode}.
 */
export class CloudsNode extends TempNode {
  static override get type(): string {
    return 'CloudsNode'
  }

  readonly cloudLayers = CloudLayers.DEFAULT.clone()
  readonly environment: CloudsEnvironment
  readonly parameters = new CloudParameterNodes()
  readonly layerParameters = new CloudLayerParameterNodes()
  readonly marchNode: CloudsMarchNode
  readonly resolveNode: CloudsResolveNode
  readonly shadowNode: ShadowMarchNode
  readonly shadowDebugNode: ShadowDebugNode

  readonly localWeatherVelocity = new Vector2()
  readonly shapeVelocity = new Vector3()
  readonly shapeDetailVelocity = new Vector3()

  private readonly localWeather: LocalWeatherNode
  private readonly shape: CloudShapeNode
  private readonly shapeDetail: CloudShapeDetailNode
  private readonly turbulence: TurbulenceNode
  private readonly textureNode: TextureNode
  private readonly outputSize = new Vector2()
  private frame = 0

  coverage = 0.3

  constructor(options: CloudsEnvironment | CloudsEnvironmentOptions) {
    super('vec4')
    this.updateBeforeType = NodeUpdateType.FRAME
    this.environment =
      options instanceof CloudsEnvironment
        ? options
        : new CloudsEnvironment(options)

    this.localWeather = new LocalWeatherNode()
    this.shape = new CloudShapeNode()
    this.shapeDetail = new CloudShapeDetailNode()
    this.turbulence = new TurbulenceNode()

    this.parameters
      .setLocalWeatherTexture(this.localWeather.getTextureNode())
      .setShapeTexture(this.shape.getTextureNode())
      .setShapeDetailTexture(this.shapeDetail.getTextureNode())
      .setTurbulenceTexture(this.turbulence.getTextureNode())

    this.parameters.shapeDetailEnabled.value = false
    this.parameters.turbulenceEnabled.value = false

    this.shadowNode = new ShadowMarchNode(
      this.environment,
      this.parameters,
      this.layerParameters
    )
    this.marchNode = new CloudsMarchNode(
      this.environment,
      this.parameters,
      this.layerParameters
    )
    this.marchNode.shadow = this.shadowNode.shadow
    // Live array: ShadowMarchNode rebuilds the resolve (and its texture nodes)
    // when the cascade count changes, so don't snapshot the array here.
    this.marchNode.shadowBuffers = this.shadowNode.getBufferNodes()
    this.resolveNode = new CloudsResolveNode(
      this.marchNode.getTextureNode(),
      this.marchNode.getVelocityTextureNode()
    )
    this.marchNode.temporalUpscale = this.resolveNode.temporalUpscale
    this.shadowDebugNode = new ShadowDebugNode(this.shadowNode.getBufferNodes())
    this.textureNode = this.resolveNode.getTextureNode()

    updateCloudLayerParameters(this.layerParameters, this.cloudLayers)
  }

  get shadowMapNode(): ShadowMarchNode {
    return this.shadowNode
  }

  getTextureNode(): TextureNode {
    return this.textureNode
  }

  /** Resolved BSM cascade textures (cascade 0 first), live across rebuilds. */
  getShadowBufferNodes(): TextureNode[] {
    return this.shadowNode.getBufferNodes()
  }

  get depthNode(): TextureNode | null {
    return this.environment.sceneDepth
  }

  set depthNode(value: TextureNode | null) {
    this.environment.sceneDepth = value
  }

  get resolutionScale(): number {
    return this.marchNode.resolutionScale
  }

  set resolutionScale(value: number) {
    if (value !== this.marchNode.resolutionScale) {
      this.marchNode.resolutionScale = value
      this.resetTemporalHistory()
    }
  }

  get temporalUpscale(): boolean {
    return this.resolveNode.temporalUpscale
  }

  set temporalUpscale(value: boolean) {
    if (value !== this.resolveNode.temporalUpscale) {
      this.resolveNode.temporalUpscale = value
      this.marchNode.temporalUpscale = value
      this.resetTemporalHistory()
    }
  }

  get temporalAlpha(): number {
    return this.resolveNode.temporalAlpha.value
  }

  set temporalAlpha(value: number) {
    this.resolveNode.temporalAlpha.value = value
  }

  get varianceGamma(): number {
    return this.resolveNode.varianceGamma.value
  }

  set varianceGamma(value: number) {
    this.resolveNode.varianceGamma.value = value
  }

  resetTemporalHistory(): this {
    this.frame = 0
    this.resolveNode.reset()
    this.marchNode.resetReprojection()
    return this
  }

  override updateBefore(frame: NodeFrame): void {
    const deltaTime = frame.deltaTime ?? 0
    this.environment.update()
    this.parameters.coverage.value = this.coverage

    this.parameters.localWeatherOffset.value.addScaledVector(
      this.localWeatherVelocity,
      deltaTime
    )
    this.parameters.shapeOffset.value.addScaledVector(
      this.shapeVelocity,
      deltaTime
    )
    this.parameters.shapeDetailOffset.value.addScaledVector(
      this.shapeDetailVelocity,
      deltaTime
    )

    updateCloudLayerParameters(this.layerParameters, this.cloudLayers)
    this.marchNode.frame = this.frame
    this.resolveNode.frame.value = this.frame
    this.shadowNode.updateBefore(frame)
    this.marchNode.render(frame, false)
    this.marchNode.getOutputSize(this.outputSize)
    this.resolveNode.setSize(this.outputSize.x, this.outputSize.y)
    this.resolveNode.render(frame)
    this.marchNode.commitReprojection(frame)
    this.frame = (this.frame + 1) % 16
  }

  override setup(builder: NodeBuilder): unknown {
    // Ensure procedural textures are built before the march samples them.
    this.localWeather.build(builder)
    this.shape.build(builder)
    this.shapeDetail.build(builder)
    this.turbulence.build(builder)
    this.shadowNode.build(builder)
    this.marchNode.build(builder)
    this.resolveNode.build(builder)
    // Sample the live temporal-resolve target.
    return this.textureNode
  }

  override dispose(): void {
    this.shadowNode.dispose()
    this.shadowDebugNode.dispose()
    this.resolveNode.dispose()
    this.marchNode.dispose()
    this.localWeather.dispose()
    this.shape.dispose()
    this.shapeDetail.dispose()
    this.turbulence.dispose()
    super.dispose()
  }
}

export const clouds = (
  options: CloudsEnvironment | CloudsEnvironmentOptions
): CloudsNode => new CloudsNode(options)
