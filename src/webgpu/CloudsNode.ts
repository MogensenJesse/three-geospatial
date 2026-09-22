import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/CloudsNode.ts

import { Vector2, Vector3 } from 'three'
import {
  type NodeBuilder,
  type NodeFrame,
  NodeUpdateType,
  TempNode,
  type Texture3DNode,
  type TextureNode
} from 'three/webgpu'

import { CloudLayer } from '../CloudLayer'
import { CloudLayers } from '../CloudLayers'
import {
  type CloudQualitySettings,
  type PhaseFunctionMode,
  type QualityPreset,
  qualityPresets
} from '../qualityPresets'
import { applyCloudsQualitySettings } from './applyCloudsQuality'
import { CloudShapeDetailNode } from './CloudShapeDetailNode'
import { CloudShapeNode } from './CloudShapeNode'
import { CloudsEnvironment } from './CloudsEnvironment'
import { CloudsMarchNode } from './CloudsMarchNode'
import {
  type CloudsFacadeOptions,
  type CloudsOptions,
  resolveCloudsOptions
} from './CloudsOptions'
import { CloudsResolveNode } from './CloudsResolveNode'
import {
  applyDebugMarchMode,
  type CloudsDebugOutput,
  type CloudsPassTiming,
  createCloudsPassTiming,
  measureCloudsPassTiming,
  setupCloudsDebugOutput
} from './cloudsDebug'
import { installCloudsNodeTuning } from './cloudsNodeTuning'
import type { Node } from './internal/node'
import { LocalWeatherNode } from './LocalWeatherNode'
import { CloudLayerParameterNodes, CloudParameterNodes } from './parameters'
import { ShadowDebugNode } from './ShadowDebugNode'
import { ShadowMarchNode } from './ShadowMarchNode'
import { TurbulenceNode } from './TurbulenceNode'
import { updateCloudLayerParameters } from './updateCloudLayerParameters'

export type { CloudsDebugOutput, CloudsPassTiming } from './cloudsDebug'

/**
 * Orchestrates procedural textures + layer packing + clouds march. Exposes an
 * overlay texture for composition (or a diagnostic view when selected).
 */
export class CloudsNode extends TempNode {
  declare depthNode: TextureNode | null
  declare resolutionScale: number
  declare temporalUpscale: boolean
  declare temporalAlpha: number
  declare temporalHistoryEnabled: boolean
  declare varianceGamma: number
  declare shapeDetailEnabled: boolean
  declare turbulenceEnabled: boolean
  declare scatteringCoefficient: number
  declare absorptionCoefficient: number
  declare turbulenceDisplacement: number
  declare localWeatherRepeat: Vector2
  declare localWeatherOffset: Vector2
  declare shapeRepeat: Vector3
  declare shapeOffset: Vector3
  declare shapeDetailRepeat: Vector3
  declare shapeDetailOffset: Vector3
  declare turbulenceRepeat: Vector2
  declare secondaryIterationCount: number
  declare skyLightScale: number
  declare stepJitterScale: number
  declare powderScale: number
  declare powderExponent: number
  declare groundBounceScale: number
  declare groundIterationCount: number
  declare phaseFunctionMode: PhaseFunctionMode
  declare shadowEnabled: boolean
  declare shadowMapSize: number
  declare shadowCascadeCount: number
  declare shadowFilterRadius: number
  declare shadowTemporalAlpha: number
  declare shadowTemporalGamma: number

  static get type(): string {
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

  private localWeather: LocalWeatherNode | null = null
  private shape: CloudShapeNode | null = null
  private shapeDetail: CloudShapeDetailNode | null = null
  private turbulence: TurbulenceNode | null = null

  private ownsLocalWeather = false
  private ownsShape = false
  private ownsShapeDetail = false
  private ownsTurbulence = false

  private readonly textureNode: TextureNode
  private readonly outputSize = new Vector2()
  private frame = 0
  private _debugOutput: CloudsDebugOutput = 'none'
  /** CPU ms around each pass (GPU work may complete later). */
  readonly lastPassTiming: CloudsPassTiming = createCloudsPassTiming()

  coverage = 0.3

  private qualityPreset: QualityPreset = 'high'

  constructor(options: CloudsOptions) {
    super('vec4')
    this.updateBeforeType = NodeUpdateType.FRAME

    const { environment, facade } = resolveCloudsOptions(options)
    this.environment = environment

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
    this.marchNode.shadowAtlas = this.shadowNode.getAtlasNode()
    this.resolveNode = new CloudsResolveNode(
      this.marchNode.getTextureNode(),
      this.marchNode.getVelocityTextureNode()
    )
    this.marchNode.temporalUpscale = this.resolveNode.temporalUpscale
    this.shadowDebugNode = new ShadowDebugNode(this.shadowNode.getBufferNodes())
    this.textureNode = this.resolveNode.getTextureNode()

    this.installDefaultProcedurals(facade)
    this.applyFacadeOptions(facade)

    updateCloudLayerParameters(this.layerParameters, this.cloudLayers)
    if (facade.qualityPreset != null) {
      this.qualityPreset = facade.qualityPreset
      this.applyQualitySettings(qualityPresets[facade.qualityPreset])
    } else {
      this.applyQualitySettings(qualityPresets.high)
    }
    this.applyPostQualityFacade(facade)
  }

  private installDefaultProcedurals(facade: CloudsFacadeOptions): void {
    if (facade.localWeatherTexture !== undefined) {
      this.setLocalWeatherTexture(facade.localWeatherTexture)
    } else {
      this.localWeather = new LocalWeatherNode()
      this.ownsLocalWeather = true
      this.parameters.setLocalWeatherTexture(this.localWeather.getTextureNode())
    }

    if (facade.shapeTexture !== undefined) {
      this.setShapeTexture(facade.shapeTexture)
    } else {
      this.shape = new CloudShapeNode()
      this.ownsShape = true
      this.parameters.setShapeTexture(this.shape.getTextureNode())
    }

    if (facade.shapeDetailTexture !== undefined) {
      this.setShapeDetailTexture(facade.shapeDetailTexture)
    } else {
      this.shapeDetail = new CloudShapeDetailNode()
      this.ownsShapeDetail = true
      this.parameters.setShapeDetailTexture(this.shapeDetail.getTextureNode())
    }

    if (facade.turbulenceTexture !== undefined) {
      this.setTurbulenceTexture(facade.turbulenceTexture)
    } else {
      this.turbulence = new TurbulenceNode()
      this.ownsTurbulence = true
      this.parameters.setTurbulenceTexture(this.turbulence.getTextureNode())
    }

    // Defaults match prior constructor (detail/turbulence off until quality).
    this.parameters.shapeDetailEnabled.value = false
    this.parameters.turbulenceEnabled.value = false
  }

  private applyFacadeOptions(facade: CloudsFacadeOptions): void {
    if (facade.cloudLayers != null) {
      const layers = facade.cloudLayers
      if (layers.length !== 4) {
        throw new Error(
          `CloudsNode cloudLayers must contain exactly 4 layers (received ${layers.length}).`
        )
      }
      for (let index = 0; index < 4; ++index) {
        const layer = layers[index]
        if (layer instanceof CloudLayer) {
          this.cloudLayers[index].copy(layer)
        } else {
          this.cloudLayers[index].copy(CloudLayer.DEFAULT)
          this.cloudLayers[index].set(layer)
        }
      }
    }

    if (facade.stbnTexture !== undefined) {
      this.setStbnTexture(facade.stbnTexture)
    }
    if (facade.coverage != null) this.coverage = facade.coverage
    if (facade.scatteringCoefficient != null) {
      this.scatteringCoefficient = facade.scatteringCoefficient
    }
    if (facade.absorptionCoefficient != null) {
      this.absorptionCoefficient = facade.absorptionCoefficient
    }
    if (facade.turbulenceDisplacement != null) {
      this.turbulenceDisplacement = facade.turbulenceDisplacement
    }
    if (facade.localWeatherRepeat != null) {
      this.localWeatherRepeat.copy(facade.localWeatherRepeat)
    }
    if (facade.localWeatherOffset != null) {
      this.localWeatherOffset.copy(facade.localWeatherOffset)
    }
    if (facade.shapeRepeat != null) this.shapeRepeat.copy(facade.shapeRepeat)
    if (facade.shapeOffset != null) this.shapeOffset.copy(facade.shapeOffset)
    if (facade.shapeDetailRepeat != null) {
      this.shapeDetailRepeat.copy(facade.shapeDetailRepeat)
    }
    if (facade.shapeDetailOffset != null) {
      this.shapeDetailOffset.copy(facade.shapeDetailOffset)
    }
    if (facade.turbulenceRepeat != null) {
      this.turbulenceRepeat.copy(facade.turbulenceRepeat)
    }
    if (facade.localWeatherVelocity != null) {
      this.localWeatherVelocity.copy(facade.localWeatherVelocity)
    }
    if (facade.shapeVelocity != null) {
      this.shapeVelocity.copy(facade.shapeVelocity)
    }
    if (facade.shapeDetailVelocity != null) {
      this.shapeDetailVelocity.copy(facade.shapeDetailVelocity)
    }
  }

  private applyPostQualityFacade(facade: CloudsFacadeOptions): void {
    if (facade.shapeDetail != null) this.shapeDetailEnabled = facade.shapeDetail
    if (facade.turbulence != null) this.turbulenceEnabled = facade.turbulence
    if (facade.resolutionScale != null) {
      this.resolutionScale = facade.resolutionScale
    }
    if (facade.temporalUpscale != null) {
      this.temporalUpscale = facade.temporalUpscale
    }
    if (facade.temporalAlpha != null) this.temporalAlpha = facade.temporalAlpha
    if (facade.varianceGamma != null) this.varianceGamma = facade.varianceGamma
    if (facade.secondaryIterationCount != null) {
      this.secondaryIterationCount = facade.secondaryIterationCount
    }
    if (facade.powderScale != null) this.powderScale = facade.powderScale
    if (facade.powderExponent != null)
      this.powderExponent = facade.powderExponent
    if (facade.groundBounceScale != null) {
      this.groundBounceScale = facade.groundBounceScale
    }
    if (facade.groundIterationCount != null) {
      this.groundIterationCount = facade.groundIterationCount
    }
    if (facade.phaseFunctionMode != null) {
      this.phaseFunctionMode = facade.phaseFunctionMode
    }
    if (facade.shadowEnabled != null) this.shadowEnabled = facade.shadowEnabled
    if (facade.shadowMapSize != null) this.shadowMapSize = facade.shadowMapSize
    if (facade.shadowCascadeCount != null) {
      this.shadowCascadeCount = facade.shadowCascadeCount
    }
    if (facade.shadowFilterRadius != null) {
      this.shadowFilterRadius = facade.shadowFilterRadius
    }
    if (facade.shadowTemporalAlpha != null) {
      this.shadowTemporalAlpha = facade.shadowTemporalAlpha
    }
    if (facade.shadowTemporalGamma != null) {
      this.shadowTemporalGamma = facade.shadowTemporalGamma
    }
  }

  getQualityPreset(): QualityPreset {
    return this.qualityPreset
  }

  setQualityPreset(preset: QualityPreset): this {
    this.qualityPreset = preset
    return this.applyQualitySettings(qualityPresets[preset])
  }

  applyQualitySettings(settings: CloudQualitySettings): this {
    applyCloudsQualitySettings(this, settings)
    return this
  }

  get shadowMapNode(): ShadowMarchNode {
    return this.shadowNode
  }

  getTextureNode(): TextureNode {
    return this.textureNode as unknown as TextureNode
  }

  getVelocityTextureNode(): TextureNode {
    return this.marchNode.getVelocityTextureNode()
  }

  /** Host-supplied or procedural weather texture. */
  setLocalWeatherTexture(node: TextureNode | null): this {
    if (this.ownsLocalWeather && this.localWeather != null) {
      this.localWeather.dispose()
    }
    this.localWeather = null
    this.ownsLocalWeather = false
    this.parameters.setLocalWeatherTexture(node)
    this.resetTemporalHistory()
    return this
  }

  setShapeTexture(node: Texture3DNode | null): this {
    if (this.ownsShape && this.shape != null) {
      this.shape.dispose()
    }
    this.shape = null
    this.ownsShape = false
    this.parameters.setShapeTexture(node)
    this.resetTemporalHistory()
    return this
  }

  setShapeDetailTexture(node: Texture3DNode | null): this {
    if (this.ownsShapeDetail && this.shapeDetail != null) {
      this.shapeDetail.dispose()
    }
    this.shapeDetail = null
    this.ownsShapeDetail = false
    this.parameters.setShapeDetailTexture(node)
    this.resetTemporalHistory()
    return this
  }

  setTurbulenceTexture(node: TextureNode | null): this {
    if (this.ownsTurbulence && this.turbulence != null) {
      this.turbulence.dispose()
    }
    this.turbulence = null
    this.ownsTurbulence = false
    this.parameters.setTurbulenceTexture(node)
    this.resetTemporalHistory()
    return this
  }

  /** Optional 3D blue-noise / STBN texture for march jitter (hash fallback). */
  setStbnTexture(node: Texture3DNode | null): this {
    this.parameters.setStbnTexture(node)
    return this
  }

  /** Resolved BSM cascade textures (cascade 0 first), live across rebuilds. */
  getShadowBufferNodes(): TextureNode[] {
    return this.shadowNode.getBufferNodes()
  }

  /** Horizontal cascade atlas for BSM sampling (march + host materials). */
  getShadowAtlasNode(): TextureNode | null {
    return this.shadowNode.getAtlasNode()
  }

  get debugOutput(): CloudsDebugOutput {
    return this._debugOutput
  }

  set debugOutput(value: CloudsDebugOutput) {
    if (value === this._debugOutput) return
    this._debugOutput = value
    this.applyDebugMarchMode()
    this.resetTemporalHistory()
    // setup() return value changed — force the pipeline to rebuild this node.
    ;(this as { needsUpdate?: boolean }).needsUpdate = true
  }

  private applyDebugMarchMode(): void {
    applyDebugMarchMode(this.marchNode.march, this._debugOutput)
    // Debug probes are a march variant axis (Phase C).
    this.marchNode.invalidateMaterial()
  }

  /**
   * Prefer putting this `CloudsNode` on the pipeline when debugging so
   * {@link updateBefore} keeps running. Returns `null` for normal compositing.
   */
  getDebugViewNode(): CloudsNode | null {
    return this._debugOutput === 'none' ? null : this
  }

  getMarchRenderSize(target: Vector2): Vector2 {
    return this.marchNode.getRenderSize(target)
  }

  getMarchOutputSize(target: Vector2): Vector2 {
    return this.marchNode.getOutputSize(target)
  }

  /**
   * Demo / host HUD snapshot. Prefer this over reading resolve-node uniforms.
   */
  getPassDiagnostics(
    marchRender: Vector2,
    marchOutput: Vector2
  ): {
    marchRender: Vector2
    marchOutput: Vector2
    temporalUpscale: boolean
    temporalUpscaleUniform: number
    temporalHistory: boolean
    historyValid: number
    shadowEnabled: boolean
    timing: CloudsPassTiming
  } {
    this.getMarchRenderSize(marchRender)
    this.getMarchOutputSize(marchOutput)
    return {
      marchRender,
      marchOutput,
      temporalUpscale: this.temporalUpscale,
      temporalUpscaleUniform: this.resolveNode.temporalUpscaleNode.value,
      temporalHistory: this.temporalHistoryEnabled,
      historyValid: this.resolveNode.historyValid.value,
      shadowEnabled: this.shadowEnabled,
      timing: this.lastPassTiming
    }
  }

  resetTemporalHistory(): this {
    this.frame = 0
    this.resolveNode.reset()
    this.marchNode.resetReprojection()
    return this
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
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
    measureCloudsPassTiming(
      this.lastPassTiming,
      {
        shadow: () => {
          this.shadowNode.updateBefore(frame)
        },
        march: () => {
          this.marchNode.render(frame, false)
          this.marchNode.getOutputSize(this.outputSize)
        },
        resolve: () => {
          this.resolveNode.setSize(this.outputSize.x, this.outputSize.y)
          this.resolveNode.render(frame)
          this.marchNode.commitReprojection(frame)
        }
      },
      this.shadowNode.lastPassTiming
    )
    this.frame = (this.frame + 1) % 16
    return undefined
  }

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    // Build only internally owned procedural generators.
    this.localWeather?.build(builder)
    this.shape?.build(builder)
    this.shapeDetail?.build(builder)
    this.turbulence?.build(builder)
    this.shadowNode.build(builder)
    this.marchNode.build(builder)
    this.resolveNode.build(builder)

    // Diagnostics must return from this setup so CloudsNode stays in the graph
    // and updateBefore keeps marching while the camera moves.
    return setupCloudsDebugOutput(this._debugOutput, {
      marchNode: this.marchNode,
      shadowNode: this.shadowNode,
      textureNode: this.textureNode
    }) as ThreeNode
  }

  override dispose(): void {
    this.shadowNode.dispose()
    this.shadowDebugNode.dispose()
    this.resolveNode.dispose()
    this.marchNode.dispose()
    if (this.ownsLocalWeather) this.localWeather?.dispose()
    if (this.ownsShape) this.shape?.dispose()
    if (this.ownsShapeDetail) this.shapeDetail?.dispose()
    if (this.ownsTurbulence) this.turbulence?.dispose()
    super.dispose()
  }
}

installCloudsNodeTuning(
  CloudsNode.prototype as unknown as import('./cloudsNodeTuning').CloudsNodeTuningHost
)

export const clouds = (options: CloudsOptions): CloudsNode =>
  new CloudsNode(options)
