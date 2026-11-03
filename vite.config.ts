import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

const ESPEAK = 'node_modules/@echogarden/espeak-ng-emscripten'

/**
 * eSpeak NG fetches espeak-ng.data from the directory of its own script, so the
 * build ships the data (and eSpeak NG's GPL text) beside the bundled chunks.
 */
function espeakData(): Plugin {
  return {
    name: 'wax-espeak-data',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'assets/espeak-ng.data', source: readFileSync(`${ESPEAK}/espeak-ng.data`) })
      this.emitFile({ type: 'asset', fileName: 'assets/espeak-ng.COPYING.txt', source: readFileSync(`${ESPEAK}/COPYING`) })
    },
  }
}

export default defineConfig({
  worker: { format: 'es' },
  // eSpeak NG (wasm2js, ≈ 780 kB) is a lazily loaded chunk, fetched only for French or German.
  build: { chunkSizeWarningLimit: 900 },
  // Served unbundled in development so that the data file sits next to the script.
  optimizeDeps: { exclude: ['@echogarden/espeak-ng-emscripten'] },
  plugins: [espeakData()],
})
