// src/webgpu/ShadowDebugNode.ts

import { float, screenUV } from 'three/tsl'
import { TempNode, type TextureNode } from 'three/webgpu'

/**
 * Samples one resolved cascade for diagnostic full-screen views. `sources` is
 * read at setup time so a live per-cascade array survives cascade rebuilds.
 */
export class ShadowDebugNode extends TempNode {
  static override get type(): string {
    return 'ShadowDebugNode'
  }

  constructor(
    private readonly sources: readonly TextureNode[],
    readonly cascade = 0
  ) {
    super('vec4')
  }

  override setup(): unknown {
    const source = this.sources[this.cascade] ?? this.sources[0]
    return source?.sample(screenUV) ?? float(0)
  }
}

export const shadowDebug = (
  sources: readonly TextureNode[],
  cascade?: number
): ShadowDebugNode => new ShadowDebugNode(sources, cascade)
