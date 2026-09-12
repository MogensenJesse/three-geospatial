// src/webgpu/sampling.ts

import {
  float,
  If,
  max,
  mix,
  pow,
  remapClamp,
  saturate,
  struct,
  vec3,
  vec4
} from 'three/tsl'

import type { CloudsEnvironment } from './CloudsEnvironment'
import { FnLayout } from './internal/FnLayout'
import type { Node } from './internal/node'
import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'

export const weatherSampleStruct = /*#__PURE__*/ struct(
  {
    heightFraction: 'vec4',
    density: 'vec4'
  },
  'WeatherSample'
)

export const mediaSampleStruct = /*#__PURE__*/ struct(
  {
    density: 'float',
    weight: 'vec4',
    scattering: 'float',
    extinction: 'float'
  },
  'MediaSample'
)

export type WeatherSampleNode = ReturnType<typeof weatherSampleStruct>
export type MediaSampleNode = ReturnType<typeof mediaSampleStruct>

const channelComponent = (
  sample: Node<'vec4'>,
  channel: string
): Node<'float'> => {
  switch (channel) {
    case 'r':
      return sample.r
    case 'g':
      return sample.g
    case 'b':
      return sample.b
    case 'a':
      return sample.a
    default:
      return sample.r
  }
}

/** Reorder texture.rgba into layer channels (WebGL `LOCAL_WEATHER_CHANNELS`). */
export function swizzleLocalWeather(
  sample: Node<'vec4'>,
  channels: string
): Node<'vec4'> {
  if (channels.length !== 4) {
    throw new Error('localWeatherChannels must be length 4')
  }
  return vec4(
    channelComponent(sample, channels[0]),
    channelComponent(sample, channels[1]),
    channelComponent(sample, channels[2]),
    channelComponent(sample, channels[3])
  )
}

export const getFlatUv = /*#__PURE__*/ FnLayout({
  name: 'getFlatCloudUv',
  type: 'vec2',
  inputs: [
    { name: 'positionWorld', type: 'vec3' },
    { name: 'mapOrigin', type: 'vec3' },
    { name: 'mapSize', type: 'vec2' }
  ]
})(([positionWorld, mapOrigin, mapSize]) =>
  positionWorld.xz.sub(mapOrigin.xz).div(mapSize).add(0.5)
)

export const getCloudPositionMeters = /*#__PURE__*/ FnLayout({
  name: 'getCloudPositionMeters',
  type: 'vec3',
  inputs: [
    { name: 'positionWorld', type: 'vec3' },
    { name: 'mapOrigin', type: 'vec3' },
    { name: 'worldUnitsPerMeter', type: 'float' }
  ]
})(([positionWorld, mapOrigin, worldUnitsPerMeter]) =>
  positionWorld.sub(mapOrigin).div(worldUnitsPerMeter)
)

export const getEnvironmentUv = (
  environment: CloudsEnvironment,
  positionWorld: Node<'vec3'>
): Node<'vec2'> =>
  getFlatUv(positionWorld, environment.mapOriginNode, environment.mapSizeNode)

export const getEnvironmentPositionMeters = (
  environment: CloudsEnvironment,
  positionWorld: Node<'vec3'>
): Node<'vec3'> =>
  getCloudPositionMeters(
    positionWorld,
    environment.mapOriginNode,
    environment.worldUnitsPerMeterNode
  )

export const getMipLevel = /*#__PURE__*/ FnLayout({
  name: 'getMipLevel',
  type: 'float',
  inputs: [
    { name: 'uv', type: 'vec2' },
    { name: 'resolution', type: 'vec2' }
  ]
})(([_uv, _resolution]) => {
  // Avoid screen-space derivatives in the clouds RTT pass for now — they can
  // pull fragment-only builtins into invalid pipeline states on some paths.
  return float(0)
})

export const insideLayerIntervals = /*#__PURE__*/ FnLayout({
  name: 'insideLayerIntervals',
  type: 'bool',
  inputs: [
    { name: 'height', type: 'float' },
    { name: 'minIntervalHeights', type: 'vec3' },
    { name: 'maxIntervalHeights', type: 'vec3' }
  ]
})(([height, minIntervalHeights, maxIntervalHeights]) => {
  const gt = vec3(height).greaterThan(minIntervalHeights)
  const lt = vec3(height).lessThan(maxIntervalHeights)
  return gt.and(lt).any()
})

export const shapeAlteringFunction = /*#__PURE__*/ FnLayout({
  name: 'shapeAlteringFunction',
  type: 'vec4',
  inputs: [
    { name: 'heightFraction', type: 'vec4' },
    { name: 'bias', type: 'vec4' }
  ]
})(([heightFraction, bias]) => {
  const biased = pow(heightFraction, bias)
  const x = biased.mul(2).sub(1).clamp(-1, 1)
  return float(1).sub(x.mul(x))
})

export const getLayerDensity = /*#__PURE__*/ FnLayout({
  name: 'getLayerDensity',
  type: 'vec4',
  inputs: [
    { name: 'heightFraction', type: 'vec4' },
    { name: 'expTerms', type: 'vec4' },
    { name: 'exponents', type: 'vec4' },
    { name: 'linearTerms', type: 'vec4' },
    { name: 'constantTerms', type: 'vec4' }
  ]
})(([heightFraction, expTerms, exponents, linearTerms, constantTerms]) => {
  return expTerms
    .mul(exponents.mul(heightFraction).exp())
    .add(linearTerms.mul(heightFraction))
    .add(constantTerms)
})

export interface SampleWeatherOptions {
  /** When true, multiply weather by shadowLayerMask (shadow pass). */
  applyShadowLayerMask?: boolean
}

/**
 * Sample local weather and pack per-layer density shells. Port of
 * `sampleWeather` in clouds.glsl.
 */
export function sampleWeather(
  parameters: CloudParameterNodes,
  layers: CloudLayerParameterNodes,
  uv: Node<'vec2'>,
  height: Node<'float'>,
  mipLevel: Node<'float'>,
  options: SampleWeatherOptions = {}
): WeatherSampleNode {
  const { localWeatherTexture } = parameters
  if (localWeatherTexture == null) {
    throw new Error('CloudParameterNodes.localWeatherTexture is required')
  }

  const heightFraction = remapClamp(
    vec4(height),
    layers.minLayerHeights,
    layers.maxLayerHeights
  ).toVar()

  const weatherUv = uv
    .mul(parameters.localWeatherRepeat)
    .add(parameters.localWeatherOffset)
  // Storage procedural textures have no mip chain; use filtered sample.
  const rawWeather = localWeatherTexture.sample(weatherUv)
  const localWeather = swizzleLocalWeather(
    rawWeather,
    layers.localWeatherChannels
  ).toVar()
  localWeather.assign(pow(localWeather, layers.weatherExponents))

  if (options.applyShadowLayerMask === true) {
    localWeather.mulAssign(layers.shadowLayerMask)
  }

  const heightScale = shapeAlteringFunction(
    heightFraction,
    layers.shapeAlteringBiases
  )
  const factor = float(1).sub(parameters.coverage.mul(heightScale)).toVar()
  const density = remapClamp(
    mix(localWeather, vec4(1), layers.coverageFilterWidths),
    factor,
    factor.add(layers.coverageFilterWidths)
  )

  return weatherSampleStruct(heightFraction, density)
}

export interface SampleMediaOptions {
  /** Skip shape-detail sampling even if the uniform flag is enabled. */
  forceDisableShapeDetail?: boolean
  /** Skip turbulence even if the uniform flag is enabled. */
  forceDisableTurbulence?: boolean
}

/**
 * Combine weather shells with shape / detail / turbulence into media
 * coefficients. Port of `sampleMedia` in clouds.glsl.
 */
export function sampleMedia(
  parameters: CloudParameterNodes,
  layers: CloudLayerParameterNodes,
  weather: WeatherSampleNode,
  position: Node<'vec3'>,
  uv: Node<'vec2'>,
  mipLevel: Node<'float'>,
  jitter: Node<'float'>,
  options: SampleMediaOptions = {}
): MediaSampleNode {
  const { shapeTexture } = parameters
  if (shapeTexture == null) {
    throw new Error('CloudParameterNodes.shapeTexture is required')
  }

  const density = weather.get('density').toVar()
  const heightFraction = weather.get('heightFraction')

  const turbulence = vec3(0).toVar()
  if (
    options.forceDisableTurbulence !== true &&
    parameters.turbulenceTexture != null
  ) {
    const turbulenceTexture = parameters.turbulenceTexture
    If(parameters.turbulenceEnabled, () => {
      const turbulenceUv = uv
        .mul(parameters.localWeatherRepeat)
        .mul(parameters.turbulenceRepeat)
      const turbulenceSample = turbulenceTexture.sample(turbulenceUv)
      turbulence.assign(
        parameters.turbulenceDisplacement
          .mul(turbulenceSample.rgb.mul(2).sub(1))
          .mul(density.dot(remapClamp(heightFraction, vec4(0.3), vec4(0))))
      )
    })
  }

  const shapePosition = position
    .add(turbulence)
    .mul(parameters.shapeRepeat)
    .add(parameters.shapeOffset)
  const shape = shapeTexture.sample(shapePosition).r
  density.assign(
    remapClamp(density, float(1).sub(shape).mul(layers.shapeAmounts), vec4(1))
  )

  if (
    options.forceDisableShapeDetail !== true &&
    parameters.shapeDetailTexture != null
  ) {
    const shapeDetailTexture = parameters.shapeDetailTexture
    If(
      parameters.shapeDetailEnabled.and(
        mipLevel.mul(0.5).add(jitter.sub(0.5).mul(0.5)).lessThan(0.5)
      ),
      () => {
        const detailPosition = position
          .add(turbulence)
          .mul(parameters.shapeDetailRepeat)
          .add(parameters.shapeDetailOffset)
        const detail = shapeDetailTexture.sample(detailPosition).r
        const modifier = mix(
          vec4(pow(detail, 6)),
          vec4(float(1).sub(detail)),
          remapClamp(heightFraction, vec4(0.2), vec4(0.4))
        ).toVar()
        modifier.assign(mix(vec4(0), modifier, layers.shapeDetailAmounts))
        density.assign(remapClamp(density.mul(2), modifier.mul(0.5), vec4(1)))
      }
    )
  }

  const profileDensity = getLayerDensity(
    heightFraction,
    layers.densityProfile.expTerms,
    layers.densityProfile.exponents,
    layers.densityProfile.linearTerms,
    layers.densityProfile.constantTerms
  )
  density.assign(
    saturate(density.mul(layers.densityScales).mul(profileDensity))
  )

  const densitySum = density.x
    .add(density.y)
    .add(density.z)
    .add(density.w)
    .toVar()
  const weight = density.div(max(densitySum, 1e-7))
  const scattering = densitySum.mul(parameters.scatteringCoefficient)
  const extinction = densitySum
    .mul(parameters.absorptionCoefficient)
    .add(scattering)

  return mediaSampleStruct(densitySum, weight, scattering, extinction)
}
