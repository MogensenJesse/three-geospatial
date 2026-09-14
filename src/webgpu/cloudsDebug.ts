// src/webgpu/cloudsDebug.ts

import { Fn, screenUV, vec4 } from 'three/tsl'
import type { TextureNode } from 'three/webgpu'

import type { CloudsMarchNode } from './CloudsMarchNode'
import type { CloudsMarchParameters } from './march'
import { ShadowDebugNode } from './ShadowDebugNode'
import type { ShadowMarchNode } from './ShadowMarchNode'

/** Full-screen diagnostic views for the demo / host tooling. */
export type CloudsDebugOutput =
  | 'none'
  | 'clouds'
  | 'velocity'
  | 'shadow-cascade-0'
  | 'shadow-cascade-1'
  | 'shadow-cascade-2'
  | 'optical-depth-local'
  | 'optical-depth-bsm'
  | 'no-shadow'

/** CPU ms around each pass (GPU work may complete later). */
export interface CloudsPassTiming {
  shadow: number
  march: number
  resolve: number
  total: number
}

export function createCloudsPassTiming(): CloudsPassTiming {
  return { shadow: 0, march: 0, resolve: 0, total: 0 }
}

/** Map a debug view id onto march optical-depth probe uniforms. */
export function applyDebugMarchMode(
  march: CloudsMarchParameters,
  debugOutput: CloudsDebugOutput
): void {
  switch (debugOutput) {
    case 'optical-depth-local':
      march.shadowDebugOpticalDepth.value = -3
      break
    case 'optical-depth-bsm':
      march.shadowDebugOpticalDepth.value = -4
      break
    case 'no-shadow':
      march.shadowDebugOpticalDepth.value = -2
      break
    default:
      march.shadowDebugOpticalDepth.value = -1
      break
  }
}

export interface CloudsDebugSetupHost {
  marchNode: CloudsMarchNode
  shadowNode: ShadowMarchNode
  textureNode: TextureNode
}

/**
 * Node graph returned from {@link CloudsNode.setup} for diagnostic views.
 * Normal compositing uses the resolved cloud buffer.
 */
export function setupCloudsDebugOutput(
  debugOutput: CloudsDebugOutput,
  host: CloudsDebugSetupHost
): unknown {
  switch (debugOutput) {
    case 'velocity': {
      const velocityTex = host.marchNode.getVelocityTextureNode()
      return Fn(() => {
        const v = velocityTex.sample(screenUV)
        return vec4(
          v.r.mul(1e-4).clamp(0, 1),
          v.g.mul(20).add(0.5).clamp(0, 1),
          v.b.mul(20).add(0.5).clamp(0, 1),
          1
        )
      })()
    }
    case 'shadow-cascade-0':
      return new ShadowDebugNode(host.shadowNode.getBufferNodes(), 0)
    case 'shadow-cascade-1':
      return new ShadowDebugNode(host.shadowNode.getBufferNodes(), 1)
    case 'shadow-cascade-2':
      return new ShadowDebugNode(host.shadowNode.getBufferNodes(), 2)
    default:
      // none / clouds / optical-depth_* / no-shadow → resolved cloud buffer
      return host.textureNode
  }
}

/** Time shadow → march → resolve and store EMA-ready CPU ms on `timing`. */
export function measureCloudsPassTiming(
  timing: CloudsPassTiming,
  passes: {
    shadow: () => void
    march: () => void
    resolve: () => void
  }
): void {
  const t0 = performance.now()
  passes.shadow()
  const t1 = performance.now()
  passes.march()
  const t2 = performance.now()
  passes.resolve()
  const t3 = performance.now()
  timing.shadow = t1 - t0
  timing.march = t2 - t1
  timing.resolve = t3 - t2
  timing.total = t3 - t0
}
