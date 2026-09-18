# WebGL main vs this WebGPU checkout

**Baseline (this checkout):** detached `5482e2ff` - Extract CloudsNode tuning & split demo controls
**Reference (WebGL):** `main` @ `b012ad06` - `@takram/three-clouds`
**Purpose:** Start-from-scratch map of how the known-good WebGL path works, what this checkout already mirrors, and where they diverge. Previous phase/audit docs were deleted.

---

## 1. One-line summary

| | WebGL `main` | This checkout (`5482e2ff`) |
|--|--|--|
| Package | `@takram/three-clouds` in a monorepo | Standalone `webgpu-clouds` Vite package |
| API surface | `postprocessing` Effect + R3F | Three.js WebGPU / TSL nodes |
| World | Geospatial + `@takram/three-atmosphere` | Flat-world, atmosphere-agnostic demo |
| Temporal owner | Built-in Bayer **TAAU** (`CloudsResolveMaterial`) | Ported Bayer **TAAU** (`CloudsResolveNode`) |
| Upscaler | None (custom resolve) | None on this commit (no `@pmndrs/upscaler`) |

The quality bar is the WebGL TAAU look. This commit still uses that same algorithm family (Bayer 4x4 + history + variance clip), not an external FSR/upscaler path.

---

## 2. How WebGL `main` works (clouds)

### Pipeline

```
EffectComposer
  -> CloudsEffect
       -> ShadowPass (+ ShadowResolve)     // beer shadow maps / cascades
       -> CloudsPass
            -> CloudsMaterial  -> low-res (or full) march RT
            |     MRT: color + depthVelocity (+ optional shadowLength)
            -> CloudsResolveMaterial -> full-res history ping-pong
  -> AerialPerspective (atmosphere package; after clouds)
```

Entry points: `packages/clouds/src/CloudsEffect.ts`, `CloudsPass.ts`, R3F wrapper `r3f/Clouds.tsx`.

### Temporal upscale (the soft look)

When `temporalUpscale === true` (default on high):

1. **March at 1/4** - `currentRenderTarget` sized `ceil(W/4) x ceil(H/4)`.
2. **Logical resolution** fed to the march shader is `lowRes * 4` (so rays / mip feel full-res).
3. **Bayer jitter** - 16-phase `bayerOffsets`; projection jittered each frame; `frame % 16` selects the active subpixel.
4. **Resolve at full res** - for each display pixel:
   - `lowResCoord = coord / 4`
   - If this pixel's Bayer phase matches `frame % 16` -> write **current** march sample (no blend).
   - Else -> reproject history with **UV velocity**, **variance clipping** (`varianceGamma`, default **2**), keep history (ghosting tolerated on clouds).
5. **Non-upscale path** (`TEMPORAL_UPSCALE` off) -> classic TAA: `mix(clippedHistory, current, temporalAlpha)` with default `temporalAlpha = 0.1`.

Shader: `packages/clouds/src/shaders/cloudsResolve.frag`.

### Velocity (WebGL)

Packed in `depthVelocity.gb` as **UV delta**:

```
prevUv = ndc.xy * 0.5 + 0.5   // from reprojectionMatrix (world) or viewReprojection
velocity = vUv - prevUv
depthVelocity = vec3(frontDepth, velocity)
```

Resolve: `prevUv = vUv - velocity`, reject if outside [0,1]. Closest-depth neighbourhood (3x3) picks the velocity sample.

### Quality defaults (high)

From `packages/clouds/src/qualityPresets.ts`:

- `resolutionScale: 1`
- Temporal upscale **on** (Effect / Pass flag; resolve material defaults `temporalUpscale = true`)
- March: 500 primary iterations, multi-scatter octaves 8, etc.
- Shadow: 3 cascades, 512^2, temporal resolve with alpha / gamma on the shadow path

### What WebGL owns that this demo does not

- Geospatial / ECEF-style framing via atmosphere
- Light shafts, haze toggles wired through Effect
- Storybook + R3F integration
- `postprocessing` EffectComposer integration
- Shared monorepo with tiles / atmosphere / geospatial helpers

---

## 3. How this checkout works (`5482e2ff`)

### Pipeline

```
WebGPURenderer + RenderPipeline (demo/main.ts)
  -> scene color pass
  -> CloudsNode
  |    -> CloudShadowNode / ShadowMarch + ShadowResolve
  |    -> CloudsMarchNode   -> 1/4 (or full) march RT + depthVelocity MRT
  |    -> CloudsResolveNode -> full-res Bayer TAAU / TAA (TSL port)
  -> compositeClouds(sceneColor, cloudTexture)
```

Library root: `src/` (shared domain) + `src/webgpu/` (TSL nodes). Demo: `demo/main.ts` + `bindCloudControls.ts`.

### Temporal (ported, not replaced)

`CloudsResolveNode` is the cloud-specific temporal resolve: **1/4 Bayer reconstruct** matching WebGL.

- March: `CloudsMarchNode.setSize` -> when `temporalUpscale`, RT = `ceil(scaled/4)`; logical res = `x4`; Bayer offsets with **Y flipped** for WebGPU top-left UV.
- Resolve: same phase test (`bayerIndices`), variance clip path, history ping-pong.
- Knobs: `temporalAlpha` (default 0.1), `varianceGamma` (default **1.5** here vs **2** on WebGL resolve material - note the delta).
- Demo toggles: quality preset, resolution scale, temporal upscale, temporal history.

### Velocity (this checkout)

Still **UV-space** like WebGL, with an explicit Y flip for WebGPU `screenUV`:

```
prevNdc -> prevUv with Y negated
velocity = screenUV - prevUv
depthVelocity = vec4(frontDepth, velocity, 1)
```

On this commit, velocity convention matches the WebGL resolve math (UV), not a later NDC / `motionScale` experiment.

### Quality presets

`src/qualityPresets.ts` defines `webglHighReference` explicitly for parity:

- `resolutionScale: 1`, `temporalUpscale: true`
- March / shadow numbers aligned with WebGL high
- Extra fields WebGL encodes differently: `powderScale`, `groundBounceScale`, `phaseFunctionMode`, shadow `temporalAlpha` / `temporalGamma`

---

## 4. Difference map (actionable)

### Architecture

| Topic | WebGL `main` | This checkout | Notes |
|--|--|--|--|
| Repo shape | Nx monorepo `packages/clouds` | Flat Vite `webgpu-clouds` | Packaging / consumers differ |
| Host API | `CloudsEffect` + postprocessing | `CloudsNode` + TSL | Same ideas, different glue |
| Shaders | GLSL `.frag` / RawShaderMaterial | TSL `Fn` graphs | Port risk: Y, depth, filter semantics |
| Atmosphere | Required peer story | Demo is art-directed / agnostic | Irradiance A/B notes in demo |
| R3F / Storybook | First-class | Removed in this scaffold | |

### Temporal / look (highest leverage)

| Topic | WebGL `main` | This checkout | Risk if wrong |
|--|--|--|--|
| Algorithm | Bayer TAAU + variance clip | Same family in `CloudsResolveNode` | Should be able to match soft WebGL stills |
| March scale | 1/4 when TAAU on | 1/4 when TAAU on | OK |
| Velocity space | UV (`vUv - prevUv`) | UV (`screenUV - prevUv` + Y flip) | Y flip / jitter sign bugs -> smear |
| `varianceGamma` | default **2** | default **1.5** | Tighter clip -> grainier / less soft |
| `temporalAlpha` | 0.1 (TAA path) | 0.1 | OK |
| History | Ping-pong RT pair | Resolve node history | Reset / first-frame validity |

### March / lighting

| Topic | WebGL | This checkout |
|--|--|--|
| Shape / detail / turbulence textures | Procedural + assets in package | Ported nodes + shared assets path |
| BSM shadows | `ShadowPass` + resolve | `CloudShadowNode` / march / resolve |
| Secondary / ground bounce | GLSL uniforms | Explicit quality fields + march |
| Accurate sun/sky light | Atmosphere-coupled | Limited / art-directed in standalone demo |

### Explicitly not on this commit

- No `demo/pmndrsTemporalClouds.ts`
- No `@pmndrs/upscaler` dependency
- No NDC `curr - prev` velocity for FSR `motionScale(0.5, -0.5)`

Later `webgpu/clouds` tip work that swapped Bayer for pmndrs is **out of scope** for this baseline. Treat that as a separate fork if revisited.

---

## 5. Suggested reading order (code)

**WebGL `main`:**

1. `packages/clouds/src/CloudsEffect.ts` - host
2. `packages/clouds/src/CloudsPass.ts` - march -> resolve -> swap
3. `packages/clouds/src/shaders/cloudsResolve.frag` - TAAU vs TAA
4. Velocity block in `packages/clouds/src/shaders/clouds.frag`
5. `packages/clouds/src/bayer.ts`, `qualityPresets.ts`

**This checkout:**

1. `src/webgpu/CloudsNode.ts` - host
2. `src/webgpu/CloudsMarchNode.ts` - size / Bayer jitter / reprojection
3. `src/webgpu/CloudsResolveNode.ts` - TAAU port
4. Velocity at end of `src/webgpu/march.ts`
5. `src/qualityPresets.ts`, `demo/main.ts`

---

## 6. Working rules from here

1. **Visual bar** = WebGL `main` stills (soft volumetrics, fine grain, feathered edges, stable when parked, no pan trails).
2. **Temporal owner on this baseline** = `CloudsResolveNode` (Bayer), not an external upscaler.
3. Prefer fixing **parity deltas** (Y/jitter/velocity, `varianceGamma`, history reset) before inventing a new temporal backend.
4. Keep docs in `docs/` lean; this file is the map. Add short dated notes only when a probe sticks.

### Git anchors

```
HEAD (baseline):  5482e2ff56a39b15e57410a2059a4196f4063d8e
main (WebGL):     b012ad06d858fc035d88aacfd73f092f93c994e4
merge-base:       1c6ff754e748aa42ea9cfc930b77ca1ec8f76d9e
```

Compare anytime with:

```powershell
git diff main...HEAD --stat -- src packages/clouds demo
```