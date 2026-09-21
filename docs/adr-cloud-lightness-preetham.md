# ADR: WebGPU cloud lightness vs WebGL (keep Preetham sky)

**Date:** 2026-09-19  
**Branch:** `webgpu/clouds-optimizations` @ `05d83a49`  
**Constraint:** Do **not** swap in takram atmosphere / `AerialPerspective`. Keep Three `SkyMesh` (Preetham) as the visible sky.

**Evidence:** WebGPU still = darker cores, heavier stipple; WebGL still = brighter, airier, softer contact shadows.

---

## Diagnosis (leverage order)

| Rank | Cause | Why it matches the stills |
|--|--|--|
| **1** | **March irradiance ≠ sky look** | Demo default `irradiance=artDirected` feeds `sun=(1,1,1)`, `sky=(0.15,0.15,0.15)` into `CloudsEnvironment`. `SkyMesh` Preetham is drawn separately and **does not** drive those uniforms. WebGL high uses `accurateSunSkyLight: true` (atmosphere LUTs) → much stronger sky fill into the volume. Result: dark cores / less airy while the backdrop sky still looks fine. |
| **2** | **Sky fill scale** | Even with better irradiance, `skyLightScale` (default 1) may need a small bump if bake energy is still under WebGL. |
| **3** | **Powder** | Knobs already match WebGL (`powderScale` 0.8, `powderExponent` 150). Only touch if cores stay crushed after irradiance. |
| **4** | **BSM** | Shadow `temporalAlpha` already **0.01** (WebGL match). Secondary sun iters already **2**. Lower leverage for “overall lightness.” |
| **—** | **Stipple grain** | Mostly temporal/Bayer (Phase 1), not lighting. Don’t chase with powder/irradiance alone. |

---

## Pick (Engine lands)

1. **Default march irradiance to `preethamBake`**, driven by the **same sun elevation** as `SkyMesh` (already on `#sun-elevation`). Keep `SkyMesh` turbidity/rayleigh/etc. untouched.  
   - Optional better later: bake from SkyMesh’s actual sun direction each frame (still no atmosphere package).  
2. A/B stills: `?irradiance=artDirected` vs `preethamBake` vs WebGL ref — expect brighter airier volumes on bake.  
3. If still short of WebGL: raise **`skyLightScale`** in small steps (e.g. 1.0 → 1.2), not sun intensity first.  
4. Only then consider slight **`powderScale`** down (e.g. 0.8 → 0.65) if dense cores remain crushed.  
5. Leave BSM / phase / multi-scatter octaves alone unless A/B proves them.

**Do not:** enable `irradiance=takram` in standalone; replace Preetham sky; raise march res for lightness.

---

## What would break / how we’d know

| Risk | Signal |
|--|--|
| Bake energy too high vs AgX exposure | Blown cloud tops / washed scene — lower exposure or bake sunScale |
| Elevation desync with SkyMesh | Clouds bright while sky looks dusk (or reverse) — bind bake to same elev control |
| skyLightScale too high | Milky / flat volumes, lost lobe contrast |
| powderScale too low | Lose soft powder darkening WebGL has in dense lobes |
| Pass | Parked still closer to WebGL airiness; Preetham horizon/sun disk unchanged; grain treated as separate temporal ticket |

---

## Handoff

**Owner:** Engine & tooling  
**QA:** after TEMP, still A/B vs WebGL ref + confirm sky dome unchanged  
**Research:** amend only if irradiance approach forks (e.g. true SkyMesh spectral bake)

---*

**Engine landed (2026-09-19):** Default irradiance → preethamBake (query/UI/takram-fallback). SkyMesh untouched. Next smoke: still vs WebGL; if short, try skyLightScale then powder.

## Status log

| When | Phase | Note |
|--|--|--|
| 2026-09-19 | **Lightness pick landed** | Demo default `preethamBake` + artDirected A/B zero-copy fix. Jesse still smoke vs WebGL; next `skyLightScale` if short. |

---

## Demo lock (2026-09-21) — ADR coherence

Jesse locked demo defaults after tuning: **exposure 1.25**, **`skyLightScale` 3**, **sky intensity 6**, irradiance **preethamBake**.

**Coherent with ADR?** Directionally yes (bake first, then sky fill). Magnitude is **past** the ADR’s “small steps” (1.0→1.2): stacked sky path is roughly **3 × 6** vs baseline bake sky. Treat as an **accepted demo art lock**, not a library default.

**Guidance:**
1. Keep **`march.skyLightScale` uniform default = 1** in the library; demo HTML/`bind` applies 3 (QA lean note).
2. If stills go milky/blown vs WebGL, dial **sky intensity down before** `skyLightScale` (preserve lobe contrast).
3. Powder still last; grain still temporal.
4. Pantheon host should get explicit options (`skyLightScale` on `CloudsOptions`) rather than inheriting a baked march default of 3.
