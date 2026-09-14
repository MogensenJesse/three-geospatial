// src/webgpu/CloudShadowNode.ts

import { clamp, exp, float, Fn, If, mix } from 'three/tsl'
import { TempNode, type NodeBuilder } from 'three/webgpu'

import type { CloudsNode } from './CloudsNode'
import { viewMatrix } from './internal/accessors'
import type { Node } from './internal/node'
import { sampleShadowOpticalDepth } from './shadowSampling'

/**
 * Samples cascaded Beer shadow maps at a world position and returns scalar
 * transmittance in [0, 1] for host materials. The owning {@link CloudsNode}
 * must remain in the render graph so shadow maps stay updated.
 */
export class CloudShadowNode extends TempNode {
  static override get type(): string {
    return 'CloudShadowNode'
  }

  readonly clouds: CloudsNode
  readonly positionWorld: Node<'vec3'>
  readonly jitter: Node<'float'>

  constructor(
    clouds: CloudsNode,
    positionWorld: Node<'vec3'>,
    jitter: Node<'float'> = float(0.5)
  ) {
    super('float')
    this.clouds = clouds
    this.positionWorld = positionWorld
    this.jitter = jitter
  }

  override setup(_builder: NodeBuilder): unknown {
    const { clouds, positionWorld, jitter } = this
    const { environment, layerParameters, shadowNode } = clouds
    const shadowTextures = clouds.getShadowBufferNodes()

    return Fn(() => {
      const transmittance = float(1).toVar()

      If(shadowNode.shadow.enabled.greaterThan(0), () => {
        const opticalDepth = sampleShadowOpticalDepth(
          {
            environment,
            layers: layerParameters,
            shadow: shadowNode.shadow,
            shadowTextures,
            viewMatrix: viewMatrix(environment.camera)
          },
          positionWorld,
          float(0),
          jitter
        )
        transmittance.assign(clamp(exp(opticalDepth.negate()), 0, 1))
      })

      return transmittance
    })()
  }
}

/**
 * Host contract for projected cloud shadows on scene materials.
 *
 * Multiply direct-light (or a NodeMaterial AO/diffuse channel) by the result.
 * Keep the {@link CloudsNode} in the composition graph so BSM updates each frame.
 *
 * @example
 * ```ts
 * material.aoNode = cloudShadow(cloudNode, positionWorld)
 * ```
 */
export const cloudShadow = (
  clouds: CloudsNode,
  positionWorld: Node<'vec3'>,
  jitter?: Node<'float'>
): CloudShadowNode => new CloudShadowNode(clouds, positionWorld, jitter)

/** Blend between unshadowed (1) and cloud transmittance for a host toggle. */
export const cloudShadowFactor = (
  clouds: CloudsNode,
  positionWorld: Node<'vec3'>,
  enabled: Node<'float'>,
  jitter?: Node<'float'>
): Node<'float'> => {
  return mix(float(1), cloudShadow(clouds, positionWorld, jitter), enabled)
}
