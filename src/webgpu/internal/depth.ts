// src/webgpu/internal/depth.ts

import {
  logarithmicDepthToViewZ,
  orthographicDepthToViewZ,
  perspectiveDepthToViewZ
} from 'three/tsl'

import type { Node } from './node'

export interface DepthOptions {
  perspective?: boolean
  logarithmic?: boolean
}

export const depthToViewZ = (
  depth: Node<'float'>,
  near: Node<'float'>,
  far: Node<'float'>,
  { perspective = true, logarithmic = false }: DepthOptions = {}
): Node<'float'> =>
  logarithmic
    ? logarithmicDepthToViewZ(depth, near, far)
    : perspective
      ? perspectiveDepthToViewZ(depth, near, far)
      : orthographicDepthToViewZ(depth, near, far)
