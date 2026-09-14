// src/webgpu/index.ts

// Stable public facade
export * from '../CloudLayer'
export * from '../CloudLayers'
export * from '../DensityProfile'
export * from '../qualityPresets'
export * from './CloudsEnvironment'
export * from './CloudsOptions'
export * from './CloudsNode'
export * from './CloudShadowNode'
export * from './compositeClouds'

// Intentional advanced / host-facing nodes
export * from './CloudsMarchNode'
export * from './CloudsResolveNode'
export * from './ShadowDebugNode'
export * from './ShadowMarchNode'
export * from './ShadowResolveNode'
export * from './shadowParameters'
export * from './CloudShapeDetailNode'
export * from './CloudShapeNode'
export * from './LocalWeatherNode'
export * from './TurbulenceNode'
export * from './parameters'

// Compatibility aliases (implementation helpers still imported in-tree)
export * from './march'
export * from './sampling'
export * from './ProceduralTexture3DNode'
export * from './ProceduralTextureNode'
export * from './updateCloudLayerParameters'
