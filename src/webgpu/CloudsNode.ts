// src/webgpu/CloudsNode.ts

import { Vector2, Vector3 } from 'three'
import {
  NodeUpdateType,
  TempNode,
  type NodeBuilder,
  type NodeFrame,
  type Texture3DNode,
  type TextureNode
} from 'three/webgpu'

import { CloudLayer } from '../CloudLayer'
import { CloudLayers } from '../CloudLayers'
import {
  qualityPresets,
  type CloudQualitySettings,
  type PhaseFunctionMode,
  type QualityPreset
} from '../qualityPresets'
import { applyCloudsQualitySettings } from './applyCloudsQuality'
import {
  applyDebugMarchMode,
  createCloudsPassTiming,
  measureCloudsPassTiming,
  setupCloudsDebugOutput,
  type CloudsDebugOutput,
  type CloudsPassTiming
} from './cloudsDebug'
import { CloudsEnvironment } from './CloudsEnvironment'
import {
  resolveCloudsOptions,
  type CloudsFacadeOptions,
  type CloudsOptions
} from './CloudsOptions'
import { CloudShapeDetailNode } from './CloudShapeDetailNode'
import { CloudShapeNode } from './CloudShapeNode'
import { CloudsMarchNode } from './CloudsMarchNode'
import { CloudsResolveNode } from './CloudsResolveNode'
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
      this.cloudLayers.length = 0
      for (const layer of facade.cloudLayers) {
        this.cloudLayers.push(
          layer instanceof CloudLayer ? layer.clone() : new CloudLayer(layer)
        )
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
    if (facade.shapeDetail != null) this.shapeDetailEnabled = facade.shapeDetail
    if (facade.turbulence != null) this.turbulenceEnabled = facade.turbulence
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
    if (facade.powderExponent != null) this.powderExponent = facade.powderExponent
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
    return this.textureNode
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

  /** When false, cloud temporal resolve never reuses history (debug). */
  get temporalHistoryEnabled(): boolean {
    return this.resolveNode.historyEnabled
  }

  set temporalHistoryEnabled(value: boolean) {
    if (value !== this.resolveNode.historyEnabled) {
      this.resolveNode.historyEnabled = value
      this.resetTemporalHistory()
    }
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

  get shadowEnabled(): boolean {
    return this.shadowNode.enabled
  }

  set shadowEnabled(value: boolean) {
    this.shadowNode.enabled = value
    this.shadowNode.shadow.enabled.value = value ? 1 : 0
    this.marchNode.shadowAtlas = value ? this.shadowNode.getAtlasNode() : null
    this.marchNode.invalidateMaterial()
    this.shadowNode.resolveNode.reset()
    this.resetTemporalHistory()
  }

  get shadowMapSize(): number {
    return this.shadowNode.shadowMaps.mapSize.x
  }

  set shadowMapSize(value: number) {
    const previous = this.shadowNode.shadowMaps.mapSize.x
    this.shadowNode.setMapSize(value)
    if (value !== previous) {
      this.marchNode.shadowAtlas = this.shadowNode.getAtlasNode()
      this.marchNode.invalidateMaterial()
      this.shadowNode.resolveNode.reset()
      this.resetTemporalHistory()
    }
  }

  get shadowCascadeCount(): number {
    return this.shadowNode.shadowMaps.cascadeCount
  }

  set shadowCascadeCount(value: number) {
    const previous = this.shadowNode.shadowMaps.cascadeCount
    this.shadowNode.setCascadeCount(value)
    if (value !== previous) {
      this.marchNode.shadowAtlas = this.shadowNode.getAtlasNode()
      this.marchNode.invalidateMaterial()
      this.shadowNode.resolveNode.reset()
      this.resetTemporalHistory()
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
  }

  override setup(builder: NodeBuilder): unknown {
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
    })
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

export const clouds = (options: CloudsOptions): CloudsNode =>
  new CloudsNode(options)
