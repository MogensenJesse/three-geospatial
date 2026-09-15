// src/webgpu/internal/FnLayout.ts

import type { ProxiedTuple } from 'three/src/nodes/TSL.js'
import type { FnNode } from 'three/src/nodes/tsl/TSLCore.js'
import { Fn } from 'three/tsl'
import type { NodeBuilder, Texture3DNode, TextureNode } from 'three/webgpu'

import type { Node, NodeType } from './node'

/** Struct factory from three/tsl — keep loose: layout shape varies by three version. */
type Struct = ((...args: never[]) => unknown) & {
  layout?: { name?: string | null }
}

type FnLayoutType = NodeType | Struct | 'texture' | 'texture3D'

export interface FnLayoutInput<T extends FnLayoutType = FnLayoutType> {
  name: string
  type: T
}

export interface FnLayoutDefinition<
  T extends FnLayoutType,
  Inputs extends readonly FnLayoutInput[] = []
> {
  typeOnly?: boolean
  name: string
  type: T
  inputs?: Inputs
}

type InferNodeObject<T extends FnLayoutType> = T extends NodeType
  ? Node<T>
  : T extends Struct
    ? ReturnType<T>
    : T extends 'texture'
      ? TextureNode
      : T extends 'texture3D'
        ? Texture3DNode
        : never

type InferNodeObjects<Inputs extends readonly FnLayoutInput[]> = {
  [K in keyof Inputs]: Inputs[K] extends FnLayoutInput<infer T>
    ? InferNodeObject<T>
    : never
}

type FnLayoutResult<
  T extends FnLayoutType,
  Inputs extends readonly FnLayoutInput[],
  Nodes extends readonly unknown[] = InferNodeObjects<Inputs>
> = (
  callback: (
    ...args: [] extends Nodes ? [NodeBuilder] : [Nodes, NodeBuilder]
  ) => InferNodeObject<T>
) => FnNode<ProxiedTuple<Nodes>, InferNodeObject<T>>

function transformType(type: FnLayoutType): string {
  if (typeof type === 'string') {
    return type
  }
  if (type.layout?.name == null) {
    throw new Error('Struct name is required.')
  }
  return type.layout.name
}

export function FnLayout<
  T extends FnLayoutType,
  const Inputs extends readonly FnLayoutInput[] = []
>({
  typeOnly = false,
  ...layout
}: FnLayoutDefinition<T, Inputs>): FnLayoutResult<T, Inputs> {
  return typeOnly
    ? callback => Fn(callback as never) as never
    : callback =>
        Fn(callback as never).setLayout({
          ...layout,
          type: transformType(layout.type),
          inputs:
            layout.inputs?.map(input => ({
              ...input,
              type: transformType(input.type)
            })) ?? []
        }) as never
}
