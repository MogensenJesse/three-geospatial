# WebGPU Clouds Performance Plan

**Repo:** `D:\three-geospatial` (`webgpu/clouds`)  
**Goal:** Close the FPS gap vs WebGL (~70+ → target ≥60 shadows-on / ≥65 shadows-off at high + TAAU on the current demo view).  
**Date:** 2026-09-14  

## Context

| Mode | Baseline (high + TAAU) | Notes |
|------|------------------------|--------|
| Shadows off | ~56–58 fps · march ~15–16 ms | Still short of WebGL |
| Shadows on | ~45–47 fps · march ~20–22 ms | Extra ~6–8 ms = BSM consume |

Micro A/Bs (4-tap PCF, phase bake/unroll, coarse-mip local sun, BSM early-out, turbulence mip-gate, cheap BSM produce) did **not** move FPS meaningfully and were reverted (except lasting product fixes: atlas correctness, hard cascade, `secondaryIterationCount=1`, narrowed exports, etc.).

**Root cause (vs WebGL `packages/clouds` on `main`):** structural, not missing cloud math.

1. **BSM sampling path** — WebGL `sampler2DArray` + layer index; WebGPU horizontal **atlas + `copyTextureToTexture` + UV remap**.
2. **Specialization** — WebGL `#ifdef` / `#pragma unroll_loop`; WebGPU TSL runtime `If` / `Loop` / `select`.
3. **Pipeline shape** — WebGL single MRT march pass; WebGPU march → resolve → host materials + TSL/bind overhead.

---

## Principles

- Prefer **architecture** over more march micro-gates.
- Measure with **GPU timestamps** (RenderDoc / PIX / Chromium WebGPU timestamps), not only CPU `lastPassTiming`.
- One A/B at a time; keep a still of silver-lining + cascade boundaries.
- Do **not** revisit: phase bake/unroll as tried, 4-tap-only PCF as primary bet, atlas-as-FPS without changing sample model.

---

## Phase A — Instrument (1–2 days)

**Why:** Confirm where GPU time goes before rewriting BSM.

### A1. Pass GPU timers
- Add WebGPU timestamp queries (or Spector/RenderDoc capture) around:
  - shadow cascade marches + resolve
  - atlas pack (`copyTextureToTexture` × N)
  - clouds march
  - clouds resolve
- Record: shadows on/off, high preset, same camera.

### A2. Capture WGSL
- Dump generated march + shadow-sample WGSL from Three/TSL.
- Note: loop structure, texture binds, whether Vogel/MS are dynamic loops.

### Exit criteria
- Written breakdown: % GPU in BSM consume vs produce vs march body vs resolve vs atlas copies.

---

## Phase B — Array / layered BSM (highest impact)

**Why:** Matches WebGL’s `sampler2DArray shadowBuffer` and removes atlas pack + UV tile math from the hot path.

### B1. Feasibility spike
- Research current Three.js r183 WebGPU support for:
  - `DataArrayTexture` / texture-array sampling in TSL
  - layered render targets / `textureLoad` per layer
  - copy from 2D cascade RT → array layer (acceptable interim)
- Document: **write path** options (A/B/C below) and pick one.

### B2. Implementation options (pick after spike)

| Option | Write path | Sample path | Risk |
|--------|------------|-------------|------|
| **B2-a** | Keep per-cascade 2D marches; `copyTextureToTexture` into **array layers** (not atlas strip) | `texture(array, vec3(uv, layer))` | Medium — still N copies, but sampling matches WebGL |
| **B2-b** | True layered RT if Three/WebGPU allows | Same | Higher feasibility risk |
| **B2-c** | Compute pass writes array layers | Same | Larger rewrite |

### B3. Sampling parity
- Replace atlas UV remap in `shadowSampling.ts` with layer index (int cascade).
- Keep hard cascade index (already in tree); optional faded cascade later if seams show.
- Remove or gate `ShadowCascadeAtlas` once array path is stable.
- Update `CloudShadowNode` / `getShadowAtlasNode` → `getShadowArrayNode` (or keep facade name).

### B4. Validate
- Preset switch map sizes / cascade counts (prior atlas bug class).
- Scene + cloud shadows while orbiting.
- FPS: expect most of the **~6–8 ms shadows-on** gap to shrink if sampling was atlas-bound.

### Exit criteria
- No atlas strip in hot path; shadows correct on all presets; shadows-on FPS clearly up vs baseline.

---

## Phase C — Shader variants (medium impact, careful)

**Why:** WebGL deletes dead code; runtime TSL leaves both branches live.

### C1. Variant axes (build-time / material cache key)
Only axes that **drop** substantial code:

1. `shadowsOn` / `shadowsOff` — omit BSM sample + related uniforms when off (already partially done via `shadowAtlas = null` + invalidate; formalize as explicit variant).
2. `groundBounce` on/off — omit nested ground OD when scale/iterations are 0.
3. `phaseApproximate` only — omit accurate Mie from graph when preset is approximate (do **not** unroll MS heavier than today).

### C2. Implementation approach
- Extend `CloudsMarchNode` material `customCacheKey` (or equivalent) with variant bits.
- Build separate TSL graphs per variant in `setup`, **excluding** unused Fn chains (not `select` between heavy paths).
- Invalidate on preset / shadow toggle only.

### C3. What not to do
- Do not reintroduce full MS unroll + dual phase bake that previously **lost** FPS.
- Do not explode variant count (keep ≤ 4–6 combinations).

### Exit criteria
- Shadows-off WGSL contains no BSM sample calls.
- Approximate-phase WGSL contains no Draine/accurate Mie.
- Measurable FPS gain on shadows-off and/or approximate high.

---

## Phase D — Quality tiers that buy FPS (optional product)

**Why:** Same algorithm as WebGL high; if array+variants aren’t enough, trade quality explicitly.

### D1. “Performance” high preset (or new `high-perf`)
Candidate knobs (document look delta):

- Shadow `mapSize` 512 → 256 (medium already)
- `maxIterationCount` 500 → 350–400
- `multiScatteringOctaves` 8 → 4–6
- Shadow produce `maxIterationCount` 50 → 32

### D2. Demo labeling
- Expose as named preset so “high” stays WebGL parity target.

### Exit criteria
- Clear FPS uplift with accepted visual checklist.

---

## Phase E — Pipeline hygiene (lower priority)

- Reduce per-frame `new Matrix4()` in `CloudsMarchNode.prepareFrame` via scratches + proven upload pattern (only if GPU profile shows CPU bound).
- Avoid redundant material invalidates on quality apply when variant key unchanged.
- Consider merging march+resolve only if profiling shows submit overhead (likely small vs march).

---

## Suggested order of work

```
A (instrument) → B (array BSM) → C (variants) → D (optional tier) → E (hygiene)
```

| Phase | Effort | Expected FPS impact | Risk |
|-------|--------|---------------------|------|
| A | S | 0 (enables decisions) | Low |
| B | L | High (shadows-on) | Medium–high |
| C | M | Medium (esp. shadows-off) | Medium (regressions) |
| D | S | Medium | Low (explicit tradeoff) |
| E | S | Low | Low |

---

## Success metrics

- **Primary:** high + TAAU, same demo framing as today  
  - Shadows on ≥ **60 fps** or ≥ **30%** reduction in march ms vs ~21 ms  
  - Shadows off ≥ **65 fps** or march ≤ ~12 ms  
- **Parity:** no new ghosting; preset switches keep stable shadows; silver-lining acceptable vs current high.
- **Non-goals:** matching ultra 1024² quality at 60 fps on this laptop.

---

## Open questions (resolve in Phase A/B1)

1. Can Three r183 WebGPU sample `DataArrayTexture` from TSL with dynamic layer index efficiently?
2. Is copy-into-array-layers (B2-a) enough, or do we need true layered renders?
3. After B, is remaining gap mostly march body (then C/D) or still BSM?

---

## References (in-tree / `main`)

- WebGL: `packages/clouds/src/shaders/clouds.frag` (`sampler2DArray shadowBuffer`, unrolled PCF/MS)
- WebGL: `packages/clouds/src/helpers/setArrayRenderTargetLayers.ts`
- WebGPU: `src/webgpu/shadowSampling.ts`, `ShadowCascadeAtlas.ts`, `march.ts`
- Prior notes: atlas float UV + preset rebuild; hard cascade; failed micro A/Bs

