// src/webgpu/CloudsEnvironment.ts

import { type PerspectiveCamera, Vector2, Vector3 } from 'three'
import { uniform } from 'three/tsl'
import type { TextureNode } from 'three/webgpu'

export interface CloudsEnvironmentOptions {
  /** Scene camera used for cloud rays, reprojection, and shadow cascades. */
  camera: PerspectiveCamera
  /** XZ extent of one weather-map tile, measured in scene world units. */
  mapSize: Vector2
  /** Center of the map in world space; Y is the zero-altitude plane. */
  mapOrigin?: Vector3
  /** Conversion factor used by meter-based cloud-layer and march settings. */
  worldUnitsPerMeter?: number
  /** Unit vector from the world toward the sun. */
  sunDirection?: Vector3
  /** Linear direct-light irradiance supplied by the host sky model. */
  sunIrradiance?: Vector3
  /** Linear ambient sky irradiance supplied by the host sky model. */
  skyIrradiance?: Vector3
  /** Linear RGB ground albedo for underside bounce (flat plane at mapOrigin.y). */
  groundAlbedo?: Vector3
  /** Optional scene depth texture for terrain/geometry occlusion. */
  sceneDepth?: TextureNode | null
}

/**
 * Host-owned inputs shared by the cloud, shadow, and temporal passes.
 *
 * The cloud volume is a horizontal Y-up slab. Layer altitudes are measured in
 * meters above `mapOrigin.y`, while `mapOrigin` and `mapSize` use scene units.
 */
export class CloudsEnvironment {
  camera: PerspectiveCamera
  readonly mapSize = new Vector2()
  readonly mapOrigin = new Vector3()
  worldUnitsPerMeter: number
  readonly sunDirection = new Vector3(0, 1, 0)
  readonly sunIrradiance = new Vector3(1)
  readonly skyIrradiance = new Vector3(0.15)
  readonly groundAlbedo = new Vector3(0.3, 0.3, 0.3)
  sceneDepth: TextureNode | null

  readonly mapSizeNode = uniform(this.mapSize).setName('cloudMapSize')
  readonly mapOriginNode = uniform(this.mapOrigin).setName('cloudMapOrigin')
  readonly worldUnitsPerMeterNode = uniform(1).setName(
    'cloudWorldUnitsPerMeter'
  )
  readonly sunDirectionNode = uniform(this.sunDirection).setName(
    'cloudSunDirection'
  )
  readonly sunIrradianceNode = uniform(this.sunIrradiance).setName(
    'cloudSunIrradiance'
  )
  readonly skyIrradianceNode = uniform(this.skyIrradiance).setName(
    'cloudSkyIrradiance'
  )
  readonly groundAlbedoNode = uniform(this.groundAlbedo).setName(
    'cloudGroundAlbedo'
  )

  constructor(options: CloudsEnvironmentOptions) {
    this.camera = options.camera
    this.mapSize.copy(options.mapSize)
    this.mapOrigin.copy(options.mapOrigin ?? new Vector3())
    this.worldUnitsPerMeter = options.worldUnitsPerMeter ?? 1
    this.sunDirection.copy(options.sunDirection ?? this.sunDirection)
    this.sunIrradiance.copy(options.sunIrradiance ?? this.sunIrradiance)
    this.skyIrradiance.copy(options.skyIrradiance ?? this.skyIrradiance)
    this.groundAlbedo.copy(options.groundAlbedo ?? this.groundAlbedo)
    this.sceneDepth = options.sceneDepth ?? null
    this.update()
  }

  /**
   * Synchronizes scalar uniforms and validates host configuration. Vector
   * uniforms retain live references and therefore require no copying.
   */
  update(): void {
    if (this.mapSize.x <= 0 || this.mapSize.y <= 0) {
      throw new Error('CloudsEnvironment.mapSize components must be positive.')
    }
    if (this.worldUnitsPerMeter <= 0) {
      throw new Error(
        'CloudsEnvironment.worldUnitsPerMeter must be greater than zero.'
      )
    }
    if (this.sunDirection.lengthSq() === 0) {
      throw new Error('CloudsEnvironment.sunDirection must be non-zero.')
    }
    this.worldUnitsPerMeterNode.value = this.worldUnitsPerMeter
  }
}
