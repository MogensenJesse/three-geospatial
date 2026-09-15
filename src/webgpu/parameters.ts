// src/webgpu/parameters.ts

import { Vector2, Vector3, Vector4 } from 'three'
import { uniform } from 'three/tsl'
import type { Texture3DNode, TextureNode } from 'three/webgpu'

type UniformOf<T> = ReturnType<typeof uniform> & { value: T }

/**
 * TSL uniforms for cloud participating-medium and weather/shape parameters.
 * Mirrors {@link createCloudParameterUniforms} for the WebGPU path.
 */
export class CloudParameterNodes {
  // Participating medium
  readonly scatteringCoefficient = uniform(1).setName('scatteringCoefficient')
  readonly absorptionCoefficient = uniform(0).setName('absorptionCoefficient')

  // Weather and shape scalars / transforms
  readonly coverage = uniform(0.3).setName('coverage')
  // One procedural weather field spans the host-provided flat map by default.
  readonly localWeatherRepeat = uniform(new Vector2().setScalar(1)).setName(
    'localWeatherRepeat'
  )
  readonly localWeatherOffset = uniform(new Vector2()).setName(
    'localWeatherOffset'
  )
  readonly shapeRepeat = uniform(new Vector3().setScalar(0.0003)).setName(
    'shapeRepeat'
  )
  readonly shapeOffset = uniform(new Vector3()).setName('shapeOffset')
  readonly shapeDetailRepeat = uniform(new Vector3().setScalar(0.006)).setName(
    'shapeDetailRepeat'
  )
  readonly shapeDetailOffset = uniform(new Vector3()).setName(
    'shapeDetailOffset'
  )
  readonly turbulenceRepeat = uniform(new Vector2().setScalar(20)).setName(
    'turbulenceRepeat'
  )
  readonly turbulenceDisplacement = uniform(350).setName(
    'turbulenceDisplacement'
  )

  /**
   * Texture nodes are owned by the caller (procedural nodes or loaded
   * textures). Assign via {@link setLocalWeatherTexture} etc.
   */
  localWeatherTexture: TextureNode | null = null
  shapeTexture: Texture3DNode | null = null
  shapeDetailTexture: Texture3DNode | null = null
  turbulenceTexture: TextureNode | null = null
  /** Optional 3D blue-noise / STBN texture for march jitter. */
  stbnTexture: Texture3DNode | null = null

  /** When true, sampleMedia applies shape-detail erosion. */
  readonly shapeDetailEnabled = uniform(true).setName('shapeDetailEnabled')

  /** When true, sampleMedia applies turbulence domain warping. */
  readonly turbulenceEnabled = uniform(true).setName('turbulenceEnabled')

  setLocalWeatherTexture(node: TextureNode | null): this {
    this.localWeatherTexture = node
    return this
  }

  setShapeTexture(node: Texture3DNode | null): this {
    this.shapeTexture = node
    return this
  }

  setShapeDetailTexture(node: Texture3DNode | null): this {
    this.shapeDetailTexture = node
    return this
  }

  setTurbulenceTexture(node: TextureNode | null): this {
    this.turbulenceTexture = node
    return this
  }

  setStbnTexture(node: Texture3DNode | null): this {
    this.stbnTexture = node
    return this
  }
}

export interface CloudDensityProfileNodes {
  expTerms: UniformOf<Vector4>
  exponents: UniformOf<Vector4>
  linearTerms: UniformOf<Vector4>
  constantTerms: UniformOf<Vector4>
}

/**
 * TSL uniforms for packed cloud-layer properties (up to 4 layers as vec4).
 * Mirrors {@link createCloudLayerUniforms} for the WebGPU path.
 */
export class CloudLayerParameterNodes {
  readonly minLayerHeights = uniform(new Vector4()).setName('minLayerHeights')
  readonly maxLayerHeights = uniform(new Vector4()).setName('maxLayerHeights')
  readonly minIntervalHeights = uniform(new Vector3()).setName(
    'minIntervalHeights'
  )
  readonly maxIntervalHeights = uniform(new Vector3()).setName(
    'maxIntervalHeights'
  )
  readonly densityScales = uniform(new Vector4()).setName('densityScales')
  readonly shapeAmounts = uniform(new Vector4()).setName('shapeAmounts')
  readonly shapeDetailAmounts = uniform(new Vector4()).setName(
    'shapeDetailAmounts'
  )
  readonly weatherExponents = uniform(new Vector4()).setName('weatherExponents')
  readonly shapeAlteringBiases = uniform(new Vector4()).setName(
    'shapeAlteringBiases'
  )
  readonly coverageFilterWidths = uniform(new Vector4()).setName(
    'coverageFilterWidths'
  )
  readonly minHeight = uniform(0).setName('minHeight')
  readonly maxHeight = uniform(0).setName('maxHeight')
  readonly shadowTopHeight = uniform(0).setName('shadowTopHeight')
  readonly shadowBottomHeight = uniform(0).setName('shadowBottomHeight')
  readonly shadowLayerMask = uniform(new Vector4()).setName('shadowLayerMask')

  readonly densityProfile: CloudDensityProfileNodes = {
    expTerms: uniform(new Vector4()).setName('densityProfile_expTerms'),
    exponents: uniform(new Vector4()).setName('densityProfile_exponents'),
    linearTerms: uniform(new Vector4()).setName('densityProfile_linearTerms'),
    constantTerms: uniform(new Vector4()).setName(
      'densityProfile_constantTerms'
    )
  }

  /**
   * Swizzle string selecting local-weather texture channels for layers 0–3
   * (e.g. `"rgba"`). Applied at graph build time in sampling helpers.
   */
  localWeatherChannels = 'rgba'
}
