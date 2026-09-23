# WebGPU Clouds

Standalone flat-world volumetric clouds for the Three.js WebGPU renderer.
The library includes procedural cloud textures, cascaded Beer shadow maps,
scene-depth occlusion, and temporal upscaling without React, an atmosphere
package, or external cloud assets.

Three.js **r185+** (peer `>=0.185 <0.187`) and a WebGPU-capable browser are required.
Lighting is **host-provided** (`sunIrradiance` / `skyIrradiance`) so the
package stays independent of Preetham, atmosphere, or any sky system.

## Public API (stable)

Import from the package root:

| Export | Role |
|--------|------|
| `clouds` / `CloudsNode` | Create and drive the cloud pass |
| `CloudsOptions` / `CloudsFacadeOptions` | Construction options |
| `compositeClouds` | Premultiplied HDR composite over the scene |
| `cloudShadow` / `CloudShadowNode` | Sample cloud shadows in host materials |
| `CloudLayer` / `CloudLayers` | Per-layer altitude, height, density, … |
| `DensityProfile` | Vertical density shape |
| `qualityPresets` / `applyQualitySettings` via node | Low/medium/high/ultra |
| `CloudsEnvironment` | Camera / map / sun / irradiance container |

Internals (`march`, cascade array, resolve shaders) are not part of the root barrel.
`CloudsNode.marchNode` / `shadowNode` exist for advanced tooling but are not
required for normal integration.

## Run the demo

```sh
npm install
npm run dev
```

## Build the library

```sh
npm run typecheck
npm run build:library
```

Output: `dist/package/` (`index.js`, `index.cjs`, `index.d.ts`).

## Use in another project

From this repo:

```sh
npm run build:library
npm pack
```

In the other project, install the tarball `npm pack` printed. The path is this repo directory (`three-geospatial`), not a folder named after the package:

```sh
npm install path/to/three-geospatial/webgpu-clouds-0.2.0.tgz
```

How the node, layers, and frame graph fit together: [USING.md](USING.md).

Peer dependency: `three@>=0.185.0 <0.187.0` (developed against r186; r185 should work).

### Minimal integration

```ts
import {
  clouds,
  compositeClouds,
  cloudShadow,
  qualityPresets
} from 'webgpu-clouds'
import {
  AgXToneMapping,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3
} from 'three/webgpu'
import { pass, float, mix, positionWorld } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import RenderPipeline from 'three/src/renderers/common/RenderPipeline.js'

const renderer = /* your WebGPURenderer */
renderer.toneMapping = AgXToneMapping

const scene = new Scene()
const camera = new PerspectiveCamera(60, 1, 1, 100_000)

const cloudNode = clouds({
  camera,
  mapOrigin: new Vector3(),
  mapSize: new Vector2(80_000, 80_000),
  worldUnitsPerMeter: 1,
  sunDirection: new Vector3(0.4, 0.8, 0.2).normalize(),
  // Host lighting (atmosphere, Preetham bake, art-direct — your choice)
  sunIrradiance: new Vector3(12, 11, 10),
  skyIrradiance: new Vector3(0.35, 0.45, 0.65),
  coverage: 0.4,
  qualityPreset: 'high',
  cloudLayers: [
    { channel: 'r', altitude: 750, height: 650, densityScale: 0.2, shadow: true },
    { channel: 'g', altitude: 1000, height: 1200, densityScale: 0.2, shadow: true },
    { channel: 'b', altitude: 7500, height: 500, densityScale: 0.003 },
    { channel: 'a' }
  ]
})

// Live layer edits
cloudNode.cloudLayers[0].altitude = 900

const scenePass = pass(scene, camera, { samples: 0 })
cloudNode.depthNode = scenePass.getTextureNode('depth')

// Optional: darken ground/landmarks under cloud shadows
const groundMaterial = new MeshStandardNodeMaterial({ color: 0x52634d })
groundMaterial.aoNode = cloudShadow(cloudNode, positionWorld)

const pipeline = new RenderPipeline(renderer)
pipeline.outputNode = compositeClouds(
  scenePass.getTextureNode('output'),
  cloudNode
)
```

**Important:** put `CloudsNode` in the composition graph (via `compositeClouds`
or as a parent update). Sampling only `cloudNode.getTextureNode()` does **not**
run shadow / march / resolve passes.

Cloud output is premultiplied linear HDR. Tone-map **after** `compositeClouds`.

Each frame, update host lighting if the sun moves:

```ts
cloudNode.environment.sunDirection.copy(sunDir)
cloudNode.environment.sunIrradiance.set(…)
cloudNode.environment.skyIrradiance.set(…)
```

After camera cuts or map rebases:

```ts
cloudNode.resetTemporalHistory()
```

Quality:

```ts
cloudNode.applyQualitySettings(qualityPresets.high)
cloudNode.setQualityPreset('medium')
```

## Coordinates and lighting

- XZ is the horizontal plane and +Y is up.
- `mapOrigin` is the weather-map center; its Y component is zero altitude.
- `mapSize` is the repeating weather-map extent in scene units.
- `worldUnitsPerMeter` converts meter-based cloud settings to scene units.
- `sunDirection` points from the world toward the sun.
- `sunIrradiance` and `skyIrradiance` are linear HDR host-lighting inputs.

## License

MIT. See [LICENSE](LICENSE) for upstream attributions retained by the port.
