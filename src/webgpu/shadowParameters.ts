// src/webgpu/shadowParameters.ts

import { Matrix4, Vector2 } from 'three'
import { uniform, uniformArray } from 'three/tsl'

/** Max cascades supported by the Phase C WebGPU spike (matches WebGL). */
export const MAX_SHADOW_CASCADES = 4

/** Uniforms shared by shadow march and clouds BSM sampling. */
export class ShadowParameterNodes {
  readonly enabled = uniform(1).setName('shadowEnabled')
  readonly cascadeCount = uniform(2, 'int').setName('shadowCascadeCount')
  readonly shadowFar = uniform(0).setName('shadowFar')
  readonly shadowCameraNear = uniform(1).setName('shadowCameraNear')

  /** World-space cascade matrices (projection × view). */
  readonly shadowMatrices = uniformArray(
    Array.from({ length: MAX_SHADOW_CASCADES }, () => new Matrix4())
  ).setName('shadowMatrices')

  /** Clip → world for shadow-map ray origins. */
  readonly inverseShadowMatrices = uniformArray(
    Array.from({ length: MAX_SHADOW_CASCADES }, () => new Matrix4())
  ).setName('inverseShadowMatrices')

  /** Orthographic depth intervals per cascade (x=start, y=end), 0–1. */
  readonly shadowIntervals = uniformArray(
    Array.from({ length: MAX_SHADOW_CASCADES }, () => new Vector2()),
    'vec2'
  ).setName('shadowIntervals')

  /**
   * Cascade matrices from the previous frame, used to reproject the shadow-map
   * front depth into screen space for the temporal resolve.
   */
  readonly reprojectionMatrices = uniformArray(
    Array.from({ length: MAX_SHADOW_CASCADES }, () => new Matrix4())
  ).setName('shadowReprojectionMatrices')

  readonly shadowTexelSize = uniform(new Vector2(1, 1)).setName(
    'shadowTexelSize'
  )

  /** Soft PCF radius in texels (0 = single sample). */
  readonly maxShadowFilterRadius = uniform(6).setName('maxShadowFilterRadius')
}

/** Ray-march quality for the sun-view BSM pass. */
export class ShadowMarchParameters {
  readonly cascadeIndex = uniform(0, 'int').setName('shadowCascadeIndex')
  readonly resolution = uniform(new Vector2(1, 1)).setName(
    'shadowMarchResolution'
  )

  readonly maxIterationCount = uniform(25, 'int').setName(
    'shadowMaxIterationCount'
  )
  readonly minStepSize = uniform(100).setName('shadowMinStepSize')
  readonly maxStepSize = uniform(1000).setName('shadowMaxStepSize')
  readonly minDensity = uniform(1e-4).setName('shadowMinDensity')
  readonly minExtinction = uniform(1e-4).setName('shadowMinExtinction')
  readonly minTransmittance = uniform(1e-2).setName('shadowMinTransmittance')
  readonly opticalDepthTailScale = uniform(2).setName('opticalDepthTailScale')

  /** Fixed mip bias for the active cascade (matches WebGL mipLevels[]). */
  readonly mipLevel = uniform(0).setName('shadowMipLevel')
}

export const shadowMipLevels = [0, 0.5, 1, 2] as const
