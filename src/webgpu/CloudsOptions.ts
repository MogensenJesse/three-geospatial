// src/webgpu/CloudsOptions.ts

import type { Vector2, Vector3 } from 'three'
import type { Texture3DNode, TextureNode } from 'three/webgpu'
import type { CloudLayerLike } from '../CloudLayer'
import type { CloudLayers } from '../CloudLayers'
import type { PhaseFunctionMode, QualityPreset } from '../qualityPresets'
import {
  CloudsEnvironment,
  type CloudsEnvironmentOptions
} from './CloudsEnvironment'

/** Marker so facade field types can live on one object and stay optional. */
type Opt<T> = { readonly __opt: T }

function opt<T>(): Opt<T> {
  return undefined as unknown as Opt<T>
}

/**
 * Single source for facade fields. {@link CloudsFacadeOptions} and the
 * environment-vs-facade split both read this object.
 */
export const cloudsFacadeFields = {
  environment: opt<CloudsEnvironment | CloudsEnvironmentOptions>(),
  qualityPreset: opt<QualityPreset>(),
  cloudLayers: opt<CloudLayers | readonly CloudLayerLike[]>(),
  localWeatherTexture: opt<TextureNode | null>(),
  shapeTexture: opt<Texture3DNode | null>(),
  shapeDetailTexture: opt<Texture3DNode | null>(),
  turbulenceTexture: opt<TextureNode | null>(),
  stbnTexture: opt<Texture3DNode | null>(),
  coverage: opt<number>(),
  scatteringCoefficient: opt<number>(),
  absorptionCoefficient: opt<number>(),
  turbulenceDisplacement: opt<number>(),
  shapeDetail: opt<boolean>(),
  turbulence: opt<boolean>(),
  resolutionScale: opt<number>(),
  temporalUpscale: opt<boolean>(),
  temporalAlpha: opt<number>(),
  temporalUpscaleAlpha: opt<number>(),
  temporalHistoryEnabled: opt<boolean>(),
  varianceGamma: opt<number>(),
  varianceGammaStatic: opt<number>(),
  depthRejectTolerance: opt<number>(),
  secondaryIterationCount: opt<number>(),
  skyLightScale: opt<number>(),
  stepJitterScale: opt<number>(),
  powderScale: opt<number>(),
  powderExponent: opt<number>(),
  groundBounceScale: opt<number>(),
  groundIterationCount: opt<number>(),
  phaseFunctionMode: opt<PhaseFunctionMode>(),
  scatterAnisotropy1: opt<number>(),
  scatterAnisotropy2: opt<number>(),
  scatterAnisotropyMix: opt<number>(),
  shadowEnabled: opt<boolean>(),
  shadowMapSize: opt<number>(),
  shadowCascadeCount: opt<number>(),
  shadowFilterRadius: opt<number>(),
  shadowTemporalAlpha: opt<number>(),
  shadowTemporalGamma: opt<number>(),
  opticalDepthTailScale: opt<number>(),
  localWeatherRepeat: opt<Vector2>(),
  localWeatherOffset: opt<Vector2>(),
  shapeRepeat: opt<Vector3>(),
  shapeOffset: opt<Vector3>(),
  shapeDetailRepeat: opt<Vector3>(),
  shapeDetailOffset: opt<Vector3>(),
  turbulenceRepeat: opt<Vector2>(),
  localWeatherVelocity: opt<Vector2>(),
  shapeVelocity: opt<Vector3>(),
  shapeDetailVelocity: opt<Vector3>()
}

type Unwrap<T> = T extends Opt<infer U> ? U : never

/**
 * Optional facade knobs for {@link clouds} / {@link CloudsNode}.
 * Environment may be passed as {@link environment} or inlined as
 * {@link CloudsEnvironmentOptions} fields on the same object.
 */
export type CloudsFacadeOptions = {
  [K in keyof typeof cloudsFacadeFields]?: Unwrap<
    (typeof cloudsFacadeFields)[K]
  >
}

/** Construction options for {@link clouds}. Legacy env-only args still work. */
export type CloudsOptions =
  | CloudsEnvironment
  | CloudsEnvironmentOptions
  | (CloudsFacadeOptions & Partial<CloudsEnvironmentOptions>)

const FACADE_KEYS = Object.keys(cloudsFacadeFields) as Array<
  keyof CloudsFacadeOptions
>

export interface ResolvedCloudsOptions {
  environment: CloudsEnvironment
  facade: CloudsFacadeOptions
}

function isEnvironmentOptions(
  value: object
): value is CloudsEnvironmentOptions {
  return 'camera' in value && 'mapSize' in value
}

/** Normalize legacy env args and the facade into one shape. */
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
