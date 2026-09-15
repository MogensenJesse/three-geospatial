// demo/wgslCapture.ts
// Phase A2: hook device.createShaderModule to dump generated WGSL once.

export interface WgslModuleSummary {
  label: string
  bytes: number
  loops: number
  ifs: number
  textureSample: number
  textureSampleLevel: number
  hasVogelHint: boolean
  hasMultipleScatterHint: boolean
}

export interface WgslCaptureResult {
  modules: Array<{ label: string; code: string }>
  summaries: WgslModuleSummary[]
}

type CreateShaderModule = (
  descriptor: GPUShaderModuleDescriptor
) => GPUShaderModule

function summarize(label: string, code: string): WgslModuleSummary {
  return {
    label,
    bytes: code.length,
    loops: (code.match(/\bfor\s*\(/g) ?? []).length,
    ifs: (code.match(/\bif\s*\(/g) ?? []).length,
    textureSample: (code.match(/\btextureSample\b/g) ?? []).length,
    textureSampleLevel: (code.match(/\btextureSampleLevel\b/g) ?? []).length,
    hasVogelHint: /vogel|goldenAngle|GOLDEN/i.test(code),
    hasMultipleScatterHint: /multipl|scatter|octave/i.test(code)
  }
}

function guessLabel(code: string, fallback: string): string {
  if (code.includes('CloudsMarch') || code.includes('cloudsMarch')) {
    return code.includes('@vertex') || code.includes('fn vertex')
      ? 'vertex_CloudsMarch'
      : 'fragment_CloudsMarch'
  }
  if (code.includes('CloudsResolve')) return 'CloudsResolve'
  if (/shadow|Shadow|BSM|vogel/i.test(code)) return 'ShadowRelated'
  return fallback
}

/**
 * Hook `createShaderModule`, force a recompile, then **render several frames**
 * while the hook is still installed (compile happens on draw, not on needsUpdate).
 */
export async function captureWgslModules(
  device: GPUDevice,
  options: {
    recompile: () => void
    render: () => void
    frames?: number
  }
): Promise<WgslCaptureResult> {
  const frames = options.frames ?? 4
  const captured: Array<{ label: string; code: string }> = []
  const original = device.createShaderModule.bind(device) as CreateShaderModule

  device.createShaderModule = ((descriptor: GPUShaderModuleDescriptor) => {
    const code = typeof descriptor.code === 'string' ? descriptor.code : ''
    const label =
      descriptor.label && descriptor.label.length > 0
        ? descriptor.label
        : guessLabel(code, `module_${captured.length}`)
    if (code.length > 0) {
      captured.push({ label, code })
    }
    return original(descriptor)
  }) as GPUDevice['createShaderModule']

  try {
    options.recompile()
    for (let i = 0; i < frames; ++i) {
      options.render()
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
  } finally {
    device.createShaderModule = original as GPUDevice['createShaderModule']
  }

  const seen = new Set<string>()
  const modules: Array<{ label: string; code: string }> = []
  for (const m of captured) {
    const key = `${m.code.length}:${m.code.slice(0, 64)}:${m.code.slice(-64)}`
    if (seen.has(key)) continue
    seen.add(key)
    modules.push(m)
  }

  return {
    modules,
    summaries: modules.map(m => summarize(m.label, m.code))
  }
}

/** Download each module as a .wgsl file and log summaries. */
export function downloadWgslCapture(
  result: WgslCaptureResult,
  filePrefix = ''
): void {
  if (result.summaries.length === 0) {
    console.warn(
      'WGSL dump: no shader modules captured' +
        (filePrefix ? ` (${filePrefix})` : '') +
        '. Compile may be cached — try again after a hard refresh.'
    )
    return
  }
  console.log('WGSL dump' + (filePrefix ? ` [${filePrefix}]` : ''))
  console.table(result.summaries)
  const prefix =
    filePrefix.length > 0 ? filePrefix.replace(/[^\w.-]+/g, '_') + '_' : ''
  for (const [i, mod] of result.modules.entries()) {
    const blob = new Blob([mod.code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download =
      prefix +
      String(i).padStart(2, '0') +
      '_' +
      mod.label.replace(/[^\w.-]+/g, '_') +
      '.wgsl'
    a.click()
    URL.revokeObjectURL(url)
  }
}
