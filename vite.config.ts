import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

const ESPEAK = 'node_modules/@echogarden/espeak-ng-emscripten'

/**
 * eSpeak NG's data (espeak-ng.data) is an asset imported with `?url` by
 * src/main.ts and handed to eSpeak NG; the build also ships eSpeak NG's GPL text.
 */
function espeakLicense(): Plugin {
  return {
    name: 'wax-espeak-license',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'assets/espeak-ng.COPYING.txt', source: readFileSync(`${ESPEAK}/COPYING`) })
    },
  }
}

export default defineConfig({
  worker: { format: 'es' },
  // eSpeak NG (wasm2js, ≈ 780 kB) is a lazily loaded chunk, fetched only for French or German.
  build: { chunkSizeWarningLimit: 900 },
  // Served unbundled in development: pre-bundling 780 kB of wasm2js gains nothing.
  optimizeDeps: { exclude: ['@echogarden/espeak-ng-emscripten'] },
  plugins: [espeakLicense()],
})
