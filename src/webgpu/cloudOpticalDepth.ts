// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
// src/webgpu/cloudOpticalDepth.ts

import { Break, float, If, int, Loop, max, mix, struct } from 'three/tsl'

import type { CloudsEnvironment } from './CloudsEnvironment'
import { FnLayout } from './internal/FnLayout'
import type { Node } from './internal/node'
import type { CloudsMarchParameters } from './march'
import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'
import {
  getEnvironmentPositionMeters,
  getEnvironmentUv,
  sampleMedia,
  sampleWeather
} from './sampling'
import { raySlabIntersection } from './shadowSampling'

export const cloudOpticalDepthResultStruct = /*#__PURE__*/ struct(
  {
    opticalDepth: 'float',
    rayDistance: 'float'
  },
  'CloudOpticalDepthResult'
)

export type CloudOpticalDepthResultNode = ReturnType<
  typeof cloudOpticalDepthResultStruct
>

/** Compile-time ceiling for the secondary sun/ground optical-depth march. */
export const MAX_SECONDARY_OPTICAL_DEPTH_ITERATIONS = 8

const remapMipIterationCount = /*#__PURE__*/ FnLayout({
  name: 'remapSecondaryOpticalDepthIterations',
  type: 'int',
  inputs: [
    { name: 'maxIterationCount', type: 'int' },
    { name: 'mipLevel', type: 'float' },
    { name: 'jitter', type: 'float' }
  ]
})(([maxIterationCount, mipLevel, jitter]) => {
  // WebGL: int(max(0, remap(mip, 0, 1, max+1, 1) - jitter))
  const remapped = mix(float(maxIterationCount).add(1), float(1), mipLevel).sub(
    jitter
  )
  return int(max(float(0), remapped))
})

export interface MarchCloudOpticalDepthContext {
  environment: CloudsEnvironment
  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  march: CloudsMarchParameters
}

/**
 * Short fragment-stage optical-depth march through the flat cloud slab.
 * Port of WebGL `marchOpticalDepth` for sun-detail / ground-bounce paths.
 * Returns zero work when `maxIterationCount` is 0.
 */
export function marchCloudOpticalDepth(
  context: MarchCloudOpticalDepthContext,
  rayOriginWorld: Node<'vec3'>,
  rayDirection: Node<'vec3'>,
  mipLevel: Node<'float'>,
  jitter: Node<'float'>,
  maxIterationCount: Node<'int'>
): CloudOpticalDepthResultNode {
  const { environment, parameters, layers, march } = context
  const worldScale = environment.worldUnitsPerMeterNode
  const opticalDepth = float(0).toVar()
  const rayDistance = float(0).toVar()

  If(maxIterationCount.greaterThan(0), () => {
    const bottomY = environment.mapOriginNode.y.add(
      layers.minHeight.mul(worldScale)
    )
    const topY = environment.mapOriginNode.y.add(
      layers.maxHeight.mul(worldScale)
    )
    const hits = raySlabIntersection(
      rayOriginWorld,
      rayDirection,
      bottomY,
      topY
    )
    const maxRayDistance = max(hits.y, float(0)).toVar()

    const iterationCount = remapMipIterationCount(
      maxIterationCount,
      mipLevel,
      jitter
    ).toVar()

    If(iterationCount.equal(0), () => {
      // WebGL fudge when mip remapping collapses the march.
      opticalDepth.assign(0.5)
    }).Else(() => {
      const stepSizeMeters = march.minSecondaryStepSize
        .div(float(iterationCount))
        .toVar()
      const stepSizeWorld = stepSizeMeters.mul(worldScale).toVar()
      const nextDistance = stepSizeWorld.mul(jitter).toVar()

      Loop(
        {
          start: 0,
          end: MAX_SECONDARY_OPTICAL_DEPTH_ITERATIONS,
          type: 'int',
          condition: '<'
        },
        ({ i }) => {
          If(
            i
              .greaterThanEqual(iterationCount)
              .or(nextDistance.greaterThan(maxRayDistance)),
            () => {
              Break()
            }
          )

          rayDistance.assign(nextDistance)
          const positionWorld = rayDistance
            .mul(rayDirection)
            .add(rayOriginWorld)
            .toVar()
          const positionMeters = getEnvironmentPositionMeters(
            environment,
            positionWorld
          ).toVar()
          const uv = getEnvironmentUv(environment, positionWorld)
          const height = positionMeters.y
          const weather = sampleWeather(
            parameters,
            layers,
            uv,
            height,
            mipLevel
          )
          const media = sampleMedia(
            parameters,
            layers,
            weather,
            positionMeters,
            uv,
            mipLevel,
            jitter
          )
          opticalDepth.addAssign(media.get('extinction').mul(stepSizeMeters))
          nextDistance.addAssign(stepSizeWorld)
          stepSizeWorld.mulAssign(march.secondaryStepScale)
          stepSizeMeters.mulAssign(march.secondaryStepScale)
        }
      )
    })
  })

  return cloudOpticalDepthResultStruct(opticalDepth, rayDistance)
}
