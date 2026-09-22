// src/webgpu/worleyFbm.ts

import { vec2, vec3, vec4 } from 'three/tsl'

import { FnLayout } from './internal/FnLayout'
import { stackableWorleyNoise } from './stackableNoise'

/**
 * Four-octave Worley FBM. `cellCount` is the first octave: shape passes 8
 * (8, 16, 32, 64) and detail passes 2 (2, 4, 8, 16).
 */
export const worleyFbm = /*#__PURE__*/ FnLayout({
  name: 'worleyFbm',
  type: 'float',
  inputs: [
    { name: 'point', type: 'vec3' },
    { name: 'cellCount', type: 'float' }
  ]
})(([point, cellCount]) => {
  const noise = vec4(
    stackableWorleyNoise(point, cellCount),
    stackableWorleyNoise(point, cellCount.mul(2)),
    stackableWorleyNoise(point, cellCount.mul(4)),
    stackableWorleyNoise(point, cellCount.mul(8))
  ).oneMinus()
  const fbm = vec3(
    noise.xyz.dot(vec3(0.625, 0.25, 0.125)),
    noise.yzw.dot(vec3(0.625, 0.25, 0.125)),
    noise.zw.dot(vec2(0.75, 0.25))
  )
  return fbm.dot(vec3(0.625, 0.25, 0.125))
})
