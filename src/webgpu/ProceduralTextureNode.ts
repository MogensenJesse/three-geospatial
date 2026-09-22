// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/ProceduralTextureNode.ts

import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  UnsignedByteType,
  Vector2
} from 'three'
import {
  Fn,
  If,
  instanceIndex,
  Return,
  textureStore,
  uvec2,
  vec2
} from 'three/tsl'
import {
  type NodeBuilder,
  StorageTexture,
  TempNode,
  type TextureNode
} from 'three/webgpu'

import type { Node } from './internal/node'
import { outputTexture } from './internal/OutputTextureNode'

export abstract class ProceduralTextureNode extends TempNode {
  static get type(): string {
    return 'ProceduralTextureNode'
  }

  /**
   * When true, the storage texture keeps a mip chain and auto-updates after
   * compute writes (local weather / turbulence). Shape/detail stay false.
   * Set from the constructor argument before the storage texture is created.
   * A subclass field initializer would run too late under useDefineForClassFields.
   */
  protected enableMipmaps = false

  readonly texture: StorageTexture

  /** When true, the next setup() dispatches a one-shot compute fill. */
  needsCompute = true

  private readonly textureNode: TextureNode

  constructor(size = new Vector2(1), enableMipmaps = false) {
    super(null)
    this.enableMipmaps = enableMipmaps
    this.texture = this.createStorageTexture()
    this.textureNode = outputTexture(this, this.texture)
    this.setSize(size.x, size.y)
  }

  protected createStorageTexture(): StorageTexture {
    const texture = new StorageTexture(1, 1)
    texture.type = UnsignedByteType
    texture.magFilter = LinearFilter
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.colorSpace = NoColorSpace
    if (this.enableMipmaps) {
      texture.generateMipmaps = true
      // Runtime WebGPU StorageTexture flag; typings lag the implementation.
      ;(
        texture as StorageTexture & { mipmapsAutoUpdate: boolean }
      ).mipmapsAutoUpdate = true
      texture.minFilter = LinearMipmapLinearFilter
    } else {
      texture.generateMipmaps = false
      texture.minFilter = LinearFilter
    }

    texture.name = (this.constructor as typeof Node).type

    return texture
  }

  getTextureNode(): TextureNode {
    return this.textureNode as ThreeNode
  }

  setSize(width: number, height: number): this {
    if (this.texture.width !== width || this.texture.height !== height) {
      this.texture.setSize(width, height, this.texture.depth)
      this.needsCompute = true
    }
    return this
  }

  protected abstract setupOutputNode(uv: Node<'vec2'>): Node

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    const { width, height } = this.texture

    // Match WebGL ProceduralTextureBase.needsRender: fill once unless dirtied.
    // Rebuild the compute graph each setup so NodeBuilder stays current; only
    // the GPU dispatch is gated.
    if (this.needsCompute) {
      this.needsCompute = false

      const computeNode = Fn(() => {
        const id = instanceIndex
        const x = id.mod(width)
        const y = id.div(width)
        const size = uvec2(width, height)
        If(uvec2(x, y).greaterThanEqual(size).any(), () => {
          Return()
        })
        const textureCoordinate = vec2(x, y)
        // Texel centers, matching WebGL ProceduralTexture UV convention.
        const uv = textureCoordinate.add(0.5).div(vec2(width, height))

        textureStore(this.texture, textureCoordinate, this.setupOutputNode(uv))
      })().compute(width * height, [8, 8, 1])

      void builder.renderer.compute(computeNode)
    }

    return super.setup(builder) as ThreeNode | null | undefined
  }

  override dispose(): void {
    this.texture.dispose()
    super.dispose()
  }
}
