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
import { LocalWeatherNode } from './LocalWeatherNode'
import { CloudLayerParameterNodes, CloudParameterNodes } from './parameters'
import { ShadowMarchNode } from './ShadowMarchNode'
import { TurbulenceNode } from './TurbulenceNode'
import { updateCloudLayerParameters } from './updateCloudLayerParameters'

export type { CloudsDebugOutput, CloudsPassTiming } from './cloudsDebug'

/**
 * Orchestrates procedural textures + layer packing + clouds march. Exposes an
 * overlay texture for composition (or a diagnostic view when selected).
 */
export class CloudsNode extends TempNode {
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
    this.textureNode = this.resolveNode.getTextureNode()

    this.installDefaultProcedurals(facade)
    const preset = facade.qualityPreset ?? 'high'
    this.qualityPreset = preset
    this.applyQualitySettings(qualityPresets[preset])
    this.applyFacadeOptions(facade)
    updateCloudLayerParameters(this.layerParameters, this.cloudLayers)
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
    if (facade.shapeDetail != null) this.shapeDetailEnabled = facade.shapeDetail
    if (facade.turbulence != null) this.turbulenceEnabled = facade.turbulence
    if (facade.resolutionScale != null) {
      this.resolutionScale = facade.resolutionScale
    }
    if (facade.temporalUpscale != null) {
      this.temporalUpscale = facade.temporalUpscale
    }
    if (facade.temporalAlpha != null) this.temporalAlpha = facade.temporalAlpha
    if (facade.temporalHistoryEnabled != null) {
      this.temporalHistoryEnabled = facade.temporalHistoryEnabled
    }
    if (facade.varianceGamma != null) this.varianceGamma = facade.varianceGamma
    if (facade.secondaryIterationCount != null) {
      this.secondaryIterationCount = facade.secondaryIterationCount
    }
    if (facade.skyLightScale != null) this.skyLightScale = facade.skyLightScale
    if (facade.stepJitterScale != null) {
      this.stepJitterScale = facade.stepJitterScale
    }
    if (facade.powderScale != null) this.powderScale = facade.powderScale
    if (facade.powderExponent != null) {
      this.powderExponent = facade.powderExponent
    }
    if (facade.groundBounceScale != null) {
      this.groundBounceScale = facade.groundBounceScale
    }
    if (facade.groundIterationCount != null) {
      this.groundIterationCount = facade.groundIterationCount
    }
    if (facade.phaseFunctionMode != null) {
      this.phaseFunctionMode = facade.phaseFunctionMode
    }
    if (facade.scatterAnisotropy1 != null) {
      this.scatterAnisotropy1 = facade.scatterAnisotropy1
    }
    if (facade.scatterAnisotropy2 != null) {
      this.scatterAnisotropy2 = facade.scatterAnisotropy2
    }
    if (facade.scatterAnisotropyMix != null) {
      this.scatterAnisotropyMix = facade.scatterAnisotropyMix
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
    if (facade.opticalDepthTailScale != null) {
      this.opticalDepthTailScale = facade.opticalDepthTailScale
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

  get temporalHistoryEnabled(): boolean {
    return this.resolveNode.historyEnabled
  }

  set temporalHistoryEnabled(value: boolean) {
    if (value !== this.resolveNode.historyEnabled) {
      this.resolveNode.historyEnabled = value
      this.resetTemporalHistory()
    }
  }

  get varianceGamma(): number {
    return this.resolveNode.varianceGamma.value
  }

  set varianceGamma(value: number) {
    this.resolveNode.varianceGamma.value = value
  }

  get shapeDetailEnabled(): boolean {
    return Boolean(this.parameters.shapeDetailEnabled.value)
  }

  set shapeDetailEnabled(value: boolean) {
    this.parameters.shapeDetailEnabled.value = value
  }

  get turbulenceEnabled(): boolean {
    return Boolean(this.parameters.turbulenceEnabled.value)
  }

  set turbulenceEnabled(value: boolean) {
    this.parameters.turbulenceEnabled.value = value
  }

  get scatteringCoefficient(): number {
    return this.parameters.scatteringCoefficient.value
  }

  set scatteringCoefficient(value: number) {
    this.parameters.scatteringCoefficient.value = value
  }

  get absorptionCoefficient(): number {
    return this.parameters.absorptionCoefficient.value
  }

  set absorptionCoefficient(value: number) {
    this.parameters.absorptionCoefficient.value = value
  }

  get turbulenceDisplacement(): number {
    return this.parameters.turbulenceDisplacement.value
  }

  set turbulenceDisplacement(value: number) {
    this.parameters.turbulenceDisplacement.value = value
  }

  get coverage(): number {
    return this.parameters.coverage.value
  }

  set coverage(value: number) {
    this.parameters.coverage.value = value
  }

  get localWeatherRepeat(): Vector2 {
    return this.parameters.localWeatherRepeat.value
  }

  get localWeatherOffset(): Vector2 {
    return this.parameters.localWeatherOffset.value
  }

  get shapeRepeat(): Vector3 {
    return this.parameters.shapeRepeat.value
  }

  get shapeOffset(): Vector3 {
    return this.parameters.shapeOffset.value
  }

  get shapeDetailRepeat(): Vector3 {
    return this.parameters.shapeDetailRepeat.value
  }

  get shapeDetailOffset(): Vector3 {
    return this.parameters.shapeDetailOffset.value
  }

  get turbulenceRepeat(): Vector2 {
    return this.parameters.turbulenceRepeat.value
  }

  get secondaryIterationCount(): number {
    return this.marchNode.march.maxIterationCountToSun.value
  }

  set secondaryIterationCount(value: number) {
    this.marchNode.march.maxIterationCountToSun.value = value
  }

  get skyLightScale(): number {
    return this.marchNode.march.skyLightScale.value
  }

  set skyLightScale(value: number) {
    this.marchNode.march.skyLightScale.value = value
  }

  get stepJitterScale(): number {
    return this.marchNode.march.stepJitterScale.value
  }

  set stepJitterScale(value: number) {
    this.marchNode.march.stepJitterScale.value = value
  }

  get powderScale(): number {
    return this.marchNode.march.powderScale.value
  }

  set powderScale(value: number) {
    this.marchNode.march.powderScale.value = value
  }

  get powderExponent(): number {
    return this.marchNode.march.powderExponent.value
  }

  set powderExponent(value: number) {
    this.marchNode.march.powderExponent.value = value
  }

  get groundBounceScale(): number {
    return this.marchNode.march.groundBounceScale.value
  }

  set groundBounceScale(value: number) {
    this.marchNode.march.groundBounceScale.value = value
  }

  get groundIterationCount(): number {
    return this.marchNode.march.maxIterationCountToGround.value
  }

  set groundIterationCount(value: number) {
    this.marchNode.march.maxIterationCountToGround.value = value
  }

  get phaseFunctionMode(): PhaseFunctionMode {
    return this.marchNode.march.phaseFunctionMode.value === 1
      ? 'accurate'
      : 'approximate'
  }

  set phaseFunctionMode(value: PhaseFunctionMode) {
    this.marchNode.march.phaseFunctionMode.value = value === 'accurate' ? 1 : 0
  }

  get scatterAnisotropy1(): number {
    return this.marchNode.march.scatterAnisotropy1.value
  }

  set scatterAnisotropy1(value: number) {
    this.marchNode.march.scatterAnisotropy1.value = value
  }

  get scatterAnisotropy2(): number {
    return this.marchNode.march.scatterAnisotropy2.value
  }

  set scatterAnisotropy2(value: number) {
    this.marchNode.march.scatterAnisotropy2.value = value
  }

  get scatterAnisotropyMix(): number {
    return this.marchNode.march.scatterAnisotropyMix.value
  }

  set scatterAnisotropyMix(value: number) {
    this.marchNode.march.scatterAnisotropyMix.value = value
  }

  get shadowEnabled(): boolean {
    return this.shadowNode.enabled
  }

  set shadowEnabled(value: boolean) {
    this.shadowNode.enabled = value
    this.shadowNode.shadow.enabled.value = value ? 1 : 0
    this.shadowNode.rebindConsumers(
      this,
      value ? this.shadowNode.getAtlasNode() : null
    )
  }

  get shadowMapSize(): number {
    return this.shadowNode.shadowMaps.mapSize.x
  }

  set shadowMapSize(value: number) {
    const previous = this.shadowNode.shadowMaps.mapSize.x
    this.shadowNode.setMapSize(value)
    if (value !== previous) {
      this.shadowNode.rebindConsumers(this)
    }
  }

  get shadowCascadeCount(): number {
    return this.shadowNode.shadowMaps.cascadeCount
  }

  set shadowCascadeCount(value: number) {
    const previous = this.shadowNode.shadowMaps.cascadeCount
    this.shadowNode.setCascadeCount(value)
    if (value !== previous) {
      this.shadowNode.rebindConsumers(this)
    }
  }

  get shadowFilterRadius(): number {
    return this.shadowNode.shadow.maxShadowFilterRadius.value
  }

  set shadowFilterRadius(value: number) {
    this.shadowNode.shadow.maxShadowFilterRadius.value = value
  }

  get shadowTemporalAlpha(): number {
    return this.shadowNode.resolveNode.temporalAlpha.value
  }

  set shadowTemporalAlpha(value: number) {
    this.shadowNode.resolveNode.temporalAlpha.value = value
  }

  get shadowTemporalGamma(): number {
    return this.shadowNode.resolveNode.varianceGamma.value
  }

  set shadowTemporalGamma(value: number) {
    this.shadowNode.resolveNode.varianceGamma.value = value
  }

  get opticalDepthTailScale(): number {
    return this.shadowNode.march.opticalDepthTailScale.value
  }

  set opticalDepthTailScale(value: number) {
    this.shadowNode.march.opticalDepthTailScale.value = value
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

  /** Cascade array for BSM sampling (march + host materials). */
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
    this.resolveNode.dispose()
    this.marchNode.dispose()
    if (this.ownsLocalWeather) this.localWeather?.dispose()
    if (this.ownsShape) this.shape?.dispose()
    if (this.ownsShapeDetail) this.shapeDetail?.dispose()
    if (this.ownsTurbulence) this.turbulence?.dispose()
    super.dispose()
  }
}

export const clouds = (options: CloudsOptions): CloudsNode =>
  new CloudsNode(options)
