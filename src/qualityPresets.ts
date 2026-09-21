// src/qualityPresets.ts

import { Vector2 } from 'three'

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'

export type PhaseFunctionMode = 'approximate' | 'accurate'

export interface CloudMarchQuality {
  multiScatteringOctaves: number
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  maxRayDistance: number
  perspectiveStepScale: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  /** Secondary sun-detail march iterations (maps to maxIterationCountToSun). */
  secondaryIterationCount: number
  minSecondaryStepSize: number
  secondaryStepScale: number
  /** Ground-bounce march iterations (Phase 3). */
  groundIterationCount: number
  powderScale: number
  powderExponent: number
  groundBounceScale: number
  phaseFunctionMode: PhaseFunctionMode
}

export interface CloudShadowQuality {
  cascadeCount: number
  mapSize: Vector2
  maxIterationCount: number
  minStepSize: number
  maxStepSize: number
  minDensity: number
  minExtinction: number
  minTransmittance: number
  shapeDetail: boolean
  turbulence: boolean
  temporalAlpha: number
  temporalGamma: number
}

export interface CloudQualitySettings {
  resolutionScale: number
  temporalUpscale: boolean
  shapeDetail: boolean
  turbulence: boolean
  clouds: CloudMarchQuality
  shadow: CloudShadowQuality
}

const highClouds: CloudMarchQuality = {
  multiScatteringOctaves: 8,
  maxIterationCount: 500,
  minStepSize: 50,
  maxStepSize: 1000,
  maxRayDistance: 2e5,
  perspectiveStepScale: 1.01,
  minDensity: 1e-5,
  minExtinction: 1e-5,
  minTransmittance: 1e-2,
  secondaryIterationCount: 2, // WebGL high maxIterationCountToSun
  minSecondaryStepSize: 100,
  secondaryStepScale: 2,
  groundIterationCount: 3,
  powderScale: 0.8,
  powderExponent: 150,
  groundBounceScale: 1,
  phaseFunctionMode: 'approximate'
}

const highShadow: CloudShadowQuality = {
  cascadeCount: 3,
  mapSize: /*#__PURE__*/ new Vector2(512, 512),
  maxIterationCount: 50,
  minStepSize: 100,
  maxStepSize: 1000,
  minDensity: 1e-5,
  minExtinction: 1e-5,
  minTransmittance: 1e-4,
  shapeDetail: true,
  turbulence: true,
  temporalAlpha: 0.01, // WebGL ShadowResolveMaterial default
  temporalGamma: 1
}

/** WebGL cloud-core reference (high preset) — parity plan Phase 0/1. */
export const webglHighReference: CloudQualitySettings = {
  resolutionScale: 1,
  temporalUpscale: true,
  shapeDetail: true,
  turbulence: true,
  clouds: highClouds,
  shadow: highShadow
}

const low: CloudQualitySettings = {
  resolutionScale: 0.5,
  temporalUpscale: false,
  shapeDetail: false,
  turbulence: false,
  clouds: {
    ...highClouds,
    multiScatteringOctaves: 8,
    maxIterationCount: 200,
    minStepSize: 100,
    maxStepSize: 1000,
    maxRayDistance: 1e5,
    minDensity: 1e-4,
    minExtinction: 1e-4,
    minTransmittance: 1e-1,
    secondaryIterationCount: 1,
    groundIterationCount: 0
  },
  shadow: {
    ...highShadow,
    cascadeCount: 2,
    mapSize: /*#__PURE__*/ new Vector2(256, 256),
    maxIterationCount: 25,
    minDensity: 1e-4,
    minExtinction: 1e-4,
    minTransmittance: 1e-2,
    shapeDetail: false,
    turbulence: false,
    temporalAlpha: 0.01
  }
}

const medium: CloudQualitySettings = {
  resolutionScale: 0.75,
  temporalUpscale: true,
  shapeDetail: true,
  turbulence: false,
  clouds: {
    ...highClouds,
    minDensity: 1e-4,
    minExtinction: 1e-4,
    secondaryIterationCount: 2,
    groundIterationCount: 1
  },
  shadow: {
    ...highShadow,
    mapSize: /*#__PURE__*/ new Vector2(256, 256),
    minDensity: 1e-4,
    minExtinction: 1e-4,
    shapeDetail: true,
    turbulence: false
  }
}

const high: CloudQualitySettings = webglHighReference

const ultra: CloudQualitySettings = {
  ...webglHighReference,
  clouds: {
    ...highClouds,
    maxIterationCount: 768,
    minStepSize: 10,
    multiScatteringOctaves: 12
  },
  shadow: {
    ...highShadow,
    mapSize: /*#__PURE__*/ new Vector2(1024, 1024),
    maxIterationCount: 64
  }
}

export const qualityPresets: Record<QualityPreset, CloudQualitySettings> = {
  low,
  medium,
  high,
  ultra
}

/** Default / high reference — matches WebGL `defaults`. */
export const defaults = webglHighReference

/** Deep-clone settings so consumers cannot mutate shared preset vectors. */
export function cloneQualitySettings(
  settings: CloudQualitySettings
): CloudQualitySettings {
  return {
    resolutionScale: settings.resolutionScale,
    temporalUpscale: settings.temporalUpscale,
    shapeDetail: settings.shapeDetail,
    turbulence: settings.turbulence,
    clouds: { ...settings.clouds },
    shadow: {
      ...settings.shadow,
      mapSize: settings.shadow.mapSize.clone()
    }
  }
}
