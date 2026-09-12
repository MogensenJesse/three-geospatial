// src/webgpu/shadowSampling.ts

import {
  Break,
  float,
  Fn,
  If,
  int,
  Loop,
  max,
  min,
  PI2,
  remapClamp,
  vec2,
  vec4,
  viewZToOrthographicDepth,
  vogelDiskSample
} from 'three/tsl'
import type { TextureNode } from 'three/webgpu'

import type { CloudsEnvironment } from './CloudsEnvironment'
import { FnLayout } from './internal/FnLayout'
import type { Node } from './internal/node'
import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'
import {
  getEnvironmentPositionMeters,
  getEnvironmentUv,
  insideLayerIntervals,
  sampleMedia,
  sampleWeather
} from './sampling'
import type {
  ShadowMarchParameters,
  ShadowParameterNodes
} from './shadowParameters'

const hashJitter = /*#__PURE__*/ FnLayout({
  name: 'shadowHashJitter',
  type: 'float',
  inputs: [{ name: 'seed', type: 'vec2' }]
})(([seed]) => {
  return seed.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract()
})

const raySlabIntersection = /*#__PURE__*/ FnLayout({
  name: 'rayCloudSlabIntersection',
  type: 'vec2',
  inputs: [
    { name: 'origin', type: 'vec3' },
    { name: 'direction', type: 'vec3' },
    { name: 'bottomY', type: 'float' },
    { name: 'topY', type: 'float' }
  ]
})(([origin, direction, bottomY, topY]) => {
  const parallel = direction.y.abs().lessThan(1e-6)
  const safeDirectionY = parallel.select(1, direction.y)
  const bottom = bottomY.sub(origin.y).div(safeDirectionY)
  const top = topY.sub(origin.y).div(safeDirectionY)
  return parallel.select(vec2(-1), vec2(min(bottom, top), max(bottom, top)))
})

export const getCascadeIndex = /*#__PURE__*/ FnLayout({
  name: 'getCascadeIndex',
  type: 'int',
  inputs: [
    { name: 'viewDepth', type: 'float' },
    { name: 'near', type: 'float' },
    { name: 'far', type: 'float' },
    { name: 'interval0', type: 'vec2' },
    { name: 'interval1', type: 'vec2' },
    { name: 'interval2', type: 'vec2' },
    { name: 'interval3', type: 'vec2' },
    { name: 'cascadeCount', type: 'int' }
  ]
})(([
  viewDepth,
  near,
  far,
  interval0,
  interval1,
  interval2,
  interval3,
  cascadeCount
]) => {
  const depth = viewZToOrthographicDepth(viewDepth, near, far)
  const result = int(-1).toVar()
  const intervals = [interval0, interval1, interval2, interval3]
  for (let i = 0; i < intervals.length; ++i) {
    const isLast = i === intervals.length - 1
    const inInterval = isLast
      ? depth.greaterThanEqual(intervals[i].x)
      : depth
          .greaterThanEqual(intervals[i].x)
          .and(depth.lessThan(intervals[i].y))
    If(cascadeCount.greaterThan(i).and(inInterval), () => {
      result.assign(i)
    })
  }
  return result
})

export const getFadedCascadeIndex = /*#__PURE__*/ FnLayout({
  name: 'getFadedCascadeIndex',
  type: 'int',
  inputs: [
    { name: 'viewDepth', type: 'float' },
    { name: 'near', type: 'float' },
    { name: 'far', type: 'float' },
    { name: 'jitter', type: 'float' },
    { name: 'interval0', type: 'vec2' },
    { name: 'interval1', type: 'vec2' },
    { name: 'interval2', type: 'vec2' },
    { name: 'interval3', type: 'vec2' },
    { name: 'cascadeCount', type: 'int' }
  ]
})(([
  viewDepth,
  near,
  far,
  jitter,
  interval0,
  interval1,
  interval2,
  interval3,
  cascadeCount
]) => {
  const depth = viewZToOrthographicDepth(viewDepth, near, far)
  const nextIndex = int(-1).toVar()
  const previousIndex = int(-1).toVar()
  const alpha = float(0).toVar()
  const intervals = [interval0, interval1, interval2, interval3]

  for (let i = 0; i < intervals.length; ++i) {
    const interval = intervals[i].toVar()
    const isLast = i === intervals.length - 1
    const center = interval.x.add(interval.y).mul(0.5)
    const closestEdge = depth.lessThan(center).select(interval.x, interval.y)
    const margin = closestEdge.mul(closestEdge).mul(0.5).toVar()
    interval.assign(interval.add(margin.mul(vec2(-0.5, 0.5))))
    const inInterval = isLast
      ? depth.greaterThanEqual(interval.x)
      : depth.greaterThanEqual(interval.x).and(depth.lessThan(interval.y))

    If(cascadeCount.greaterThan(i).and(inInterval), () => {
      previousIndex.assign(nextIndex)
      nextIndex.assign(i)
      alpha.assign(
        isLast
          ? depth.sub(interval.x).div(margin).saturate()
          : min(depth.sub(interval.x), interval.y.sub(depth))
              .div(margin)
              .saturate()
      )
    })
  }

  return nextIndex
    .lessThan(0)
    .select(
      nextIndex,
      jitter.lessThanEqual(alpha).select(nextIndex, previousIndex)
    )
})

export const readShadowOpticalDepth = /*#__PURE__*/ FnLayout({
  name: 'readShadowOpticalDepth',
  type: 'float',
  inputs: [
    { name: 'shadow', type: 'vec4' },
    { name: 'distanceToTop', type: 'float' },
    { name: 'distanceOffset', type: 'float' }
  ]
})(([shadow, distanceToTop, distanceOffset]) => {
  const distanceToFront = max(
    0,
    distanceToTop.sub(distanceOffset).sub(shadow.r)
  )
  return min(shadow.b.add(shadow.a), shadow.g.mul(distanceToFront))
})

export interface SampleShadowOpticalDepthContext {
  environment: CloudsEnvironment
  layers: CloudLayerParameterNodes
  shadow: ShadowParameterNodes
  shadowTextures: readonly TextureNode[]
  debugMode?: Node<'float'>
  viewMatrix: Node<'mat4'>
}

/** Reads Beer shadow optical depth for a flat-world cloud sample. */
export function sampleShadowOpticalDepth(
  context: SampleShadowOpticalDepthContext,
  positionWorld: Node<'vec3'>,
  distanceOffset: Node<'float'>,
  jitter: Node<'float'>
): Node<'float'> {
  const { environment, layers, shadow, shadowTextures } = context
  const worldScale = environment.worldUnitsPerMeterNode
  const sunDirection = environment.sunDirectionNode.normalize()
  const topY = environment.mapOriginNode.y.add(
    layers.shadowTopHeight.mul(worldScale)
  )
  const bottomY = environment.mapOriginNode.y.add(
    layers.shadowBottomHeight.mul(worldScale)
  )
  const distanceToTopWorld = raySlabIntersection(
    positionWorld,
    sunDirection,
    bottomY,
    topY
  ).y
  const opticalDepth = float(0).toVar()

  If(distanceToTopWorld.greaterThan(0), () => {
    const viewPosition = context.viewMatrix.mul(vec4(positionWorld, 1))
    const cascadeIndex = getFadedCascadeIndex(
      viewPosition.z,
      shadow.shadowCameraNear,
      shadow.shadowFar,
      jitter,
      shadow.shadowIntervals.element(int(0)),
      shadow.shadowIntervals.element(int(1)),
      shadow.shadowIntervals.element(int(2)),
      shadow.shadowIntervals.element(int(3)),
      shadow.cascadeCount
    )

    If(cascadeIndex.greaterThanEqual(0), () => {
      const clip = shadow.shadowMatrices
        .element(cascadeIndex)
        .mul(vec4(positionWorld, 1))
      const uv = clip.xy.div(clip.w).mul(0.5).add(0.5)
      If(
        uv.x
          .greaterThanEqual(0)
          .and(uv.x.lessThanEqual(1))
          .and(uv.y.greaterThanEqual(0))
          .and(uv.y.lessThanEqual(1)),
        () => {
          const distanceToTop = distanceToTopWorld.div(worldScale)
          const radius = shadow.maxShadowFilterRadius.mul(
            remapClamp(sunDirection.y, 0.1, 0)
          )

          const readAt = (sampleUv: Node<'vec2'>): Node<'float'> => {
            let value = readShadowOpticalDepth(
              shadowTextures[0].sample(sampleUv),
              distanceToTop,
              distanceOffset
            )
            for (let i = 1; i < shadowTextures.length; ++i) {
              value = cascadeIndex
                .equal(i)
                .select(
                  readShadowOpticalDepth(
                    shadowTextures[i].sample(sampleUv),
                    distanceToTop,
                    distanceOffset
                  ),
                  value
                )
            }
            return value
          }

          const samplePCF = (
            sampleUv: Node<'vec2'>,
            filterRadius: Node<'float'>
          ): Node<'float'> => {
            const sampleCount = int(8)
            const phi = jitter.mul(PI2)
            const sum = float(0).toVar()
            Loop({ start: 0, end: 8, type: 'int', name: 'i' }, ({ i }) => {
              const offset = vogelDiskSample(i, sampleCount, phi)
              sum.addAssign(
                readAt(
                  sampleUv.add(
                    offset.mul(filterRadius).mul(shadow.shadowTexelSize)
                  )
                )
              )
            })
            return sum.div(float(sampleCount))
          }

          If(radius.lessThan(0.1), () => {
            opticalDepth.assign(readAt(uv))
          }).Else(() => {
            opticalDepth.assign(samplePCF(uv, radius))
          })

          const debugMode = context.debugMode
          if (debugMode != null) {
            const raw = (channel: 'r' | 'g' | 'b' | 'a'): Node<'float'> => {
              let value = shadowTextures[0].sample(uv)[channel]
              for (let i = 1; i < shadowTextures.length; ++i) {
                value = cascadeIndex
                  .equal(i)
                  .select(shadowTextures[i].sample(uv)[channel], value)
              }
              return value
            }
            opticalDepth.assign(
              debugMode
                .equal(-11)
                .select(
                  raw('r'),
                  debugMode
                    .equal(-12)
                    .select(
                      raw('g'),
                      debugMode
                        .equal(-13)
                        .select(
                          raw('b'),
                          debugMode
                            .equal(-14)
                            .select(
                              raw('a'),
                              debugMode
                                .equal(-15)
                                .select(raw('b').add(raw('a')), opticalDepth)
                            )
                        )
                    )
                )
            )
          }
        }
      )
    })
  })

  return opticalDepth
}

export interface ShadowMarchColorContext {
  environment: CloudsEnvironment
  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  shadow: ShadowParameterNodes
  march: ShadowMarchParameters
}

interface ShadowRay {
  direction: Node<'vec3'>
  origin: Node<'vec3'>
  near: Node<'float'>
  distanceWorld: Node<'float'>
}

function getShadowRay(
  context: ShadowMarchColorContext,
  uv: Node<'vec2'>
): ShadowRay {
  const { environment, layers, shadow, march } = context
  const clip = uv.mul(2).sub(1)
  const point = shadow.inverseShadowMatrices
    .element(march.cascadeIndex)
    .mul(vec4(clip, -1, 1))
  const origin = point.xyz.div(point.w)
  const direction = environment.sunDirectionNode.normalize().negate()
  const worldScale = environment.worldUnitsPerMeterNode
  const bottomY = environment.mapOriginNode.y.add(
    layers.shadowBottomHeight.mul(worldScale)
  )
  const topY = environment.mapOriginNode.y.add(
    layers.shadowTopHeight.mul(worldScale)
  )
  const hits = raySlabIntersection(origin, direction, bottomY, topY)
  const near = max(0, hits.x)
  return {
    direction,
    origin: near.mul(direction).add(origin),
    near,
    distanceWorld: max(0, hits.y.sub(near))
  }
}

/** Cloud-front depth and UV velocity for the shadow temporal resolve. */
export function setupShadowMarchVelocity(
  context: ShadowMarchColorContext,
  uv: Node<'vec2'>,
  color: Node<'vec4'>
): Node<'vec4'> {
  return Fn(() => {
    const { environment, march, shadow } = context
    const ray = getShadowRay(context, uv)
    const frontPositionWorld = color.x
      .mul(environment.worldUnitsPerMeterNode)
      .mul(ray.direction)
      .add(ray.origin)
    const previousClip = shadow.reprojectionMatrices
      .element(march.cascadeIndex)
      .mul(vec4(frontPositionWorld, 1))
    const previousUv = previousClip.xy.div(previousClip.w).mul(0.5).add(0.5)
    const velocity = uv.sub(previousUv).mul(march.resolution)
    return vec4(color.x, velocity, 0)
  })()
}

/**
 * Sun-view Beer shadow march. Output: front distance (meters), mean extinction,
 * optical depth, tail.
 */
export function setupShadowMarchColor(
  context: ShadowMarchColorContext,
  uv: Node<'vec2'>
): Node<'vec4'> {
  const { environment, parameters, layers, march } = context

  return Fn(() => {
    const ray = getShadowRay(context, uv)
    const worldScale = environment.worldUnitsPerMeterNode
    const maxRayDistance = ray.distanceWorld.div(worldScale).toVar()
    const jitter = hashJitter(uv.mul(march.resolution))
    const stepSize = min(
      max(
        maxRayDistance.div(float(march.maxIterationCount)),
        march.minStepSize
      ),
      march.maxStepSize
    ).toVar()
    const rayDistance = stepSize.mul(jitter).toVar()

    const extinctionSum = float(0).toVar()
    const opticalDepth = float(0).toVar()
    const opticalDepthTail = float(0).toVar()
    const transmittanceIntegral = float(1).toVar()
    const weightedDistanceSum = float(0).toVar()
    const transmittanceSum = float(0).toVar()
    const sampleCount = float(0).toVar()

    Loop(
      { start: 0, end: 64, type: 'int', name: 'i', condition: '<' },
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
          .mul(worldScale)
          .mul(ray.direction)
          .add(ray.origin)
        const positionMeters = getEnvironmentPositionMeters(
          environment,
          positionWorld
        )
        const height = positionMeters.y

        If(
          insideLayerIntervals(
            height,
            layers.minIntervalHeights,
            layers.maxIntervalHeights
          ),
          () => {
            rayDistance.addAssign(stepSize)
          }
        ).Else(() => {
          const weatherUv = getEnvironmentUv(environment, positionWorld)
          const weather = sampleWeather(
            parameters,
            layers,
            weatherUv,
            height,
            march.mipLevel,
            { applyShadowLayerMask: true }
          )

          If(
            weather.get('density').greaterThan(vec4(march.minDensity)).any(),
            () => {
              const media = sampleMedia(
                parameters,
                layers,
                weather,
                positionMeters,
                weatherUv,
                march.mipLevel,
                jitter,
                {
                  forceDisableShapeDetail: true,
                  forceDisableTurbulence: true
                }
              )
              If(
                media.get('extinction').greaterThan(march.minExtinction),
                () => {
                  extinctionSum.addAssign(media.get('extinction'))
                  opticalDepth.addAssign(media.get('extinction').mul(stepSize))
                  transmittanceIntegral.mulAssign(
                    media.get('extinction').negate().mul(stepSize).exp()
                  )
                  weightedDistanceSum.addAssign(
                    rayDistance.mul(transmittanceIntegral)
                  )
                  transmittanceSum.addAssign(transmittanceIntegral)
                  sampleCount.addAssign(1)
                }
              )
            }
          )

          If(
            transmittanceIntegral.lessThanEqual(march.minTransmittance),
            () => {
              opticalDepthTail.assign(
                min(
                  march.opticalDepthTailScale
                    .mul(stepSize)
                    .mul(float(1).sub(sampleCount).exp()),
                  stepSize.mul(0.5)
                )
              )
              Break()
            }
          )
          rayDistance.addAssign(stepSize)
        })
      }
    )

    const output = vec4(maxRayDistance, 0, 0, 0).toVar()
    If(sampleCount.greaterThan(0), () => {
      output.assign(
        vec4(
          min(
            weightedDistanceSum.div(max(transmittanceSum, 1e-7)),
            maxRayDistance
          ),
          extinctionSum.div(sampleCount),
          opticalDepth,
          opticalDepthTail
        )
      )
    })
    return output
  })()
}
