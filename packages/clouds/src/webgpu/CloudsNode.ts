import { Vector2, Vector3 } from 'three'
import {
  NodeUpdateType,
  TempNode,
  type NodeBuilder,
  type NodeFrame,
  type TextureNode
} from 'three/webgpu'

import { outputTexture } from '@takram/three-geospatial/webgpu'

import { CloudLayers } from '../CloudLayers'
import { CloudShapeDetailNode } from './CloudShapeDetailNode'
import { CloudShapeNode } from './CloudShapeNode'
import { CloudsMarchNode } from './CloudsMarchNode'
import { LocalWeatherNode } from './LocalWeatherNode'
import { CloudLayerParameterNodes, CloudParameterNodes } from './parameters'
import { TurbulenceNode } from './TurbulenceNode'
import { updateCloudLayerParameters } from './updateCloudLayerParameters'

/**
 * Orchestrates procedural textures + layer packing + clouds march.
 * Exposes an overlay texture for {@link AerialPerspectiveNode.overlayNode}.
 */
export class CloudsNode extends TempNode {
  static override get type(): string {
    return 'CloudsNode'
  }

  readonly cloudLayers = CloudLayers.DEFAULT.clone()
  readonly parameters = new CloudParameterNodes()
  readonly layerParameters = new CloudLayerParameterNodes()
  readonly marchNode: CloudsMarchNode

  readonly localWeatherVelocity = new Vector2()
  readonly shapeVelocity = new Vector3()
  readonly shapeDetailVelocity = new Vector3()

  private readonly localWeather: LocalWeatherNode
  private readonly shape: CloudShapeNode
  private readonly shapeDetail: CloudShapeDetailNode
  private readonly turbulence: TurbulenceNode
  private readonly textureNode: TextureNode

  coverage = 0.3

  constructor() {
    super('vec4')
    this.updateBeforeType = NodeUpdateType.FRAME

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

    this.marchNode = new CloudsMarchNode(this.parameters, this.layerParameters)
    this.textureNode = outputTexture(this, this.marchNode.getTexture())

    updateCloudLayerParameters(this.layerParameters, this.cloudLayers)
  }

  getTextureNode(): TextureNode {
    return this.textureNode
  }

  set depthNode(value: TextureNode | null) {
    this.marchNode.depthNode = value
  }

  get depthNode(): TextureNode | null {
    return this.marchNode.depthNode
  }

  set resolutionScale(value: number) {
    this.marchNode.resolutionScale = value
  }

  get resolutionScale(): number {
    return this.marchNode.resolutionScale
  }

  override updateBefore(frame: NodeFrame): void {
    const deltaTime = frame.deltaTime ?? 0
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
    this.marchNode.updateBefore(frame)
  }

  override setup(builder: NodeBuilder): unknown {
    // Ensure procedural textures are built before the march samples them.
    this.localWeather.build(builder)
    this.shape.build(builder)
    this.shapeDetail.build(builder)
    this.turbulence.build(builder)
    this.marchNode.build(builder)
    // Sample the march target; OutputTextureNode also builds this owner.
    return this.textureNode
  }

  override dispose(): void {
    this.marchNode.dispose()
    this.localWeather.dispose()
    this.shape.dispose()
    this.shapeDetail.dispose()
    this.turbulence.dispose()
    super.dispose()
  }
}

export const clouds = (): CloudsNode => new CloudsNode()
