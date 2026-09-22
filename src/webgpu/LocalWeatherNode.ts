// src/webgpu/LocalWeatherNode.ts

import { Vector2 } from 'three'
import { float, int, Loop, smoothstep, vec3, vec4 } from 'three/tsl'

import { FnLayout } from './internal/FnLayout'
import type { Node } from './internal/node'
import { ProceduralTextureNode } from './ProceduralTextureNode'
import { stackablePerlinNoise, stackableWorleyNoise } from './stackableNoise'

const weatherWorleyFbm = /*#__PURE__*/ FnLayout({
  name: 'weatherWorleyFbm',
  type: 'float',
  inputs: [
    { name: 'point', type: 'vec3' },
    { name: 'frequency', type: 'float' },
    { name: 'amplitude', type: 'float' },
    { name: 'lacunarity', type: 'float' },
    { name: 'gain', type: 'float' },
    { name: 'octaveCount', type: 'int' }
  ]
})(([point, frequency, amplitude, lacunarity, gain, octaveCount]) => {
  const amplitudeVar = amplitude.toVar()
  const frequencyVar = frequency.toVar()
  const noise = float(0).toVar()
  Loop({ start: 0, end: octaveCount }, () => {
    noise.addAssign(
      amplitudeVar.mul(stackableWorleyNoise(point, frequencyVar).oneMinus())
    )
    frequencyVar.mulAssign(lacunarity)
    amplitudeVar.mulAssign(gain)
  })
  return noise
})

export class LocalWeatherNode extends ProceduralTextureNode {
  static override get type(): string {
    return 'LocalWeatherNode'
  }

  constructor(size = new Vector2().setScalar(512)) {
    super(size, true)
  }

  protected override setupOutputNode(uv: Node<'vec2'>): Node {
    const output = vec4().toVar()

    // Mid clouds
    {
      let worley = weatherWorleyFbm(
        vec3(uv, 0).add(vec3(0.5)),
        float(8.0), // frequency
        float(0.4), // amplitude
        float(2.0), // lacunarity
        float(0.95), // gain
        int(4) // octaveCount
      )
      worley = smoothstep(1.0, 1.4, worley)
      output.g.assign(worley)
    }

    // Low clouds
    {
      let worley = weatherWorleyFbm(
        vec3(uv, 0),
        float(16.0), // frequency
        float(0.4), // amplitude
        float(2.0), // lacunarity
        float(0.95), // gain
        int(4) // octaveCount
      )
      worley = smoothstep(0.8, 1.4, worley)
      output.r.assign(worley.sub(output.g).saturate())
    }

    // High clouds
    {
      let perlin = stackablePerlinNoise(
        vec3(uv, 0),
        vec3(6.0, 12.0, 1.0), // frequency
        int(8) // octaveCount
      )
      perlin = smoothstep(-0.5, 0.5, perlin)
      output.b.assign(perlin)
    }

    // Extra
    {
      let perlin = stackablePerlinNoise(
        vec3(uv, 0).add(vec3(-19.1, 33.4, 47.2)),
        vec3(32.0), // frequency
        int(4) // octaveCount
      )
      perlin = smoothstep(-0.5, 0.5, perlin)
      output.a.assign(perlin)
    }

    return output
  }
}
