import { OrbitControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, type FC } from 'react'
import { AgXToneMapping } from 'three'
import { context, pass, toneMapping, uniform } from 'three/tsl'
import { PostProcessing, type Renderer } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import {
  aerialPerspective,
  AtmosphereContext
} from '@takram/three-atmosphere/webgpu'
import { clouds } from '@takram/three-clouds/webgpu'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import { Description } from '../components/Description'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  localDateArgs,
  localDateArgTypes,
  useLocalDateControls,
  type LocalDateArgs
} from '../controls/localDateControls'
import {
  locationArgs,
  locationArgTypes,
  useLocationControls,
  type LocationArgs
} from '../controls/locationControls'
import { rendererArgs, rendererArgTypes } from '../controls/rendererControls'
import {
  toneMappingArgs,
  toneMappingArgTypes,
  useToneMappingControls,
  type ToneMappingArgs
} from '../controls/toneMappingControls'
import { useGuardedFrame } from '../hooks/useGuardedFrame'
import { useResource } from '../hooks/useResource'
import { useTransientControl } from '../hooks/useTransientControl'

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)

  const atmosphereContext = useResource(() => new AtmosphereContext(), [])
  atmosphereContext.camera = camera

  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...renderer.contextNode.value,
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  const cloudsNode = useResource(() => {
    const node = clouds()
    node.coverage = 0.4
    node.resolutionScale = 0.5
    return node
  }, [])

  // Empty scene → depth = 1 → sky path in aerial perspective.
  const passNode = useResource(
    () => pass(scene, camera, { samples: 0 }),
    [scene, camera]
  )
  const colorNode = passNode.getTextureNode('output')
  const depthNode = passNode.getTextureNode('depth')

  const aerialNode = useResource(() => {
    const node = aerialPerspective(colorNode, depthNode)
    // Use the CloudsNode itself so it is a first-class graph citizen
    // (updateBefore registration), not only an OutputTexture owner.
    node.overlayNode = cloudsNode
    return node
  }, [colorNode, depthNode, cloudsNode])

  const lensFlareNode = useResource(() => lensFlare(aerialNode), [aerialNode])

  const toneMappingNode = useResource(
    () => toneMapping(AgXToneMapping, uniform(0), lensFlareNode),
    [lensFlareNode]
  )

  const postProcessing = useResource(
    () => new PostProcessing(renderer, toneMappingNode.add(dithering)),
    [renderer, toneMappingNode]
  )

  useGuardedFrame(() => {
    postProcessing.render()
  }, 1)

  useTransientControl(
    ({ coverage }: StoryArgs) => ({ coverage }),
    ({ coverage }) => {
      cloudsNode.coverage = coverage
    }
  )

  useToneMappingControls(toneMappingNode, () => {
    postProcessing.needsUpdate = true
  })

  useLocationControls(atmosphereContext.matrixWorldToECEF.value)

  useLocalDateControls(date => {
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } =
      atmosphereContext
    getECIToECEFRotationMatrix(date, matrixECIToECEF.value)
    getSunDirectionECI(date, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(date, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  })

  return <OrbitControls target={[0, 0, 0]} minDistance={1} />
}

interface StoryArgs extends ToneMappingArgs, LocalDateArgs, LocationArgs {
  coverage: number
}

export const Story: StoryFC<Record<string, never>, StoryArgs> = () => (
  <WebGPUCanvas camera={{ near: 1, far: 1e8, position: [1, 0, 0] }}>
    <Content />
    <Description />
  </WebGPUCanvas>
)

Story.args = {
  coverage: 0.4,
  ...localDateArgs({
    dayOfYear: 0,
    timeOfDay: 9
  }),
  ...locationArgs({
    longitude: 30,
    latitude: 35,
    height: 300
  }),
  ...toneMappingArgs({
    toneMappingExposure: 10
  }),
  ...rendererArgs()
}

Story.argTypes = {
  coverage: {
    control: {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01
    },
    table: { category: 'clouds' }
  },
  ...localDateArgTypes(),
  ...locationArgTypes(),
  ...toneMappingArgTypes(),
  ...rendererArgTypes()
}
