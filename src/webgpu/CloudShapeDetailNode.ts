// src/webgpu/CloudShapeDetailNode.ts

import { Vector3 } from 'three/webgpu'

import { CLOUD_SHAPE_DETAIL_TEXTURE_SIZE } from '../constants'
import type { Node } from './internal/node'
import { ProceduralTexture3DNode } from './ProceduralTexture3DNode'
import { worleyFbm } from './worleyFbm'

export class CloudShapeDetailNode extends ProceduralTexture3DNode {
  static override get type(): string {
    return 'CloudShapeDetailNode'
  }

  constructor(size = new Vector3().setScalar(CLOUD_SHAPE_DETAIL_TEXTURE_SIZE)) {
    super(size)
  }

  protected override setupOutputNode(uvw: Node<'vec3'>): Node {
    return worleyFbm(uvw, 2)
  }
}
