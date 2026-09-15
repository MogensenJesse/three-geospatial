// demo/passStats.ts
// Demo-only pass-stats HUD — keeps diagnostic formatting out of main.ts.

import type { Vector2 } from 'three'
import type { CloudsPassTiming } from '../src'

export interface PassStatsSnapshot {
  marchRender: Vector2
  marchOutput: Vector2
  drawingBuffer: Vector2
  temporalUpscale: boolean
  temporalUpscaleUniform: number
  temporalHistory: boolean
  historyValid: number
  shadowEnabled: boolean
  timing: CloudsPassTiming
  /** GPU render-pass ms from WebGPU timestamp queries (when available). */
  gpuRenderMs?: number
}

export interface PassTimingEma {
  produce: number
  shadowResolve: number
  atlas: number
  shadow: number
  march: number
  resolve: number
  total: number
  gpuRender: number
}

export function createPassTimingEma(): PassTimingEma {
  return {
    produce: 0,
    shadowResolve: 0,
    atlas: 0,
    shadow: 0,
    march: 0,
    resolve: 0,
    total: 0,
    gpuRender: 0
  }
}

const ema = (prev: number, next: number, a = 0.1): number =>
  prev === 0 ? next : prev * (1 - a) + next * a

/** Update EMA totals from the latest CPU pass timings (+ optional GPU). */
export function accumulatePassTiming(
  dest: PassTimingEma,
  timing: CloudsPassTiming,
  gpuRenderMs = 0
): void {
  dest.produce = ema(dest.produce, timing.produce)
  dest.shadowResolve = ema(dest.shadowResolve, timing.shadowResolve)
  dest.atlas = ema(dest.atlas, timing.atlas)
  dest.shadow = ema(dest.shadow, timing.shadow)
  dest.march = ema(dest.march, timing.march)
  dest.resolve = ema(dest.resolve, timing.resolve)
  dest.total = ema(dest.total, timing.total)
  if (gpuRenderMs > 0) {
    dest.gpuRender = ema(dest.gpuRender, gpuRenderMs)
  }
}

/** One-line HUD string for #pass-stats. */
export function formatPassStats(
  snap: PassStatsSnapshot,
  timingEma: PassTimingEma
): string {
  const onOff = (v: boolean): string => (v ? 'on' : 'off')
  const ms = (n: number): string => n.toFixed(1)
  const gpu =
    timingEma.gpuRender > 0 ? ` · gpu ${ms(timingEma.gpuRender)}` : ''
  return (
    `March RT ${snap.marchRender.x}×${snap.marchRender.y} · ` +
    `out ${snap.marchOutput.x}×${snap.marchOutput.y} · ` +
    `draw ${snap.drawingBuffer.x}×${snap.drawingBuffer.y} · ` +
    `TAAU ${onOff(snap.temporalUpscale)} · tu ${snap.temporalUpscaleUniform} · ` +
    `hist ${onOff(snap.temporalHistory)} · hv ${snap.historyValid} · ` +
    `shadows ${onOff(snap.shadowEnabled)} · ` +
    `ms p ${ms(timingEma.produce)} / sr ${ms(timingEma.shadowResolve)} / a ${ms(timingEma.atlas)} / ` +
    `m ${ms(timingEma.march)} / r ${ms(timingEma.resolve)} / Σ ${ms(timingEma.total)}` +
    gpu
  )
}
