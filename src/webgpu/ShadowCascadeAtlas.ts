// src/webgpu/ShadowCascadeAtlas.ts

import {
  HalfFloatType,
  LinearFilter,
  RenderTarget,
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
 * Horizontal cascade atlas [c0|c1|c2…] for cheap single-bind BSM sampling.
 * Always recreates the RT on resize — WebGPU `setSize` left a stale GPU
 * texture after quality-preset switches.
 */
export class ShadowCascadeAtlas {
  private target: RenderTarget | null = null
  /** Stable node — only `.value` swaps when the RT is recreated. */
  private readonly node: TextureNode = texture()
  private readonly dst = new Vector3()

  /** Texture node for march / host materials, or null before first rebuild. */
  getTextureNode(): TextureNode | null {
    return this.target != null ? this.node : null
  }

  rebuild(cascadeCount: number, mapSize: number): void {
    this.target?.dispose()
    this.target = new RenderTarget(mapSize * cascadeCount, mapSize, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    this.target.texture.minFilter = LinearFilter
    this.target.texture.magFilter = LinearFilter
    this.target.texture.generateMipmaps = false
    this.target.texture.name = 'CloudsShadowAtlas'
    this.node.value = this.target.texture
  }

  /** Pack resolved per-cascade textures into the horizontal atlas. */
  pack(
    renderer: CopyRenderer,
    sources: readonly Texture[],
    mapSize: number
  ): void {
    if (this.target == null) return
    if (typeof renderer.initTexture === 'function') {
      renderer.initTexture(this.target.texture)
    }
    for (let i = 0; i < sources.length; ++i) {
      this.dst.set(i * mapSize, 0, 0)
      renderer.copyTextureToTexture(
        sources[i],
        this.target.texture,
        null,
        this.dst
      )
    }
  }

  dispose(): void {
    this.target?.dispose()
    this.target = null
  }
}
