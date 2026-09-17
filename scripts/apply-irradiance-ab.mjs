#!/usr/bin/env node
/**
 * Apply demo irradiance A/B on webgpu-clouds package root (HP-JM).
 * cwd must be D:\three-geospatial (or the packed package root with demo/).
 *
 * Modes: artDirected | preethamBake | takram (stub)
 * Query: ?irradiance=<mode>
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const write = (rel, content) => {
  fs.writeFileSync(path.join(root, rel), content.replace(/\r\n/g, '\n'), 'utf8')
  console.log('wrote', rel)
}
const mustInclude = (src, needle, label) => {
  if (!src.includes(needle)) {
    throw new Error(`missing needle for ${label}: ${JSON.stringify(needle.slice(0, 160))}`)
  }
}

if (!fs.existsSync(path.join(root, 'demo/main.ts'))) {
  throw new Error(`demo/main.ts not found in ${root} — run from webgpu-clouds package root`)
}

// --- demo/irradianceModes.ts ---
{
  const rel = 'demo/irradianceModes.ts'
  if (fs.existsSync(path.join(root, rel)) && read(rel).includes('preethamBakeIrradiance')) {
    console.log('skip', rel)
  } else {
    write(
      rel,
      `// demo/irradianceModes.ts — demo-only sun/sky irradiance A/B helpers.
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
  const elev = Math.max(-5, Math.min(90, elevationDeg))
  const t = Math.max(0, elev) / 90
  const sunScale = 0.15 + 1.35 * Math.pow(t, 0.65)
  outSun.set(
    sunScale * (1.15 - 0.25 * t),
    sunScale * (0.85 + 0.15 * t),
    sunScale * (0.55 + 0.45 * t)
  )
  const skyScale = 0.08 + 0.35 * Math.pow(t, 0.5)
  outSky.set(
    skyScale * (0.45 + 0.2 * t),
    skyScale * (0.55 + 0.25 * t),
    skyScale * (0.85 + 0.15 * t)
  )
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
  return 'artDirected'
}

export function irradianceModeFromLocation(
  search = typeof location !== 'undefined' ? location.search : ''
): IrradianceMode {
  try {
    return parseIrradianceMode(new URLSearchParams(search).get('irradiance'))
  } catch {
    return 'artDirected'
  }
}
`
    )
  }
}

// --- index.html ---
{
  let html = read('index.html')
  if (html.includes('id="irradiance-mode"')) {
    console.log('skip index.html irradiance-mode')
  } else {
    const block = `
        <label>
          <span>Irradiance mode</span>
          <select id="irradiance-mode">
            <option value="artDirected" selected>Art-directed</option>
            <option value="preethamBake">Preetham bake</option>
            <option value="takram" disabled>Takram (needs atmosphere dep)</option>
          </select>
        </label>
`
    let inserted = false
    for (const summary of [
      '<summary id="diagnostics-heading">Diagnostics</summary>',
      '<summary>Diagnostics</summary>'
    ]) {
      if (html.includes(summary)) {
        html = html.replace(summary, summary + '\n' + block)
        inserted = true
        break
      }
    }
    if (!inserted) {
      const sunLabel = html.indexOf('id="sun-elevation"')
      if (sunLabel < 0) throw new Error('index.html: no Diagnostics / sun-elevation anchor')
      const labelStart = html.lastIndexOf('<label', sunLabel)
      if (labelStart < 0) throw new Error('index.html: sun-elevation label not found')
      html = html.slice(0, labelStart) + block + html.slice(labelStart)
    }
    write('index.html', html)
  }
}

// --- demo/main.ts ---
{
  let main = read('demo/main.ts')
  if (main.includes('applyIrradianceMode') || main.includes('./irradianceModes')) {
    console.log('skip demo/main.ts (already wired)')
  } else {
    const srcImport = main.match(/import\s*\{[^}]+\}\s*from\s*'\.\.\/src'/)
    if (!srcImport || srcImport.index == null) {
      throw new Error("demo/main.ts: missing import from '../src'")
    }
    const at = srcImport.index + srcImport[0].length
    main =
      main.slice(0, at) +
      `\nimport {\n  artDirectedSky,\n  artDirectedSun,\n  irradianceModeFromLocation,\n  preethamBakeIrradiance,\n  type IrradianceMode\n} from './irradianceModes'` +
      main.slice(at)

    const sunInputNeedle =
      "const sunInput = requireElement<HTMLInputElement>('sun-elevation')"
    mustInclude(main, sunInputNeedle, 'sunInput')
    main = main.replace(
      sunInputNeedle,
      `${sunInputNeedle}
  const irradianceModeInput =
    requireElement<HTMLSelectElement>('irradiance-mode')
  let irradianceMode: IrradianceMode = irradianceModeFromLocation()
  if (irradianceMode === 'takram') {
    console.warn(
      '[demo] irradiance=takram blocked (no atmosphere in standalone demo). Using artDirected. Compare via storybook-webgpu Clouds-Basic.'
    )
    irradianceMode = 'artDirected'
  }
  irradianceModeInput.value = irradianceMode`
    )

    const applyFn = `
  const applyIrradianceMode = (): void => {
    const env = cloudNode.environment
    const elev = Number(sunInput.value)
    if (irradianceMode === 'preethamBake') {
      preethamBakeIrradiance(elev, env.sunIrradiance, env.skyIrradiance)
    } else {
      env.sunIrradiance.copy(artDirectedSun)
      env.skyIrradiance.copy(artDirectedSky)
    }
    cloudNode.resetTemporalHistory()
  }

  const updateIrradianceMode = (): void => {
    irradianceMode = irradianceModeInput.value as IrradianceMode
    if (irradianceMode === 'takram') {
      console.warn(
        '[demo] takram mode blocked — falling back to artDirected.'
      )
      irradianceMode = 'artDirected'
      irradianceModeInput.value = 'artDirected'
    }
    const url = new URL(location.href)
    url.searchParams.set('irradiance', irradianceMode)
    history.replaceState(null, '', url)
    applyIrradianceMode()
  }

  const updateSunAndIrradiance = (): void => {
    updateSun()
    applyIrradianceMode()
  }
`

    if (main.includes('  const updateSun = (): void => {')) {
      main = main.replace(
        '  const updateSun = (): void => {',
        applyFn + '\n  const updateSun = (): void => {'
      )
    } else if (/const updateSun\s*=\s*\(\)\s*:\s*void\s*=>\s*\{/.test(main)) {
      main = main.replace(
        /const updateSun\s*=\s*\(\)\s*:\s*void\s*=>\s*\{/,
        applyFn + '\n  const updateSun = (): void => {'
      )
    } else {
      throw new Error('demo/main.ts: missing updateSun')
    }

    mustInclude(main, "sunInput.addEventListener('input', updateSun)", 'sun listener')
    main = main.replace(
      "sunInput.addEventListener('input', updateSun)",
      `sunInput.addEventListener('input', updateSunAndIrradiance)
  irradianceModeInput.addEventListener('change', updateIrradianceMode)`
    )

    if (main.includes("sunInput.removeEventListener('input', updateSun)")) {
      main = main.replace(
        "sunInput.removeEventListener('input', updateSun)",
        `sunInput.removeEventListener('input', updateSunAndIrradiance)
      irradianceModeInput.removeEventListener('change', updateIrradianceMode)`
      )
    }

    // Snapshot art-directed baselines + Pantheon-like history off, then apply.
    const boot = `
  artDirectedSun.copy(cloudNode.environment.sunIrradiance)
  artDirectedSky.copy(cloudNode.environment.skyIrradiance)
  const maybeHistory = cloudNode as { temporalHistoryEnabled?: boolean }
  if (typeof maybeHistory.temporalHistoryEnabled === 'boolean') {
    maybeHistory.temporalHistoryEnabled = false
  }
  applyIrradianceMode()
`
    if (main.includes('  updateSun()\n  updateExposure()')) {
      main = main.replace(
        '  updateSun()\n  updateExposure()',
        `  updateSun()\n${boot}  updateExposure()`
      )
    } else if (/\n  updateSun\(\)\n/.test(main)) {
      main = main.replace('\n  updateSun()\n', `\n  updateSun()\n${boot}`)
    } else {
      console.warn('warn: add applyIrradianceMode boot manually after updateSun()')
    }

    write('demo/main.ts', main)
  }
}

console.log('irradiance A/B apply complete')
console.log('Then: pnpm dev → ?irradiance=artDirected | preethamBake (history off if API present)')
