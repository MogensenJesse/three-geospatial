// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
// src/webgpu/ProceduralStorageNode.ts

import {
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  UnsignedByteType,
  type Vector2,
  type Vector3
} from 'three'
import {
  Fn,
  If,
  instanceIndex,
  Return,
  textureStore,
  uvec2,
  uvec3,
  vec2,
  vec3
} from 'three/tsl'
import type { Node as ThreeNode } from 'three/webgpu'
import {
  type NodeBuilder,
  Storage3DTexture,
  StorageTexture,
  TempNode,
  type Texture3DNode,
  type TextureNode
} from 'three/webgpu'

import type { Node } from './internal/node'
import { outputTexture, outputTexture3D } from './internal/OutputTextureNode'

type StorageFor<D extends 2 | 3> = D extends 2
  ? StorageTexture
  : Storage3DTexture

/**
 * One-shot compute fill for a 2D or 3D storage texture. Dimension is a
 * constructor argument so mipmaps are decided before the texture exists.
 * Subclass field initializers run too late under useDefineForClassFields.
 */
export abstract class ProceduralStorageNode<
  D extends 2 | 3 = 2 | 3
> extends TempNode {
  static get type(): string {
    return 'ProceduralStorageNode'
  }

  readonly dimension: D

  /**
   * When true, a 2D storage texture keeps a mip chain and auto-updates after
   * compute writes (local weather / turbulence). 3D shape/detail stay false.
   */
  protected enableMipmaps = false

  readonly texture: StorageFor<D>

  /** When true, the next setup() dispatches a one-shot compute fill. */
  needsCompute = true

  protected readonly textureNode: TextureNode | Texture3DNode

  constructor(dimension: D, size: Vector2 | Vector3, enableMipmaps = false) {
    super(null)
    this.dimension = dimension
    this.enableMipmaps = enableMipmaps
    this.texture = (
      dimension === 2
        ? this.createStorageTexture()
        : this.createStorage3DTexture()
    ) as StorageFor<D>
    this.textureNode =
      dimension === 2
        ? outputTexture(this, this.texture)
        : outputTexture3D(this, this.texture)
    if (dimension === 2) {
      const plane = size as Vector2
      this.setSize2D(plane.x, plane.y)
    } else {
      const volume = size as Vector3
      this.setSize3D(volume.x, volume.y, volume.z)
    }
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

  protected createStorage3DTexture(): Storage3DTexture {
    const texture = new Storage3DTexture(1, 1, 1)
    texture.type = UnsignedByteType
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.wrapR = RepeatWrapping
    texture.colorSpace = NoColorSpace
    texture.generateMipmaps = false
    texture.name = (this.constructor as typeof Node).type
    return texture
  }

  protected setSize2D(width: number, height: number): void {
    const texture = this.texture as StorageTexture
    if (texture.width !== width || texture.height !== height) {
      texture.setSize(width, height, texture.depth)
      this.needsCompute = true
    }
  }

  protected setSize3D(width: number, height: number, depth: number): void {
    const texture = this.texture as Storage3DTexture
    if (
      texture.width !== width ||
      texture.height !== height ||
      texture.depth !== depth
    ) {
      texture.setSize(width, height, depth)
      this.needsCompute = true
    }
  }

  protected abstract setupOutputNode(coord: Node<'vec2'> | Node<'vec3'>): Node

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    if (this.dimension === 2) {
      this.dispatch2D(builder)
    } else {
      this.dispatch3D(builder)
    }
    return super.setup(builder) as ThreeNode | null | undefined
  }

  private dispatch2D(builder: NodeBuilder): void {
    const { width, height } = this.texture
    if (!this.needsCompute) {
      return
    }
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

  private dispatch3D(builder: NodeBuilder): void {
    const { width, height, depth } = this.texture
    if (!this.needsCompute) {
      return
    }
    this.needsCompute = false

    const computeNode = Fn(() => {
      const id = instanceIndex
      const x = id.mod(width)
      const y = id.div(width).mod(height)
      const z = id.div(width * height)
      const size = uvec3(width, height, depth)
      If(uvec3(x, y, z).greaterThanEqual(size).any(), () => {
        Return()
      })
      const textureCoordinate = vec3(x, y, z)
      // Texel centers, matching WebGL Procedural3DTextureBase layer UVW:
      // point = vec3(vUv.xy, (layer + 0.5) / size).
      const uvw = textureCoordinate.add(0.5).div(vec3(width, height, depth))
      textureStore(this.texture, textureCoordinate, this.setupOutputNode(uvw))
    })().compute(width * height * depth, [4, 4, 4])

    void builder.renderer.compute(computeNode)
  }

  override dispose(): void {
    this.texture.dispose()
    super.dispose()
  }
}
