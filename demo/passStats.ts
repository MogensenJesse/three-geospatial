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
}

export interface PassTimingEma {
  shadow: number
  march: number
  resolve: number
  total: number
}

export function createPassTimingEma(): PassTimingEma {
  return { shadow: 0, march: 0, resolve: 0, total: 0 }
}

const ema = (prev: number, next: number, a = 0.1): number =>
  prev === 0 ? next : prev * (1 - a) + next * a

/** Update EMA totals from the latest CPU pass timings. */
export function accumulatePassTiming(
  dest: PassTimingEma,
  timing: CloudsPassTiming
): void {
  dest.shadow = ema(dest.shadow, timing.shadow)
  dest.march = ema(dest.march, timing.march)
  dest.resolve = ema(dest.resolve, timing.resolve)
  dest.total = ema(dest.total, timing.total)
}

/** One-line HUD string for #pass-stats. */
export function formatPassStats(
  snap: PassStatsSnapshot,
  timingEma: PassTimingEma
): string {
  const onOff = (v: boolean): string => (v ? 'on' : 'off')
  const ms = (n: number): string => n.toFixed(1)
  return (
    `March RT ${snap.marchRender.x}×${snap.marchRender.y} · ` +
    `out ${snap.marchOutput.x}×${snap.marchOutput.y} · ` +
    `draw ${snap.drawingBuffer.x}×${snap.drawingBuffer.y} · ` +
    `TAAU ${onOff(snap.temporalUpscale)} · tu ${snap.temporalUpscaleUniform} · ` +
    `hist ${onOff(snap.temporalHistory)} · hv ${snap.historyValid} · ` +
    `shadows ${onOff(snap.shadowEnabled)} · ` +
    `ms sh ${ms(timingEma.shadow)} / m ${ms(timingEma.march)} / r ${ms(timingEma.resolve)} / Σ ${ms(timingEma.total)}`
  )
}
