// src/webgpu/updateCloudLayerParameters.ts

import type { CloudLayers } from '../CloudLayers'
import type { CloudLayerParameterNodes } from './parameters'

const shadowLayerMaskScratch = [0, 0, 0, 0]

/**
 * Packs {@link CloudLayers} into TSL layer uniforms. Same packing as
 * {@link updateCloudLayerUniforms} for the WebGL path.
 */
export function updateCloudLayerParameters(
  parameters: CloudLayerParameterNodes,
  layers: CloudLayers
): void {
  layers.packValues('altitude', parameters.minLayerHeights.value)
  layers.packSums('altitude', 'height', parameters.maxLayerHeights.value)
  layers.packIntervalHeights(
    parameters.minIntervalHeights.value,
    parameters.maxIntervalHeights.value
  )
  layers.packValues('densityScale', parameters.densityScales.value)
  layers.packValues('shapeAmount', parameters.shapeAmounts.value)
  layers.packValues('shapeDetailAmount', parameters.shapeDetailAmounts.value)
  layers.packValues('weatherExponent', parameters.weatherExponents.value)
  layers.packValues('shapeAlteringBias', parameters.shapeAlteringBiases.value)
  layers.packValues(
    'coverageFilterWidth',
    parameters.coverageFilterWidths.value
  )

  const { densityProfile } = parameters
  layers.packDensityProfiles('expTerm', densityProfile.expTerms.value)
  layers.packDensityProfiles('exponent', densityProfile.exponents.value)
  layers.packDensityProfiles('linearTerm', densityProfile.linearTerms.value)
  layers.packDensityProfiles('constantTerm', densityProfile.constantTerms.value)

  let totalMinHeight = Infinity
  let totalMaxHeight = 0
  let shadowBottomHeight = Infinity
  let shadowTopHeight = 0
  shadowLayerMaskScratch.fill(0)
  for (let i = 0; i < layers.length; ++i) {
    const { altitude, height, shadow } = layers[i]
    const maxHeight = altitude + height
    if (height > 0) {
      if (altitude < totalMinHeight) {
        totalMinHeight = altitude
      }
      if (shadow && altitude < shadowBottomHeight) {
        shadowBottomHeight = altitude
      }
      if (maxHeight > totalMaxHeight) {
        totalMaxHeight = maxHeight
      }
      if (shadow && maxHeight > shadowTopHeight) {
        shadowTopHeight = maxHeight
      }
    }
    shadowLayerMaskScratch[i] = shadow ? 1 : 0
  }
  if (totalMinHeight !== Infinity) {
    parameters.minHeight.value = totalMinHeight
    parameters.maxHeight.value = totalMaxHeight
  } else {
    if (totalMaxHeight !== 0) {
      throw new Error('Invalid cloud layer height range.')
    }
    parameters.minHeight.value = 0
    parameters.maxHeight.value = 0
  }
  if (shadowBottomHeight !== Infinity) {
    parameters.shadowBottomHeight.value = shadowBottomHeight
    parameters.shadowTopHeight.value = shadowTopHeight
  } else {
    if (shadowTopHeight !== 0) {
      throw new Error('Invalid cloud shadow layer height range.')
    }
    parameters.shadowBottomHeight.value = 0
    parameters.shadowTopHeight.value = 0
  }
  parameters.shadowLayerMask.value.fromArray(shadowLayerMaskScratch)

  parameters.localWeatherChannels = layers.localWeatherChannels
}
