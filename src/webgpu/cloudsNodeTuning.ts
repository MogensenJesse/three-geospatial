// src/webgpu/cloudsNodeTuning.ts

/** Structural host so tuning can install without circular CloudsNode import. */
export interface CloudsNodeTuningHost {
  marchNode: any
  resolveNode: any
  shadowNode: any
  parameters: any
  environment: any
  resetTemporalHistory(): unknown
}

export function installCloudsNodeTuning(proto: object): void {
  Object.defineProperties(proto, {
    depthNode: {
      get(this: CloudsNodeTuningHost) {
        return this.environment.sceneDepth
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.environment.sceneDepth = value
      },
      enumerable: true,
      configurable: true
    },
    resolutionScale: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.resolutionScale
      },
      set(this: CloudsNodeTuningHost, value: any) {
        if (value !== this.marchNode.resolutionScale) {
          this.marchNode.resolutionScale = value
          this.resetTemporalHistory()
        }
      },
      enumerable: true,
      configurable: true
    },
    temporalUpscale: {
      get(this: CloudsNodeTuningHost) {
        return this.resolveNode.temporalUpscale
      },
      set(this: CloudsNodeTuningHost, value: any) {
        if (value !== this.resolveNode.temporalUpscale) {
          this.resolveNode.temporalUpscale = value
          this.marchNode.temporalUpscale = value
          this.resetTemporalHistory()
        }
      },
      enumerable: true,
      configurable: true
    },
    temporalAlpha: {
      get(this: CloudsNodeTuningHost) {
        return this.resolveNode.temporalAlpha.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.resolveNode.temporalAlpha.value = value
      },
      enumerable: true,
      configurable: true
    },
    temporalHistoryEnabled: {
      get(this: CloudsNodeTuningHost) {
        return this.resolveNode.historyEnabled
      },
      set(this: CloudsNodeTuningHost, value: any) {
        if (value !== this.resolveNode.historyEnabled) {
          this.resolveNode.historyEnabled = value
          this.resetTemporalHistory()
        }
      },
      enumerable: true,
      configurable: true
    },
    varianceGamma: {
      get(this: CloudsNodeTuningHost) {
        return this.resolveNode.varianceGamma.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.resolveNode.varianceGamma.value = value
      },
      enumerable: true,
      configurable: true
    },
    shapeDetailEnabled: {
      get(this: CloudsNodeTuningHost) {
        return Boolean(this.parameters.shapeDetailEnabled.value)
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.parameters.shapeDetailEnabled.value = value
      },
      enumerable: true,
      configurable: true
    },
    turbulenceEnabled: {
      get(this: CloudsNodeTuningHost) {
        return Boolean(this.parameters.turbulenceEnabled.value)
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.parameters.turbulenceEnabled.value = value
      },
      enumerable: true,
      configurable: true
    },
    scatteringCoefficient: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.scatteringCoefficient.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.parameters.scatteringCoefficient.value = value
      },
      enumerable: true,
      configurable: true
    },
    absorptionCoefficient: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.absorptionCoefficient.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.parameters.absorptionCoefficient.value = value
      },
      enumerable: true,
      configurable: true
    },
    turbulenceDisplacement: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.turbulenceDisplacement.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.parameters.turbulenceDisplacement.value = value
      },
      enumerable: true,
      configurable: true
    },
    localWeatherRepeat: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.localWeatherRepeat.value
      },
      enumerable: true,
      configurable: true
    },
    localWeatherOffset: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.localWeatherOffset.value
      },
      enumerable: true,
      configurable: true
    },
    shapeRepeat: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.shapeRepeat.value
      },
      enumerable: true,
      configurable: true
    },
    shapeOffset: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.shapeOffset.value
      },
      enumerable: true,
      configurable: true
    },
    shapeDetailRepeat: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.shapeDetailRepeat.value
      },
      enumerable: true,
      configurable: true
    },
    shapeDetailOffset: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.shapeDetailOffset.value
      },
      enumerable: true,
      configurable: true
    },
    turbulenceRepeat: {
      get(this: CloudsNodeTuningHost) {
        return this.parameters.turbulenceRepeat.value
      },
      enumerable: true,
      configurable: true
    },
    secondaryIterationCount: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.maxIterationCountToSun.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.maxIterationCountToSun.value = value
      },
      enumerable: true,
      configurable: true
    },
    skyLightScale: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.skyLightScale.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.skyLightScale.value = value
      },
      enumerable: true,
      configurable: true
    },
    stepJitterScale: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.stepJitterScale.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.stepJitterScale.value = value
      },
      enumerable: true,
      configurable: true
    },
    powderScale: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.powderScale.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.powderScale.value = value
      },
      enumerable: true,
      configurable: true
    },
    powderExponent: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.powderExponent.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.powderExponent.value = value
      },
      enumerable: true,
      configurable: true
    },
    groundBounceScale: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.groundBounceScale.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.groundBounceScale.value = value
      },
      enumerable: true,
      configurable: true
    },
    groundIterationCount: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.maxIterationCountToGround.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.maxIterationCountToGround.value = value
      },
      enumerable: true,
      configurable: true
    },
    phaseFunctionMode: {
      get(this: CloudsNodeTuningHost) {
        return this.marchNode.march.phaseFunctionMode.value === 1
          ? 'accurate'
          : 'approximate'
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.marchNode.march.phaseFunctionMode.value =
          value === 'accurate' ? 1 : 0
      },
      enumerable: true,
      configurable: true
    },
    shadowEnabled: {
      get(this: CloudsNodeTuningHost) {
        return this.shadowNode.enabled
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.shadowNode.enabled = value
        this.shadowNode.shadow.enabled.value = value ? 1 : 0
        this.shadowNode.rebindConsumers(
          this,
          value ? this.shadowNode.getAtlasNode() : null
        )
      },
      enumerable: true,
      configurable: true
    },
    shadowMapSize: {
      get(this: CloudsNodeTuningHost) {
        return this.shadowNode.shadowMaps.mapSize.x
      },
      set(this: CloudsNodeTuningHost, value: any) {
        const previous = this.shadowNode.shadowMaps.mapSize.x
        this.shadowNode.setMapSize(value)
        if (value !== previous) {
          this.shadowNode.rebindConsumers(this)
        }
      },
      enumerable: true,
      configurable: true
    },
    shadowCascadeCount: {
      get(this: CloudsNodeTuningHost) {
        return this.shadowNode.shadowMaps.cascadeCount
      },
      set(this: CloudsNodeTuningHost, value: any) {
        const previous = this.shadowNode.shadowMaps.cascadeCount
        this.shadowNode.setCascadeCount(value)
        if (value !== previous) {
          this.shadowNode.rebindConsumers(this)
        }
      },
      enumerable: true,
      configurable: true
    },
    shadowFilterRadius: {
      get(this: CloudsNodeTuningHost) {
        return this.shadowNode.shadow.maxShadowFilterRadius.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.shadowNode.shadow.maxShadowFilterRadius.value = value
      },
      enumerable: true,
      configurable: true
    },
    shadowTemporalAlpha: {
      get(this: CloudsNodeTuningHost) {
        return this.shadowNode.resolveNode.temporalAlpha.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.shadowNode.resolveNode.temporalAlpha.value = value
      },
      enumerable: true,
      configurable: true
    },
    shadowTemporalGamma: {
      get(this: CloudsNodeTuningHost) {
        return this.shadowNode.resolveNode.varianceGamma.value
      },
      set(this: CloudsNodeTuningHost, value: any) {
        this.shadowNode.resolveNode.varianceGamma.value = value
      },
      enumerable: true,
      configurable: true
    }
  })
}
