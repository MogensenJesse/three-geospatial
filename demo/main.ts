// demo/main.ts

import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import Stats from 'three/addons/libs/stats.module.js'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { WaterMesh } from 'three/addons/objects/WaterMesh.js'
import ThreeRenderPipeline from 'three/src/renderers/common/RenderPipeline.js'
import { float, mix, pass, positionWorld, texture3D, uniform } from 'three/tsl'
import {
  AgXToneMapping,
  BoxGeometry,
  Color,
  Data3DTexture,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardNodeMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  Scene,
  TextureLoader,
  TimestampQuery,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGPURenderer
} from 'three/webgpu'

import {
  type CloudsDebugOutput,
  cloudShadow,
  clouds,
  compositeClouds
} from '../src'
import { bindCloudControls } from './bindCloudControls'
import { demoArt } from './demoArt'
import { requireElement, showError } from './dom'
import {
  accumulatePassTiming,
  createPassTimingEma,
  formatPassStats
} from './passStats'
import {
  type DemoFrameGate,
  installStabilityProbe
} from './stabilityProbe'
import './styles.css'

interface DemoRenderPipeline {
  outputNode: ReturnType<typeof compositeClouds>
  render(): void
  dispose(): void
}

const RenderPipeline = ThreeRenderPipeline as unknown as new (
  renderer: WebGPURenderer
) => DemoRenderPipeline

const STBN_TEXTURE_WIDTH = 128
const STBN_TEXTURE_HEIGHT = 128
const STBN_TEXTURE_DEPTH = 64

async function loadStbnTexture(url: string): Promise<Data3DTexture> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load STBN: ${response.status} ${url}`)
  }
  const data = new Uint8Array(await response.arrayBuffer())
  const texture = new Data3DTexture(
    data,
    STBN_TEXTURE_WIDTH,
    STBN_TEXTURE_HEIGHT,
    STBN_TEXTURE_DEPTH
  )
  texture.type = UnsignedByteType
  texture.format = RedFormat
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.needsUpdate = true
  return texture
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
  const stbnJitterFreezeInput =
    requireElement<HTMLInputElement>('stbn-jitter-freeze')
  const showPassStats = new URLSearchParams(location.search).has('stats')
  const passStats = showPassStats ? document.createElement('p') : null
  if (passStats != null) {
    passStats.id = 'pass-stats'
    passStats.className = 'status'
    passStats.setAttribute('aria-live', 'polite')
    passStats.textContent = 'Pass sizes: —'
    requireElement<HTMLElement>('diagnostics').append(passStats)
  }
  const passTimingEma = showPassStats ? createPassTimingEma() : null
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
  const skyLightScaleInput = requireElement<HTMLInputElement>('sky-light-scale')
  skyLightScaleInput.value = String(demoArt.skyLightScale)
  const skyLightScaleOutput = requireElement<HTMLOutputElement>(
    'sky-light-scale-value'
  )
  skyLightScaleOutput.value = demoArt.skyLightScale.toFixed(2)
  const skyIntensityInput = requireElement<HTMLInputElement>('sky-intensity')
  skyIntensityInput.value = String(demoArt.skyIntensity)
  const skyIntensityOutput = requireElement<HTMLOutputElement>(
    'sky-intensity-value'
  )
  const groundBounceInput = requireElement<HTMLInputElement>('ground-bounce')
  const groundBounceOutput = requireElement<HTMLOutputElement>(
    'ground-bounce-value'
  )
  const phaseFunctionInput = requireElement<HTMLSelectElement>('phase-function')
  const sunInput = requireElement<HTMLInputElement>('sun-elevation')
  const sunOutput = requireElement<HTMLOutputElement>('sun-value')
  const exposureInput = requireElement<HTMLInputElement>('exposure')
  exposureInput.value = String(demoArt.exposure)
  const exposureOutput = requireElement<HTMLOutputElement>('exposure-value')

  const renderer = new WebGPURenderer({ antialias: true, trackTimestamp: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = AgXToneMapping
  renderer.toneMappingExposure = demoArt.exposure
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

  const sunDirection = new Vector3().setFromSphericalCoords(
    1,
    MathUtils.degToRad(90 - Number(sunInput.value)),
    MathUtils.degToRad(135)
  )

  // Demo-only ocean ground (Three.js WaterMesh + classic waternormals).
  const waterNormals = await new TextureLoader().loadAsync(
    '/textures/waternormals.jpg'
  )
  waterNormals.wrapS = waterNormals.wrapT = RepeatWrapping
  const groundGeometry = new PlaneGeometry(80_000, 80_000)
  const water = new WaterMesh(groundGeometry, {
    waterNormals,
    sunDirection,
    sunColor: 0xffffff,
    waterColor: 0x001e0f,
    distortionScale: 3.7,
    size: 1.0,
    alpha: 1.0
  })
  water.rotation.x = -Math.PI / 2
  scene.add(water)
  // bindCloudControls quality rebind still touches needsUpdate on this material.
  const groundMaterial = water.material

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

  const hemisphere = new HemisphereLight(0xcce8ff, 0x3a3026, 1.5)
  scene.add(hemisphere)

  const sunlight = new DirectionalLight(0xfff2df, 4)
  scene.add(sunlight)
  const cloudNode = clouds({
    camera,
    mapOrigin: new Vector3(),
    mapSize: new Vector2(80_000, 80_000),
    worldUnitsPerMeter: 1,
    sunDirection,
    sunIrradiance: new Vector3(),
    skyIrradiance: new Vector3()
  })
  cloudNode.skyLightScale = demoArt.skyLightScale
  cloudNode.coverage = Number(coverageInput.value)
  const stbnTexture = await loadStbnTexture('/textures/stbn.bin')
  cloudNode.setStbnTexture(texture3D(stbnTexture))
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
  // WaterMesh uses a custom NodeMaterial (no aoNode); landmarks keep cloud AO.
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

  const updatePassStats = (): void => {
    if (passStats == null || passTimingEma == null) return
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
  })

  const params = new URLSearchParams(location.search)
  const autorotate = params.get('autorotate')
  if (autorotate != null) {
    controls.autoRotate = true
    const speed = Number(autorotate)
    if (autorotate !== '' && Number.isFinite(speed) && speed > 0) {
      controls.autoRotateSpeed = speed
    }
  }
  if (params.get('weather') === '1') {
    animateWeatherInput.checked = true
    animateWeatherInput.dispatchEvent(new Event('change'))
  }
  if (params.get('history') === '0') {
    temporalHistoryInput.checked = false
    temporalHistoryInput.dispatchEvent(new Event('change'))
  }
  if (params.get('upscale') === '0') {
    temporalUpscaleInput.checked = false
    temporalUpscaleInput.dispatchEvent(new Event('change'))
  }

  const frameGate: DemoFrameGate = { allowRender: null, afterRender: null }
  ;(window as Window & { cloudNode?: typeof cloudNode }).cloudNode = cloudNode

  installStabilityProbe(frameGate, {
    renderer,
    getOutputTarget: () => cloudNode.resolveNode.outputTarget,
    assertStatic: () => {
      if (controls.autoRotate) {
        throw new Error(
          'cloudsStability needs a static camera. Drop ?autorotate and stop orbiting.'
        )
      }
      const moving =
        cloudNode.localWeatherVelocity.lengthSq() > 0 ||
        cloudNode.shapeVelocity.lengthSq() > 0 ||
        cloudNode.shapeDetailVelocity.lengthSq() > 0
      if (moving) {
        throw new Error(
          'cloudsStability needs static weather. Turn off Animate weather.'
        )
      }
    },
    getMode: () => ({
      temporalHistory: cloudNode.temporalHistoryEnabled,
      temporalUpscale: cloudNode.temporalUpscale
    })
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
    if (frameGate.allowRender != null && !frameGate.allowRender()) {
      return
    }
    stats.begin()
    controls.update()
    renderPipeline.render()
    frameGate.afterRender?.()
    if (showPassStats && !gpuResolveInFlight) {
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
    if (showPassStats) updatePassStats()
    stats.end()
  })
  status.textContent = 'WebGPU active'
  if (showPassStats) updatePassStats()

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
      waterNormals.dispose()
      stbnTexture.dispose()
      landmarkGeometry.dispose()
      landmarkMaterial.dispose()
      renderer.dispose()
    },
    { once: true }
  )
}

void main().catch(showError)
