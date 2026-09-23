// src/webgpu/cloudsMarchVariant.ts
// Build-time march specialization (JS-omitted TSL, not runtime If/select).

import type { TextureNode } from 'three/webgpu'

import { MAX_MULTI_SCATTERING_OCTAVES } from '../qualityPresets'
import type { CloudsMarchParameters } from './march'

/** Axes that drop substantial WGSL when false. Debug modes compile only when selected. */
export type CloudsMarchDebugMode =
  | 'off'
  | 'local'
  | 'bsm'
  | 'unshadowed'
  | 'forced'

export interface CloudsMarchVariant {
  shadows: boolean
  localSun: boolean
  groundBounce: boolean
  powder: boolean
  phaseAccurate: boolean
  /** Exact MS loop trip count (replaces Loop(8)+Break). */
  multiScatteringOctaves: number
  /**
   * Optical-depth debug view. `off` is the beauty shader and omits those branches.
   */
  debug: CloudsMarchDebugMode
}

function marchDebugMode(value: number): CloudsMarchDebugMode {
  if (value === -3) return 'local'
  if (value === -4) return 'bsm'
  if (value === -5) return 'unshadowed'
  if (value >= 0) return 'forced'
  return 'off'
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
  return {
    shadows: shadowAtlas != null,
    localSun: Number(march.maxIterationCountToSun.value) > 0,
    groundBounce:
      Number(march.groundBounceScale.value) > 0 &&
      Number(march.maxIterationCountToGround.value) > 0,
    powder: Number(march.powderScale.value) > 0,
    phaseAccurate: Number(march.phaseFunctionMode.value) === 1,
    multiScatteringOctaves: octaves,
    debug: marchDebugMode(Number(march.shadowDebugOpticalDepth.value))
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
    `o${v.multiScatteringOctaves}`,
    `d${v.debug}`
  ].join('_')
}
