# Using `webgpu-clouds`

Guide for an engineer or coding agent integrating the package. Import from the package root only.

```ts
import {
  clouds,
  compositeClouds,
  cloudShadow,
  qualityPresets,
  cloneQualitySettings
} from 'webgpu-clouds'
```

Peer dependency: `three@>=0.185.0 <0.187.0`, WebGPU renderer, TSL (`three/tsl`, `three/webgpu`). The package does not include a sky model. The host supplies sun and sky light.

`README.md` has the install steps and a minimal snippet. This file is the model those snippets rely on.

## What the node does

`clouds(options)` returns a `CloudsNode`. It is a TSL `vec4` node. Each frame it renders a flat, Y-up cloud volume and writes a full-resolution texture. That texture is premultiplied linear HDR: `rgb` is in-scattered radiance, `a` is opacity. `rgb` is already scaled by opacity. Leave it that way.

Default quality (`high`) marches at quarter resolution on a 16-frame Bayer lattice, then a temporal resolve reprojects the previous frame and fills the missing pixels. `medium` and `ultra` do the same. `low` marches at half resolution with no temporal upscale and costs more per pixel.

The image is stable when the camera moves slowly because settled pixels keep a long history. After a camera cut, a teleport, or a change of `mapOrigin`, call `cloudNode.resetTemporalHistory()`.

## The node must be in the frame graph

`CloudsNode.updateBefore` runs the shadow maps, the march, and the resolve. Three.js only calls it when the node is reachable from the pipeline output.

Wire it with `compositeClouds`. Reading `cloudNode.getTextureNode()` from a material that never references `cloudNode` does not run the passes, so the texture stays empty and `cloudShadow` stops updating.

```ts
const scenePass = pass(scene, camera, { samples: 0 })
cloudNode.depthNode = scenePass.getTextureNode('depth')

pipeline.outputNode = compositeClouds(
  scenePass.getTextureNode('output'),
  cloudNode
)
```

`compositeClouds` evaluates `scene.rgb * (1 - clouds.a) + clouds.rgb`. Tone-map that result. The scene pass color and `sunIrradiance` / `skyIrradiance` are linear HDR. Compositing after tone mapping flattens the clouds.

`depthNode` is the scene depth texture. Without it, clouds draw through geometry. Use the same camera as `environment.camera`, including `near` and `far`.

## Coordinates and light

XZ is horizontal. +Y is up.

| Field | Unit | Meaning |
| --- | --- | --- |
| `mapOrigin` | scene units | Weather-map center. `y` is altitude 0. |
| `mapSize` | scene units | Size of one repeating weather tile. Both components must be `> 0`. |
| `worldUnitsPerMeter` | scene units per meter | Scales meter-based layer altitudes and march steps. Must be `> 0`. Default `1`. |
| `sunDirection` | unitless | From the world toward the sun. Must be non-zero. Not read from a `DirectionalLight`. |
| `sunIrradiance` | linear HDR RGB | Direct light. Default `(1, 1, 1)`. |
| `skyIrradiance` | linear HDR RGB | Ambient sky light. Default `(0.15, 0.15, 0.15)`. |
| `groundAlbedo` | linear RGB | Flat underside bounce at `mapOrigin.y`. Default `(0.3, 0.3, 0.3)`. |

Copy sun and irradiance every frame when they change. Vector uniforms hold the same `Vector3` instances, so in-place `.copy()` / `.set()` is enough. Call `environment.update()` yourself only if the node is not in the graph; otherwise `updateBefore` does it.

`camera` must be a `PerspectiveCamera`.

## Layers

There are always four layers, one per weather-texture channel (`r`, `g`, `b`, `a`). Omit `cloudLayers` to keep `CloudLayers.DEFAULT`: two shadowed cumulus slabs, one thin high layer on `b`, and an empty `a` layer (`height: 0`). Passing an array of any other length throws.

Altitudes and heights are meters above `mapOrigin.y`. `densityScale` is the layer's density multiplier. `shadow: true` puts that layer into the cascaded shadow maps. The fourth default layer does not cast shadows.

Mutate fields on `cloudNode.cloudLayers[i]` (`altitude`, `height`, `densityScale`, `shadow`, `densityProfile`, and the other `CloudLayer` fields). They are packed into uniforms every frame. Keep the same four-element array.

`coverage` (default `0.3`) fills more of the weather signal as it rises. Per-layer `coverageFilterWidth` softens that threshold.

`densityProfile` shapes density over the layer height. The default `DensityProfile(0, 0, 0.75, 0.25)` is `0.75 * heightFraction + 0.25`.

## Shadows on scene objects

`cloudShadow(cloudNode, positionWorld)` is a TSL float, transmittance in `[0, 1]`, from the cascaded Beer shadow maps. Multiply direct light by it, or assign a node-material `aoNode`:

```ts
material.aoNode = cloudShadow(cloudNode, positionWorld)
```

This reads the maps. It does not render them. `cloudNode` still has to stay in the composition graph, and `shadowEnabled` stays on (the default). Layers with `shadow: false` do not darken the ground.

## Quality

Default preset is `high`. Change it with `cloudNode.setQualityPreset('low' | 'medium' | 'high' | 'ultra')`.

`qualityPresets` is a shared object. Copy it before editing:

```ts
const settings = cloneQualitySettings(qualityPresets.high)
settings.clouds.maxIterationCount = 300
cloudNode.applyQualitySettings(settings)
```

`resolutionScale` is applied to the drawing buffer before the quarter-resolution split (`high` `1`, `medium` `0.75`, `low` `0.5`).

Leave `temporalUpscale` on for `medium` and above. Turning it off marches every output pixel and shortens the steps, so the frame cost jumps several times. `temporalHistoryEnabled = false` shows the raw noisy reconstruction and is a debug switch.

## Motion

These velocities are scene units (or UV, for the weather offset) per second. `updateBefore` adds `velocity * deltaTime` to the matching offset:

- `localWeatherVelocity` scrolls the weather map
- `shapeVelocity` scrolls the 3D shape
- `shapeDetailVelocity` scrolls the detail noise

Camera motion is reprojected. Weather scrolling is not, so fast `localWeatherVelocity` smears inside the cloud volume. That smear is expected.

## Textures

Omit the texture options. The node builds procedural weather, shape, detail, and turbulence textures and disposes them in `dispose()`.

Replace one by passing a `TextureNode` / `Texture3DNode` to `setLocalWeatherTexture`, `setShapeTexture`, `setShapeDetailTexture`, or `setTurbulenceTexture`. Weather and shape are required; a `null` replacement makes the march throw. `setStbnTexture` is optional blue-noise for step jitter.

## Tear-down and history resets

Call `cloudNode.dispose()` when the effect is removed. Call `resetTemporalHistory()` after a camera cut or a `mapOrigin` rebase. Changing the weather or shape texture resets history on its own.

## Leave these alone

`marchNode`, `shadowNode`, resolve uniforms, and anything outside the root export are internal. Drive quality through `setQualityPreset` / `applyQualitySettings`, and drive appearance through `cloudLayers`, `coverage`, the environment vectors, and the public setters on `CloudsNode`. `debugOutput` is for the demo; leave it at `'none'`.
