// demo/stabilityProbe.ts
// Demo-only temporal-stability probe. Reads a centred crop of the resolved
// cloud buffer and reports mean |Δ luminance| between consecutive frames.
// Later ghosting phases must match a static-camera run of this within noise.

import type { RenderTarget, WebGPURenderer } from 'three/webgpu'

/** Frames rendered before scoring, so the number is steady-state, not startup. */
const WARMUP_FRAMES = 48
const CROP = 256

export interface CloudsStabilityReport {
  /** Consecutive frame pairs scored (after warmup). */
  frames: number
  warmup: number
  cropSize: number
  /** Mean |Δ luminance| per pixel, averaged over the scored pairs. */
  meanAbsLuminanceDelta: number
  maxAbsLuminanceDelta: number
  nonFinitePixels: number
  temporalHistory: boolean
  temporalUpscale: boolean
}

export interface DemoFrameGate {
  /** While set, the animation loop renders a frame only when this returns true. */
  allowRender: (() => boolean) | null
  afterRender: (() => void) | null
}

export interface StabilityProbeHost {
  renderer: WebGPURenderer
  getOutputTarget: () => RenderTarget
  /** Throws when the camera or weather is moving. */
  assertStatic: () => void
  getMode: () => { temporalHistory: boolean; temporalUpscale: boolean }
}

function float16(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const fraction = bits & 0x3ff
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024)
  }
  if (exponent === 31) {
    return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Half-float RGBA readback. Row stride matches WebGPU's 256-byte copy alignment,
 * and the last row is unpadded (three.js `copyTextureToBuffer`).
 */
function decodeLuminance(
  raw: Uint16Array,
  width: number,
  height: number
): { lum: Float64Array; nonFinite: number } {
  const bytesPerTexel = 8
  const rowU16 = (Math.ceil((width * bytesPerTexel) / 256) * 256) / 2
  const lastRowU16 = (width * bytesPerTexel) / 2
  const expected = (height - 1) * rowU16 + lastRowU16
  if (raw.length !== expected) {
    throw new Error(
      `Cloud readback length ${raw.length} does not match a ${width}×${height} half-float crop (expected ${expected}).`
    )
  }
  const lum = new Float64Array(width * height)
  let nonFinite = 0
  for (let y = 0; y < height; ++y) {
    const row = y * rowU16
    for (let x = 0; x < width; ++x) {
      const offset = row + x * 4
      const value = luminance(
        float16(raw[offset] ?? 0),
        float16(raw[offset + 1] ?? 0),
        float16(raw[offset + 2] ?? 0)
      )
      lum[y * width + x] = value
      if (!Number.isFinite(value)) nonFinite += 1
    }
  }
  return { lum, nonFinite }
}

function nextRenderedFrame(gate: DemoFrameGate): Promise<void> {
  return new Promise(resolve => {
    gate.allowRender = () => true
    gate.afterRender = () => {
      gate.allowRender = () => false
      gate.afterRender = null
      resolve()
    }
  })
}

async function measure(
  gate: DemoFrameGate,
  host: StabilityProbeHost,
  frames: number
): Promise<CloudsStabilityReport> {
  gate.allowRender = () => false
  const mode = host.getMode()
  let previous: Float64Array | null = null
  let cropSize = CROP
  let sum = 0
  let maxDelta = 0
  let nonFinitePixels = 0
  let scored = 0

  for (let frame = 0; frame < WARMUP_FRAMES + frames; ++frame) {
    await nextRenderedFrame(gate)
    const target = host.getOutputTarget()
    cropSize = Math.min(CROP, target.width, target.height)
    if (cropSize < 1) {
      throw new Error('Resolved cloud target has no pixels to read.')
    }
    const x = Math.floor((target.width - cropSize) / 2)
    const y = Math.floor((target.height - cropSize) / 2)
    const raw = await host.renderer.readRenderTargetPixelsAsync(
      target,
      x,
      y,
      cropSize,
      cropSize
    )
    if (!(raw instanceof Uint16Array)) {
      throw new Error(
        `Expected half-float readback (Uint16Array), received ${raw.constructor.name}.`
      )
    }
    const decoded = decodeLuminance(raw, cropSize, cropSize)
    nonFinitePixels += decoded.nonFinite
    if (previous != null && frame >= WARMUP_FRAMES) {
      const count = decoded.lum.length
      let pairSum = 0
      for (let i = 0; i < count; ++i) {
        const current = decoded.lum[i] ?? 0
        const prior = previous[i] ?? 0
        if (!Number.isFinite(current) || !Number.isFinite(prior)) continue
        const delta = Math.abs(current - prior)
        pairSum += delta
        if (delta > maxDelta) maxDelta = delta
      }
      sum += pairSum / count
      scored += 1
    }
    previous = decoded.lum
  }

  return {
    frames: scored,
    warmup: WARMUP_FRAMES,
    cropSize,
    meanAbsLuminanceDelta: sum / scored,
    maxAbsLuminanceDelta: maxDelta,
    nonFinitePixels,
    temporalHistory: mode.temporalHistory,
    temporalUpscale: mode.temporalUpscale
  }
}

/** Installs `window.cloudsStability(frames = 64)`. */
export function installStabilityProbe(
  gate: DemoFrameGate,
  host: StabilityProbeHost
): void {
  let running = false
  const cloudsStability = (frames = 64): Promise<CloudsStabilityReport> => {
    if (running) {
      return Promise.reject(new Error('cloudsStability is already running.'))
    }
    if (!Number.isInteger(frames) || frames < 2) {
      return Promise.reject(
        new Error('cloudsStability frames must be an integer >= 2.')
      )
    }
    try {
      host.assertStatic()
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error))
      )
    }
    running = true
    return measure(gate, host, frames).finally(() => {
      running = false
      gate.allowRender = null
      gate.afterRender = null
    })
  }
  ;(
    window as Window & {
      cloudsStability?: (frames?: number) => Promise<CloudsStabilityReport>
    }
  ).cloudsStability = cloudsStability
}
