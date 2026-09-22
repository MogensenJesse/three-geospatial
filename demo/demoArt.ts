// demo/demoArt.ts

/**
 * Demo picture lock. The sliders and the renderer read these values.
 * index.html does not repeat them.
 *
 * Exposure 1.25, sky-light scale 3, and sky intensity 6 are the tuned
 * Preetham-bake picture. The march uniform's own default sky-light scale is 1.
 */
export const demoArt = {
  exposure: 1.25,
  skyLightScale: 3,
  /** Multiplier on the Preetham-baked sky irradiance. */
  skyIntensity: 6
} as const
