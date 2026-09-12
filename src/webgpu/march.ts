// src/webgpu/march.ts

import { Matrix4, Vector2 } from 'three'
import {
  Break,
  exp,
  float,
  Fn,
  If,
  Loop,
  max,
  min,
  mix,
  positionGeometry,
  pow,
  remapClamp,
  screenCoordinate,
  screenUV,
  struct,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { NodeBuilder, TextureNode } from 'three/webgpu'

import type { CloudsEnvironment } from './CloudsEnvironment'
import {
  inverseProjectionMatrix,
  inverseViewMatrix,
  viewMatrix
} from './internal/accessors'
import { depthToViewZ } from './internal/depth'
import { FnLayout } from './internal/FnLayout'
import type { Node } from './internal/node'
import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'
import {
  getEnvironmentPositionMeters,
  getEnvironmentUv,
  getMipLevel,
  insideLayerIntervals,
  sampleMedia,
  sampleWeather
} from './sampling'
import type { ShadowParameterNodes } from './shadowParameters'
import { sampleShadowOpticalDepth } from './shadowSampling'

const RECIPROCAL_PI4 = /*#__PURE__*/ float(1 / (4 * Math.PI))

export const marchResultStruct = /*#__PURE__*/ struct(
  {
    color: 'vec4',
    frontDepth: 'float',
    depthVelocity: 'vec4'
  },
  'CloudsMarchResult'
)

export type MarchResultNode = ReturnType<typeof marchResultStruct>

/** Meter-based cloud marching and host-lighting controls. */
export class CloudsMarchParameters {
  readonly maxIterationCount = uniform(64).setName('maxIterationCount')
  readonly minStepSize = uniform(200).setName('minStepSize')
  readonly maxStepSize = uniform(2000).setName('maxStepSize')
  readonly maxRayDistance = uniform(5e4).setName('maxRayDistance')
  readonly cameraNear = uniform(1).setName('cloudsCameraNear')
  readonly cameraFar = uniform(1e8).setName('cloudsCameraFar')
  readonly temporalJitter = uniform(new Vector2()).setName(
    'cloudsTemporalJitter'
  )
  readonly targetUvScale = uniform(new Vector2(1, 1)).setName(
    'cloudsTargetUvScale'
  )
  readonly mipLevelScale = uniform(1).setName('cloudsMipLevelScale')
  readonly reprojectionMatrix = uniform(new Matrix4()).setName(
    'cloudsReprojectionMatrix'
  )
  readonly viewReprojectionMatrix = uniform(new Matrix4()).setName(
    'cloudsViewReprojectionMatrix'
  )
  /** -1 uses BSM, -2 visualizes depth; non-negative forces optical depth. */
  readonly shadowDebugOpticalDepth = uniform(-1).setName(
    'shadowDebugOpticalDepth'
  )
  readonly perspectiveStepScale = uniform(1.02).setName('perspectiveStepScale')
  readonly minDensity = uniform(1e-4).setName('minDensity')
  readonly minExtinction = uniform(1e-4).setName('minExtinction')
  readonly minTransmittance = uniform(1e-1).setName('minTransmittance')

  readonly maxIterationCountToSun = uniform(0).setName('maxIterationCountToSun')
  readonly minSecondaryStepSize = uniform(100).setName('minSecondaryStepSize')
  readonly secondaryStepScale = uniform(2).setName('secondaryStepScale')

  readonly skyLightScale = uniform(1).setName('skyLightScale')
  readonly scatterAnisotropy1 = uniform(0.7).setName('scatterAnisotropy1')
  readonly scatterAnisotropy2 = uniform(-0.2).setName('scatterAnisotropy2')
  readonly scatterAnisotropyMix = uniform(0.5).setName('scatterAnisotropyMix')
  readonly multiScatteringOctaves = uniform(4, 'int').setName(
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
  const coefficients = vec3(1).toVar()
  const scattering = float(0).toVar()
  Loop({ start: 0, end: 8 }, ({ i }) => {
    If(i.greaterThanEqual(octaveCount), () => {
      Break()
    })
    scattering.addAssign(
      coefficients.x
        .mul(exp(opticalDepth.negate().mul(coefficients.y)))
        .mul(phaseFunction(cosTheta, coefficients.z, g1, g2, mixWeight))
    )
    coefficients.mulAssign(0.5)
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
  environment: CloudsEnvironment
  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  march: CloudsMarchParameters
  shadow?: ShadowParameterNodes | null
  shadowBuffers?: readonly TextureNode[] | null
  depthNode?: TextureNode | null
}

/** Fullscreen flat-slab cloud march with BSM lighting and temporal velocity. */
export function setupCloudsMarch(
  builder: NodeBuilder,
  context: MarchCloudsContext
): MarchResultNode {
  const { environment, parameters, layers, march } = context
  const camera = environment.camera

  return Fn(() => {
    const clipPosition = vec4(
      positionGeometry.xy.add(
        vec2(march.temporalJitter.x, march.temporalJitter.y.negate()).mul(2)
      ),
      positionGeometry.z,
      1
    )
    const positionView = inverseProjectionMatrix(camera)
      .mul(clipPosition)
      .xyz.toVar()
    const rayDirection = inverseViewMatrix(camera)
      .mul(vec4(positionView, 0))
      .xyz.normalize()
      .toVar()
    const cameraPosition = inverseViewMatrix(camera)
      .mul(vec4(0, 0, 0, 1))
      .xyz.toVar()
    const cameraDirection = inverseViewMatrix(camera)
      .mul(vec4(0, 0, -1, 0))
      .xyz.normalize()
    const sunDirection = environment.sunDirectionNode.normalize().toVar()
    const cosTheta = sunDirection.dot(rayDirection).toVar()
    const worldScale = environment.worldUnitsPerMeterNode

    const bottomY = environment.mapOriginNode.y.add(
      layers.minHeight.mul(worldScale)
    )
    const topY = environment.mapOriginNode.y.add(
      layers.maxHeight.mul(worldScale)
    )
    const cameraHeight = cameraPosition.y
      .sub(environment.mapOriginNode.y)
      .div(worldScale)
    const nearPlane = march.cameraNear
    const rayNearFar = vec2(-1).toVar()

    If(rayDirection.y.abs().lessThan(1e-6), () => {
      If(
        cameraPosition.y
          .greaterThanEqual(bottomY)
          .and(cameraPosition.y.lessThanEqual(topY)),
        () => {
          rayNearFar.assign(
            vec2(nearPlane, nearPlane.add(march.maxRayDistance.mul(worldScale)))
          )
        }
      )
    }).Else(() => {
      const t0 = bottomY.sub(cameraPosition.y).div(rayDirection.y)
      const t1 = topY.sub(cameraPosition.y).div(rayDirection.y)
      rayNearFar.assign(vec2(max(nearPlane, min(t0, t1)), max(t0, t1)))
    })

    const sceneViewZ = float(0).toVar()
    if (context.depthNode != null) {
      const depth = context.depthNode
        .sample(screenUV.mul(march.targetUvScale).add(march.temporalJitter))
        .r.toVar()
      If(depth.lessThan(1 - 1e-7), () => {
        sceneViewZ.assign(
          depthToViewZ(depth, march.cameraNear, march.cameraFar, {
            perspective: true,
            logarithmic: builder.renderer.logarithmicDepthBuffer
          })
        )
        const rayDistanceToScene = sceneViewZ
          .negate()
          .div(rayDirection.dot(cameraDirection))
        If(rayDistanceToScene.greaterThan(0), () => {
          rayNearFar.y.assign(min(rayNearFar.y, rayDistanceToScene))
        })
      })
    }

    const invalidRay = rayNearFar
      .lessThan(vec2(0))
      .any()
      .or(rayNearFar.y.lessThan(rayNearFar.x))
      .toVar()
    const outputColor = vec4(0).toVar()
    const frontDepth = sceneViewZ
      .lessThan(0)
      .select(sceneViewZ.negate(), march.cameraFar)
      .toVar()
    const hitClouds = float(0).toVar()

    If(invalidRay.not(), () => {
      const rayOrigin = rayNearFar.x
        .mul(rayDirection)
        .add(cameraPosition)
        .toVar()
      const jitter = hashJitter(screenCoordinate.xy)
      const startUv = getEnvironmentUv(environment, rayOrigin)
      const mipFromUv = getMipLevel(
        startUv.mul(parameters.localWeatherRepeat),
        march.resolution
      )
      const mipLevel = mix(
        0,
        mipFromUv,
        min(1, cameraHeight.abs().mul(0.2).div(max(layers.maxHeight, 1e-3)))
      )
        .mul(march.mipLevelScale)
        .toVar()

      const radianceIntegral = vec3(0).toVar()
      const transmittanceIntegral = float(1).toVar()
      const weightedDistanceSum = float(0).toVar()
      const transmittanceSum = float(0).toVar()
      const maxRayDistance = min(
        rayNearFar.y.sub(rayNearFar.x),
        march.maxRayDistance.mul(worldScale)
      ).toVar()
      const stepSize = march.minStepSize
        .mul(worldScale)
        .add(march.perspectiveStepScale.sub(1).mul(rayNearFar.x))
        .toVar()
      const rayDistance = stepSize.mul(jitter).mul(2).toVar()
      const rayStartTexelsPerPixel = pow(2, mipLevel)

      Loop(
        { start: 0, end: 256, type: 'int', name: 'i', condition: '<' },
        ({ i }) => {
          If(
            i
              .greaterThanEqual(march.maxIterationCount)
              .or(rayDistance.greaterThan(maxRayDistance)),
            () => {
              Break()
            }
          )

          const positionWorld = rayDistance
            .mul(rayDirection)
            .add(rayOrigin)
            .toVar()
          const positionMeters = getEnvironmentPositionMeters(
            environment,
            positionWorld
          ).toVar()
          const height = positionMeters.y
          const sampleMip = max(
            float(1),
            rayStartTexelsPerPixel.add(rayDistance.div(worldScale).mul(1e-5))
          )
            .log2()
            .toVar()
          const maxStepWorld = march.maxStepSize.mul(worldScale)

          If(
            insideLayerIntervals(
              height,
              layers.minIntervalHeights,
              layers.maxIntervalHeights
            ),
            () => {
              stepSize.mulAssign(march.perspectiveStepScale)
              rayDistance.addAssign(
                mix(stepSize, maxStepWorld, min(1, sampleMip))
              )
            }
          ).Else(() => {
            const uv = getEnvironmentUv(environment, positionWorld)
            const weather = sampleWeather(
              parameters,
              layers,
              uv,
              height,
              sampleMip
            )

            If(
              weather
                .get('density')
                .greaterThan(vec4(march.minDensity))
                .any()
                .not(),
              () => {
                stepSize.mulAssign(march.perspectiveStepScale)
                rayDistance.addAssign(
                  mix(stepSize, maxStepWorld, min(1, sampleMip))
                )
              }
            ).Else(() => {
              const media = sampleMedia(
                parameters,
                layers,
                weather,
                positionMeters,
                uv,
                sampleMip,
                jitter
              )

              If(
                media.get('extinction').greaterThan(march.minExtinction),
                () => {
                  const opticalDepth = float(0).toVar()
                  const shadowBuffers = context.shadowBuffers
                  if (context.shadow != null && shadowBuffers != null) {
                    If(height.lessThan(layers.shadowTopHeight), () => {
                      const sampled = context.shadow!.enabled.mul(
                        sampleShadowOpticalDepth(
                          {
                            environment,
                            layers,
                            shadow: context.shadow!,
                            shadowTextures: shadowBuffers,
                            debugMode: march.shadowDebugOpticalDepth,
                            viewMatrix: viewMatrix(camera)
                          },
                          positionWorld,
                          float(0),
                          jitter
                        )
                      )
                      opticalDepth.assign(
                        march.shadowDebugOpticalDepth
                          .greaterThanEqual(0)
                          .select(march.shadowDebugOpticalDepth, sampled)
                      )
                    })
                  }

                  const direct = environment.sunIrradianceNode.mul(
                    approximateMultipleScattering(
                      opticalDepth,
                      cosTheta,
                      march.scatterAnisotropy1,
                      march.scatterAnisotropy2,
                      march.scatterAnisotropyMix,
                      march.multiScatteringOctaves
                    )
                  )
                  const skyGradient = weather
                    .get('heightFraction')
                    .mul(0.5)
                    .add(0.5)
                    .dot(media.get('weight'))
                  const radiance = direct
                    .add(
                      environment.skyIrradianceNode
                        .mul(RECIPROCAL_PI4)
                        .mul(skyGradient)
                        .mul(march.skyLightScale)
                    )
                    .toVar()

                  If(march.shadowDebugOpticalDepth.equal(-2), () => {
                    radiance.assign(vec3(opticalDepth))
                  })
                    .ElseIf(march.shadowDebugOpticalDepth.equal(-5), () => {
                      radiance.assign(
                        environment.sunIrradianceNode.mul(
                          approximateMultipleScattering(
                            float(0),
                            cosTheta,
                            march.scatterAnisotropy1,
                            march.scatterAnisotropy2,
                            march.scatterAnisotropyMix,
                            march.multiScatteringOctaves
                          )
                        )
                      )
                    })
                    .ElseIf(march.shadowDebugOpticalDepth.equal(-6), () => {
                      radiance.assign(vec3(opticalDepth.negate().exp()))
                    })
                    .ElseIf(
                      march.shadowDebugOpticalDepth.lessThanEqual(-11),
                      () => {
                        radiance.assign(vec3(opticalDepth))
                      }
                    )
                  radiance.mulAssign(media.get('scattering'))

                  const stepMeters = stepSize.div(worldScale)
                  const transmittance = exp(
                    media.get('extinction').negate().mul(stepMeters)
                  )
                  const scatteringIntegral = radiance
                    .sub(radiance.mul(transmittance))
                    .div(max(media.get('extinction'), 1e-7))
                  radianceIntegral.addAssign(
                    transmittanceIntegral.mul(scatteringIntegral)
                  )
                  transmittanceIntegral.mulAssign(transmittance)
                  weightedDistanceSum.addAssign(
                    rayDistance.mul(transmittanceIntegral)
                  )
                  transmittanceSum.addAssign(transmittanceIntegral)
                }
              )

              If(
                transmittanceIntegral.lessThanEqual(march.minTransmittance),
                () => {
                  Break()
                }
              )
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
      If(transmittanceSum.greaterThan(0).and(opacity.greaterThan(0)), () => {
        frontDepth.assign(
          rayNearFar.x.add(weightedDistanceSum.div(transmittanceSum))
        )
        hitClouds.assign(1)
      })
      outputColor.assign(color)
    })

    const prevUv = vec2(0).toVar()
    If(hitClouds.greaterThan(0), () => {
      const frontPositionWorld = frontDepth
        .mul(rayDirection)
        .add(cameraPosition)
      const prevClip = march.reprojectionMatrix.mul(vec4(frontPositionWorld, 1))
      const prevNdc = prevClip.xy.div(prevClip.w)
      prevUv.assign(vec2(prevNdc.x, prevNdc.y.negate()).mul(0.5).add(0.5))
    }).Else(() => {
      const frontView = positionView.mul(frontDepth)
      const prevClip = march.viewReprojectionMatrix.mul(vec4(frontView, 1))
      const prevNdc = prevClip.xy.div(prevClip.w)
      prevUv.assign(vec2(prevNdc.x, prevNdc.y.negate()).mul(0.5).add(0.5))
    })
    const depthVelocity = vec4(frontDepth, screenUV.sub(prevUv), 0)
    return marchResultStruct(outputColor, frontDepth, depthVelocity)
  })() as MarchResultNode
}

/** @deprecated Use {@link setupCloudsMarch}. */
export function setupCloudsMarchColor(
  builder: NodeBuilder,
  context: MarchCloudsContext
): Node<'vec4'> {
  return setupCloudsMarch(builder, context).get('color')
}
