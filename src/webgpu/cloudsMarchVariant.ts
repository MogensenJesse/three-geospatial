// src/webgpu/cloudsMarchVariant.ts
// Phase C: build-time march specialization (JS-omitted TSL, not runtime If/select).

import type { TextureNode } from 'three/webgpu'

import { MAX_MULTI_SCATTERING_OCTAVES } from '../qualityPresets'
import type { CloudsMarchParameters } from './march'

/** Axes that drop substantial WGSL when false / -1. Keep ≤ ~6 live combos. */
export interface CloudsMarchVariant {
  shadows: boolean
  localSun: boolean
  groundBounce: boolean
  powder: boolean
  phaseAccurate: boolean
  /** -1 = omit optical-depth debug probes from the graph. */
  debugOpticalDepth: number
  /** Exact MS loop trip count (replaces Loop(8)+Break). */
  multiScatteringOctaves: number
}

export function resolveCloudsMarchVariant(
  march: CloudsMarchParameters,
  shadowAtlas: TextureNode | null | undefined
): CloudsMarchVariant {
  const octaves = Math.max(
    1,
    Math.min(
      MAX_MULTI_SCATTERING_OCTAVES,
      Math.round(
        Number(march.multiScatteringOctaves.value) ||
          MAX_MULTI_SCATTERING_OCTAVES
      )
    )
  )
  const debug = Number(march.shadowDebugOpticalDepth.value)
  return {
    shadows: shadowAtlas != null,
    localSun: Number(march.maxIterationCountToSun.value) > 0,
    groundBounce:
      Number(march.groundBounceScale.value) > 0 &&
      Number(march.maxIterationCountToGround.value) > 0,
    powder: Number(march.powderScale.value) > 0,
    phaseAccurate: Number(march.phaseFunctionMode.value) === 1,
    debugOpticalDepth: Number.isFinite(debug) ? debug : -1,
    multiScatteringOctaves: octaves
  }
}

export function cloudsMarchVariantKey(v: CloudsMarchVariant): string {
  return [
    'cm',
    v.shadows ? 's1' : 's0',
    v.localSun ? 'l1' : 'l0',
    v.groundBounce ? 'g1' : 'g0',
    v.powder ? 'p1' : 'p0',
    v.phaseAccurate ? 'ph1' : 'ph0',
    `d${v.debugOpticalDepth}`,
    `o${v.multiScatteringOctaves}`
  ].join('_')
}
