// src/webgpu/applyCloudsQuality.ts

import {
  type CloudQualitySettings,
  cloneQualitySettings
} from '../qualityPresets'
import type { CloudsMarchNode } from './CloudsMarchNode'
import type { CloudParameterNodes } from './parameters'
import type { ShadowMarchNode } from './ShadowMarchNode'

/** Minimal host surface needed to apply a quality preset. */
export interface CloudsQualityHost {
  parameters: CloudParameterNodes
  marchNode: CloudsMarchNode
  shadowNode: ShadowMarchNode
  resolutionScale: number
  temporalUpscale: boolean
  resetTemporalHistory(): unknown
}

/**
 * Push {@link CloudQualitySettings} onto march and shadow nodes and rebind
 * the BSM cascade array.
 */
export function applyCloudsQualitySettings(
  host: CloudsQualityHost,
  settings: CloudQualitySettings
): void {
  const next = cloneQualitySettings(settings)
  const { clouds: cloudQuality, shadow: shadowQuality } = next

  host.resolutionScale = next.resolutionScale
  host.temporalUpscale = next.temporalUpscale
  host.parameters.shapeDetailEnabled.value = next.shapeDetail
  host.parameters.turbulenceEnabled.value = next.turbulence

  const march = host.marchNode.march
  march.multiScatteringOctaves.value = cloudQuality.multiScatteringOctaves
  march.maxIterationCount.value = cloudQuality.maxIterationCount
  march.minStepSize.value = cloudQuality.minStepSize
  march.maxStepSize.value = cloudQuality.maxStepSize
  march.maxRayDistance.value = cloudQuality.maxRayDistance
  march.perspectiveStepScale.value = cloudQuality.perspectiveStepScale
  march.minDensity.value = cloudQuality.minDensity
  march.minExtinction.value = cloudQuality.minExtinction
  march.minTransmittance.value = cloudQuality.minTransmittance
  march.maxIterationCountToSun.value = cloudQuality.secondaryIterationCount
  march.minSecondaryStepSize.value = cloudQuality.minSecondaryStepSize
  march.secondaryStepScale.value = cloudQuality.secondaryStepScale
  march.powderScale.value = cloudQuality.powderScale
  march.powderExponent.value = cloudQuality.powderExponent
  march.groundBounceScale.value = cloudQuality.groundBounceScale
  march.maxIterationCountToGround.value = cloudQuality.groundIterationCount
  march.phaseFunctionMode.value =
    cloudQuality.phaseFunctionMode === 'accurate' ? 1 : 0

  const shadowMarch = host.shadowNode.march
  shadowMarch.maxIterationCount.value = shadowQuality.maxIterationCount
  shadowMarch.minStepSize.value = shadowQuality.minStepSize
  shadowMarch.maxStepSize.value = shadowQuality.maxStepSize
  shadowMarch.minDensity.value = shadowQuality.minDensity
  shadowMarch.minExtinction.value = shadowQuality.minExtinction
  shadowMarch.minTransmittance.value = shadowQuality.minTransmittance

  host.shadowNode.setMapSize(shadowQuality.mapSize)
  host.shadowNode.setCascadeCount(shadowQuality.cascadeCount)
  host.shadowNode.resolveNode.temporalAlpha.value = shadowQuality.temporalAlpha
  host.shadowNode.resolveNode.varianceGamma.value = shadowQuality.temporalGamma

  // Cascade array recreates on map/cascade change; rebind so sampling never keeps a
  // disposed GPU texture after preset switches.
  host.marchNode.shadowAtlas = host.shadowNode.getAtlasNode()
  // No-ops when the march variant key is unchanged (for example, re-applying the same preset).
  host.marchNode.invalidateMaterial()
  host.shadowNode.resolveNode.reset()
  host.resetTemporalHistory()
}
