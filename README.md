# WebGPU Clouds

Standalone flat-world volumetric clouds for the Three.js WebGPU renderer.
The library includes procedural cloud textures, cascaded Beer shadow maps,
scene-depth occlusion, and temporal upscaling without React, an atmosphere
package, or external cloud assets.

Three.js 0.183 and a WebGPU-capable browser are required.

## Run the demo

```sh
npm install
npm run dev
```

The vanilla Vite demo includes orbit controls and native controls for cloud
coverage and sun elevation.

## Build and check

```sh
npm run typecheck
npm run lint
npm run build
```

`npm run build` writes the library to `dist/package` and the demo to
`dist/demo`.

## Basic integration

```ts
import { clouds, compositeClouds } from 'webgpu-clouds'
import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3
} from 'three'
import { pass } from 'three/tsl'
import { RenderPipeline, WebGPURenderer } from 'three/webgpu'

const renderer = new WebGPURenderer()
renderer.toneMapping = ACESFilmicToneMapping

const scene = new Scene()
const camera = new PerspectiveCamera(60, 1, 1, 100_000)
const cloudNode = clouds({
  camera,
  mapOrigin: new Vector3(),
  mapSize: new Vector2(80_000, 80_000),
  worldUnitsPerMeter: 1,
  sunDirection: new Vector3(0.4, 0.8, 0.2).normalize(),
  sunIrradiance: new Vector3(12, 11, 10),
  skyIrradiance: new Vector3(0.35, 0.45, 0.65)
})

const scenePass = pass(scene, camera, { samples: 0 })
const sceneColor = scenePass.getTextureNode('output')
const sceneDepth = scenePass.getTextureNode('depth')
cloudNode.depthNode = sceneDepth

const pipeline = new RenderPipeline(renderer)
pipeline.outputNode = compositeClouds(sceneColor, cloudNode)
pipeline.render()
```

Use the `CloudsNode` itself in the composition graph. Sampling only
`cloudNode.getTextureNode()` does not register the node's shadow, march, and
temporal update passes.

Cloud output is premultiplied linear HDR. `compositeClouds` applies the
correct blend, and tone mapping belongs after cloud composition.

## Coordinates and lighting

- XZ is the horizontal plane and +Y is up.
- `mapOrigin` is the weather-map center; its Y component is zero altitude.
- `mapSize` is the repeating weather-map extent in scene units.
- `worldUnitsPerMeter` converts meter-based cloud settings to scene units.
- `sunDirection` points from the world toward the sun.
- `sunIrradiance` and `skyIrradiance` are linear HDR host-lighting inputs.

Assign the scene pass depth texture to `cloudNode.depthNode` so opaque
geometry occludes the clouds. Reset temporal history after camera cuts,
world-origin rebases, or discontinuous map changes:

```ts
cloudNode.resetTemporalHistory()
```

## License

MIT. See [LICENSE](LICENSE) for upstream attributions retained by the port.
