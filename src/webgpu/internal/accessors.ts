// src/webgpu/internal/accessors.ts

import type { Camera } from 'three'
import { reference } from 'three/tsl'

import type { Node } from './node'

let caches: WeakMap<object, Record<string, object>> | undefined

function getCache<T extends object>(
  object: object,
  name: string,
  create: () => T
): T {
  caches ??= new WeakMap<object, Record<string, object>>()
  let cache = caches.get(object)
  if (cache == null) {
    cache = {}
    caches.set(object, cache)
  }
  let value = cache[name]
  if (value == null) {
    value = create()
    cache[name] = value
  }
  return value as T
}

export const viewMatrix = (camera: Camera): Node<'mat4'> =>
  getCache(camera, 'viewMatrix', () =>
    reference('matrixWorldInverse', 'mat4', camera).setName('viewMatrix')
  )

export const inverseViewMatrix = (camera: Camera): Node<'mat4'> =>
  getCache(camera, 'inverseViewMatrix', () =>
    reference('matrixWorld', 'mat4', camera).setName('inverseViewMatrix')
  )
