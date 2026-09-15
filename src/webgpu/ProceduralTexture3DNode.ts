// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/ProceduralTexture3DNode.ts

import {
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  UnsignedByteType,
  Vector3
} from 'three'
import {
  Fn,
  If,
  instanceIndex,
  Return,
  textureStore,
  uvec3,
  vec3
} from 'three/tsl'
import {
  type NodeBuilder,
  Storage3DTexture,
  TempNode,
  type Texture3DNode
} from 'three/webgpu'

import type { Node } from './internal/node'
import { outputTexture3D } from './internal/OutputTextureNode'

export abstract class ProceduralTexture3DNode extends TempNode {
  static get type(): string {
    return 'ProceduralTexture3DNode'
  }

  readonly texture = this.createStorage3DTexture()

  /** When true, the next setup() dispatches a one-shot compute fill. */
  needsCompute = true

  private readonly textureNode: Texture3DNode

  constructor(size = new Vector3(1)) {
    super(null)
    this.textureNode = outputTexture3D(this, this.texture)
    this.setSize(size.x, size.y, size.z)
  }

  protected createStorage3DTexture(name?: string): Storage3DTexture {
    const texture = new Storage3DTexture(1, 1, 1)
    texture.type = UnsignedByteType
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.wrapR = RepeatWrapping
    texture.colorSpace = NoColorSpace
    texture.generateMipmaps = false

    const typeName = (this.constructor as typeof Node).type
    texture.name = name != null ? `${typeName}.${name}` : typeName

    return texture
  }

  getTextureNode(): Texture3DNode {
    return this.textureNode as ThreeNode
  }

  setSize(width: number, height: number, depth: number): this {
    if (
      this.texture.width !== width ||
      this.texture.height !== height ||
      this.texture.depth !== depth
    ) {
      this.texture.setSize(width, height, depth)
      this.needsCompute = true
    }
    return this
  }

  protected abstract setupOutputNode(
    uvw: Node<'vec3'>,
    builder: NodeBuilder
  ): Node

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    const { width, height, depth } = this.texture

    // Match WebGL Procedural3DTextureBase.needsRender: fill once unless dirtied.
    // Rebuild the compute graph each setup so NodeBuilder stays current; only
    // the GPU dispatch is gated.
    if (this.needsCompute) {
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

        textureStore(
          this.texture,
          textureCoordinate,
          this.setupOutputNode(uvw, builder)
        )
      })().compute(width * height * depth, [4, 4, 4])

      void builder.renderer.compute(computeNode)
    }

    return super.setup(builder) as ThreeNode | null | undefined
  }

  override dispose(): void {
    this.texture.dispose()
    super.dispose()
  }
}
