# Phase A findings — GPU timers + WGSL

Captured 2026-09-15 (high preset, TAAU on, hist on, March RT 462×272).

## Results

### Shadows ON (high)

- pass-stats: `March RT 462×272 · out 1846×1085 · draw 1846×1085 · TAAU on · tu 1 · hist on · hv 1 · shadows on · ms p 0.2 / sr 0.4 / a 0.0 / m 20.5 / r 0.2 / Σ 21.3 · gpu 11.4`

### Shadows OFF (high)

- pass-stats: `March RT 462×272 · out 1846×1085 · draw 1846×1085 · TAAU on · tu 1 · hist on · hv 1 · shadows off · ms p 0.0 / sr 0.0 / a 0.0 / m 15.2 / r 0.4 / Σ 15.6 · gpu 5.0`

## Split interpretation

| Bucket | ON | OFF | Delta | Read |
|--------|----|-----|-------|------|
| produce (`p`) | 0.2 | 0.0 | +0.2 | Cascade marches cheap on CPU submit |
| shadow-resolve (`sr`) | 0.4 | 0.0 | +0.4 | Small |
| atlas (`a`) | 0.0 | 0.0 | 0 | Pack not a CPU bottleneck |
| march (`m`) | 20.5 | 15.2 | **+5.3** | **BSM sample path inside clouds march** |
| resolve (`r`) | 0.2 | 0.4 | ~0 | Noise |
| CPU Σ | 21.3 | 15.6 | +5.7 | Matches march delta |
| GPU frame | 11.4 | 5.0 | **+6.4** | Confirms ~6 ms GPU shadows-on tax |

Rough % of shadows-on CPU Σ: march ~96%, produce+sr+atlas ~3%, resolve ~1%.
Shadows-on GPU is ~2.3× shadows-off GPU for the whole render pool.

## WGSL dump notes

Dump captured march only (shadow materials may already have been hot):

| label | bytes | loops | ifs | textureSample | textureSampleLevel | vogel? | MS? |
|-------|-------|-------|-----|---------------|--------------------|--------|-----|
| vertex_CloudsMarch | 558 | 0 | 0 | 0 | 0 | no | no |
| fragment_CloudsMarch | 44009 | 5 | 53 | 17 | 3 | yes | yes |

44 KB fragment with 53 `if`s / 5 `for`s + Vogel/MS hints matches the structural TSL specialization gap vs WebGL `#ifdef` / unrolled loops.

## Exit criteria checklist

- [x] Written % split: produce vs atlas vs march body vs resolve
- [x] WGSL shows loop/If/texture bind shape for march (shadow/resolve modules not in this dump)
- [x] Ready for Phase B (array/layered BSM) with measured baseline

## Next

Phase B: array/layered BSM sampling (atlas UV remap → layer index) — highest expected impact on the ~6 ms GPU march tax. Phase C (shader variants) still relevant given 53 runtime ifs.

## Full WGSL dump (fragment_CloudsMarch)

- 44009 bytes, **5 loops**, **53 ifs**, 17 textureSample, 3 textureSampleLevel, 1 textureLoad
- Loops: main march `for i < 512`, plus **four** `for i < 8` (Vogel PCF × sides + MS octaves)
- Atlas UV remap was live in dump: `(cascade + u) / cascadeCount` — replaced in Phase B by `texture_2d_array` + layer index
- No `texture_2d_array` in pre-B dump (expected)

## Phase B (2026-09-15)

Implemented **B2-a**: `DataArrayTexture` cascade array + `copyTextureToTexture(..., dst.z = layer)` + `.depth(cascadeIndex).sample(uv)`.
Retest: hard refresh, high preset, shadows on/off — compare `m` / `gpu` to baseline above.

## Phase B retest (2026-09-15, after null-buffer fix)

| | ON | OFF | Δ (on−off) |
|--|----|-----|------------|
| **Baseline A** march / gpu | 20.5 / 11.4 | 15.2 / 5.0 | +5.3 / **+6.4** |
| **B2-a array** march / gpu | 20.1 / 9.9 | 16.1 / 5.5 | +4.0 / **+4.4** |

- Shadows-on GPU: **−1.5 ms** (~13%)
- Shadows-on tax (GPU Δ): **−2.0 ms** (~6.4 → 4.4)
- March CPU almost flat; atlas pack still ~0
- Conclusion: array sampling helps cache/ALU a little; remaining gap is still structural (runtime If/Loop, Vogel×8 in march, TSL specialization). **Phase C (shader variants)** is the next high-leverage lever.


## Phase C retest (2026-09-15)

| | ON m / gpu | OFF m / gpu | GPU tax |
|--|------------|-------------|---------|
| B2-a | 20.1 / 9.9 | 16.1 / 5.5 | 4.4 |
| **C variants** | **0.1 / 9.4** | **0.8 / 7.8** | **1.6** |

- CPU march submit collapsed (likely less sync/recompile work in the measured window).
- Shadows-on GPU slightly better (9.9→9.4); shadows-off GPU **regressed** (5.5→7.8) — investigate if look is wrong or noise.
- Dump WGSL was empty (hook removed before compile); dump path fixed to render while hooked + nonce cache key.


## Phase C confirmed (2026-09-15)

- Look: cloud shadows still correct
- FPS: **70+ on and off** (monitor refresh capped); was ~45–58 shadows-on
- WGSL dump (likely shadows-off variant): **44009 → 32748 bytes**, loops **5 → 4**, ifs **53 → 28**
  - Gone: Vogel / getCascadeIndex / readShadowOpticalDepth / Draine (accurate Mie)
  - Kept: henyey, ground, powder, main `i < 512` + three `i < 8` (MS/local paths)
- Note: dump has no BSM symbols — re-dump with shadows **on** if we need on-variant WGSL


## On vs off WGSL (Phase C)

| Variant | bytes | loops | ifs | texSample | array | Vogel/BSM | Draine |
|---------|-------|-------|-----|-----------|-------|-----------|--------|
| pre-C | 44009 | 5 | 53 | 17 | no | yes | yes |
| **shadows-on** | **37976** | 5 | 37 | 11 | **yes** | **yes** | no |
| **shadows-off** | **32748** | 4 | 28 | 9 | no | **no** | no |

On − off: +5.2 KB, +1 loop (Vogel PCF), +9 ifs, +2 textureSample; `texture_2d_array` only on.
Specialization confirmed: off omits BSM entirely; on uses array layers; accurate Mie omitted on both (high = approximate).
