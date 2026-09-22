// src/webgpu/cloudsSizes.ts

export interface CloudsSizes {
  outputWidth: number
  outputHeight: number
  marchWidth: number
  marchHeight: number
  logicalWidth: number
  logicalHeight: number
}

/**
 * Drawing-buffer size after resolution scale, then the quarter-res march
 * target when temporal upscaling is on. Logical size is the march target
 * snapped back to a multiple of 4 so Bayer phases cover the output.
 */
export function computeCloudsSizes(
  drawingWidth: number,
  drawingHeight: number,
  resolutionScale: number,
  temporalUpscale: boolean
): CloudsSizes {
  const outputWidth = Math.max(Math.round(drawingWidth * resolutionScale), 1)
  const outputHeight = Math.max(Math.round(drawingHeight * resolutionScale), 1)
  const marchWidth = temporalUpscale ? Math.ceil(outputWidth / 4) : outputWidth
  const marchHeight = temporalUpscale
    ? Math.ceil(outputHeight / 4)
    : outputHeight
  const logicalWidth = temporalUpscale ? marchWidth * 4 : marchWidth
  const logicalHeight = temporalUpscale ? marchHeight * 4 : marchHeight
  return {
    outputWidth,
    outputHeight,
    marchWidth,
    marchHeight,
    logicalWidth,
    logicalHeight
  }
}
