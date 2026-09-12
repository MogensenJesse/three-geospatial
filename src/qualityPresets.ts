// src/qualityPresets.ts

import { Vector2 } from 'three'

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra'

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
}

export interface CloudQualitySettings {
  resolutionScale: number
  temporalUpscale: boolean
  shapeDetail: boolean
  turbulence: boolean
  clouds: CloudMarchQuality
  shadow: CloudShadowQuality
}

// WebGL cloud-core reference (high preset) — per parity plan Phase 0
const webglHighReference: CloudQualitySettings = {
  resolutionScale: 1,
  temporalUpscale: true,
  shapeDetail: true,
  turbulence: true,
  clouds: {
    multiScatteringOctaves: 8,
    maxIterationCount: 500,
    minStepSize: 50,
    maxStepSize: 1000,
    maxRayDistance: 2e5,
    perspectiveStepScale: 1.01,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 1e-2
  },
  shadow: {
    cascadeCount: 3,
    mapSize: /*#__PURE__*/ new Vector2(512, 512),
    maxIterationCount: 50,
    minStepSize: 100,
    maxStepSize: 1000,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 1e-4
  }
}

// Practical performance presets derived from the reference
const low: CloudQualitySettings = {
  resolutionScale: 0.5,
  temporalUpscale: false,
  shapeDetail: false,
  turbulence: false,
  clouds: {
    multiScatteringOctaves: 2,
    maxIterationCount: 32,
    minStepSize: 400,
    maxStepSize: 2000,
    maxRayDistance: 2.5e4,
    perspectiveStepScale: 1.02,
    minDensity: 1e-4,
    minExtinction: 1e-4,
    minTransmittance: 0.2
  },
  shadow: {
    cascadeCount: 2,
    mapSize: /*#__PURE__*/ new Vector2(256, 256),
    maxIterationCount: 24,
    minStepSize: 100,
    maxStepSize: 1000,
    minDensity: 1e-4,
    minExtinction: 1e-4,
    minTransmittance: 1e-2
  }
}

const medium: CloudQualitySettings = {
  resolutionScale: 0.75,
  temporalUpscale: true,
  shapeDetail: true,
  turbulence: false,
  clouds: {
    multiScatteringOctaves: 4,
    maxIterationCount: 96,
    minStepSize: 150,
    maxStepSize: 1500,
    maxRayDistance: 1e5,
    perspectiveStepScale: 1.01,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 5e-3
  },
  shadow: {
    cascadeCount: 3,
    mapSize: /*#__PURE__*/ new Vector2(512, 512),
    maxIterationCount: 40,
    minStepSize: 100,
    maxStepSize: 1000,
    minDensity: 1e-5,
    minExtinction: 1e-5,
    minTransmittance: 1e-4
  }
}

const high: CloudQualitySettings = webglHighReference

const ultra: CloudQualitySettings = {
  ...webglHighReference,
  clouds: {
    ...webglHighReference.clouds,
    maxIterationCount: 768,
    minStepSize: 25,
    multiScatteringOctaves: 12
  },
  shadow: {
    ...webglHighReference.shadow,
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

// Backward-compat: some consumers still import `defaults` as the reference config.
// Use the WebGL high reference as the default fallback.
export const defaults = webglHighReference

// Re-export reference for documentation / tooling
export { webglHighReference }
