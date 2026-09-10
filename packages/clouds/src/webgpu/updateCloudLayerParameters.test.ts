import { CloudLayers } from '../CloudLayers'
import { CloudLayerParameterNodes } from './parameters'
import { updateCloudLayerParameters } from './updateCloudLayerParameters'

describe('updateCloudLayerParameters', () => {
  test('packs altitudes, intervals, and shadow mask like WebGL uniforms', () => {
    const layers = new CloudLayers([
      {
        channel: 'r',
        altitude: 750,
        height: 650,
        densityScale: 0.2,
        shadow: true
      },
      {
        channel: 'g',
        altitude: 1000,
        height: 1200,
        densityScale: 0.2,
        shadow: true
      },
      {
        channel: 'b',
        altitude: 7500,
        height: 500,
        densityScale: 0.003,
        shadow: false
      },
      { channel: 'a', altitude: 0, height: 0, densityScale: 0 }
    ])
    const parameters = new CloudLayerParameterNodes()
    updateCloudLayerParameters(parameters, layers)

    expect(parameters.minLayerHeights.value.toArray()).toEqual([
      750, 1000, 7500, 0
    ])
    expect(parameters.maxLayerHeights.value.toArray()).toEqual([
      1400, 2200, 8000, 0
    ])
    expect(parameters.minHeight.value).toBe(750)
    expect(parameters.maxHeight.value).toBe(8000)
    expect(parameters.shadowBottomHeight.value).toBe(750)
    expect(parameters.shadowTopHeight.value).toBe(2200)
    expect(parameters.shadowLayerMask.value.toArray()).toEqual([1, 1, 0, 0])
    expect(parameters.densityScales.value.toArray()).toEqual([
      0.2, 0.2, 0.003, 0
    ])
    expect(parameters.localWeatherChannels).toBe('rgba')
  })

  test('updates localWeatherChannels from layer channel packing', () => {
    const layers = new CloudLayers([
      { channel: 'b', altitude: 0, height: 1 },
      { channel: 'r', altitude: 2, height: 1 },
      { channel: 'g', altitude: 4, height: 1 },
      { channel: 'a', altitude: 6, height: 1 }
    ])
    const parameters = new CloudLayerParameterNodes()
    updateCloudLayerParameters(parameters, layers)
    expect(parameters.localWeatherChannels).toBe('brga')
  })
})
