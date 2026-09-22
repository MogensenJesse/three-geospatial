import type { Node as ThreeNode } from 'three/webgpu'
// src/webgpu/CloudsMarchNode.ts

import {
  type Camera,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  NearestFilter,
  NoBlending,
  RenderTarget,
  RGBAFormat,
  type Texture,
  Vector2
} from 'three'
import { positionGeometry, texture, vec4 } from 'three/tsl'
import {
  MRTNode,
  type NodeBuilder,
  type NodeFrame,
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  TempNode,
  type TextureNode
} from 'three/webgpu'

import { bayerOffsets } from '../bayer'
import type { CloudsEnvironment } from './CloudsEnvironment'
import {
  cloudsMarchVariantKey,
  resolveCloudsMarchVariant
} from './cloudsMarchVariant'
import { outputTexture } from './internal/OutputTextureNode'
import { CloudsMarchParameters, setupCloudsMarch } from './march'
import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'
import type { ShadowParameterNodes } from './shadowParameters'

const { resetRendererState, restoreRendererState } = RendererUtils

const sizeScratch = /*#__PURE__*/ new Vector2()

interface CloudsMarchDebug {
  __cloudsMarchShaderHook?: boolean
  __cloudsMarchShaderCode?: string
  __cloudsMarchShaderMessages?: Array<{
    type: string
    message: string
    lineNum: number
    linePos: number
  }>
  __cloudsMarchShaderError?: {
    label: string
    message: string
    lineNum: number
    linePos: number
    snippet: string
  }
}

/**
 * Deferred march MRT graph. This must remain an {@link MRTNode}; hiding `mrt`
 * behind a plain TempNode prevents NodeMaterial from emitting the WGSL output
 * struct, which silently clears both attachments.
 */
class CloudsMarchColorNode extends MRTNode {
  static get type(): string {
    return 'CloudsMarchColorNode'
  }

  constructor(private readonly owner: CloudsMarchNode) {
    super({})
  }

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    const result = setupCloudsMarch(builder, {
      parameters: this.owner.parameters,
      layers: this.owner.layers,
      environment: this.owner.environment,
      march: this.owner.march,
      shadow: this.owner.shadow,
      shadowAtlas: this.owner.shadowAtlas,
      depthNode: this.owner.environment.sceneDepth
    })
    this.outputNodes = {
      output: result.get('color'),
      velocity: result.get('depthVelocity')
    }
    return super.setup(builder) as ThreeNode | null | undefined
  }
}

/**
 * Fullscreen volumetric clouds ray march into color + depth-velocity buffers.
 *
 * Prefer driving updates via {@link CloudsNode}. Standalone use sets
 * {@link updateBeforeType} to FRAME and samples {@link getTextureNode}.
 */
export class CloudsMarchNode extends TempNode {
  static get type(): string {
    return 'CloudsMarchNode'
  }

  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  readonly march = new CloudsMarchParameters()

  resolutionScale = 1
  /** Bayer/TAAU phase, 0..15. */
  frame = 0
  /** STBN slice. Advances every rendered frame, including when TAAU is off. */
  private stbnFrame = 0

  /** Optional BSM inputs (Phase C). */
  shadow: ShadowParameterNodes | null = null
  shadowAtlas: TextureNode | null = null

  private readonly renderTarget: RenderTarget
  private readonly textureNode: TextureNode
  private readonly velocityNode: TextureNode
  private readonly material = new NodeMaterial()
  private readonly mesh: QuadMesh
  private rendererState?: RendererUtils.RendererState
  private readonly outputSize = new Vector2(1, 1)
  private previousProjectionMatrix?: Matrix4
  private previousViewMatrix?: Matrix4
  /** Ping-pong Matrix4 uploads so Three sees a new .value reference each frame. */
  private readonly invProjScratchA = new Matrix4()
  private readonly invProjScratchB = new Matrix4()
  private readonly reprojectionScratchA = new Matrix4()
  private readonly reprojectionScratchB = new Matrix4()
  private readonly viewReprojectionScratchA = new Matrix4()
  private readonly viewReprojectionScratchB = new Matrix4()
  private matrixScratchFlip = false
  private lastVariantKey = ''
  private _temporalUpscale = false

  constructor(
    readonly environment: CloudsEnvironment,
    parameters: CloudParameterNodes,
    layers: CloudLayerParameterNodes
  ) {
    super('vec4')
    this.parameters = parameters
    this.layers = layers
    // Owned by CloudsNode when composed; enable FRAME for standalone use.
    this.updateBeforeType = NodeUpdateType.NONE

    this.renderTarget = new RenderTarget(1, 1, {
      count: 2,
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    for (const texture of this.renderTarget.textures) {
      texture.minFilter = LinearFilter
      texture.magFilter = LinearFilter
      texture.generateMipmaps = false
    }
    this.renderTarget.textures[0].name = 'output'
    this.renderTarget.textures[1].type = FloatType
    this.renderTarget.textures[1].minFilter = NearestFilter
    this.renderTarget.textures[1].magFilter = NearestFilter
    this.renderTarget.textures[1].name = 'velocity'

    this.textureNode = outputTexture(
      this as never,
      this.renderTarget.textures[0]
    ) as unknown as TextureNode
    // Same owner hook as color so a velocity-only debug view still runs the march.
    this.velocityNode = outputTexture(
      this as never,
      this.renderTarget.textures[1]
    ) as unknown as TextureNode
    this.material.name = 'CloudsMarch'
    this.material.blending = NoBlending
    this.material.depthTest = false
    this.material.depthWrite = false
    // Fullscreen clip-space quad (same pattern as core debug / filter RTT).
    this.material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    this.material.customProgramCacheKey = () =>
      cloudsMarchVariantKey(
        resolveCloudsMarchVariant(this.march, this.shadowAtlas)
      )
    this.mesh = new QuadMesh(this.material)
  }

  getTexture(): Texture {
    return this.renderTarget.textures[0]
  }

  getTextureNode(): TextureNode {
    return this.textureNode as unknown as TextureNode
  }

  getVelocityTextureNode(): TextureNode {
    return this.velocityNode
  }

  get depthNode(): TextureNode | null {
    return this.environment.sceneDepth
  }

  set depthNode(value: TextureNode | null) {
    this.environment.sceneDepth = value
  }

  getOutputSize(target: Vector2): Vector2 {
    return target.copy(this.outputSize)
  }

  /** Actual march render-target size (after resolution scale / TAAU /4). */
  getRenderSize(target: Vector2): Vector2 {
    return target.set(this.renderTarget.width, this.renderTarget.height)
  }

  get temporalUpscale(): boolean {
    return this._temporalUpscale
  }

  set temporalUpscale(value: boolean) {
    if (value !== this._temporalUpscale) {
      this._temporalUpscale = value
      this.frame = 0
      this.resetReprojection()
    }
  }

  setSize(width: number, height: number): this {
    const outputWidth = Math.max(Math.round(width * this.resolutionScale), 1)
    const outputHeight = Math.max(Math.round(height * this.resolutionScale), 1)
    const w = this.temporalUpscale ? Math.ceil(outputWidth / 4) : outputWidth
    const h = this.temporalUpscale ? Math.ceil(outputHeight / 4) : outputHeight
    const logicalWidth = this.temporalUpscale ? w * 4 : w
    const logicalHeight = this.temporalUpscale ? h * 4 : h
    const outputSizeChanged =
      this.outputSize.x !== outputWidth || this.outputSize.y !== outputHeight

    if (this.renderTarget.width !== w || this.renderTarget.height !== h) {
      this.renderTarget.setSize(w, h)
    }
    this.outputSize.set(outputWidth, outputHeight)
    this.march.resolution.value.set(logicalWidth, logicalHeight)
    this.march.targetUvScale.value.set(
      logicalWidth / outputWidth,
      logicalHeight / outputHeight
    )
    if (outputSizeChanged) {
      this.resetReprojection()
    }
    return this
  }

  private prepareFrame(camera: Camera): void {
    const { march } = this
    const rangeCamera = camera as Camera & { near: number; far: number }
    march.cameraNear.value = rangeCamera.near
    march.cameraFar.value = rangeCamera.far
    march.temporalUpscaleAmount.value = this.temporalUpscale ? 1 : 0
    // Full-res path: denser steps so the thin high layer (≈500 m) does not onion-skin.
    march.stepSizeScale.value = this.temporalUpscale ? 1 : 0.35

    let dx = 0
    let dy = 0
    if (this.temporalUpscale) {
      const offset = bayerOffsets[this.frame % bayerOffsets.length]
      // WebGPU screen Y is top-down; flip Bayer offset Y so the jittered
      // subpixel matches resolve's top-left phaseIndex (flat[y*4+x]).
      const ox = offset.x
      const oy = 1 - offset.y
      dx = ((ox - 0.5) / march.resolution.value.x) * 4
      dy = ((oy - 0.5) / march.resolution.value.y) * 4
      march.mipLevelScale.value = 0.25
    } else {
      march.mipLevelScale.value = 1
    }
    // Projection NDC Y-up (+dy). screenUV Y-down → UV jitter -dy.
    march.temporalJitter.value.set(dx, this.temporalUpscale ? -dy : 0)

    // Ping-pong scratches: same math as `new Matrix4()` each frame (avoids
    // skipped uniform uploads on in-place edits) without per-frame allocs.
    const flip = this.matrixScratchFlip
    this.matrixScratchFlip = !flip
    const invProj = flip ? this.invProjScratchA : this.invProjScratchB
    const reprojection = flip
      ? this.reprojectionScratchA
      : this.reprojectionScratchB
    const viewReprojection = flip
      ? this.viewReprojectionScratchA
      : this.viewReprojectionScratchB

    invProj.copy(camera.projectionMatrix)
    if (this.temporalUpscale) {
      invProj.elements[8] += dx * 2
      invProj.elements[9] += dy * 2
    }
    invProj.invert()
    march.inverseProjectionMatrix.value = invProj

    const previousProjection =
      this.previousProjectionMatrix ?? camera.projectionMatrix
    const previousView = this.previousViewMatrix ?? camera.matrixWorldInverse
    reprojection.copy(previousProjection)
    if (this.temporalUpscale) {
      reprojection.elements[8] += dx * 2
      reprojection.elements[9] += dy * 2
    }
    reprojection.multiply(previousView)
    march.reprojectionMatrix.value = reprojection
    viewReprojection.copy(reprojection).multiply(camera.matrixWorld)
    march.viewReprojectionMatrix.value = viewReprojection
  }

  copyReprojectionMatrix(camera: Camera): void {
    this.previousProjectionMatrix ??= new Matrix4()
    this.previousViewMatrix ??= new Matrix4()
    this.previousProjectionMatrix.copy(camera.projectionMatrix)
    this.previousViewMatrix.copy(camera.matrixWorldInverse)
  }

  commitReprojection(frame: NodeFrame): void {
    const camera = this.environment.camera ?? frame.camera
    if (camera != null) {
      this.copyReprojectionMatrix(camera)
    }
  }

  resetReprojection(): this {
    this.previousProjectionMatrix = undefined
    this.previousViewMatrix = undefined
    return this
  }

  render(frame: NodeFrame, commitReprojection = true): void {
    const { renderer } = frame
    if (renderer == null) {
      return
    }

    const size = renderer.getDrawingBufferSize(sizeScratch)
    this.setSize(size.x, size.y)
    const camera = this.environment.camera
    if (camera != null && 'near' in camera && 'far' in camera) {
      this.prepareFrame(camera)
    }
    // Independent of the 0..15 Bayer phase and of temporalUpscale.
    this.march.frame.value = this.stbnFrame
    this.stbnFrame = (this.stbnFrame + 1) % 64

    // Capture CloudsMarch WGSL parse details (Firefox often omits them).
    const device = (renderer as { backend?: { device?: GPUDevice } }).backend
      ?.device
    if (
      device != null &&
      (globalThis as CloudsMarchDebug).__cloudsMarchShaderHook !== true
    ) {
      ;(globalThis as CloudsMarchDebug).__cloudsMarchShaderHook = true
      const original = device.createShaderModule.bind(device)
      device.createShaderModule = descriptor => {
        const module = original(descriptor)
        const label = descriptor.label ?? ''
        if (label.includes('CloudsMarch')) {
          const code = descriptor.code ?? ''
          const debug = globalThis as CloudsMarchDebug
          debug.__cloudsMarchShaderCode = code
          void module.getCompilationInfo().then(info => {
            debug.__cloudsMarchShaderMessages = info.messages.map(message => ({
              type: message.type,
              message: message.message,
              lineNum: message.lineNum,
              linePos: message.linePos
            }))
            for (const message of info.messages) {
              if (message.type !== 'error') continue
              const lines = code.split('\n')
              const start = Math.max(0, message.lineNum - 6)
              const end = Math.min(lines.length, message.lineNum + 6)
              const snippet = lines
                .slice(start, end)
                .map((line, i) => `${start + i + 1}: ${line}`)
                .join('\n')
              const payload = {
                label,
                message: message.message,
                lineNum: message.lineNum,
                linePos: message.linePos,
                snippet
              }
              ;(globalThis as CloudsMarchDebug).__cloudsMarchShaderError =
                payload
              console.error('[CloudsMarch WGSL]', payload.message, snippet)
            }
          })
        }
        return module
      }
    }

    this.rendererState = resetRendererState(renderer, this.rendererState!)
    renderer.setRenderTarget(this.renderTarget)
    // Transparent clear so empty texels don't cover the sky.
    renderer.setClearColor(0, 0)
    renderer.clear()
    this.mesh.render(renderer)
    restoreRendererState(renderer, this.rendererState)

    if (camera != null && commitReprojection) {
      this.copyReprojectionMatrix(camera)
      if (this.temporalUpscale) {
        this.frame = (this.frame + 1) % bayerOffsets.length
      }
    }
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    this.render(frame)
    return undefined
  }

  /**
   * Rebuild the march fragment graph for the current variant key.
   * No-ops when the key is unchanged (Phase E — skip redundant compiles).
   */
  /**
   * @param force - Rebuild even when the variant key is unchanged (e.g. WGSL dump).
   */
  invalidateMaterial(force = false): this {
    const key = cloudsMarchVariantKey(
      resolveCloudsMarchVariant(this.march, this.shadowAtlas)
    )
    if (!force && key === this.lastVariantKey) {
      return this
    }
    this.lastVariantKey = key
    this.material.fragmentNode = new CloudsMarchColorNode(this) as never
    this.material.needsUpdate = true
    return this
  }

  override setup(builder: NodeBuilder): ThreeNode | null | undefined {
    this.lastVariantKey = cloudsMarchVariantKey(
      resolveCloudsMarchVariant(this.march, this.shadowAtlas)
    )
    // Assign a deferred node — do not expand If/Loop into the parent builder.
    this.material.fragmentNode = new CloudsMarchColorNode(this) as never
    this.material.needsUpdate = true

    return this.textureNode as unknown as TextureNode
  }

  override dispose(): void {
    this.renderTarget.dispose()
    this.material.dispose()
    this.mesh.geometry.dispose()
    super.dispose()
  }
}

export const cloudsMarch = (
  ...args: ConstructorParameters<typeof CloudsMarchNode>
): CloudsMarchNode => new CloudsMarchNode(...args)
