import {
  atan,
  float,
  If,
  max,
  mix,
  PI,
  PI2,
  pow,
  remapClamp,
  saturate,
  struct,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { Texture3DNode, TextureNode } from 'three/webgpu'
import invariant from 'tiny-invariant'

import { FnLayout, type Node } from '@takram/three-geospatial/webgpu'

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
  invariant(channels.length === 4, 'localWeatherChannels must be length 4')
  return vec4(
    channelComponent(sample, channels[0]),
    channelComponent(sample, channels[1]),
    channelComponent(sample, channels[2]),
    channelComponent(sample, channels[3])
  )
}

export const getSphericalUv = /*#__PURE__*/ FnLayout({
  name: 'getSphericalUv',
  type: 'vec2',
  inputs: [{ name: 'position', type: 'vec3' }]
})(([position]) => {
  const st = position.yx.normalize()
  const phi = atan(st.x, st.y)
  const theta = position.normalize().z.asin()
  return vec2(phi.div(PI2).add(0.5), theta.div(PI).add(0.5))
})

export const getCubeSphereUv = /*#__PURE__*/ FnLayout({
  name: 'getCubeSphereUv',
  type: 'vec2',
  inputs: [{ name: 'position', type: 'vec3' }]
})(([position]) => {
  const n = position.normalize().toVar()
  const f = n.abs().toVar()
  const c = n.div(max(f.x, max(f.y, f.z))).toVar()
  const m = vec2().toVar()

  If(f.yy.greaterThan(f.xz).all(), () => {
    m.assign(c.y.greaterThan(0).select(vec2(n.x.negate(), n.z), n.xz))
  }).ElseIf(f.xx.greaterThan(f.yz).all(), () => {
    m.assign(c.x.greaterThan(0).select(n.yz, vec2(n.y.negate(), n.z)))
  }).Else(() => {
    m.assign(c.z.greaterThan(0).select(n.xy, vec2(n.x, n.y.negate())))
  })

  const m2 = m.mul(m).toVar()
  const q = m2.xy.dot(vec2(-2, 2)).sub(3).toVar()
  const q2 = q.mul(q)
  const uv = vec2().toVar()
  uv.x.assign(
    float(1.5)
      .add(m2.x)
      .sub(m2.y)
      .sub(float(-24).mul(m2.x).add(q2).sqrt().mul(0.5))
      .sqrt()
      .mul(m.x.greaterThan(0).select(1, -1))
  )
  uv.y.assign(
    float(6)
      .div(float(3).sub(uv.x.mul(uv.x)))
      .sqrt()
      .mul(m.y)
  )
  return uv.mul(0.5).add(0.5)
})

export const getGlobeUv = /*#__PURE__*/ FnLayout({
  name: 'getGlobeUv',
  type: 'vec2',
  inputs: [{ name: 'position', type: 'vec3' }]
})(([position]) => getCubeSphereUv(position))

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
 * Sample local weather and pack per-layer density shells.
 * Port of `sampleWeather` in clouds.glsl.
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
  invariant(
    localWeatherTexture != null,
    'CloudParameterNodes.localWeatherTexture is required'
  )

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
  let localWeather = swizzleLocalWeather(
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
  const factor = float(1)
    .sub(parameters.coverage.mul(heightScale))
    .toVar()
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
  invariant(
    shapeTexture != null,
    'CloudParameterNodes.shapeTexture is required'
  )

  const density = weather.get('density').toVar()
  const heightFraction = weather.get('heightFraction')

  const surfaceNormal = position.normalize()
  const localWeatherSpeed = parameters.localWeatherOffset.length()
  const evolution = surfaceNormal.negate().mul(localWeatherSpeed).mul(2e4)

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
    .add(evolution)
    .add(turbulence)
    .mul(parameters.shapeRepeat)
    .add(parameters.shapeOffset)
  const shape = (shapeTexture as Texture3DNode).sample(shapePosition).r
  density.assign(
    remapClamp(
      density,
      float(1).sub(shape).mul(layers.shapeAmounts),
      vec4(1)
    )
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
        density.assign(
          remapClamp(density.mul(2), modifier.mul(0.5), vec4(1))
        )
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
