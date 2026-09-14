// src/webgpu/march.ts

import { Matrix4, Vector2 } from 'three'
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
  interleavedGradientNoise,
  screenCoordinate,
  screenUV,
  struct,
  textureSize,
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
import { marchCloudOpticalDepth } from './cloudOpticalDepth'
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

  readonly maxIterationCountToGround = uniform(0).setName(
    'maxIterationCountToGround'
  )
  readonly powderScale = uniform(0.8).setName('powderScale')
  readonly powderExponent = uniform(150).setName('powderExponent')
  readonly groundBounceScale = uniform(1).setName('groundBounceScale')
  /** 0 = approximate dual-lobe, 1 = accurate (Draine + HG mix). */
  readonly phaseFunctionMode = uniform(0, 'int').setName('phaseFunctionMode')

  readonly resolution = uniform(new Vector2(1, 1)).setName('cloudsResolution')
  /** Host frame index for optional STBN jitter. */
  readonly frame = uniform(0, 'int').setName('cloudsFrame')
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

const phaseFunction = /*#__PURE__*/ FnLayout({
  name: 'cloudsPhaseFunction',
  type: 'float',
  inputs: [
    { name: 'cosTheta', type: 'float' },
    { name: 'attenuation', type: 'float' },
    { name: 'g1', type: 'float' },
    { name: 'g2', type: 'float' },
    { name: 'mixWeight', type: 'float' },
    { name: 'phaseMode', type: 'int' }
  ]
})(([cosTheta, attenuation, g1, g2, mixWeight, phaseMode]) => {
  // Accurate fit for large particles (d=10): NVIDIA approximate Mie.
  const gHG = float(0.988176691700256)
  const gD = float(0.5556712547839497)
  const alpha = float(21.995520856274638)
  const accurateWeight = float(0.4819554318404214)
  const accurate = mix(
    henyeyGreenstein(vec2(gHG).mul(attenuation), cosTheta).x,
    drainePhase(cosTheta, gD.mul(attenuation), alpha),
    accurateWeight
  )
  const g = vec2(g1, g2).mul(attenuation)
  const weights = vec2(float(1).sub(mixWeight), mixWeight)
  const approximate = henyeyGreenstein(g, cosTheta).dot(weights)
  return phaseMode.equal(1).select(accurate, approximate)
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
    { name: 'octaveCount', type: 'int' },
    { name: 'phaseMode', type: 'int' }
  ]
})(([opticalDepth, cosTheta, g1, g2, mixWeight, octaveCount, phaseMode]) => {
  const coefficients = vec3(1).toVar()
  const scattering = float(0).toVar()
  Loop({ start: 0, end: 8 }, ({ i }) => {
    If(i.greaterThanEqual(octaveCount), () => {
      Break()
    })
    scattering.addAssign(
      coefficients.x
        .mul(exp(opticalDepth.negate().mul(coefficients.y)))
        .mul(
          phaseFunction(
            cosTheta,
            coefficients.z,
            g1,
            g2,
            mixWeight,
            phaseMode
          )
        )
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
      // Prefer host STBN when provided; otherwise hash jitter.
      const jitter = float(0).toVar()
      if (parameters.stbnTexture != null) {
        const stbn = parameters.stbnTexture
        const size = textureSize(stbn, int(0))
        const scale = float(1).div(size)
        const layer = float(march.frame.mod(size.z))
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
                  // Local sun-detail march (Phase 2); BSM fills the remainder.
                  // With BSM present, skip the nested sun march at coarser mips
                  // (same gate as ground bounce) — biggest shadows-on CPU saver.
                  const localOpticalDepth = float(0).toVar()
                  const sunRayDistance = float(0).toVar()
                  const shadowBuffers = context.shadowBuffers
                  const shadowAtlas = context.shadowAtlas
                  const hasBsm =
                    context.shadow != null &&
                    (shadowBuffers != null || shadowAtlas != null)
                  const runLocalSun = march.maxIterationCountToSun.greaterThan(0)
                  If(runLocalSun, () => {
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
                  })
                  const bsmOpticalDepth = float(0).toVar()
                  // JS-null buffers omit BSM from the shader entirely (toggle
                  // invalidates the march material). Runtime enabled gates the
                  // sample so we never pay Vogel PCF when shadows are off.
                  if (
                    context.shadow != null &&
                    (shadowAtlas != null || shadowBuffers != null)
                  ) {
                    If(
                      context.shadow.enabled
                        .greaterThan(0)
                        .and(height.lessThan(layers.shadowTopHeight)),
                      () => {
                        const sampled = sampleShadowOpticalDepth(
                          {
                            environment,
                            layers,
                            shadow: context.shadow!,
                            shadowTextures: shadowBuffers ?? [],
                            shadowAtlas: context.shadowAtlas ?? null,
                            debugMode: march.shadowDebugOpticalDepth,
                            viewMatrix: viewMatrix(camera)
                          },
                          positionWorld,
                          sunRayDistance,
                          jitter
                        )
                        bsmOpticalDepth.assign(
                          march.shadowDebugOpticalDepth
                            .greaterThanEqual(0)
                            .select(march.shadowDebugOpticalDepth, sampled)
                        )
                      }
                    )
                  }

                  const opticalDepth = localOpticalDepth
                    .add(bsmOpticalDepth)
                    .toVar()
                  // Debug: -3 = local only, -4 = BSM only (else combined).
                  If(march.shadowDebugOpticalDepth.equal(-3), () => {
                    opticalDepth.assign(localOpticalDepth)
                  }).ElseIf(march.shadowDebugOpticalDepth.equal(-4), () => {
                    opticalDepth.assign(bsmOpticalDepth)
                  })

                  const direct = environment.sunIrradianceNode.mul(
                    approximateMultipleScattering(
                      opticalDepth,
                      cosTheta,
                      march.scatterAnisotropy1,
                      march.scatterAnisotropy2,
                      march.scatterAnisotropyMix,
                      march.multiScatteringOctaves,
                      march.phaseFunctionMode
                    )
                  )
                  const radiance = direct.toVar()

                  // Ground bounce (flat plane at mapOrigin.y). Disabled when
                  // scale or ground iterations are zero.
                  If(
                    march.groundBounceScale
                      .greaterThan(0)
                      .and(march.maxIterationCountToGround.greaterThan(0))
                      .and(height.lessThan(layers.shadowTopHeight))
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
                            march.multiScatteringOctaves,
                            march.phaseFunctionMode
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

                  // Powder: after scattering, before integration.
                  If(march.powderScale.greaterThan(0), () => {
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
                  })

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

/** @deprecated Use {@link setupCloudsMarch}. */
export function setupCloudsMarchColor(
  builder: NodeBuilder,
  context: MarchCloudsContext
): Node<'vec4'> {
  return setupCloudsMarch(builder, context).get('color')
}
