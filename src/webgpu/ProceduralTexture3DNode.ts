// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/ProceduralTexture3DNode.ts

import { Vector3 } from 'three'
import type { Texture3DNode } from 'three/webgpu'

import { ProceduralStorageNode } from './ProceduralStorageNode'

export abstract class ProceduralTexture3DNode extends ProceduralStorageNode<3> {
  static override get type(): string {
    return 'ProceduralTexture3DNode'
  }

  constructor(size = new Vector3(1)) {
    super(3, size, false)
  }

  getTextureNode(): Texture3DNode {
    return this.textureNode as ThreeNode
  }

  setSize(width: number, height: number, depth: number): this {
    this.setSize3D(width, height, depth)
    return this
  }
}
