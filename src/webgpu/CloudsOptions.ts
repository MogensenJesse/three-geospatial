// src/webgpu/CloudsOptions.ts

import type { Vector2, Vector3 } from 'three'
import type { Texture3DNode, TextureNode } from 'three/webgpu'

import type { CloudLayers } from '../CloudLayers'
import type { CloudLayerLike } from '../CloudLayer'
import type { PhaseFunctionMode, QualityPreset } from '../qualityPresets'
import {
  CloudsEnvironment,
  type CloudsEnvironmentOptions
} from './CloudsEnvironment'

/**
 * Optional facade knobs for {@link clouds} / {@link CloudsNode}.
 * Environment may be passed as {@link environment} or inlined as
 * {@link CloudsEnvironmentOptions} fields on the same object.
 */
export interface CloudsFacadeOptions {
  environment?: CloudsEnvironment | CloudsEnvironmentOptions
  qualityPreset?: QualityPreset
  cloudLayers?: CloudLayers | readonly CloudLayerLike[]
  localWeatherTexture?: TextureNode | null
  shapeTexture?: Texture3DNode | null
  shapeDetailTexture?: Texture3DNode | null
  turbulenceTexture?: TextureNode | null
  stbnTexture?: Texture3DNode | null
  coverage?: number
  scatteringCoefficient?: number
  absorptionCoefficient?: number
  turbulenceDisplacement?: number
  shapeDetail?: boolean
  turbulence?: boolean
  resolutionScale?: number
  temporalUpscale?: boolean
  temporalAlpha?: number
  varianceGamma?: number
  secondaryIterationCount?: number
  powderScale?: number
  powderExponent?: number
  groundBounceScale?: number
  groundIterationCount?: number
  phaseFunctionMode?: PhaseFunctionMode
  shadowEnabled?: boolean
  shadowMapSize?: number
  shadowCascadeCount?: number
  shadowFilterRadius?: number
  shadowTemporalAlpha?: number
  shadowTemporalGamma?: number
  localWeatherRepeat?: Vector2
  localWeatherOffset?: Vector2
  shapeRepeat?: Vector3
  shapeOffset?: Vector3
  shapeDetailRepeat?: Vector3
  shapeDetailOffset?: Vector3
  turbulenceRepeat?: Vector2
  localWeatherVelocity?: Vector2
  shapeVelocity?: Vector3
  shapeDetailVelocity?: Vector3
}

/** Construction options for {@link clouds}. Legacy env-only args still work. */
export type CloudsOptions =
  | CloudsEnvironment
  | CloudsEnvironmentOptions
  | (CloudsFacadeOptions & Partial<CloudsEnvironmentOptions>)

const FACADE_KEYS = new Set<string>([
  'environment',
  'qualityPreset',
  'cloudLayers',
  'localWeatherTexture',
  'shapeTexture',
  'shapeDetailTexture',
  'turbulenceTexture',
  'stbnTexture',
  'coverage',
  'scatteringCoefficient',
  'absorptionCoefficient',
  'turbulenceDisplacement',
  'shapeDetail',
  'turbulence',
  'resolutionScale',
  'temporalUpscale',
  'temporalAlpha',
  'varianceGamma',
  'secondaryIterationCount',
  'powderScale',
  'powderExponent',
  'groundBounceScale',
  'groundIterationCount',
  'phaseFunctionMode',
  'shadowEnabled',
  'shadowMapSize',
  'shadowCascadeCount',
  'shadowFilterRadius',
  'shadowTemporalAlpha',
  'shadowTemporalGamma',
  'localWeatherRepeat',
  'localWeatherOffset',
  'shapeRepeat',
  'shapeOffset',
  'shapeDetailRepeat',
  'shapeDetailOffset',
  'turbulenceRepeat',
  'localWeatherVelocity',
  'shapeVelocity',
  'shapeDetailVelocity'
])

export interface ResolvedCloudsOptions {
  environment: CloudsEnvironment
  facade: CloudsFacadeOptions
}

function isEnvironmentOptions(
  value: object
): value is CloudsEnvironmentOptions {
  return 'camera' in value && 'mapSize' in value
}

/** Normalize legacy env args and the Phase 7 facade into one shape. */
export function resolveCloudsOptions(
  options: CloudsOptions
): ResolvedCloudsOptions {
  if (options instanceof CloudsEnvironment) {
    return { environment: options, facade: {} }
  }

  const record = options as Record<string, unknown>
  const facade: CloudsFacadeOptions = {}
  for (const key of FACADE_KEYS) {
    if (key in record && record[key] !== undefined) {
      ;(facade as Record<string, unknown>)[key] = record[key]
    }
  }

  let environment: CloudsEnvironment
  if (facade.environment instanceof CloudsEnvironment) {
    environment = facade.environment
  } else if (facade.environment != null) {
    environment = new CloudsEnvironment(facade.environment)
  } else if (isEnvironmentOptions(options)) {
    const envOnly: Record<string, unknown> = { ...record }
    for (const key of FACADE_KEYS) {
      delete envOnly[key]
    }
    environment = new CloudsEnvironment(
      envOnly as unknown as CloudsEnvironmentOptions
    )
  } else {
    throw new Error(
      'clouds(): provide CloudsEnvironment, CloudsEnvironmentOptions, or CloudsOptions.environment'
    )
  }

  return { environment, facade }
}
