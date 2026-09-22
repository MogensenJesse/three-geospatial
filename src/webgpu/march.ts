// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
// src/webgpu/march.ts

import { Matrix4, Vector2 } from 'three'
import {
  Break,
  dot,
  exp,
  Fn,
  float,
  fract,
  If,
  int,
  interleavedGradientNoise,
  Loop,
  logarithmicDepthToViewZ,
  max,
  min,
  mix,
  perspectiveDepthToViewZ,
  positionGeometry,
  pow,
  remapClamp,
  screenCoordinate,
  screenUV,
  sin,
  struct,
  textureSize,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { NodeBuilder, TextureNode } from 'three/webgpu'

import { qualityPresets } from '../qualityPresets'
import type { CloudsEnvironment } from './CloudsEnvironment'
import { marchCloudOpticalDepth } from './cloudOpticalDepth'
import {
  type CloudsMarchVariant,
  resolveCloudsMarchVariant
} from './cloudsMarchVariant'
import { inverseViewMatrix, viewMatrix } from './internal/accessors'
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
import { raySlabIntersection, sampleShadowOpticalDepth } from './shadowSampling'

const RECIPROCAL_PI4 = /*#__PURE__*/ float(1 / (4 * Math.PI))

/** High-preset march defaults so a standalone node matches CloudsNode. */
const highClouds = qualityPresets.high.clouds

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
  readonly maxIterationCount = uniform(highClouds.maxIterationCount).setName(
    'maxIterationCount'
  )
  readonly minStepSize = uniform(highClouds.minStepSize).setName('minStepSize')
  readonly maxStepSize = uniform(highClouds.maxStepSize).setName('maxStepSize')
  readonly maxRayDistance = uniform(highClouds.maxRayDistance).setName(
    'maxRayDistance'
  )
  readonly cameraNear = uniform(1).setName('cloudsCameraNear')
  readonly cameraFar = uniform(1e8).setName('cloudsCameraFar')
  readonly temporalJitter = uniform(new Vector2()).setName(
    'cloudsTemporalJitter'
  )
  readonly targetUvScale = uniform(new Vector2(1, 1)).setName(
    'cloudsTargetUvScale'
  )
  readonly mipLevelScale = uniform(1).setName('cloudsMipLevelScale')
  /** Jittered inverse projection (WebGL CloudsMaterial parity). */
  readonly inverseProjectionMatrix = uniform(new Matrix4()).setName(
    'cloudsInverseProjectionMatrix'
  )
  readonly reprojectionMatrix = uniform(new Matrix4()).setName(
    'cloudsReprojectionMatrix'
  )
  readonly viewReprojectionMatrix = uniform(new Matrix4()).setName(
    'cloudsViewReprojectionMatrix'
  )
  /**
   * -1 normal lighting, -3 local optical depth, -4 BSM optical depth,
   * -5 unshadowed lighting; non-negative forces optical depth.
   */
  readonly shadowDebugOpticalDepth = uniform(-1).setName(
    'shadowDebugOpticalDepth'
  )
  readonly perspectiveStepScale = uniform(
    highClouds.perspectiveStepScale
  ).setName('perspectiveStepScale')
  readonly minDensity = uniform(highClouds.minDensity).setName('minDensity')
  readonly minExtinction = uniform(highClouds.minExtinction).setName(
    'minExtinction'
  )
  readonly minTransmittance = uniform(highClouds.minTransmittance).setName(
    'minTransmittance'
  )

  readonly maxIterationCountToSun = uniform(
    highClouds.secondaryIterationCount
  ).setName('maxIterationCountToSun')
  readonly minSecondaryStepSize = uniform(
    highClouds.minSecondaryStepSize
  ).setName('minSecondaryStepSize')
  readonly secondaryStepScale = uniform(highClouds.secondaryStepScale).setName(
    'secondaryStepScale'
  )

  readonly skyLightScale = uniform(1).setName('skyLightScale')
  readonly scatterAnisotropy1 = uniform(0.7).setName('scatterAnisotropy1')
  readonly scatterAnisotropy2 = uniform(-0.2).setName('scatterAnisotropy2')
  readonly scatterAnisotropyMix = uniform(0.5).setName('scatterAnisotropyMix')
  readonly multiScatteringOctaves = uniform(
    highClouds.multiScatteringOctaves,
    'int'
  ).setName('multiScatteringOctaves')

  readonly maxIterationCountToGround = uniform(
    highClouds.groundIterationCount
  ).setName('maxIterationCountToGround')
  readonly powderScale = uniform(highClouds.powderScale).setName('powderScale')
  readonly powderExponent = uniform(highClouds.powderExponent).setName(
    'powderExponent'
  )
  readonly groundBounceScale = uniform(highClouds.groundBounceScale).setName(
    'groundBounceScale'
  )
  /** 0 = approximate dual-lobe, 1 = accurate (Draine + HG mix). */
  readonly phaseFunctionMode = uniform(
    highClouds.phaseFunctionMode === 'accurate' ? 1 : 0,
    'int'
  ).setName('phaseFunctionMode')

  readonly resolution = uniform(new Vector2(1, 1)).setName('cloudsResolution')
  /** STBN time-slice index, 0..63. Not the Bayer/TAAU phase. */
  readonly frame = uniform(0, 'int').setName('cloudsFrame')
  /** 1 = STBN/hash ray-start jitter live; 0 freezes jitter at 0 (debug stills). */
  readonly stepJitterScale = uniform(1).setName('cloudsStepJitterScale')
  /** <1 densifies steps when TAAU is off (thin high-layer onion-skin). */
  readonly stepSizeScale = uniform(1).setName('cloudsStepSizeScale')
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

const drainePhase = /*#__PURE__*/ FnLayout({
  name: 'cloudsDrainePhase',
  type: 'float',
  inputs: [
    { name: 'u', type: 'float' },
    { name: 'g', type: 'float' },
    { name: 'a', type: 'float' }
  ]
})(([u, g, a]) => {
  const g2 = g.mul(g)
  return float(1)
    .sub(g2)
    .mul(float(1).add(a.mul(u).mul(u)))
    .div(
      float(4)
        .mul(float(1).add(a.mul(float(1).add(g2.mul(2))).div(3)))
        .mul(Math.PI)
        .mul(pow(float(1).add(g2).sub(g.mul(2).mul(u)), 1.5))
    )
})

/** Accurate fit for large particles (d=10): NVIDIA approximate Mie. */
const phaseAccurate = (
  cosTheta: Node<'float'>,
  attenuation: Node<'float'>
): Node<'float'> => {
  const gHG = float(0.988176691700256)
  const gD = float(0.5556712547839497)
  const alpha = float(21.995520856274638)
  const accurateWeight = float(0.4819554318404214)
  return mix(
    henyeyGreenstein(vec2(gHG).mul(attenuation), cosTheta).x,
    drainePhase(cosTheta, gD.mul(attenuation), alpha),
    accurateWeight
  )
}

/** Phase / MS specialized at build time via {@link CloudsMarchVariant}. */
const phaseApproximate = (
  cosTheta: Node<'float'>,
  attenuation: Node<'float'>,
  g1: Node<'float'>,
  g2: Node<'float'>,
  mixWeight: Node<'float'>
): Node<'float'> => {
  const g = vec2(g1, g2).mul(attenuation)
  const weights = vec2(float(1).sub(mixWeight), mixWeight)
  return henyeyGreenstein(g, cosTheta).dot(weights)
}

const phaseForVariant = (
  cosTheta: Node<'float'>,
  attenuation: Node<'float'>,
  g1: Node<'float'>,
  g2: Node<'float'>,
  mixWeight: Node<'float'>,
  variant: CloudsMarchVariant
): Node<'float'> => {
  if (variant.phaseAccurate) {
    return phaseAccurate(cosTheta, attenuation)
  }
  return phaseApproximate(cosTheta, attenuation, g1, g2, mixWeight)
}

const approximateMultipleScattering = (
  opticalDepth: Node<'float'>,
  cosTheta: Node<'float'>,
  g1: Node<'float'>,
  g2: Node<'float'>,
  mixWeight: Node<'float'>,
  variant: CloudsMarchVariant
): Node<'float'> => {
  const coefficients = vec3(1).toVar()
  const scattering = float(0).toVar()
  // Exact trip count — no Loop(8)+Break(octave) dead iterations.
  Loop(
    { start: 0, end: variant.multiScatteringOctaves, type: 'int', name: 'i' },
    () => {
      scattering.addAssign(
        coefficients.x
          .mul(exp(opticalDepth.negate().mul(coefficients.y)))
          .mul(
            phaseForVariant(
              cosTheta,
              coefficients.z,
              g1,
              g2,
              mixWeight,
              variant
            )
          )
      )
      coefficients.mulAssign(0.5)
    }
  )
  return scattering
}

export interface MarchCloudsContext {
  environment: CloudsEnvironment
  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  march: CloudsMarchParameters
  shadow?: ShadowParameterNodes | null
  shadowAtlas?: TextureNode | null
  depthNode?: TextureNode | null
}

/** Fullscreen flat-slab cloud march with BSM lighting and temporal velocity. */
export function setupCloudsMarch(
  builder: NodeBuilder,
  context: MarchCloudsContext
): MarchResultNode {
  const { environment, parameters, layers, march } = context
  const camera = environment.camera
  const variant = resolveCloudsMarchVariant(march, context.shadowAtlas)

  return Fn(() => {
    // WebGL clouds.vert: viewPosition = inverseProjectionMatrix * vec4(position,1)
    // with Bayer-jittered projection inverted on the CPU.
    const clipPosition = vec4(positionGeometry.xy, positionGeometry.z, 1)
    const positionView = march.inverseProjectionMatrix
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
      // Horizontal rays stay in the branch above: raySlabIntersection returns
      // vec2(-1) for them, which would drop a camera already inside the slab.
      const hits = raySlabIntersection(
        cameraPosition,
        rayDirection,
        bottomY,
        topY
      )
      rayNearFar.assign(vec2(max(nearPlane, hits.x), hits.y))
    })

    const sceneViewZ = float(0).toVar()
    if (context.depthNode != null) {
      const depth = context.depthNode
        .sample(screenUV.mul(march.targetUvScale).add(march.temporalJitter))
        .r.toVar()
      If(depth.lessThan(1 - 1e-7), () => {
        sceneViewZ.assign(
          builder.renderer.logarithmicDepthBuffer
            ? logarithmicDepthToViewZ(depth, march.cameraNear, march.cameraFar)
            : perspectiveDepthToViewZ(depth, march.cameraNear, march.cameraFar)
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
      // Ray-start jitter: screen STBN/IGN in *march-pixel* space (WebGL
      // getSTBN / gl_FragCoord parity). Do not scale by TAAU factor — that
      // beats Bayer 4x4 and causes diagonal stripes.
      const jitter = float(0).toVar()
      if (parameters.stbnTexture != null) {
        const stbn = parameters.stbnTexture
        // TSL textureSize() on 3D textures emits vec2 + pad Z=0 — broken WGSL.
        // Match takram stbn.bin (128x128x64); keep in sync with demo loader.
        const stbnSize = vec3(128, 128, 64)
        const scale = vec3(1).div(stbnSize)
        const layer = float(march.frame.mod(int(64)))
        jitter.assign(
          stbn.sample(vec3(screenCoordinate.xy, layer).mul(scale)).r
        )
      } else {
        jitter.assign(
          interleavedGradientNoise(
            screenCoordinate.xy.add(march.temporalJitter.mul(march.resolution))
          )
        )
      }
      // Debug: stepJitterScale=0 freezes ray-start (no STBN stipple in stills).
      jitter.mulAssign(march.stepJitterScale)
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
        .mul(march.stepSizeScale)
        .toVar()
      const rayDistance = stepSize.mul(jitter).mul(2).toVar()
      const rayStartTexelsPerPixel = pow(2, mipLevel)

      Loop(
        { start: 0, end: 512, type: 'int', name: 'i', condition: '<' },
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
          const maxStepWorld = march.maxStepSize
            .mul(worldScale)
            .mul(march.stepSizeScale)

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
                  // Local sun-detail march; BSM fills the remainder.
                  const localOpticalDepth = float(0).toVar()
                  const sunRayDistance = float(0).toVar()
                  const shadowAtlas = context.shadowAtlas
                  // Omit the local-sun optical-depth march when secondary iterations are 0.
                  if (variant.localSun) {
                    const sunMarch = marchCloudOpticalDepth(
                      { environment, parameters, layers, march },
                      positionWorld,
                      sunDirection,
                      sampleMip,
                      jitter,
                      int(march.maxIterationCountToSun)
                    )
                    localOpticalDepth.assign(sunMarch.get('opticalDepth'))
                    sunRayDistance.assign(sunMarch.get('rayDistance'))
                  }
                  const bsmOpticalDepth = float(0).toVar()
                  // BSM + Vogel only in the shadows-on material variant.
                  if (
                    variant.shadows &&
                    context.shadow != null &&
                    shadowAtlas != null
                  ) {
                    If(height.lessThan(layers.shadowTopHeight), () => {
                      const sampled = sampleShadowOpticalDepth(
                        {
                          environment,
                          layers,
                          shadow: context.shadow!,
                          shadowAtlas,
                          viewMatrix: viewMatrix(camera)
                        },
                        positionWorld,
                        sunRayDistance,
                        jitter
                      )
                      If(
                        march.shadowDebugOpticalDepth.greaterThanEqual(0),
                        () => {
                          bsmOpticalDepth.assign(march.shadowDebugOpticalDepth)
                        }
                      ).Else(() => {
                        bsmOpticalDepth.assign(sampled)
                      })
                    })
                  }

                  const opticalDepth = localOpticalDepth
                    .add(bsmOpticalDepth)
                    .toVar()
                  If(march.shadowDebugOpticalDepth.equal(-3), () => {
                    opticalDepth.assign(localOpticalDepth)
                  }).Else(() => {
                    If(march.shadowDebugOpticalDepth.equal(-4), () => {
                      opticalDepth.assign(bsmOpticalDepth)
                    })
                  })

                  const direct = environment.sunIrradianceNode.mul(
                    approximateMultipleScattering(
                      opticalDepth,
                      cosTheta,
                      march.scatterAnisotropy1,
                      march.scatterAnisotropy2,
                      march.scatterAnisotropyMix,
                      variant
                    )
                  )
                  const radiance = direct.toVar()

                  // Ground-bounce optical depth omitted when scale or iterations are 0.
                  if (variant.groundBounce) {
                    If(
                      height
                        .lessThan(layers.shadowTopHeight)
                        .and(sampleMip.lessThan(0.5)),
                      () => {
                        const downDirection = vec3(0, -1, 0)
                        const groundMarch = marchCloudOpticalDepth(
                          { environment, parameters, layers, march },
                          positionWorld,
                          downDirection,
                          sampleMip,
                          jitter,
                          int(march.maxIterationCountToGround)
                        )
                        const groundIrradiance = environment.skyIrradianceNode
                          .add(
                            environment.sunIrradianceNode.mul(
                              float(1).sub(parameters.coverage)
                            )
                          )
                          .toVar()
                        const bounced = environment.groundAlbedoNode
                          .mul(1 / Math.PI)
                          .mul(groundIrradiance)
                          .mul(exp(groundMarch.get('opticalDepth').negate()))
                        radiance.addAssign(
                          bounced
                            .mul(RECIPROCAL_PI4)
                            .mul(march.groundBounceScale)
                        )
                      }
                    )
                  }

                  const skyGradient = weather
                    .get('heightFraction')
                    .mul(0.5)
                    .add(0.5)
                    .dot(media.get('weight'))
                  radiance.addAssign(
                    environment.skyIrradianceNode
                      .mul(RECIPROCAL_PI4)
                      .mul(skyGradient)
                      .mul(march.skyLightScale)
                  )

                  If(march.shadowDebugOpticalDepth.equal(-5), () => {
                    radiance.assign(
                      environment.sunIrradianceNode.mul(
                        approximateMultipleScattering(
                          float(0),
                          cosTheta,
                          march.scatterAnisotropy1,
                          march.scatterAnisotropy2,
                          march.scatterAnisotropyMix,
                          variant
                        )
                      )
                    )
                  })
                  radiance.mulAssign(media.get('scattering'))

                  // Powder omitted when scale is 0.
                  if (variant.powder) {
                    radiance.mulAssign(
                      float(1).sub(
                        march.powderScale.mul(
                          exp(
                            media
                              .get('extinction')
                              .negate()
                              .mul(march.powderExponent)
                          )
                        )
                      )
                    )
                  }

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

    // NDC Y+ is up; WebGPU screenUV Y+ is down (top-left). Flip Y for prevUv.
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
    // a=1 required: MRT packs vec4; a=0 under material blending can zero RGB.
    const velocity = screenUV.sub(prevUv)
    const depthVelocity = vec4(frontDepth, velocity, 1)
    return marchResultStruct(outputColor, frontDepth, depthVelocity)
  })() as MarchResultNode
}
