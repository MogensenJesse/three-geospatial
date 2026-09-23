// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
// src/webgpu/temporalResolve.ts

import { float, max, min, sqrt, vec4 } from 'three/tsl'

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

/** 3×3 neighbourhood, center included. */
export const closestOffsets: readonly TexelOffset[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 0],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
]

/** Same 3×3 without the center. The cloud resolve loads that texel itself. */
export const closestNeighbourOffsets: readonly TexelOffset[] =
  closestOffsets.filter(([x, y]) => x !== 0 || y !== 0)

export interface VarianceClipOptions {
  offsets: readonly TexelOffset[]
  sampleNeighbor: (x: number, y: number) => Vec4
  current: Vec4
  history: Vec4
  gamma: FloatNode
}

interface NeighbourhoodBox {
  mean: Vec4
  minColor: Vec4
  maxColor: Vec4
}

/** Mean and gamma-scaled variance box of `current` plus `offsets`. */
function neighbourhoodBox(options: {
  offsets: readonly TexelOffset[]
  sampleNeighbor: (x: number, y: number) => Vec4
  current: Vec4
  gamma: FloatNode
}): NeighbourhoodBox {
  const { offsets, sampleNeighbor, current, gamma } = options
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
  return {
    mean,
    minColor: mean.sub(deviation).toConst(),
    maxColor: mean.add(deviation).toConst()
  }
}

/**
 * Rgb variance clip. The caller owns the offset table and the sample op.
 * Shadows pass an 8-neighbour box and unclamped loads. Alpha is copied from
 * the neighbourhood mean.
 */
export function varianceClip(options: VarianceClipOptions): Vec4 {
  const { mean, minColor, maxColor } = neighbourhoodBox(options)
  return clipAABB(
    mean.clamp(minColor, maxColor),
    options.history,
    minColor,
    maxColor
  )
}

export interface CloudVarianceClipResult {
  color: Vec4
  mean: Vec4
}

/**
 * Cloud clip. Rgb uses {@link clipAABB}. Alpha is projected on its own so a
 * jittering low-res alpha cannot rescale stable rgb. `alphaExtentFloor` keeps
 * a flat opaque neighbourhood from clipping on noise.
 */
export function cloudVarianceClip(options: {
  offsets: readonly TexelOffset[]
  sampleNeighbor: (x: number, y: number) => Vec4
  current: Vec4
  history: Vec4
  gamma: FloatNode
  alphaExtentFloor: number
}): CloudVarianceClipResult {
  const { mean, minColor, maxColor } = neighbourhoodBox(options)
  const rgbClipped = clipAABB(
    mean.clamp(minColor, maxColor),
    options.history,
    minColor,
    maxColor
  )
  const centerA = maxColor.a.add(minColor.a).mul(0.5).toConst()
  const extentA = max(
    maxColor.a.sub(minColor.a).mul(0.5),
    float(options.alphaExtentFloor)
  ).toConst()
  const deltaA = rgbClipped.a.sub(centerA).toConst()
  const unitA = deltaA.abs().div(extentA).toConst()
  return {
    color: unitA
      .greaterThan(1)
      .select(vec4(rgbClipped.rgb, centerA.add(deltaA.div(unitA))), rgbClipped),
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
 * candidate (the center texel for shadows). The sample callback owns clamping.
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
