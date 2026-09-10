import {
  HalfFloatType,
  LinearFilter,
  RenderTarget,
  RGBAFormat,
  Vector2,
  type Texture
} from 'three'
import {
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RendererUtils,
  TempNode,
  type NodeBuilder,
  type NodeFrame,
  type TextureNode
} from 'three/webgpu'
import { positionGeometry, vec4 } from 'three/tsl'

import { outputTexture } from '@takram/three-geospatial/webgpu'

import {
  CloudsMarchParameters,
  setupCloudsMarchColor,
  type MarchCloudsContext
} from './march'
import type {
  CloudLayerParameterNodes,
  CloudParameterNodes
} from './parameters'

const { resetRendererState, restoreRendererState } = RendererUtils

const sizeScratch = /*#__PURE__*/ new Vector2()

interface CloudsMarchDebug {
  __cloudsMarchShaderHook?: boolean
  __cloudsMarchShaderError?: {
    label: string
    message: string
    lineNum: number
    linePos: number
    snippet: string
  }
}

/**
 * Deferred march color graph. Constructed as `material.fragmentNode` so the
 * heavy If/Loop stack is built only when the RTT material compiles — not while
 * nested inside the parent compose-pass builder (which corrupted vertex/fragment).
 */
class CloudsMarchColorNode extends TempNode {
  static override get type(): string {
    return 'CloudsMarchColorNode'
  }

  readonly marchContext: MarchCloudsContext

  constructor(marchContext: MarchCloudsContext) {
    super('vec4')
    this.marchContext = marchContext
  }

  override setup(builder: NodeBuilder): unknown {
    return setupCloudsMarchColor(builder, this.marchContext)
  }
}

/**
 * Fullscreen volumetric clouds ray march into an overlay buffer.
 * Phase B: no BSM / TAAU.
 *
 * Prefer driving updates via {@link CloudsNode}. Standalone use sets
 * {@link updateBeforeType} to FRAME and samples {@link getTextureNode}.
 */
export class CloudsMarchNode extends TempNode {
  static override get type(): string {
    return 'CloudsMarchNode'
  }

  parameters: CloudParameterNodes
  layers: CloudLayerParameterNodes
  readonly march = new CloudsMarchParameters()

  depthNode: TextureNode | null = null
  resolutionScale = 1

  private readonly renderTarget: RenderTarget
  private readonly textureNode: TextureNode
  private readonly material = new NodeMaterial()
  private readonly mesh: QuadMesh
  private rendererState?: RendererUtils.RendererState

  constructor(
    parameters: CloudParameterNodes,
    layers: CloudLayerParameterNodes
  ) {
    super('vec4')
    this.parameters = parameters
    this.layers = layers
    // Owned by CloudsNode when composed; enable FRAME for standalone use.
    this.updateBeforeType = NodeUpdateType.NONE

    this.renderTarget = new RenderTarget(1, 1, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    const { texture } = this.renderTarget
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.generateMipmaps = false
    texture.name = 'CloudsMarchNode'

    this.textureNode = outputTexture(this, texture)
    this.material.name = 'CloudsMarch'
    // Fullscreen clip-space quad (same pattern as core debug / filter RTT).
    this.material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    this.mesh = new QuadMesh(this.material)
  }

  getTexture(): Texture {
    return this.renderTarget.texture
  }

  getTextureNode(): TextureNode {
    return this.textureNode
  }

  setSize(width: number, height: number): this {
    const w = Math.max(Math.round(width * this.resolutionScale), 1)
    const h = Math.max(Math.round(height * this.resolutionScale), 1)
    if (this.renderTarget.width !== w || this.renderTarget.height !== h) {
      this.renderTarget.setSize(w, h)
      this.march.resolution.value.set(w, h)
    }
    return this
  }

  override updateBefore({ renderer }: NodeFrame): void {
    if (renderer == null) {
      return
    }

    const size = renderer.getDrawingBufferSize(sizeScratch)
    this.setSize(size.x, size.y)

    // Capture CloudsMarch WGSL parse details (Firefox often omits them).
    const device = (renderer as { backend?: { device?: GPUDevice } }).backend
      ?.device
    if (device != null && !(globalThis as CloudsMarchDebug).__cloudsMarchShaderHook) {
      ;(globalThis as CloudsMarchDebug).__cloudsMarchShaderHook = true
      const original = device.createShaderModule.bind(device)
      device.createShaderModule = descriptor => {
        const module = original(descriptor)
        const label = descriptor.label ?? ''
        if (label.includes('CloudsMarch')) {
          const code = descriptor.code ?? ''
          void module.getCompilationInfo().then(info => {
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
              ;(globalThis as CloudsMarchDebug).__cloudsMarchShaderError = payload
              console.error('[CloudsMarch WGSL]', payload.message, '\n' + snippet)
            }
          })
        }
        return module
      }
    }

    this.rendererState = resetRendererState(renderer, this.rendererState)
    renderer.setRenderTarget(this.renderTarget)
    // Transparent clear so empty texels don't cover the sky.
    renderer.setClearColor(0, 0)
    renderer.clear()
    this.mesh.render(renderer)
    restoreRendererState(renderer, this.rendererState)
  }

  override setup(_builder: NodeBuilder): unknown {
    const context: MarchCloudsContext = {
      parameters: this.parameters,
      layers: this.layers,
      march: this.march
    }

    // Assign a deferred node — do not expand If/Loop into the parent builder.
    this.material.fragmentNode = new CloudsMarchColorNode(context)
    this.material.needsUpdate = true

    return this.textureNode
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
