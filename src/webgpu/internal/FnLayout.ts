// src/webgpu/internal/FnLayout.ts

import type { ProxiedTuple } from 'three/src/nodes/TSL.js'
import type { FnNode } from 'three/src/nodes/tsl/TSLCore.js'
import { Fn } from 'three/tsl'
import type { NodeBuilder } from 'three/webgpu'

import type { Node, NodeType } from './node'

export interface FnLayoutInput<T extends NodeType = NodeType> {
  name: string
  type: T
}

export interface FnLayoutDefinition<
  T extends NodeType,
  Inputs extends readonly FnLayoutInput[] = []
> {
  name: string
  type: T
  inputs?: Inputs
}

type InferNodeObjects<Inputs extends readonly FnLayoutInput[]> = {
  [K in keyof Inputs]: Inputs[K] extends FnLayoutInput<infer T>
    ? Node<T>
    : never
}

type FnLayoutResult<
  T extends NodeType,
  Inputs extends readonly FnLayoutInput[],
  Nodes extends readonly unknown[] = InferNodeObjects<Inputs>
> = (
  callback: (
    ...args: [] extends Nodes ? [NodeBuilder] : [Nodes, NodeBuilder]
  ) => Node<T>
) => FnNode<ProxiedTuple<Nodes>, Node<T>>

export function FnLayout<
  T extends NodeType,
  const Inputs extends readonly FnLayoutInput[] = []
>(layout: FnLayoutDefinition<T, Inputs>): FnLayoutResult<T, Inputs> {
  return callback =>
    Fn(callback as never).setLayout({
      name: layout.name,
      type: layout.type,
      inputs:
        layout.inputs?.map(input => ({
          name: input.name,
          type: input.type
        })) ?? []
    }) as never
}
