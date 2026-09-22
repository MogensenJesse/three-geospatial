// demo/irradianceModes.ts — demo-only sun/sky irradiance A/B helpers.
import { Vector3 } from 'three'

export type IrradianceMode = 'artDirected' | 'preethamBake' | 'takram'

/** Snapshot filled once from CloudsEnvironment at demo boot. */
export const artDirectedSun = new Vector3(1, 1, 1)
export const artDirectedSky = new Vector3(0.15, 0.15, 0.15)

/**
 * Cheap Preetham-ish bake from sun elevation (degrees).
 * Isolates chromaticity vs march without Takram LUTs / full Preetham sky.
 */
export function preethamBakeIrradiance(
  elevationDeg: number,
  outSun: Vector3,
  outSky: Vector3
): void {
  // Match art-directed peak energy (~15/12.5/10 sun, ~0.38/0.5/0.72 sky)
  // while keeping a mild Preetham-ish warm→cool chrominance curve.
  const elev = Math.max(-5, Math.min(90, elevationDeg))
  const daylight = Math.max(0, Math.min(1, elev / 90))
  const soft = Math.pow(daylight, 0.65)
  const sunScale = 0.15 + 0.85 * soft // multiplies into ~15 peak
  outSun
    .set(15 * (1.05 - 0.1 * soft), 12.5, 10 * (0.85 + 0.2 * soft))
    .multiplyScalar(sunScale / 1.0)
  // Rebuild explicitly for clarity / stable energy
  outSun.set(
    15 * (1.08 - 0.12 * soft) * (0.15 + 0.85 * soft),
    12.5 * (0.95 + 0.05 * soft) * (0.15 + 0.85 * soft),
    10 * (0.75 + 0.3 * soft) * (0.15 + 0.85 * soft)
  )
  const skyScale = 0.35 + 0.65 * soft
  outSky.set(0.38 * skyScale, 0.5 * skyScale, 0.72 * skyScale)
  if (elev < 0) {
    outSun.multiplyScalar(0.05)
    outSky.multiplyScalar(0.35)
  }
}

export function parseIrradianceMode(
  raw: string | null | undefined
): IrradianceMode {
  if (raw === 'preethamBake' || raw === 'takram' || raw === 'artDirected') {
    return raw
  }
  return 'preethamBake' // ADR: match SkyMesh fill energy; artDirected sky=0.15 was crushing volumes
}

export function irradianceModeFromLocation(
  search = typeof location !== 'undefined' ? location.search : ''
): IrradianceMode {
  try {
    return parseIrradianceMode(new URLSearchParams(search).get('irradiance'))
  } catch {
    return 'preethamBake'
  }
}
