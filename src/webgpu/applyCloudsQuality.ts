// src/webgpu/applyCloudsQuality.ts

import {
  type CloudQualitySettings,
  cloneQualitySettings,
  type PhaseFunctionMode
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
  shapeDetailEnabled: boolean
  turbulenceEnabled: boolean
  secondaryIterationCount: number
  powderScale: number
  powderExponent: number
  groundBounceScale: number
  groundIterationCount: number
  phaseFunctionMode: PhaseFunctionMode
  shadowMapSize: number
  shadowCascadeCount: number
  shadowTemporalAlpha: number
  shadowTemporalGamma: number
  resetTemporalHistory(): unknown
}

/**
 * Push {@link CloudQualitySettings} through the host setters, then the march
 * and shadow uniforms that have no facade setter.
 */
export function applyCloudsQualitySettings(
  host: CloudsQualityHost,
  settings: CloudQualitySettings
): void {
  const next = cloneQualitySettings(settings)
  const { clouds: cloudQuality, shadow: shadowQuality } = next

  host.resolutionScale = next.resolutionScale
  host.temporalUpscale = next.temporalUpscale
  host.shapeDetailEnabled = next.shapeDetail
  host.turbulenceEnabled = next.turbulence
  host.secondaryIterationCount = cloudQuality.secondaryIterationCount
  host.powderScale = cloudQuality.powderScale
  host.powderExponent = cloudQuality.powderExponent
  host.groundBounceScale = cloudQuality.groundBounceScale
  host.groundIterationCount = cloudQuality.groundIterationCount
  host.phaseFunctionMode = cloudQuality.phaseFunctionMode
  host.shadowMapSize = shadowQuality.mapSize
  host.shadowCascadeCount = shadowQuality.cascadeCount
  host.shadowTemporalAlpha = shadowQuality.temporalAlpha
  host.shadowTemporalGamma = shadowQuality.temporalGamma

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
  march.minSecondaryStepSize.value = cloudQuality.minSecondaryStepSize
  march.secondaryStepScale.value = cloudQuality.secondaryStepScale

  const shadowMarch = host.shadowNode.march
  shadowMarch.maxIterationCount.value = shadowQuality.maxIterationCount
  shadowMarch.minStepSize.value = shadowQuality.minStepSize
  shadowMarch.maxStepSize.value = shadowQuality.maxStepSize
  shadowMarch.minDensity.value = shadowQuality.minDensity
  shadowMarch.minExtinction.value = shadowQuality.minExtinction
  shadowMarch.minTransmittance.value = shadowQuality.minTransmittance
  // Octaves are written on the march uniform after the shadow rebind.
  // Invalidate once so high↔ultra compiles the new trip count.
  host.marchNode.invalidateMaterial()
}
