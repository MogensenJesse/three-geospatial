// demo/main.ts

import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import Stats from 'three/addons/libs/stats.module.js'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import ThreeRenderPipeline from 'three/src/renderers/common/RenderPipeline.js'
import { float, mix, pass, positionWorld, uniform } from 'three/tsl'
import {
  AgXToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  TimestampQuery,
  Vector2,
  Vector3,
  WebGPURenderer
} from 'three/webgpu'

import {
  type CloudsDebugOutput,
  cloudShadow,
  clouds,
  compositeClouds,
  type QualityPreset
} from '../src'
import {
  artDirectedSky,
  artDirectedSun,
  irradianceModeFromLocation,
  preethamBakeIrradiance,
  type IrradianceMode
} from './irradianceModes'
import {
  accumulatePassTiming,
  createPassTimingEma,
  formatPassStats
} from './passStats'
import { captureWgslModules, downloadWgslCapture } from './wgslCapture'
import './styles.css'

interface DemoRenderPipeline {
  outputNode: ReturnType<typeof compositeClouds>
  render(): void
  dispose(): void
}

const RenderPipeline = ThreeRenderPipeline as unknown as new (
  renderer: WebGPURenderer
) => DemoRenderPipeline

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (element == null) {
    throw new Error(`Missing required demo element: #${id}`)
  }
  return element as T
}

function showError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(reason)

  const panel = document.getElementById('error')
  const output = document.getElementById('error-message')
  const status = document.getElementById('status')
  if (panel != null && output != null) {
    panel.hidden = false
    output.textContent = message
  }
  if (status != null) {
    status.textContent = 'Initialization failed'
  }
}

async function main(): Promise<void> {
  if (!('gpu' in navigator) || navigator.gpu == null) {
    throw new Error(
      'This demo requires WebGPU. Use a current browser with WebGPU enabled.'
    )
  }

  const app = requireElement<HTMLElement>('app')
  const status = requireElement<HTMLElement>('status')
  const coverageInput = requireElement<HTMLInputElement>('coverage')
  const coverageOutput = requireElement<HTMLOutputElement>('coverage-value')
  const layerControls = [0, 1, 2].map(index => ({
    index,
    altitude: requireElement<HTMLInputElement>(`layer-${index}-altitude`),
    altitudeOut: requireElement<HTMLOutputElement>(
      `layer-${index}-altitude-value`
    ),
    height: requireElement<HTMLInputElement>(`layer-${index}-height`),
    heightOut: requireElement<HTMLOutputElement>(`layer-${index}-height-value`),
    density: requireElement<HTMLInputElement>(`layer-${index}-density`),
    densityOut: requireElement<HTMLOutputElement>(
      `layer-${index}-density-value`
    )
  }))
  const animateWeatherInput =
    requireElement<HTMLInputElement>('animate-weather')
  const qualityPresetInput = requireElement<HTMLSelectElement>('quality-preset')
  const resolutionScaleInput =
    requireElement<HTMLSelectElement>('resolution-scale')
  const resolutionScaleOutput = requireElement<HTMLOutputElement>(
    'resolution-scale-value'
  )
  const temporalUpscaleInput =
    requireElement<HTMLInputElement>('temporal-upscale')
  const shapeDetailInput = requireElement<HTMLInputElement>('shape-detail')
  const turbulenceInput = requireElement<HTMLInputElement>('turbulence')
  const cloudShadowsInput = requireElement<HTMLInputElement>('cloud-shadows')
  const sceneShadowsInput = requireElement<HTMLInputElement>('scene-shadows')
  const debugOutputInput = requireElement<HTMLSelectElement>('debug-output')
  const temporalHistoryInput =
    requireElement<HTMLInputElement>('temporal-history')
  const passStats = requireElement<HTMLElement>('pass-stats')
  const passTimingEma = createPassTimingEma()
  const sunDetailInput = requireElement<HTMLInputElement>('sun-detail')
  const sunDetailOutput = requireElement<HTMLOutputElement>('sun-detail-value')
  const marchIterationsInput =
    requireElement<HTMLInputElement>('march-iterations')
  const marchIterationsOutput = requireElement<HTMLOutputElement>(
    'march-iterations-value'
  )
  const multiScatterInput = requireElement<HTMLInputElement>('multi-scatter')
  const multiScatterOutput = requireElement<HTMLOutputElement>(
    'multi-scatter-value'
  )
  const powderScaleInput = requireElement<HTMLInputElement>('powder-scale')
  const powderScaleOutput =
    requireElement<HTMLOutputElement>('powder-scale-value')
  const groundBounceInput = requireElement<HTMLInputElement>('ground-bounce')
  const groundBounceOutput = requireElement<HTMLOutputElement>(
    'ground-bounce-value'
  )
  const phaseFunctionInput = requireElement<HTMLSelectElement>('phase-function')
  const sunInput = requireElement<HTMLInputElement>('sun-elevation')
  const irradianceModeInput =
    requireElement<HTMLSelectElement>('irradiance-mode')
  let irradianceMode: IrradianceMode = irradianceModeFromLocation()
  if (irradianceMode === 'takram') {
    console.warn(
      '[demo] irradiance=takram blocked (no atmosphere in standalone demo). Using artDirected. Compare via storybook-webgpu Clouds-Basic.'
    )
    irradianceMode = 'artDirected'
  }
  irradianceModeInput.value = irradianceMode
  const sunOutput = requireElement<HTMLOutputElement>('sun-value')
  const exposureInput = requireElement<HTMLInputElement>('exposure')
  const exposureOutput = requireElement<HTMLOutputElement>('exposure-value')

  const renderer = new WebGPURenderer({ antialias: true, trackTimestamp: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = Number(exposureInput.value)
  renderer.domElement.setAttribute('aria-label', 'Volumetric cloud scene')
  app.append(renderer.domElement)
  await renderer.init()

  const scene = new Scene()
  scene.background = new Color(0x8db5cf)

  const camera = new PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    1,
    100_000
  )
  camera.position.set(2200, 300, 3600)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(0, 750, 0)
  controls.minDistance = 250
  controls.maxDistance = 12_000
  controls.maxPolarAngle = Math.PI * 0.55
  controls.update()

  const sky = new SkyMesh() as SkyMesh & {
    cloudCoverage: { value: number }
  }
  sky.scale.setScalar(90_000)
  sky.turbidity.value = 5
  sky.rayleigh.value = 2.2
  sky.mieCoefficient.value = 0.006
  sky.mieDirectionalG.value = 0.82
  sky.cloudCoverage.value = 0
  scene.add(sky)

  const groundGeometry = new PlaneGeometry(80_000, 80_000)
  const groundMaterial = new MeshStandardNodeMaterial({
    color: 0x52634d,
    roughness: 0.95
  })
  const ground = new Mesh(groundGeometry, groundMaterial)
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)

  const landmarkGeometry = new BoxGeometry(240, 900, 240)
  const landmarkMaterial = new MeshStandardNodeMaterial({
    color: 0xb6a78f,
    roughness: 0.8
  })
  for (const [x, z, scale] of [
    [-900, -700, 0.65],
    [0, -1500, 1],
    [1100, -400, 0.45]
  ] as const) {
    const landmark = new Mesh(landmarkGeometry, landmarkMaterial)
    landmark.position.set(x, 450 * scale, z)
    landmark.scale.y = scale
    scene.add(landmark)
  }

  const grid = new GridHelper(12_000, 24, 0x83927d, 0x65715f)
  grid.position.y = 1
  scene.add(grid)

  const hemisphere = new HemisphereLight(0xcce8ff, 0x3a3026, 1.5)
  scene.add(hemisphere)

  const sunlight = new DirectionalLight(0xfff2df, 4)
  scene.add(sunlight)

  const sunDirection = new Vector3().setFromSphericalCoords(
    1,
    MathUtils.degToRad(90 - Number(sunInput.value)),
    MathUtils.degToRad(135)
  )
  const cloudNode = clouds({
    camera,
    mapOrigin: new Vector3(),
    mapSize: new Vector2(80_000, 80_000),
    worldUnitsPerMeter: 1,
    sunDirection,
    sunIrradiance: new Vector3(),
    skyIrradiance: new Vector3()
  })
  cloudNode.coverage = Number(coverageInput.value)
  const marchRenderSize = new Vector2()
  const marchOutputSize = new Vector2()
  const drawingBufferSize = new Vector2()

  const sceneShadowsEnabled = uniform(1).setName('sceneShadowsEnabled')
  const cloudShadowTransmittance = cloudShadow(cloudNode, positionWorld)
  const sceneShadowFactor = mix(
    float(1),
    cloudShadowTransmittance as never,
    sceneShadowsEnabled
  )
  groundMaterial.aoNode = sceneShadowFactor
  landmarkMaterial.aoNode = sceneShadowFactor

  const scenePass = pass(scene, camera, { samples: 0 })
  const sceneColor = scenePass.getTextureNode('output')
  const sceneDepth = scenePass.getTextureNode('depth')
  cloudNode.depthNode = sceneDepth

  const renderPipeline = new RenderPipeline(renderer)
  const compositedOutput = compositeClouds(sceneColor, cloudNode as never)
  renderPipeline.outputNode = compositedOutput

  const updateDebugOutput = (): void => {
    const mode = debugOutputInput.value as CloudsDebugOutput
    cloudNode.debugOutput = mode
    // Use cloudNode itself for diagnostics so its updateBefore (march) still runs.
    renderPipeline.outputNode =
      mode === 'none'
        ? compositedOutput
        : (cloudNode as unknown as typeof compositedOutput)
    ;(renderPipeline as { needsUpdate?: boolean }).needsUpdate = true
  }

  const updateTemporalHistory = (): void => {
    cloudNode.temporalHistoryEnabled = temporalHistoryInput.checked
  }

  let gpuRenderMs = 0
  let gpuResolveInFlight = false
  const dumpWgslButton = requireElement<HTMLButtonElement>('dump-wgsl')

  const updatePassStats = (): void => {
    const diag = cloudNode.getPassDiagnostics(marchRenderSize, marchOutputSize)
    renderer.getDrawingBufferSize(drawingBufferSize)
    accumulatePassTiming(passTimingEma, diag.timing, gpuRenderMs)
    passStats.textContent = formatPassStats(
      {
        marchRender: diag.marchRender,
        marchOutput: diag.marchOutput,
        drawingBuffer: drawingBufferSize,
        temporalUpscale: diag.temporalUpscale,
        temporalUpscaleUniform: diag.temporalUpscaleUniform,
        temporalHistory: diag.temporalHistory,
        historyValid: diag.historyValid,
        shadowEnabled: diag.shadowEnabled,
        timing: diag.timing,
        gpuRenderMs
      },
      passTimingEma
    )
  }

  dumpWgslButton.addEventListener('click', () => {
    void (async () => {
      const backend = renderer.backend as { device?: GPUDevice }
      const device = backend.device
      if (device == null) {
        status.textContent = 'WGSL dump: no GPU device yet'
        return
      }
      dumpWgslButton.disabled = true
      const prevShadows = cloudNode.shadowEnabled
      const marchMaterial = (
        cloudNode.marchNode as unknown as {
          material: { customProgramCacheKey: () => string }
        }
      ).material
      const baseKey = marchMaterial.customProgramCacheKey.bind(marchMaterial)

      const captureVariant = async (
        shadowsOn: boolean,
        label: string
      ): Promise<number> => {
        cloudNode.shadowEnabled = shadowsOn
        const nonce = 'dump-' + label + '-' + String(Date.now())
        marchMaterial.customProgramCacheKey = () => baseKey() + '|' + nonce
        cloudNode.marchNode.invalidateMaterial(true)
        status.textContent = 'Capturing WGSL (' + label + ')…'
        const result = await captureWgslModules(device, {
          recompile: () => {
            cloudNode.marchNode.invalidateMaterial(true)
          },
          render: () => {
            renderPipeline.render()
          },
          frames: 6
        })
        downloadWgslCapture(result, label)
        return result.modules.length
      }

      try {
        const onCount = await captureVariant(true, 'shadows-on')
        const offCount = await captureVariant(false, 'shadows-off')
        status.textContent =
          'WGSL dump: shadows-on ' +
          String(onCount) +
          ' + shadows-off ' +
          String(offCount) +
          ' modules (downloads + console.table)'
      } catch (err) {
        console.error(err)
        status.textContent = 'WGSL dump failed (see console)'
      } finally {
        marchMaterial.customProgramCacheKey = baseKey
        cloudNode.shadowEnabled = prevShadows
        cloudNode.marchNode.invalidateMaterial(true)
        dumpWgslButton.disabled = false
      }
    })()
  })

  const syncQualityControlsFromNode = (): void => {
    resolutionScaleInput.value = String(cloudNode.resolutionScale)
    resolutionScaleOutput.value = `${Math.round(cloudNode.resolutionScale * 100)}%`
    temporalUpscaleInput.checked = cloudNode.temporalUpscale
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
    cloudNode.environment.sunIrradiance
      .set(15, 12.5, 10)
      .multiplyScalar(0.15 + daylight * 0.85)
    cloudNode.environment.skyIrradiance
      .set(0.38, 0.5, 0.72)
      .multiplyScalar(0.35 + daylight * 0.65)

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
    multiScatterOutput.value = String(octaves)
    cloudNode.resetTemporalHistory()
  }

  const updatePowderScale = (): void => {
    const scale = Number(powderScaleInput.value)
    cloudNode.powderScale = scale
    powderScaleOutput.value = scale.toFixed(2)
    cloudNode.resetTemporalHistory()
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
  groundBounceInput.addEventListener('input', updateGroundBounce)
  phaseFunctionInput.addEventListener('change', updatePhaseFunction)
  sunInput.addEventListener('input', updateSunAndIrradiance)
  irradianceModeInput.addEventListener('change', updateIrradianceMode)
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
  artDirectedSun.copy(cloudNode.environment.sunIrradiance)
  artDirectedSky.copy(cloudNode.environment.skyIrradiance)
  applyIrradianceMode()
  updateExposure()

  const stats = new Stats()
  stats.showPanel(0)
  // Panel occupies top-left; keep the FPS widget visible on the right.
  stats.dom.style.left = 'auto'
  stats.dom.style.right = '0px'
  document.body.appendChild(stats.dom)

  const resize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    cloudNode.resetTemporalHistory()
  }
  window.addEventListener('resize', resize)

  renderer.setAnimationLoop(() => {
    stats.begin()
    controls.update()
    renderPipeline.render()
    if (!gpuResolveInFlight) {
      gpuResolveInFlight = true
      void renderer
        .resolveTimestampsAsync(TimestampQuery.RENDER)
        .then(ms => {
          if (typeof ms === 'number' && Number.isFinite(ms)) {
            gpuRenderMs = ms
          }
        })
        .catch(() => {
          /* timestamp-query optional */
        })
        .finally(() => {
          gpuResolveInFlight = false
        })
    }
    updatePassStats()
    stats.end()
  })
  status.textContent = 'WebGPU active'
  updatePassStats()

  window.addEventListener(
    'beforeunload',
    () => {
      renderer.setAnimationLoop(null)
      window.removeEventListener('resize', resize)
      coverageInput.removeEventListener('input', updateCoverage)
      // Layer control listeners are anonymous; left until page unload.
      animateWeatherInput.removeEventListener('change', updateAnimation)
      qualityPresetInput.removeEventListener('change', updateQualityPreset)
      resolutionScaleInput.removeEventListener('change', updateResolutionScale)
      temporalUpscaleInput.removeEventListener('change', updateTemporalUpscale)
      shapeDetailInput.removeEventListener('change', updateShapeDetail)
      turbulenceInput.removeEventListener('change', updateTurbulence)
      cloudShadowsInput.removeEventListener('change', updateCloudShadows)
      sceneShadowsInput.removeEventListener('change', updateSceneShadows)
      debugOutputInput.removeEventListener('change', updateDebugOutput)
      temporalHistoryInput.removeEventListener('change', updateTemporalHistory)
      sunDetailInput.removeEventListener('input', updateSunDetail)
      marchIterationsInput.removeEventListener('input', updateMarchIterations)
      multiScatterInput.removeEventListener('input', updateMultiScatter)
      powderScaleInput.removeEventListener('input', updatePowderScale)
      groundBounceInput.removeEventListener('input', updateGroundBounce)
      phaseFunctionInput.removeEventListener('change', updatePhaseFunction)
      sunInput.removeEventListener('input', updateSunAndIrradiance)
      irradianceModeInput.removeEventListener('change', updateIrradianceMode)
      exposureInput.removeEventListener('input', updateExposure)
      stats.dom.remove()
      controls.dispose()
      renderPipeline.dispose()
      scenePass.dispose()
      cloudNode.dispose()
      sky.geometry.dispose()
      sky.material.dispose()
      groundGeometry.dispose()
      groundMaterial.dispose()
      landmarkGeometry.dispose()
      landmarkMaterial.dispose()
      renderer.dispose()
    },
    { once: true }
  )
}

void main().catch(showError)
