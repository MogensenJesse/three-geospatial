// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
// src/webgpu/temporalResolve.ts

import { float, max, sqrt, vec4 } from 'three/tsl'

import type { Node } from './internal/node'

type Vec4 = Node<'vec4'>
type FloatNode = Node<'float'>

export type TexelOffset = readonly [number, number]

/**
 * Clip a history sample to the variance AABB of the current neighbourhood.
 * Shared by the cloud resolve and the shadow resolve.
 */
export function clipAABB(
  current: Vec4,
  history: Vec4,
  minColor: Vec4,
  maxColor: Vec4
): Vec4 {
  const center = maxColor.rgb.add(minColor.rgb).mul(0.5).toConst()
  const extent = maxColor.rgb.sub(minColor.rgb).mul(0.5).add(1e-7)
  const delta = history.sub(vec4(center, current.a)).toConst()
  const unit = delta.xyz.div(extent).abs().toConst()
  const maximum = max(unit.x, max(unit.y, unit.z)).toConst()
  return maximum
    .greaterThan(1)
    .select(vec4(center, current.a).add(delta.div(maximum)), history)
}

/**
 * Variance-clip `history` against `current` plus the neighbours `sampleNeighbor`
 * returns. The offset table and the sample op stay with the caller: clouds use
 * a 4-neighbour cross (clamped UV or load), shadows use an 8-neighbour box
 * (unclamped load).
 */
export function varianceClip(options: {
  offsets: readonly TexelOffset[]
  sampleNeighbor: (x: number, y: number) => Vec4
  current: Vec4
  history: Vec4
  gamma: FloatNode
}): Vec4 {
  const { offsets, sampleNeighbor, current, history, gamma } = options
  const moment1 = current.toVar()
  const moment2 = current.pow2().toVar()
  for (const [x, y] of offsets) {
    const neighbor = sampleNeighbor(x, y).toConst()
    moment1.addAssign(neighbor)
    moment2.addAssign(neighbor.pow2())
  }
  const sampleCount = offsets.length + 1
  const mean = moment1.div(sampleCount).toConst()
  const deviation = sqrt(moment2.div(sampleCount).sub(mean.pow2()).max(0))
    .mul(gamma)
    .toConst()
  const minColor = mean.sub(deviation).toConst()
  const maxColor = mean.add(deviation).toConst()
  return clipAABB(mean.clamp(minColor, maxColor), history, minColor, maxColor)
}

/**
 * Closest fragment in an offset neighbourhood. `initial` is the starting
 * candidate (a sentinel for clouds, the center texel for shadows). The sample
 * callback owns clamping.
 */
export function closestDepthVelocity(options: {
  offsets: readonly TexelOffset[]
  sample: (x: number, y: number) => Vec4
  initial: Vec4
}): Vec4 {
  const closest = options.initial.toVar()
  for (const [x, y] of options.offsets) {
    const neighbor = options.sample(x, y)
    closest.assign(neighbor.r.lessThan(closest.r).select(neighbor, closest))
  }
  return closest
}

/** Clouds-only hard cut: square smoothstep of UV velocity so fast pixels drop history. */
export function motionFactor(velocity: Node<'vec2'>): FloatNode {
  const speed = velocity.x.abs().add(velocity.y.abs())
  const step = speed.smoothstep(float(0.002), float(0.014))
  return step.mul(step)
}
