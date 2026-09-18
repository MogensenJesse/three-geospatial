# WebGPU clouds look-parity plan (vs WebGL main)

**Baseline:** `webgpu/clouds` @ `2edaeb00` (Bayer `CloudsResolveNode`, no pmndrs; descended from `5482e2ff`)
**Reference:** `main` @ `b012ad06` (`@takram/three-clouds` Bayer TAAU)  
**Map:** `docs/webgl-main-vs-webgpu-checkout.md`  
**Goal:** Match WebGL **march**, **lighting**, and **temporal** look (soft volumetrics, fine organic grain, feathered edges, stable stills, clean pans).

Out of scope unless Jesse expands later: R3F/Storybook packaging, geospatial ECEF framing, full atmosphere/`AerialPerspective` coupling, haze, light shafts, `@pmndrs/upscaler`.

---

## Acceptance bar (all phases)

Use the same camera / time-of-day / coverage when comparing.

| Check | Pass means |
|--|--|
| **Still (parked 2s+)** | Soft volume + fine grain; no chunky Bayer sparkle once settled; edges feather like WebGL |
| **Gentle pan** | No colour trails / smear; history reprojects; age/phase behaviour feels continuous |
| **Fast pan** | May thin history but no wrong-direction ghosts; recovers cleanly when stopped |
| **Lighting** | Core brightness, powder soft-shadow in lobes, ground bounce, and BSM self-shadow read like WebGL high (art-directed sun/sky allowed to differ slightly in absolute colour) |

Default probe preset: **high** (`webglHighReference`): `resolutionScale = 1`, `temporalUpscale = true`.

---

## Phase 0 - Lock the harness (no look work yet)

**Why:** Without a fixed A/B path, every later tweak is guesswork.

1. Keep temporal owner = **Bayer** (`CloudsMarchNode` + `CloudsResolveNode`). Do not reintroduce pmndrs.
2. Demo defaults: high preset, TAAU on, temporal history on.
3. Capture / keep a WebGL still (and optional short pan) as the visual bar; store under `docs/ref/` when local-exec allows, otherwise link criteria only.
4. Log once per session: march RT size, logical res, `temporalUpscale`, `varianceGamma`, `temporalAlpha`, frame Bayer phase.
5. Update the comparison doc only when a phase sticks (short dated note), not every probe.

**Exit:** One-command / one-toggle path to "WebGL-comparable" demo settings; QA can reproduce.

---

## Phase 1 - Temporal look parity (highest leverage)

**Why:** Softness and pan behaviour come from TAAU + velocity + variance clip. Comparison doc flags the concrete deltas.

### 1a. Knob parity

| Knob | WebGL | This checkout | Action |
|--|--|--|--|
| `varianceGamma` | **2** (`CloudsResolveMaterial`) | **1.5** (`CloudsResolveNode`) | **Verified.** Match **2** first; A/B still grain |
| `temporalAlpha` | 0.1 (non-TAAU / classic TAA) | 0.1 | Keep; TAAU phase-write path does not use this blend the same way |
| March scale | `ceil(W/4)` when TAAU | `ceil(scaled/4)` + logical `x4` | **Verified** in `CloudsMarchNode.setSize` |
| Bayer 16-phase | `bayerOffsets` | Ported + **Y flip** (`oy = 1 - offset.y`, jitter `-dy`) | **Verified** vs resolve `flat[y*4+x]` |
| Velocity | UV `vUv - prevUv` | UV `screenUV - prevUv` with **NDC Y negate** | **Verified** end of `march.ts`; wrong Y = opposite-pan ghosts |

### 1b. Velocity / jitter correctness

WebGL and this commit both use **UV** velocity (`currentUV - prevUV`), not NDC/FSR.

1. Debug overlay: show `|velocity|` or history rejection (existing debug paths / `DEBUG_SHOW_VELOCITY` equivalent).
2. Verify **Y flip** on `prevUv` and Bayer jitter sign against WebGPU `screenUV` (top-left). Wrong sign = opposite-pan ghosts.
3. Confirm reprojection matrices are updated after each frame (WebGL `copyReprojection` order).
4. History reset on resize / preset / TAAU toggle (no stale full-screen dump).

### 1c. Resolve path fidelity

1. TAAU branch: current Bayer phase writes fresh sample; other phases reproject + variance clip (no soft leftover when rejected).
2. Neighbourhood / closest-depth velocity sample matches WebGL 3x3 intent.
3. Filter: WebGL resolve often uses plain `texture()` history; match filtering (Linear) on history/current RTs.

**Exit:** Still matches WebGL softness at gamma 2; gentle + fast pan pass the acceptance bar. Hand to QA with verify steps.

**Files:** `src/webgpu/CloudsResolveNode.ts`, `CloudsMarchNode.ts`, velocity end of `src/webgpu/march.ts`, `src/bayer.ts`.

---

## Phase 2 - March sampling parity

**Why:** Temporal can only refine what the march puts in the 1/4 RT. Onion-skin, density holes, and step banding are march issues.

1. Align **high** march knobs with WebGL defaults (already largely in `webglHighReference`):
   - `maxIterationCount` 500, `minStepSize` 50, `maxStepSize` 1000, `maxRayDistance` 2e5
   - `minDensity` / `minExtinction` / `minTransmittance`
   - `perspectiveStepScale` 1.01
   - secondary / ground iteration counts (**note:** WebGL `maxIterationCountToSun = 2` vs checkout `secondaryIterationCount = 1`) (**note:** WebGL `maxIterationCountToSun = 2` vs checkout `secondaryIterationCount = 1`)
2. When TAAU on: `stepSizeScale` / `mipLevelScale` behaviour vs WebGL jittered mip (WebGL comments on doubling jitter for spatial aliasing - verify WebGPU equivalent).
3. When TAAU off: denser steps (`stepSizeScale` 0.35 today) - confirm this is intentional vs WebGL full-res TAA path, not a silent look break.
4. Shape / detail / turbulence sampling: same assets and stack order as WebGL; A/B with turbulence off to isolate.
5. Layer altitudes / coverage / densityScale: use the same layer recipe as the WebGL high story when comparing.

**Exit:** Single-frame (or TAAU-off) march structure reads like WebGL; no large missing layers or step banding that temporal cannot hide.

**Files:** `src/webgpu/march.ts`, `sampling.ts`, `CloudsMarchNode.ts`, `qualityPresets.ts`, `applyCloudsQuality.ts`, layer setup in demo.

---

## Phase 3 - Lighting / shading parity

**Why:** Same density can still look "wrong" if powder, multi-scatter, phase, or BSM diverge.

### 3a. In-scattering / media (cloud body)

1. Confirm live uniforms match high preset: `powderScale` 0.8, `powderExponent` 150, `groundBounceScale` 1, `multiScatteringOctaves` 8, `phaseFunctionMode` approximate (unless WebGL story uses accurate).
2. Variant keys in `cloudsMarchVariant.ts` must rebuild when those knobs change (no stale `p0`/`g0` graph).
3. A/B toggles in demo (or DEV): powder on/off, ground bounce on/off, octaves 8 vs lower - isolate which term mismatches WebGL.
4. Sun/sky irradiance: standalone demo is art-directed. Document the intended mode (`artDirected` vs any takram path). Parity = relative lobe shape and self-shadow, not pixel-identical sky colour.

### 3b. Beer shadow maps

1. Cascade count / map size / march limits vs WebGL high (3 x 512, 50 iterations, etc.) — **aligned** in `webglHighReference.shadow`.
2. Shadow temporal resolve knobs (**verified delta**):
   - WebGL `ShadowResolveMaterial`: `temporalAlpha = 0.01`, `varianceGamma = 1`
   - Checkout node defaults match that, but `highShadow` / `applyCloudsQuality` sets **`temporalAlpha = 0.1`** (10× WebGL) and maps `temporalGamma` → `varianceGamma` (= **1**). **Match WebGL 0.01** before blaming BSM softness.
3. Shadow jitter off (WebGL note) — ensure WebGPU shadow path does not fight cloud Bayer jitter.
4. Secondary sun marches: WebGL `maxIterationCountToSun = 2` vs checkout `secondaryIterationCount = 1` on high — raise to **2** when lighting lobes look thin.

**Exit:** Lit stills match WebGL "feel" under the same sun elevation; powder and BSM soft contact visible; no flat unlit slabs.

**Files:** `march.ts` lighting terms, `shadowSampling.ts`, `ShadowResolveNode.ts`, `CloudShadowNode.ts`, `applyCloudsQuality.ts`, `qualityPresets.ts`.

---

## Phase 4 - Cross-term polish (only after 1-3)

1. Side-by-side still contact sheet (WebGL vs WebGPU) at 2-3 sun angles.
2. Perf budget: keep 1/4 TAAU; if cost spikes, cut secondary/shadow iterations before touching temporal gamma.
3. Known intentional gaps list (atmosphere haze, light shafts, accurate sun/sky from atmosphere LUTs) so QA does not fail them.
4. Optional: bump `varianceGamma` / history only if Phase 1 still needs micro-tuning after lighting is fixed (lighting changes change variance neighbourhood).

**Exit:** Written "parity achieved / residual gaps" note in this doc or a short follow-up; QA sign-off on acceptance table.

---

## Phase order (do not skip ahead)

```
0 Harness
  -> 1 Temporal (gamma, velocity/Y, history)
    -> 2 March sampling
      -> 3 Lighting + BSM
        -> 4 Polish / QA sign-off
```

Temporal first: it dominates the soft WebGL look Jesse set as the bar. March before lighting when structure is wrong; lighting before declaring colour parity.

---

## Per-phase TEMP -> QA handoff

When a phase sticks:

1. Intent + files/symbols touched
2. Verify: still / gentle pan / fast pan (+ lighting A/B if Phase 3)
3. Risks: Y/jitter, history reset, dispose, quality preset stomps
4. Ping QA; do not ask them to finish the feature

---

## Quick reference - first concrete edits (Phase 1a)

1. Set `CloudsResolveNode.varianceGamma` default **1.5 -> 2** (match WebGL `CloudsResolveMaterial`).
2. Hard-refresh; park camera; compare grain to WebGL still.
3. If pans smear, debug UV velocity Y/sign before changing gamma again.
4. Only then open Phase 2 march knobs.

---

## Git anchors

```
webgpu/clouds (local): 2edaeb008bb538bc38271276ac49880d1d2a29d8  (parity-map tip; Bayer baseline)
main (WebGL):          b012ad06d858fc035d88aacfd73f092f93c994e4
```

---

## Verification notes (Research) - 2026-09-18

Checked plan text against live `webgpu/clouds` HEAD and `git show main:packages/clouds/...`.

| Claim | Result |
|--|--|
| Temporal owner = Bayer (no pmndrs) | **Pass** — `CloudsResolveNode` present; no `pmndrsTemporalClouds` |
| `varianceGamma` 1.5 vs WebGL 2 | **Pass** (real delta; Phase 1a first edit) |
| UV velocity + WebGPU Y flip | **Pass** |
| March 1/4 + logical ×4 when TAAU | **Pass** |
| High march knobs ≈ WebGL | **Mostly pass** — `minTransmittance` 1e-2 matches; **secondary ToSun 1 vs 2** |
| Shadow temporal defaults | **Fail match** — preset drives shadow `temporalAlpha` **0.1** vs WebGL **0.01** |
| Baseline SHA in plan | **Updated** — tip is `2edaeb00` (parity-map commit), still Bayer family |

**Order still correct:** harness → temporal (gamma/velocity) → march → lighting/BSM → polish. Do not skip to lighting while gamma is 1.5 and pans smear.

**Residual risks:** Bayer phase vs jitter Y mismatch under resize; quality-preset stomping TAAU/history; art-directed irradiance ≠ atmosphere LUTs (intentional gap).
