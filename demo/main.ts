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
import { bindCloudControls } from './bindCloudControls'
import { requireElement, showError } from './dom'
import {
  artDirectedSky,
  artDirectedSun,
  type IrradianceMode,
  irradianceModeFromLocation,
  preethamBakeIrradiance
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

  const cloudControls = bindCloudControls({
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
    irradianceMode,
    irradianceModeInput,
    landmarkMaterial,
    layerControls,
    marchIterationsInput,
    marchIterationsOutput,
    multiScatterInput,
    multiScatterOutput,
    phaseFunctionInput,
    powderScaleInput,
    powderScaleOutput,
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
    turbulenceInput,
    updateDebugOutput,
    updateTemporalHistory
  })

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
      cloudControls.dispose()
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
