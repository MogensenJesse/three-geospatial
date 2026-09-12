// src/webgpu/internal/node.ts

import { Node as ThreeNode } from 'three/webgpu'

export type NodeType =
  | 'float'
  | 'int'
  | 'uint'
  | 'bool'
  | 'vec2'
  | 'ivec2'
  | 'uvec2'
  | 'bvec2'
  | 'vec3'
  | 'ivec3'
  | 'uvec3'
  | 'bvec3'
  | 'vec4'
  | 'ivec4'
  | 'uvec4'
  | 'bvec4'
  | 'mat2'
  | 'mat3'
  | 'mat4'
  | 'color'

/**
 * Annotation-only TSL node type. Three's current TSL declarations do not
 * consistently preserve value dimensions through every operation.
 */
export type Node<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  T extends NodeType = NodeType
> = ThreeNode

export const Node = ThreeNode
