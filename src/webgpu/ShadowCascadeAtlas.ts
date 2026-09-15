// src/webgpu/ShadowCascadeAtlas.ts

import {
  DataArrayTexture,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector3,
  type Texture
} from 'three'
import { texture } from 'three/tsl'
import type { TextureNode } from 'three/webgpu'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CopyRenderer = {
  copyTextureToTexture: (
    src: Texture,
    dst: Texture,
    ...rest: any[]
  ) => void
  initTexture?: (t: Texture) => void
}

/**
 * Cascade array texture (one layer per cascade) for BSM sampling.
 * Matches WebGL's sampler2DArray shape more closely than a horizontal atlas:
 * pack still uses N copies, but UV remap math leaves the hot path.
 * Always recreates the texture on rebuild — WebGPU left stale GPU resources
 * after quality-preset size changes.
 *
 * Note: WebGPU's updateTexture path requires a real ArrayBufferView. A
 * `DataArrayTexture(null, …)` throws endlessly on `writeTexture`.
 */
export class ShadowCascadeAtlas {
  private texture: DataArrayTexture | null = null
  /** Stable node — only `.value` swaps when the array is recreated. */
  private readonly node: TextureNode = texture()
  private readonly dst = new Vector3()

  /** Texture node for march / host materials, or null before first rebuild. */
  getTextureNode(): TextureNode | null {
    return this.texture != null ? this.node : null
  }

  rebuild(cascadeCount: number, mapSize: number): void {
    this.texture?.dispose()
    // HalfFloat RGBA → Uint16 per channel (Three DataTexture convention).
    const data = new Uint16Array(mapSize * mapSize * cascadeCount * 4)
    const next = new DataArrayTexture(data, mapSize, mapSize, cascadeCount)
    next.format = RGBAFormat
    next.type = HalfFloatType
    next.minFilter = LinearFilter
    next.magFilter = LinearFilter
    next.generateMipmaps = false
    next.name = 'CloudsShadowCascadeArray'
    next.needsUpdate = true
    // DataArrayTexture sets isDataArrayTexture; some Three paths only check isArrayTexture.
    ;(next as Texture & { isArrayTexture?: boolean }).isArrayTexture = true
    this.texture = next
    this.node.value = next
  }

  /** Pack resolved per-cascade textures into array layers (dst.z = layer). */
  pack(
    renderer: CopyRenderer,
    sources: readonly Texture[],
    _mapSize: number
  ): void {
    if (this.texture == null) return
    if (typeof renderer.initTexture === 'function') {
      renderer.initTexture(this.texture)
    }
    // GPU copies own the contents; avoid re-uploading the empty CPU buffer.
    this.texture.needsUpdate = false
    for (let i = 0; i < sources.length; ++i) {
      this.dst.set(0, 0, i)
      renderer.copyTextureToTexture(
        sources[i],
        this.texture,
        null,
        this.dst
      )
    }
  }

  dispose(): void {
    this.texture?.dispose()
    this.texture = null
  }
}
