---
name: cloud-renderer-feature-parity
overview: Bring the standalone flat-world WebGPU cloud package to cloud-core feature parity with the original WebGL renderer. The work restores WebGL-quality presets, secondary lighting, shading, sampling, shadow stability, scene-shadow integration, and package ergonomics without reintroducing atmosphere, geospatial, React, Storybook, WebGL, or tests.
todos:
  - id: define-parity-contract
    content: Lock the cloud-core parity contract, reference settings, and manual comparison scenarios.
    status: pending
  - id: wire-quality-presets
    content: Implement atomic runtime quality presets and align high-quality defaults with WebGL.
    status: pending
  - id: port-secondary-sun-march
    content: Port the local sun optical-depth march and BSM distance-offset integration.
    status: pending
  - id: restore-cloud-lighting
    content: Port powder shading, ground bounce, and accurate phase-function support.
    status: pending
  - id: restore-weather-lod
    content: Restore local-weather mip generation, footprint LOD, and optional stochastic jitter input.
    status: pending
  - id: stabilize-shadow-pipeline
    content: Align shadow quality, detail sampling, temporal filtering, and runtime cascade rebuilds.
    status: pending
  - id: expose-scene-shadows
    content: Add a standalone TSL cloud-shadow sampling API and demonstrate shadows on the ground.
    status: pending
  - id: harden-public-api
    content: Add ergonomic settings, custom texture injection, diagnostics, and stable exports.
    status: pending
  - id: validate-and-package
    content: Complete static checks, user-run visual parity scenarios, documentation, and package validation.
    status: pending
isProject: true
---

# Standalone WebGPU Cloud Feature Parity

## Goal and definition of parity
Reach parity with the cloud-core behavior of `main:packages/clouds/` while preserving the current standalone architecture:
- Flat XZ world with +Y up.
- Three.js WebGPU/TSL only at runtime.
- Host-provided sun and sky irradiance.
- Procedural defaults with optional host texture injection.
- No atmosphere LUTs, ECEF/geospatial transforms, React/R3F, Storybook, Nx, WebGL fallback, or tests.

Parity means matching the original renderer’s cloud density, high-quality lighting controls, self-shadow detail, temporal stability, quality presets, scene-facing cloud shadows, and package-level configurability. Haze, Bruneton aerial perspective, and atmosphere-coupled shadow-length/light-shaft composition are explicitly excluded because they are atmosphere features rather than standalone cloud-core behavior.

## Existing foundation to preserve
- [`CloudsNode`](src/webgpu/CloudsNode.ts) already owns the correct pass order: procedural resources → shadow march → shadow resolve → cloud march → cloud resolve.
- Four cloud layers and density profiles are already ported in [`CloudLayer`](src/CloudLayer.ts), [`CloudLayers`](src/CloudLayers.ts), and [`updateCloudLayerParameters`](src/webgpu/updateCloudLayerParameters.ts).
- Procedural weather, shape, detail, and turbulence generation already run as one-shot compute nodes.
- Cascaded Beer shadow maps, cascade fading, optical-depth decoding, and Vogel-disk PCF are present.
- Cloud TAAU already has the WebGL 4×4 Bayer schedule, depth/velocity MRT, reprojection, variance clipping, and history ping-pong.
- Cloud output is premultiplied linear HDR and [`compositeClouds`](src/webgpu/compositeClouds.ts) blends it before tone mapping.
- Scene-depth occlusion and explicit temporal-history reset are working.

## Impact and risk gates
- **HIGH risk:** changing [`sampleMedia`](src/webgpu/sampling.ts) affects both cloud and shadow marches across three graph processes. Keep its existing density contract stable; add lighting helpers around it rather than mixing new lighting state into the media struct unless required.
- **HIGH risk:** changing [`ShadowResolveNode`](src/webgpu/ShadowResolveNode.ts) reaches 18 symbols across `CloudsNode.updateBefore`, `ShadowMarchNode` construction, cascade rebuilds, and disposal. Temporal tuning must preserve ping-pong ownership and live texture-node references.
- **MEDIUM risk:** changing [`ProceduralTextureNode`](src/webgpu/ProceduralTextureNode.ts) affects local weather, turbulence, `CloudsNode`, and dependent procedural abstractions. Add mip behavior in the base only where both 2D subclasses can safely use it.
- **LOW risk:** `CloudsNode` quality orchestration and `setupCloudsMarch` have narrow direct caller sets, but their render-graph lifecycle still requires explicit rebuild/history handling.
- Re-run GitNexus impact before each phase if the index changes. Warn before implementation if any target becomes HIGH or CRITICAL beyond the known risks above.

## Phase 0 — Lock the parity contract

### Reference configuration
Use the WebGL `high` preset as the capability target:
- Resolution scale `1`, temporal upscaling enabled.
- Shape detail and turbulence enabled.
- Cloud march: 500 maximum iterations, 50 m minimum step, 1000 m maximum step, 200 km maximum distance, perspective scale `1.01`.
- Density/extinction thresholds `1e-5`; transmittance threshold `1e-2`.
- Eight multiple-scattering octaves.
- Two local sun-march samples and three ground-march samples.
- Shadow march: three cascades at 512², 50 iterations, 100–1000 m steps, thresholds `1e-5`/`1e-5`/`1e-4`.
- Cloud resolve alpha/gamma `0.1`/`2`; shadow resolve alpha/gamma `0.01`/`1`.

### Manual comparison scenes
Use the standalone demo to maintain repeatable checks:
- Noon/high sun: bright tops, readable interiors, stable shadow detail.
- Low sun: forward scattering, long soft self-shadowing, no cascade flicker.
- Camera below the 750 m cloud base: underside fill and ground bounce.
- Horizon view: no early 50 km cutoff, excessive banding, or missing distant clouds.
- Opaque landmarks crossing cloud silhouettes: correct scene-depth occlusion.
- Static camera for 16+ frames: TAAU and shadow history converge without shimmer.
- Camera orbit, resize, and abrupt control changes: history resets without ghost trails.
- Animated weather: temporal reconstruction remains stable while density moves.

### Exit criteria
- Record the reference values in [`qualityPresets.ts`](src/qualityPresets.ts), not as demo-only constants.
- Keep the current demo composition and coordinate conventions fixed throughout later visual comparisons.

## Phase 1 — Make quality presets real

### Quality schema
Expand [`CloudQualitySettings`](src/qualityPresets.ts) to cover every cloud-core quality control:
- Existing resolution, TAAU, detail, turbulence, primary cloud march, and BSM fields.
- Secondary sun/ground iteration counts and step controls.
- Multiple-scattering and phase-function mode.
- Powder and ground-bounce controls.
- Shadow temporal alpha/gamma and whether shadow detail/turbulence are enabled.
- Cascade count, map size, filter radius, and split controls.

### Runtime API
Add atomic methods on [`CloudsNode`](src/webgpu/CloudsNode.ts):
```ts
cloudNode.setQualityPreset('high')
cloudNode.applyQualitySettings(settings)
```
- Apply all scalar uniforms, feature flags, cloud resolution, shadow map size, and cascade count as one transaction.
- Clone mutable vectors from presets so consumers cannot mutate shared preset state.
- Reset cloud and shadow histories once after the full transaction.
- If cascade count changes, rebuild shadow targets and mark the cloud march material graph dirty so its sampled texture nodes are rebound.
- Add a narrow `invalidateMaterial()` method to [`CloudsMarchNode`](src/webgpu/CloudsMarchNode.ts) instead of exposing its private material.

### Preset behavior
- Make `high` match the WebGL cloud-core reference values above.
- Preserve `low` and `medium` as practical performance options.
- Make `ultra` increase sampling fidelity without changing the lighting model.
- Apply `high` by default to restore original appearance; performance-sensitive consumers can explicitly choose `medium` or `low`.
- Raise the cloud march’s compile-time loop ceiling from 256 to at least 512 and the multiple-scattering ceiling from 8 to 12, while retaining uniform early exits.
- Align `ShadowMarchParameters` runtime defaults with the selected preset instead of its current disconnected hardcoded values.

### Demo and validation
- Add a quality preset selector to [`index.html`](index.html) and wire it in [`demo/main.ts`](demo/main.ts).
- Keep individual rendering toggles as explicit overrides after preset selection.
- Verify preset switching repeatedly, including cascade-count and map-size changes, without stale bindings or leaked render targets.
- Run format, lint, typecheck, and both builds.

## Phase 2 — Port the secondary sun-detail march

### TSL lighting helper
Add [`src/webgpu/cloudOpticalDepth.ts`](src/webgpu/cloudOpticalDepth.ts) with a focused fragment-stage helper that:
- Intersects a ray with the flat cloud slab.
- Marches weather and media using the existing [`sampleWeather`](src/webgpu/sampling.ts) and [`sampleMedia`](src/webgpu/sampling.ts) contracts.
- Uses `maxIterationCount`, `minSecondaryStepSize`, `secondaryStepScale`, mip level, and jitter.
- Returns both accumulated optical depth and traveled distance in a small TSL struct.
- Performs no work when the configured iteration count is zero.

### Main march integration
In [`setupCloudsMarch`](src/webgpu/march.ts):
- At every dense primary sample, march a short ray toward `environment.sunDirection`.
- Add the local optical depth to the BSM optical depth.
- Pass the local march’s traveled distance as `distanceOffset` to [`sampleShadowOpticalDepth`](src/webgpu/shadowSampling.ts) so the BSM does not count the same ray segment twice.
- Preserve the existing debug modes by allowing local and BSM optical depth to be inspected separately.

### Validation
- Compare sun-facing edge detail with secondary iteration count `0`, `1`, and `2`.
- Check low-sun rays for bounded slab exits and no division instability near the horizon.
- Verify no change when the feature is disabled.
- Run static checks and builds; user performs the visual scenarios because the agent does not start development servers.

## Phase 3 — Restore cloud-core shading

### Powder shading
Add `powderScale` and `powderExponent` to [`CloudsMarchParameters`](src/webgpu/march.ts) and the quality schema.
- Port the WebGL attenuation exactly: apply it after direct/sky/ground radiance is assembled and before multiplying by media scattering.
- Use `powderScale = 0.8` and `powderExponent = 150` for the parity preset.
- Treat `powderScale = 0` as the disabled path.

### Ground bounce
Extend [`CloudsEnvironmentOptions`](src/webgpu/CloudsEnvironment.ts) with a live linear `groundAlbedo` vector, defaulting to `(0.3, 0.3, 0.3)`.
- Use `mapOrigin.y` as the flat ground plane; do not add terrain/geospatial dependencies.
- March optical depth downward with the shared secondary helper and `maxIterationCountToGround`.
- Recreate the WebGL approximation from host lighting: ground radiance derives from sky irradiance plus coverage-reduced sun irradiance, multiplied by `groundAlbedo / π` and attenuated through the cloud.
- Apply `groundBounceScale` and the same low-altitude/detail gate used by WebGL where it remains meaningful in flat space.
- Make zero ground iterations or zero scale a clean disabled path.

### Phase-function capability
- Port the WebGL accurate phase-function branch alongside the existing dual-lobe approximation.
- Expose a typed `phaseFunction: 'approximate' | 'accurate'` setting.
- Prefer a uniform branch initially; only make it graph-specialized if profiling shows a material cost.

### Validation
- Compare top lighting, dark cores, bright rims, and underside fill independently by toggling sun march, powder, and ground bounce.
- Confirm energy remains finite for zero absorption, dense clouds, and near-zero sun elevation.
- Run static checks and builds.

## Phase 4 — Restore local-weather LOD and stochastic sampling

### Correct parity target
The original explicit `textureLod` path applies to the local-weather texture. Shape and detail textures remain level-zero filtered samples; do not build unnecessary 3D mip pyramids.

### Mipmap generation
In [`ProceduralTextureNode`](src/webgpu/ProceduralTextureNode.ts):
- Allow 2D procedural nodes to opt into mipmaps.
- For local weather and turbulence, use `LinearMipmapLinearFilter`, `generateMipmaps = true`, and storage-texture automatic mip updates after compute writes.
- Preserve one-shot compute generation and mark mip content dirty whenever the texture is resized or recomputed.
- Keep non-mip users on their existing linear path.

### Footprint LOD
Replace the stubbed [`getMipLevel`](src/webgpu/sampling.ts) with the original screen-footprint calculation:
- Compute derivatives from `uv * resolution`.
- Use the original `0.1` footprint scale and logarithmic level formula.
- Keep derivative construction inside fragment-stage cloud/shadow graphs so it cannot leak into procedural compute pipelines.
- Sample local weather with the explicit calculated level.
- Preserve `mipLevelScale = 0.25` under temporal upscaling.

### Optional jitter input
- Add an optional 3D blue-noise/STBN texture node to cloud options.
- Use it when supplied and retain hash jitter as the dependency-free default.
- Do not bundle or download an external texture automatically.

### Validation
- Compare distant cloud structure and empty-space stepping with LOD forced to zero versus automatic LOD.
- Inspect animation for LOD popping and static views for structured hash noise.
- Confirm procedural compute still runs once per dirty texture.
- Run static checks and builds.

## Phase 5 — Stabilize and align the shadow pipeline

### Shadow quality parity
Update [`ShadowMarchParameters`](src/webgpu/shadowParameters.ts) from the active preset:
- Restore 50 iterations and WebGL high thresholds.
- Allow shape detail and turbulence in the shadow march when the active preset enables them; remove unconditional force-disable behavior from [`shadowSampling.ts`](src/webgpu/shadowSampling.ts).
- Retain lower-cost shadow settings in low/medium presets.

### Temporal resolve parity
In [`ShadowResolveNode`](src/webgpu/ShadowResolveNode.ts):
- Change the high-preset history alpha from `0.9` to the WebGL value `0.01`.
- Keep alpha and variance gamma runtime configurable.
- Clear history after sun jumps, quality changes, map-size changes, cascade-count changes, or explicit host resets.
- Preserve per-cascade ping-pong targets and live output texture nodes.

### Runtime rebuild safety
In [`ShadowMarchNode`](src/webgpu/ShadowMarchNode.ts):
- Make map-size changes resize existing targets and reset resolve history.
- Make cascade-count changes dispose and rebuild only owned resources.
- Rebind cloud-march shadow textures through the Phase 1 graph invalidation path.
- Keep separate 2D targets per cascade; do not retry the unsupported layered-target design.

### Validation
- Hold the camera static for at least 32 frames and verify convergence.
- Orbit across cascade boundaries and inspect low-sun filtering.
- Toggle quality presets and shadows repeatedly.
- Confirm no old target remains referenced after cascade rebuilds.
- Run static checks and builds.

## Phase 6 — Expose cloud shadows to scene materials

### Public TSL shadow node
Add [`src/webgpu/CloudShadowNode.ts`](src/webgpu/CloudShadowNode.ts):
- Accept a `CloudsNode`/shadow context and a world-position node.
- Reuse the BSM cascade selection, matrix projection, optical-depth decoding, and PCF helpers from [`shadowSampling.ts`](src/webgpu/shadowSampling.ts).
- Return scalar transmittance in `[0, 1]`, not a renderer-specific light object.
- Keep the clouds update owner in the render graph and document this requirement.

### Stable host contract
Expose:
```ts
cloudShadow(cloudNode, positionWorld)
```
- Hide raw cascade texture arrays and matrix packing behind this helper.
- Document how to multiply host direct-light contribution or a custom NodeMaterial channel by the transmittance.
- Keep in-cloud self-shadow sampling unchanged.

### Demo proof
- Replace the demo ground with a compatible node material and apply cloud-shadow transmittance to its sun-lit result.
- Add a separate scene-shadow toggle so users can distinguish cloud self-shadowing from projected ground shadows.
- Verify landmarks and ground receive moving cloud shadows without atmosphere code.

### Validation
- Check noon, low-sun, cascade boundaries, camera movement, and animated weather.
- Verify disabling scene shadows does not disable in-cloud BSM.
- Run static checks and builds.

## Phase 7 — Harden the public cloud API

### Ergonomic facade
Extend the `clouds()` options or add a typed `CloudsOptions` layer covering:
- Environment inputs.
- Initial quality preset.
- Optional local-weather, shape, detail, turbulence, and jitter texture nodes.
- Initial cloud layers.
- Common scattering, animation, temporal, and shadow overrides.

Add stable `CloudsNode` accessors for common controls instead of requiring consumers to mutate nested uniforms:
- Coverage, detail, turbulence, scattering/absorption.
- Repeats, offsets, velocities, and turbulence displacement.
- Phase, powder, ground bounce, and secondary iteration settings.
- Shadow enabled, map size, cascade count, filter radius, temporal alpha/gamma.

### Resource ownership
- Track whether procedural textures are internally owned or supplied by the host.
- Do not build unused procedural generators when host textures are provided.
- Dispose only internally owned textures.
- Reset histories when texture identities or discontinuous map parameters change.

### Diagnostics
- Connect existing BSM channel/debug modes and [`ShadowDebugNode`](src/webgpu/ShadowDebugNode.ts) through an explicit debug-output selector.
- Add only useful standalone views: cloud color, depth/velocity, selected shadow cascade/channels, and no-shadow comparison.
- Keep diagnostic nodes out of production output unless selected.
- Expose these controls in a collapsed demo section.

### Exports
- Export the stable facade, quality types, cloud-shadow helper, layer model, and intentional advanced nodes from [`src/webgpu/index.ts`](src/webgpu/index.ts).
- Stop treating internal render-target helpers and implementation-only shader functions as primary API.
- Preserve compatibility aliases where removing an existing export would be unnecessary.

### Validation
- Build the declaration bundle and inspect it for private/internal Three.js types.
- Exercise default, custom-texture, custom-layer, and manual-setting construction paths.
- Run static checks and builds.

## Phase 8 — Validate and package the parity release

### Static gates after every implementation phase
- `npx prettier --check` for changed files.
- `npm run lint`.
- `npm run typecheck`.
- `npm run build:library`.
- `npm run build:demo`.
- Inspect emitted ESM/CJS and declarations for unresolved monorepo, WebGL, atmosphere, React, or internal project imports.
- Run GitNexus `detect_changes({ scope: "all" })` before any requested commit; partial or truncated analysis is not a clean result.

### User-run visual acceptance
The agent must not start a development server. The user runs `npm run dev` and validates the Phase 0 scenarios after each visual phase.

Final acceptance requires:
- High preset reproduces the original cloud density range and layer detail without the current early distance cutoff.
- Secondary sun detail, powder, and ground bounce each produce the intended WebGL-like contribution and can be disabled independently.
- Self-shadows converge stably and agree with visible shape detail.
- Local-weather LOD reduces distant aliasing without destroying large-scale density.
- TAAU remains stable through motion, camera cuts, resize, and quality changes.
- Scene materials can consume cloud-shadow transmittance through a documented public helper.
- The standalone demo exposes presets and representative controls without Storybook.
- The package builds with Three.js as its only runtime peer.

### Package integration
- Replace the demo’s internal `three/src/renderers/common/RenderPipeline.js` import with the supported public Three.js `PostProcessing`/TSL composition path.
- Update [`README.md`](README.md) with the final construction, quality, custom-texture, temporal-reset, and scene-shadow APIs.
- Keep `private: true` until the user chooses the final npm package name and publication policy.
- Do not commit or publish unless explicitly requested.

## Deferred and excluded features
- Atmosphere LUT-based `accurateSunSkyLight`.
- Bruneton aerial perspective and haze.
- ECEF/ellipsoid curvature, altitude correction, and geospatial world-origin rebasing.
- Atmosphere shadow-length/light-shaft composition.
- WebGL and `postprocessing` compatibility layers.
- React/R3F and Storybook wrappers.
- Automated tests, per the explicit project requirement.