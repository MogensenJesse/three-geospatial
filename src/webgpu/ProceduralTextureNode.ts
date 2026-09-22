// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/ProceduralTextureNode.ts

import { Vector2 } from 'three'
import type { TextureNode } from 'three/webgpu'

import { ProceduralStorageNode } from './ProceduralStorageNode'

export abstract class ProceduralTextureNode extends ProceduralStorageNode<2> {
  static override get type(): string {
    return 'ProceduralTextureNode'
  }

  constructor(size = new Vector2(1), enableMipmaps = false) {
    super(2, size, enableMipmaps)
  }

  getTextureNode(): TextureNode {
    return this.textureNode as ThreeNode
  }

  setSize(width: number, height: number): this {
    this.setSize2D(width, height)
    return this
  }
}
