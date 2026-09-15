// src/webgpu/internal/node.ts

import type { Node as ThreeNode } from 'three/webgpu'
import { Node as ThreeNodeValue } from 'three/webgpu'

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
 * Common numeric/vector node kinds that carry math helpers in @types/three
 * r186. Using this as the default keeps `.add` / `.mul` / `.saturate` etc.
 * available when a call site does not pin a narrower type.
 */
type MathNodeType =
  | 'float'
  | 'int'
  | 'uint'
  | 'bool'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'mat2'
  | 'mat3'
  | 'mat4'
  | 'color'

/**
 * Typed TSL node. Narrow `T` when you can; the default is a math-capable
 * union so procedural shader code typechecks under Three r186+.
 */
export type Node<T extends NodeType = MathNodeType> = ThreeNode<T>

export const Node = ThreeNodeValue
