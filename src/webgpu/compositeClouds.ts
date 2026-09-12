// src/webgpu/compositeClouds.ts

import { vec4 } from 'three/tsl'

import type { Node } from './internal/node'

/**
 * Composites premultiplied cloud RGBA over a premultiplied scene color.
 *
 * `result.rgb = scene.rgb * (1 - clouds.a) + clouds.rgb`
 */
export const compositeClouds = (
  sceneColor: Node<'vec4'>,
  cloudColor: Node<'vec4'>
): Node<'vec4'> => {
  const remaining = cloudColor.a.oneMinus()
  return vec4(
    sceneColor.rgb.mul(remaining).add(cloudColor.rgb),
    cloudColor.a.add(sceneColor.a.mul(remaining))
  )
}
