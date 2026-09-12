// demo/main.ts

import {
  AgXToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer
} from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import ThreeRenderPipeline from 'three/src/renderers/common/RenderPipeline.js'
import { pass } from 'three/tsl'

import { clouds, compositeClouds } from '../src'
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
  const animateWeatherInput =
    requireElement<HTMLInputElement>('animate-weather')
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
  const sunInput = requireElement<HTMLInputElement>('sun-elevation')
  const sunOutput = requireElement<HTMLOutputElement>('sun-value')
  const exposureInput = requireElement<HTMLInputElement>('exposure')
  const exposureOutput = requireElement<HTMLOutputElement>('exposure-value')

  const renderer = new WebGPURenderer({ antialias: true })
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
  const groundMaterial = new MeshStandardMaterial({
    color: 0x52634d,
    roughness: 0.95
  })
  const ground = new Mesh(groundGeometry, groundMaterial)
  ground.rotation.x = -Math.PI / 2
  scene.add(ground)

  const landmarkGeometry = new BoxGeometry(240, 900, 240)
  const landmarkMaterial = new MeshStandardMaterial({
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
  cloudNode.resolutionScale = Number(resolutionScaleInput.value)
  cloudNode.temporalUpscale = temporalUpscaleInput.checked

  const scenePass = pass(scene, camera, { samples: 0 })
  const sceneColor = scenePass.getTextureNode('output')
  const sceneDepth = scenePass.getTextureNode('depth')
  cloudNode.depthNode = sceneDepth

  const renderPipeline = new RenderPipeline(renderer)
  renderPipeline.outputNode = compositeClouds(sceneColor, cloudNode)

  const updateCoverage = (): void => {
    const coverage = Number(coverageInput.value)
    cloudNode.coverage = coverage
    coverageOutput.value = coverage.toFixed(2)
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
    cloudNode.parameters.shapeDetailEnabled.value = shapeDetailInput.checked
    cloudNode.resetTemporalHistory()
  }

  const updateTurbulence = (): void => {
    cloudNode.parameters.turbulenceEnabled.value = turbulenceInput.checked
    cloudNode.resetTemporalHistory()
  }

  const updateCloudShadows = (): void => {
    const enabled = cloudShadowsInput.checked
    cloudNode.shadowNode.enabled = enabled
    cloudNode.shadowNode.shadow.enabled.value = enabled ? 1 : 0
    cloudNode.shadowNode.resolveNode.reset()
    cloudNode.resetTemporalHistory()
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

  const updateExposure = (): void => {
    const exposure = Number(exposureInput.value)
    renderer.toneMappingExposure = exposure
    exposureOutput.value = exposure.toFixed(2)
  }

  coverageInput.addEventListener('input', updateCoverage)
  animateWeatherInput.addEventListener('change', updateAnimation)
  resolutionScaleInput.addEventListener('change', updateResolutionScale)
  temporalUpscaleInput.addEventListener('change', updateTemporalUpscale)
  shapeDetailInput.addEventListener('change', updateShapeDetail)
  turbulenceInput.addEventListener('change', updateTurbulence)
  cloudShadowsInput.addEventListener('change', updateCloudShadows)
  sunInput.addEventListener('input', updateSun)
  exposureInput.addEventListener('input', updateExposure)
  updateCoverage()
  updateAnimation()
  updateResolutionScale()
  updateTemporalUpscale()
  updateShapeDetail()
  updateTurbulence()
  updateCloudShadows()
  updateSun()
  updateExposure()

  const resize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    cloudNode.resetTemporalHistory()
  }
  window.addEventListener('resize', resize)

  renderer.setAnimationLoop(() => {
    controls.update()
    renderPipeline.render()
  })
  status.textContent = 'WebGPU active'

  window.addEventListener(
    'beforeunload',
    () => {
      renderer.setAnimationLoop(null)
      window.removeEventListener('resize', resize)
      coverageInput.removeEventListener('input', updateCoverage)
      animateWeatherInput.removeEventListener('change', updateAnimation)
      resolutionScaleInput.removeEventListener('change', updateResolutionScale)
      temporalUpscaleInput.removeEventListener('change', updateTemporalUpscale)
      shapeDetailInput.removeEventListener('change', updateShapeDetail)
      turbulenceInput.removeEventListener('change', updateTurbulence)
      cloudShadowsInput.removeEventListener('change', updateCloudShadows)
      sunInput.removeEventListener('input', updateSun)
      exposureInput.removeEventListener('input', updateExposure)
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
