// vite.config.ts

import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const isThreeImport = (id: string): boolean =>
  id === 'three' || id.startsWith('three/')

export default defineConfig(({ mode }) => {
  const libraryMode = mode === 'library'

  return {
    plugins: libraryMode
      ? [
          dts({
            entryRoot: 'src',
            include: ['src'],
            pathsToAliases: false,
            tsconfigPath: './tsconfig.json'
          })
        ]
      : [],
    build: libraryMode
      ? {
          copyPublicDir: false,
          emptyOutDir: true,
          lib: {
            entry: 'src/index.ts',
            formats: ['es', 'cjs'],
            fileName: format => (format === 'es' ? 'index.js' : 'index.cjs')
          },
          outDir: 'dist/package',
          rollupOptions: {
            external: isThreeImport
          },
          sourcemap: true
        }
      : {
          emptyOutDir: true,
          outDir: 'dist/demo',
          sourcemap: true
        }
  }
})
