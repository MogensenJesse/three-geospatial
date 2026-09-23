// demo/bindCloudControls.ts

import { MathUtils, Vector3 } from 'three/webgpu'

import type { QualityPreset } from '../src'

export interface CloudControlsDeps {
  animateWeatherInput: any
  cloudNode: any
  cloudShadowsInput: any
  coverageInput: any
  coverageOutput: HTMLOutputElement
  debugOutputInput: any
  exposureInput: any
  exposureOutput: HTMLOutputElement
  groundBounceInput: any
  groundBounceOutput: HTMLOutputElement
  groundMaterial: any
  hemisphere: any
  landmarkMaterial: any
  layerControls: any
  marchIterationsInput: any
  marchIterationsOutput: HTMLOutputElement
  multiScatterInput: any
  multiScatterOutput: HTMLOutputElement
  phaseFunctionInput: any
  powderScaleInput: any
  powderScaleOutput: HTMLOutputElement
  skyIntensityInput: any
  skyIntensityOutput: HTMLOutputElement
  skyLightScaleInput: any
  skyLightScaleOutput: HTMLOutputElement
  qualityPresetInput: any
  renderer: any
  resolutionScaleInput: any
  resolutionScaleOutput: HTMLOutputElement
  sceneShadowsEnabled: any
  sceneShadowsInput: any
  shapeDetailInput: any
  sky: any
  sunDetailInput: any
  sunDetailOutput: HTMLOutputElement
  sunDirection: any
  sunInput: any
  sunOutput: HTMLOutputElement
  sunlight: any
  temporalHistoryInput: any
  temporalUpscaleInput: any
  stbnJitterFreezeInput: any
  turbulenceInput: any
  updateDebugOutput: () => void
  updateTemporalHistory: any
}

/**
 * Cheap Preetham-ish bake from sun elevation (degrees).
 * Isolates chromaticity vs march without a full Preetham sky model.
 */
function preethamBakeIrradiance(
  elevationDeg: number,
  outSun: Vector3,
  outSky: Vector3
): void {
  const elev = Math.max(-5, Math.min(90, elevationDeg))
  const daylight = Math.max(0, Math.min(1, elev / 90))
  const soft = Math.pow(daylight, 0.65)
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

export function bindCloudControls(deps: CloudControlsDeps): {
  dispose: () => void
} {
  const {
    animateWeatherInput,
    cloudNode,
    cloudShadowsInput,
    coverageInput,
    coverageOutput,
    debugOutputInput,
    exposureInput,
    exposureOutput,
    groundBounceInput,
    groundBounceOutput,
    groundMaterial,
    hemisphere,
    landmarkMaterial,
    layerControls,
    marchIterationsInput,
    marchIterationsOutput,
    multiScatterInput,
    multiScatterOutput,
    phaseFunctionInput,
    powderScaleInput,
    powderScaleOutput,
    skyIntensityInput,
    skyIntensityOutput,
    skyLightScaleInput,
    skyLightScaleOutput,
    qualityPresetInput,
    renderer,
    resolutionScaleInput,
    resolutionScaleOutput,
    sceneShadowsEnabled,
    sceneShadowsInput,
    shapeDetailInput,
    sky,
    sunDetailInput,
    sunDetailOutput,
    sunDirection,
    sunInput,
    sunOutput,
    sunlight,
    temporalHistoryInput,
    temporalUpscaleInput,
    stbnJitterFreezeInput,
    turbulenceInput,
    updateDebugOutput,
    updateTemporalHistory
  } = deps

  const syncQualityControlsFromNode = (): void => {
    resolutionScaleInput.value = String(cloudNode.resolutionScale)
    resolutionScaleOutput.value = `${Math.round(cloudNode.resolutionScale * 100)}%`
    temporalUpscaleInput.checked = cloudNode.temporalUpscale
    stbnJitterFreezeInput.checked =
      new URLSearchParams(location.search).get('stbnJitter') === '0'
    shapeDetailInput.checked = cloudNode.shapeDetailEnabled
    turbulenceInput.checked = cloudNode.turbulenceEnabled
    sunDetailInput.value = String(cloudNode.secondaryIterationCount)
    sunDetailOutput.value = String(
      Math.round(Number(cloudNode.secondaryIterationCount))
    )
    marchIterationsInput.value = String(
      cloudNode.marchNode.march.maxIterationCount.value
    )
    marchIterationsOutput.value = String(
      Math.round(Number(cloudNode.marchNode.march.maxIterationCount.value))
    )
    multiScatterInput.value = String(
      cloudNode.marchNode.march.multiScatteringOctaves.value
    )
    multiScatterOutput.value = String(
      Math.round(Number(cloudNode.marchNode.march.multiScatteringOctaves.value))
    )
    powderScaleInput.value = String(cloudNode.powderScale)
    powderScaleOutput.value = cloudNode.powderScale.toFixed(2)
    skyLightScaleInput.value = String(cloudNode.skyLightScale)
    skyLightScaleOutput.value = Number(cloudNode.skyLightScale).toFixed(2)
    skyIntensityOutput.value = Number(skyIntensityInput.value).toFixed(2)
    groundBounceInput.value = String(cloudNode.groundBounceScale)
    groundBounceOutput.value = cloudNode.groundBounceScale.toFixed(2)
    phaseFunctionInput.value = cloudNode.phaseFunctionMode
  }

  const updateQualityPreset = (): void => {
    cloudNode.setQualityPreset(qualityPresetInput.value as QualityPreset)
    syncQualityControlsFromNode()
    // CloudShadowNode may have captured atlas at setup; force host rebind.
    groundMaterial.needsUpdate = true
    landmarkMaterial.needsUpdate = true
  }

  const updateCoverage = (): void => {
    const coverage = Number(coverageInput.value)
    cloudNode.coverage = coverage
    coverageOutput.value = coverage.toFixed(2)
  }

  const syncLayerControlsFromNode = (): void => {
    for (const ctrl of layerControls) {
      const layer = cloudNode.cloudLayers[ctrl.index]
      ctrl.altitude.value = String(layer.altitude)
      ctrl.altitudeOut.value = String(Math.round(layer.altitude))
      ctrl.height.value = String(layer.height)
      ctrl.heightOut.value = String(Math.round(layer.height))
      ctrl.density.value = String(layer.densityScale)
      ctrl.densityOut.value =
        layer.densityScale < 0.01
          ? layer.densityScale.toFixed(3)
          : layer.densityScale.toFixed(2)
    }
  }

  const updateLayerFromControls = (index: number): void => {
    const ctrl = layerControls[index]
    const layer = cloudNode.cloudLayers[index]
    layer.altitude = Number(ctrl.altitude.value)
    layer.height = Number(ctrl.height.value)
    layer.densityScale = Number(ctrl.density.value)
    ctrl.altitudeOut.value = String(Math.round(layer.altitude))
    ctrl.heightOut.value = String(Math.round(layer.height))
    ctrl.densityOut.value =
      layer.densityScale < 0.01
        ? layer.densityScale.toFixed(3)
        : layer.densityScale.toFixed(2)
    cloudNode.resetTemporalHistory()
  }

  const updateAnimation = (): void => {
    cloudNode.localWeatherVelocity.set(
      animateWeatherInput.checked ? 0.001 : 0,
      0
    )
    cloudNode.resetTemporalHistory()
  }

  const updateResolutionScale = (): void => {
    const resolutionScale = Number(resolutionScaleInput.value)
    cloudNode.resolutionScale = resolutionScale
    resolutionScaleOutput.value = `${Math.round(resolutionScale * 100)}%`
  }

  const updateTemporalUpscale = (): void => {
    cloudNode.temporalUpscale = temporalUpscaleInput.checked
  }

  const applyStbnJitterFreeze = (): void => {
    // Checked / ?stbnJitter=0 → scale 0 (frozen). Default off = STBN live.
    cloudNode.stepJitterScale = stbnJitterFreezeInput.checked ? 0 : 1
    cloudNode.resetTemporalHistory()
  }

  const updateStbnJitterFreeze = (): void => {
    const url = new URL(location.href)
    if (stbnJitterFreezeInput.checked) {
      url.searchParams.set('stbnJitter', '0')
    } else {
      url.searchParams.delete('stbnJitter')
    }
    history.replaceState(null, '', url)
    applyStbnJitterFreeze()
  }

  const updateShapeDetail = (): void => {
    cloudNode.shapeDetailEnabled = shapeDetailInput.checked
    cloudNode.resetTemporalHistory()
  }

  const updateTurbulence = (): void => {
    cloudNode.turbulenceEnabled = turbulenceInput.checked
    cloudNode.resetTemporalHistory()
  }

  const updateCloudShadows = (): void => {
    cloudNode.shadowEnabled = cloudShadowsInput.checked
  }

  const updateSceneShadows = (): void => {
    sceneShadowsEnabled.value = sceneShadowsInput.checked ? 1 : 0
  }

  const applyIrradiance = (): void => {
    const env = cloudNode.environment
    const elev = Number(sunInput.value)
    const skyIntensity = Number(skyIntensityInput.value)
    preethamBakeIrradiance(elev, env.sunIrradiance, env.skyIrradiance)
    env.skyIrradiance.multiplyScalar(skyIntensity)
    cloudNode.resetTemporalHistory()
  }

  const updateSunAndIrradiance = (): void => {
    updateSun()
    applyIrradiance()
  }

  const updateSun = (): void => {
    const elevation = Number(sunInput.value)
    sunOutput.value = `${Math.round(elevation)}°`

    sunDirection.setFromSphericalCoords(
      1,
      MathUtils.degToRad(90 - elevation),
      MathUtils.degToRad(135)
    )
    sky.sunPosition.value.copy(sunDirection)

    const daylight = MathUtils.smoothstep(sunDirection.y, 0, 0.65)
    cloudNode.environment.sunDirection.copy(sunDirection)

    sunlight.position.copy(sunDirection).multiplyScalar(10_000)
    sunlight.intensity = 1 + daylight * 4
    hemisphere.intensity = 0.5 + daylight
    cloudNode.resetTemporalHistory()
  }

  const updateSunDetail = (): void => {
    const samples = Number(sunDetailInput.value)
    cloudNode.secondaryIterationCount = samples
    sunDetailOutput.value = String(samples)
    cloudNode.resetTemporalHistory()
  }

  const updateMarchIterations = (): void => {
    const iterations = Number(marchIterationsInput.value)
    cloudNode.marchNode.march.maxIterationCount.value = iterations
    marchIterationsOutput.value = String(iterations)
    cloudNode.resetTemporalHistory()
  }

  const updateMultiScatter = (): void => {
    const octaves = Number(multiScatterInput.value)
    cloudNode.marchNode.march.multiScatteringOctaves.value = octaves
    cloudNode.marchNode.invalidateMaterial()
    multiScatterOutput.value = String(octaves)
    cloudNode.resetTemporalHistory()
  }

  const updatePowderScale = (): void => {
    const scale = Number(powderScaleInput.value)
    cloudNode.powderScale = scale
    powderScaleOutput.value = scale.toFixed(2)
    cloudNode.resetTemporalHistory()
  }

  const updateSkyLightScale = (): void => {
    const scale = Number(skyLightScaleInput.value)
    cloudNode.skyLightScale = scale
    skyLightScaleOutput.value = scale.toFixed(2)
    cloudNode.resetTemporalHistory()
  }

  const updateSkyIntensity = (): void => {
    skyIntensityOutput.value = Number(skyIntensityInput.value).toFixed(2)
    applyIrradiance()
  }

  const updateGroundBounce = (): void => {
    const scale = Number(groundBounceInput.value)
    cloudNode.groundBounceScale = scale
    groundBounceOutput.value = scale.toFixed(2)
    cloudNode.resetTemporalHistory()
  }

  const updatePhaseFunction = (): void => {
    cloudNode.phaseFunctionMode = phaseFunctionInput.value as
      | 'approximate'
      | 'accurate'
    cloudNode.resetTemporalHistory()
  }

  const updateExposure = (): void => {
    const exposure = Number(exposureInput.value)
    renderer.toneMappingExposure = exposure
    exposureOutput.value = exposure.toFixed(2)
  }

  coverageInput.addEventListener('input', updateCoverage)
  for (const ctrl of layerControls) {
    const idx = ctrl.index
    const onLayer = (): void => {
      updateLayerFromControls(idx)
    }
    ctrl.altitude.addEventListener('input', onLayer)
    ctrl.height.addEventListener('input', onLayer)
    ctrl.density.addEventListener('input', onLayer)
  }
  animateWeatherInput.addEventListener('change', updateAnimation)
  qualityPresetInput.addEventListener('change', updateQualityPreset)
  resolutionScaleInput.addEventListener('change', updateResolutionScale)
  temporalUpscaleInput.addEventListener('change', updateTemporalUpscale)
  stbnJitterFreezeInput.addEventListener('change', updateStbnJitterFreeze)
  shapeDetailInput.addEventListener('change', updateShapeDetail)
  turbulenceInput.addEventListener('change', updateTurbulence)
  cloudShadowsInput.addEventListener('change', updateCloudShadows)
  sceneShadowsInput.addEventListener('change', updateSceneShadows)
  debugOutputInput.addEventListener('change', updateDebugOutput)
  temporalHistoryInput.addEventListener('change', updateTemporalHistory)
  sunDetailInput.addEventListener('input', updateSunDetail)
  marchIterationsInput.addEventListener('input', updateMarchIterations)
  multiScatterInput.addEventListener('input', updateMultiScatter)
  powderScaleInput.addEventListener('input', updatePowderScale)
  skyLightScaleInput.addEventListener('input', updateSkyLightScale)
  skyIntensityInput.addEventListener('input', updateSkyIntensity)
  groundBounceInput.addEventListener('input', updateGroundBounce)
  phaseFunctionInput.addEventListener('change', updatePhaseFunction)
  sunInput.addEventListener('input', updateSunAndIrradiance)
  exposureInput.addEventListener('input', updateExposure)
  updateCoverage()
  syncLayerControlsFromNode()
  updateAnimation()
  updateQualityPreset()
  updateCloudShadows()
  updateSceneShadows()
  updateDebugOutput()
  temporalHistoryInput.checked = true
  updateTemporalHistory()
  updateSun()
  applyIrradiance()
  applyStbnJitterFreeze()
  updateExposure()

  return {
    dispose: () => {
      // Demo page unload owns full teardown; listeners die with the document.
    }
  }
}
