// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
// src/webgpu/temporalResolve.ts

import { float, max, min, sqrt, vec3, vec4 } from 'three/tsl'

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

export interface VarianceClipOptions {
  offsets: readonly TexelOffset[]
  sampleNeighbor: (x: number, y: number) => Vec4
  current: Vec4
  history: Vec4
  gamma: FloatNode
  /**
   * Build the clip box on rgba. Default off: rgb box, alpha copied from the
   * neighbourhood mean (shadow resolve).
   */
  clipAlpha?: boolean
  /**
   * Half-extent floor used when `clipAlpha` is set, so a flat channel (opaque
   * cloud alpha) does not clip on noise. Called with the neighbourhood mean.
   */
  minExtent?: (mean: Vec4) => Vec4
}

export interface VarianceClipResult {
  color: Vec4
  /** max(0, clipScale - 1). 0 means history was already inside the box. */
  clipAmount: FloatNode
  mean: Vec4
}

/**
 * Variance-clip `history` against `current` plus the neighbours `sampleNeighbor`
 * returns. The offset table and the sample op stay with the caller: clouds use
 * a 4-neighbour cross (clamped UV or load), shadows use an 8-neighbour box
 * (unclamped load).
 *
 * Without `clipAlpha` this is the original rgb clip, which the shadow resolve
 * depends on.
 */
export function varianceClip(options: VarianceClipOptions): Vec4 {
  if (options.clipAlpha === true) {
    return varianceClipEx(options).color
  }
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

/** Same neighbourhood as {@link varianceClip}, plus how hard the clip was. */
export function varianceClipEx(options: VarianceClipOptions): VarianceClipResult {
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
  const clampedMean = mean.clamp(minColor, maxColor).toConst()
  if (options.clipAlpha !== true) {
    return {
      color: clipAABB(clampedMean, history, minColor, maxColor),
      clipAmount: float(0),
      mean
    }
  }
  // Rgb stays on the original clip. A 4D box lets a jittering low-res alpha
  // rescale stable rgb and brings the still-camera grain back.
  const rgbClipped = clipAABB(clampedMean, history, minColor, maxColor)
  const floorExtent = options.minExtent?.(mean) ?? vec4(1e-7)
  const centerA = maxColor.a.add(minColor.a).mul(0.5).toConst()
  const extentA = max(
    maxColor.a.sub(minColor.a).mul(0.5),
    floorExtent.a
  ).toConst()
  const deltaA = rgbClipped.a.sub(centerA).toConst()
  const unitA = deltaA.abs().div(extentA).toConst()
  // Confidence only. The colour clip above stays on the original tight box.
  // A 2% floor keeps low-res noise from capping N across a cloud body.
  // Read the mean through a new vec3; swizzle methods can write back into it.
  const rgbCenter = maxColor.rgb.add(minColor.rgb).mul(0.5).toConst()
  const rgbHalf = maxColor.rgb.sub(minColor.rgb).mul(0.5).toConst()
  const rgbExtent = max(
    rgbHalf,
    vec3(mean.r, mean.g, mean.b).mul(0.02)
  )
    .add(1e-7)
    .toConst()
  const rgbUnit = history.rgb.sub(rgbCenter).div(rgbExtent).abs().toConst()
  const rgbClip = max(rgbUnit.x, max(rgbUnit.y, rgbUnit.z)).sub(1).max(0)
  return {
    color: unitA
      .greaterThan(1)
      .select(vec4(rgbClipped.rgb, centerA.add(deltaA.div(unitA))), rgbClipped),
    clipAmount: max(rgbClip, unitA.sub(1).max(0)),
    mean
  }
}

/**
 * Closest fragment plus the depth range of `center` and `offsets`. `offsets`
 * must not repeat the center. Ties keep `center`, so a sky neighbourhood whose
 * depth is `cameraFar` (above the old 1e7 sentinel) still has a real velocity.
 * Closest selection otherwise matches {@link closestDepthVelocity}.
 */
export function closestDepthVelocityRange(options: {
  offsets: readonly TexelOffset[]
  sample: (x: number, y: number) => Vec4
  center: Vec4
}): { closest: Vec4; center: Vec4; minDepth: FloatNode; maxDepth: FloatNode } {
  const closest = options.center.toVar()
  const minDepth = options.center.r.toVar()
  const maxDepth = options.center.r.toVar()
  for (const [x, y] of options.offsets) {
    const neighbor = options.sample(x, y)
    closest.assign(neighbor.r.lessThan(closest.r).select(neighbor, closest))
    minDepth.assign(min(minDepth, neighbor.r))
    maxDepth.assign(max(maxDepth, neighbor.r))
  }
  return { closest, center: options.center, minDepth, maxDepth }
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
