import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/internal/OutputTextureNode.ts

import type { Texture } from 'three'
import {
  type Node,
  type NodeBuilder,
  Texture3DNode,
  TextureNode
} from 'three/webgpu'

interface MatrixUpdateNode {
  setUpdateMatrix(value: boolean): void
}

export class OutputTextureNode extends TextureNode {
  static get type(): string {
    return 'CloudsOutputTextureNode'
  }

  constructor(
    readonly owner: Node,
    texture: Texture
  ) {
    super(texture)
    ;(this as unknown as MatrixUpdateNode).setUpdateMatrix(false)
  }

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    this.owner.build(builder)
    return super.setup(builder)
  }

  override clone(): this {
    // @ts-expect-error Subclasses preserve this constructor contract.
    const node = new this.constructor(this.owner, this.value)
    node.uvNode = this.uvNode
    node.levelNode = this.levelNode
    node.biasNode = this.biasNode
    node.sampler = this.sampler
    node.depthNode = this.depthNode
    node.compareNode = this.compareNode
    node.gradNode = this.gradNode
    return node
  }
}

export class OutputTexture3DNode extends Texture3DNode {
  static get type(): string {
    return 'CloudsOutputTexture3DNode'
  }

  constructor(
    readonly owner: Node,
    texture: Texture
  ) {
    super(texture)
    ;(this as unknown as MatrixUpdateNode).setUpdateMatrix(false)
  }

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    this.owner.build(builder)
    return super.setup(builder)
  }

  override clone(): this {
    // @ts-expect-error Subclasses preserve this constructor contract.
    const node = new this.constructor(this.owner, this.value)
    node.uvNode = this.uvNode
    node.levelNode = this.levelNode
    node.biasNode = this.biasNode
    node.sampler = this.sampler
    node.depthNode = this.depthNode
    node.compareNode = this.compareNode
    node.gradNode = this.gradNode
    return node
  }
}

export const outputTexture = (
  ...args: ConstructorParameters<typeof OutputTextureNode>
): OutputTextureNode => new OutputTextureNode(...args)

export const outputTexture3D = (
  ...args: ConstructorParameters<typeof OutputTexture3DNode>
): OutputTexture3DNode => new OutputTexture3DNode(...args)
