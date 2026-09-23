// @ts-nocheck — Three r186 TSL typings are incomplete for this module; revisit.
// src/webgpu/temporalResolve.ts

import { float, int, max, min, sqrt, texture, vec2, vec4 } from 'three/tsl'
import type { TextureNode } from 'three/webgpu'

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
  const center = maxColor.add(minColor).mul(0.5).toConst()
  const halfExtent = maxColor.sub(minColor).mul(0.5)
  const floorExtent = options.minExtent?.(mean) ?? vec4(1e-7)
  const extent = max(halfExtent, floorExtent).toConst()
  const delta = history.sub(center).toConst()
  const unit = delta.div(extent).abs().toConst()
  const maximum = max(unit.x, max(unit.y, max(unit.z, unit.w))).toConst()
  return {
    color: maximum
      .greaterThan(1)
      .select(center.add(delta.div(maximum)), history),
    clipAmount: maximum.sub(1).max(0),
    mean
  }
}

/**
 * Closest fragment plus the depth range of the same neighbourhood. `minDepth`
 * and `maxDepth` cover the sampled texels only, not `initial` (clouds pass a
 * sentinel). Closest selection matches {@link closestDepthVelocity}.
 */
export function closestDepthVelocityRange(options: {
  offsets: readonly TexelOffset[]
  sample: (x: number, y: number) => Vec4
  initial: Vec4
}): { closest: Vec4; minDepth: FloatNode; maxDepth: FloatNode } {
  const closest = options.initial.toVar()
  const minDepth = float(1e7).toVar()
  const maxDepth = float(0).toVar()
  for (const [x, y] of options.offsets) {
    const neighbor = options.sample(x, y)
    closest.assign(neighbor.r.lessThan(closest.r).select(neighbor, closest))
    minDepth.assign(min(minDepth, neighbor.r))
    maxDepth.assign(max(maxDepth, neighbor.r))
  }
  return { closest, minDepth, maxDepth }
}

/**
 * 5-tap Catmull-Rom history fetch (Jimenez). At a texel centre only the centre
 * tap survives, so a static camera matches bilinear. Negative lobes are clamped
 * away: rgb ≥ 0, alpha in 0..1.
 */
export function sampleCatmullRom(
  textureNode: TextureNode,
  uv: Node<'vec2'>,
  texelSize: Node<'vec2'>
): Vec4 {
  const samplePos = uv.div(texelSize).toConst()
  const texPos1 = samplePos.sub(0.5).floor().add(0.5).toConst()
  const f = samplePos.sub(texPos1).toConst()
  const w0 = f
    .mul(float(-0.5).add(f.mul(float(1).sub(f.mul(0.5)))))
    .toConst()
  const w1 = float(1)
    .add(f.mul(f).mul(float(-2.5).add(f.mul(1.5))))
    .toConst()
  const w2 = f
    .mul(float(0.5).add(f.mul(float(2).sub(f.mul(1.5)))))
    .toConst()
  const w3 = f
    .mul(f)
    .mul(float(-0.5).add(f.mul(0.5)))
    .toConst()
  const w12 = w1.add(w2).toConst()
  const offset12 = w2.div(w12).toConst()
  const texPos0 = texPos1.sub(1).mul(texelSize).toConst()
  const texPos3 = texPos1.add(2).mul(texelSize).toConst()
  const texPos12 = texPos1.add(offset12).mul(texelSize).toConst()
  const at = (x: Node<'float'>, y: Node<'float'>): Vec4 =>
    texture(textureNode, vec2(x, y), int(0))
  const result = at(texPos12.x, texPos0.y)
    .mul(w12.x.mul(w0.y))
    .add(at(texPos0.x, texPos12.y).mul(w0.x.mul(w12.y)))
    .add(at(texPos12.x, texPos12.y).mul(w12.x.mul(w12.y)))
    .add(at(texPos3.x, texPos12.y).mul(w3.x.mul(w12.y)))
    .add(at(texPos12.x, texPos3.y).mul(w12.x.mul(w3.y)))
    .toConst()
  return vec4(result.rgb.max(0), result.a.clamp(0, 1))
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
