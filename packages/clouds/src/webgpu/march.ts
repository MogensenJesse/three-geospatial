import { Vector2 } from 'three'
import {
  Break,
  exp,
  float,
  Fn,
  If,
  int,
  Loop,
  max,
  min,
  mix,
  positionGeometry,
  pow,
  remapClamp,
  screenCoordinate,
  struct,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { NodeBuilder } from 'three/webgpu'

import {
  getAtmosphereContext,
  getIndirectLuminanceToPoint,
  getSplitScalarIlluminance
} from '@takram/three-atmosphere/webgpu'
import {
  cameraNear,
  FnLayout,
  inverseProjectionMatrix,
  inverseViewMatrix,
  raySpheresIntersections,
  type Node
} from '@takram/three-geospatial/webgpu'

import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'
import {
  getGlobeUv,
  getMipLevel,
  insideLayerIntervals,
  sampleMedia,
  sampleWeather
} from './sampling'

const RECIPROCAL_PI4 = /*#__PURE__*/ float(1 / (4 * Math.PI))


export const marchResultStruct = /*#__PURE__*/ struct(
  {
    color: 'vec4',
    frontDepth: 'float'
  },
  'CloudsMarchResult'
)

export type MarchResultNode = ReturnType<typeof marchResultStruct>

/** March / lighting uniforms for the Phase B spike (reduced quality defaults). */
export class CloudsMarchParameters {
  readonly maxIterationCount = uniform(64).setName('maxIterationCount')
  readonly minStepSize = uniform(200).setName('minStepSize')
  readonly maxStepSize = uniform(2000).setName('maxStepSize')
  readonly maxRayDistance = uniform(5e4).setName('maxRayDistance')
  readonly perspectiveStepScale = uniform(1.02).setName('perspectiveStepScale')
  readonly minDensity = uniform(1e-4).setName('minDensity')
  readonly minExtinction = uniform(1e-4).setName('minExtinction')
  readonly minTransmittance = uniform(1e-1).setName('minTransmittance')

  readonly maxIterationCountToSun = uniform(0).setName(
    'maxIterationCountToSun'
  )
  readonly minSecondaryStepSize = uniform(100).setName('minSecondaryStepSize')
  readonly secondaryStepScale = uniform(2).setName('secondaryStepScale')

  readonly skyLightScale = uniform(1).setName('skyLightScale')
  readonly scatterAnisotropy1 = uniform(0.7).setName('scatterAnisotropy1')
  readonly scatterAnisotropy2 = uniform(-0.2).setName('scatterAnisotropy2')
  readonly scatterAnisotropyMix = uniform(0.5).setName('scatterAnisotropyMix')
  readonly multiScatteringOctaves = uniform(int(4)).setName(
    'multiScatteringOctaves'
  )

  readonly resolution = uniform(new Vector2(1, 1)).setName('cloudsResolution')
}

const henyeyGreenstein = /*#__PURE__*/ FnLayout({
  name: 'henyeyGreenstein',
  type: 'vec2',
  inputs: [
    { name: 'g', type: 'vec2' },
    { name: 'cosTheta', type: 'float' }
  ]
})(([g, cosTheta]) => {
  const g2 = g.mul(g)
  return float(1 / (4 * Math.PI)).mul(
    float(1)
      .sub(g2)
      .div(
        max(
          vec2(1e-7),
          pow(float(1).add(g2).sub(g.mul(2).mul(cosTheta)), vec2(1.5))
        )
      )
  )
})

const phaseFunction = /*#__PURE__*/ FnLayout({
  name: 'cloudsPhaseFunction',
  type: 'float',
  inputs: [
    { name: 'cosTheta', type: 'float' },
    { name: 'attenuation', type: 'float' },
    { name: 'g1', type: 'float' },
    { name: 'g2', type: 'float' },
    { name: 'mixWeight', type: 'float' }
  ]
})(([cosTheta, attenuation, g1, g2, mixWeight]) => {
  const g = vec2(g1, g2).mul(attenuation)
  const weights = vec2(float(1).sub(mixWeight), mixWeight)
  return henyeyGreenstein(g, cosTheta).dot(weights)
})

const approximateMultipleScattering = /*#__PURE__*/ FnLayout({
  name: 'approximateMultipleScattering',
  type: 'float',
  inputs: [
    { name: 'opticalDepth', type: 'float' },
    { name: 'cosTheta', type: 'float' },
    { name: 'g1', type: 'float' },
    { name: 'g2', type: 'float' },
    { name: 'mixWeight', type: 'float' },
    { name: 'octaveCount', type: 'int' }
  ]
})(([opticalDepth, cosTheta, g1, g2, mixWeight, octaveCount]) => {
  const coeffs = vec3(1).toVar()
  const attenuation = vec3(0.5, 0.5, 0.5)
  const scattering = float(0).toVar()
  Loop({ start: 0, end: 8 }, ({ i }) => {
    If(i.greaterThanEqual(octaveCount), () => {
      Break()
    })
    const beerLambert = exp(opticalDepth.negate().mul(coeffs.y))
    scattering.addAssign(
      coeffs.x.mul(beerLambert).mul(
        phaseFunction(cosTheta, coeffs.z, g1, g2, mixWeight)
      )
    )
    coeffs.mulAssign(attenuation)
  })
  return scattering
})

const hashJitter = /*#__PURE__*/ FnLayout({
  name: 'cloudsHashJitter',
  type: 'float',
  inputs: [{ name: 'seed', type: 'vec2' }]
})(([seed]) => {
  return seed.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract()
})

export interface MarchCloudsContext {
  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  march: CloudsMarchParameters
}

/**
 * Fullscreen clouds march (Phase B): no BSM, no TAAU, reduced secondary rays.
 */
export function setupCloudsMarchColor(
  builder: NodeBuilder,
  context: MarchCloudsContext
): Node<'vec4'> {
  const atmosphere = getAtmosphereContext(builder)
  const camera = atmosphere.camera ?? builder.camera
  if (camera == null) {
    return vec4(0)
  }

  const { parameters, layers, march } = context
  // Atmosphere LUT space uses km; cloud march uses meters (WebGL convention).
  const bottomRadiusMeters = float(atmosphere.parameters.bottomRadius)
  const { worldToUnit } = atmosphere.parametersNode

  const {
    sunDirectionECEF,
    cameraPositionECEF,
    altitudeCorrectionECEF,
    matrixWorldToECEF,
    cameraHeight
  } = atmosphere

  // Wrap If/Loop stack statements in Fn so they attach to the fragment output.
  // Assigning a bare stack graph to material.fragmentNode produces invalid WGSL
  // (vertex_RTT / fragment_RTT parse errors).
  return Fn(() => {
  const cameraPosition = cameraPositionECEF.add(altitudeCorrectionECEF).toVar()

  const positionView = inverseProjectionMatrix(camera)
    .mul(vec4(positionGeometry, 1))
    .xyz.toVar()
  const directionWorld = inverseViewMatrix(camera).mul(
    vec4(positionView, 0)
  ).xyz
  const rayDirection = matrixWorldToECEF
    .mul(vec4(directionWorld, 0))
    .xyz.normalize()
    .toVar()

  const cosTheta = sunDirectionECEF.dot(rayDirection).toVar()
  const heightAtCamera = cameraHeight.toVar()
  const nearPlane = cameraNear(camera)

  const radii = bottomRadiusMeters.add(
    vec4(0, layers.minHeight, layers.maxHeight, layers.shadowTopHeight)
  )
  const intersections = raySpheresIntersections(
    cameraPosition,
    rayDirection,
    vec3(0),
    radii
  ).toConst()
  const first = intersections.get('near')
  const second = intersections.get('far')

  // Ground hit when looking down at the ellipsoid.
  const r = cameraPosition.length()
  const mu = cameraPosition.dot(rayDirection).div(r)
  const intersectsGround = mu
    .lessThan(0)
    .and(
      r
        .mul(r)
        .mul(mu.mul(mu).sub(1))
        .add(bottomRadiusMeters.mul(bottomRadiusMeters))
        .greaterThanEqual(0)
    )
    .toVar()

  const rayNearFar = vec2(-1).toVar()
  If(heightAtCamera.lessThan(layers.minHeight), () => {
    If(intersectsGround, () => {
      rayNearFar.assign(vec2(-1))
    }).Else(() => {
      rayNearFar.assign(vec2(second.y, second.z))
    })
  })
    .ElseIf(heightAtCamera.lessThan(layers.maxHeight), () => {
      If(intersectsGround, () => {
        rayNearFar.assign(vec2(nearPlane, first.y))
      }).Else(() => {
        rayNearFar.assign(vec2(nearPlane, second.z))
      })
    })
    .Else(() => {
      rayNearFar.assign(vec2(first.z, second.z))
      If(intersectsGround, () => {
        rayNearFar.assign(vec2(rayNearFar.x, first.y))
      })
    })

  const invalidRay = rayNearFar
    .lessThan(vec2(0))
    .any()
    .or(rayNearFar.y.lessThan(rayNearFar.x))
    .toVar()

  const outputColor = vec4(0).toVar()

  If(invalidRay.not(), () => {
    const rayOrigin = rayNearFar.x.mul(rayDirection).add(cameraPosition).toVar()
    const jitter = hashJitter(screenCoordinate.xy)
    const globeUv = getGlobeUv(rayOrigin)
    const mipFromUv = getMipLevel(
      globeUv.mul(parameters.localWeatherRepeat),
      march.resolution
    )
    const mipLevel = mix(
      0,
      mipFromUv,
      min(1, heightAtCamera.mul(0.2).div(max(layers.maxHeight, 1e-3)))
    ).toVar()

    const radianceIntegral = vec3(0).toVar()
    const transmittanceIntegral = float(1).toVar()
    const weightedDistanceSum = float(0).toVar()
    const transmittanceSum = float(0).toVar()

    const maxRayDistance = min(
      rayNearFar.y.sub(rayNearFar.x),
      march.maxRayDistance
    ).toVar()
    const stepSize = march.minStepSize
      .add(march.perspectiveStepScale.sub(1).mul(rayNearFar.x))
      .toVar()
    const rayDistance = stepSize.mul(jitter).mul(2).toVar()
    const rayStartTexelsPerPixel = pow(2, mipLevel)

    Loop(
      { start: 0, end: 64, type: 'int', name: 'i', condition: '<' },
      ({ i }) => {
        If(i.greaterThanEqual(march.maxIterationCount), () => {
          Break()
        })
        If(rayDistance.greaterThan(maxRayDistance), () => {
          Break()
        })

        const position = rayDistance
          .mul(rayDirection)
          .add(rayOrigin)
          .toVar()
        const height = position.length().sub(bottomRadiusMeters).toVar()
        const sampleMip = max(
          float(1),
          rayStartTexelsPerPixel.add(rayDistance.mul(1e-5))
        )
          .log2()
          .toVar()

        If(insideLayerIntervals(height, layers.minIntervalHeights, layers.maxIntervalHeights), () => {
          // Empty gap between layers — take a longer step.
          stepSize.mulAssign(march.perspectiveStepScale)
          rayDistance.addAssign(
            mix(stepSize, march.maxStepSize, min(1, sampleMip))
          )
        }).Else(() => {
          const uv = getGlobeUv(position)
          const weather = sampleWeather(
            parameters,
            layers,
            uv,
            height,
            sampleMip
          )
          const weatherDensity = weather.get('density')

          If(weatherDensity.greaterThan(vec4(march.minDensity)).any().not(), () => {
            // Empty weather — longer step.
            stepSize.mulAssign(march.perspectiveStepScale)
            rayDistance.addAssign(
              mix(stepSize, march.maxStepSize, min(1, sampleMip))
            )
          }).Else(() => {
            const media = sampleMedia(
              parameters,
              layers,
              weather,
              position,
              uv,
              sampleMip,
              jitter,
              {
                // Phase B spike: keep detail/turbulence off for perf unless wired.
                forceDisableShapeDetail: true,
                forceDisableTurbulence: true
              }
            )

            If(media.get('extinction').greaterThan(march.minExtinction), () => {
              const positionUnit = position.mul(worldToUnit).toVar()
              const split = getSplitScalarIlluminance(
                positionUnit,
                sunDirectionECEF
              ).toConst()
              const sunIrradiance = split.get('direct')
              const skyIrradiance = split.get('indirect')

              // Phase B: no secondary sun march / BSM. Nested Loops must use
              // distinct WGSL index names (reusing `i` fails shader parse).
              const opticalDepth = float(0)

              const radiance = sunIrradiance
                .mul(
                  approximateMultipleScattering(
                    opticalDepth,
                    cosTheta,
                    march.scatterAnisotropy1,
                    march.scatterAnisotropy2,
                    march.scatterAnisotropyMix,
                    march.multiScatteringOctaves
                  )
                )
                .toVar()

              const skyGradient = weather
                .get('heightFraction')
                .mul(0.5)
                .add(0.5)
                .dot(media.get('weight'))
              radiance.addAssign(
                skyIrradiance
                  .mul(RECIPROCAL_PI4)
                  .mul(skyGradient)
                  .mul(march.skyLightScale)
              )
              radiance.mulAssign(media.get('scattering'))

              const transmittance = exp(
                media.get('extinction').negate().mul(stepSize)
              )
              const clampedExtinction = max(media.get('extinction'), 1e-7)
              const scatteringIntegral = radiance
                .sub(radiance.mul(transmittance))
                .div(clampedExtinction)
              radianceIntegral.addAssign(
                transmittanceIntegral.mul(scatteringIntegral)
              )
              transmittanceIntegral.mulAssign(transmittance)

              weightedDistanceSum.addAssign(
                rayDistance.mul(transmittanceIntegral)
              )
              transmittanceSum.addAssign(transmittanceIntegral)
            })

            If(transmittanceIntegral.lessThanEqual(march.minTransmittance), () => {
              Break()
            })

            stepSize.mulAssign(march.perspectiveStepScale)
            rayDistance.addAssign(stepSize)
          })
        })
      }
    )

    const opacity = remapClamp(
      transmittanceIntegral,
      1,
      march.minTransmittance
    )
    const color = vec4(radianceIntegral, opacity).toVar()

    // Aerial perspective along the mean cloud depth.
    If(transmittanceSum.greaterThan(0).and(opacity.greaterThan(0)), () => {
      const frontDepth = weightedDistanceSum.div(transmittanceSum)
      const frontPosition = rayNearFar.x
        .add(frontDepth)
        .mul(rayDirection)
        .add(cameraPosition)
      const transfer = getIndirectLuminanceToPoint(
        cameraPosition.mul(worldToUnit),
        frontPosition.mul(worldToUnit),
        0,
        sunDirectionECEF
      ).toConst()
      color.rgb.assign(
        color.rgb
          .mul(transfer.get('transmittance'))
          .add(transfer.get('luminance').mul(color.a))
      )
    })

    outputColor.assign(color)
  })

  return outputColor
  })()
}
