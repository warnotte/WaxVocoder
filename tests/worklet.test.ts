// Runs the real AudioWorklet processor in a simulated AudioWorkletGlobalScope,
// which lacks TextEncoder/TextDecoder (node --test isolates each test file).
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

type Message = { type: string; [key: string]: unknown }
type ProcessorInstance = {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

const posted: Message[] = []
const port = {
  onmessage: null as ((event: { data: unknown }) => void) | null,
  postMessage: (message: Message) => posted.push(message),
}
let Processor: (new (options: unknown) => ProcessorInstance) | undefined

Reflect.deleteProperty(globalThis, 'TextEncoder')
Reflect.deleteProperty(globalThis, 'TextDecoder')
Object.assign(globalThis, {
  sampleRate: 48_000,
  AudioWorkletProcessor: class {
    readonly port = port
  },
  registerProcessor: (name: string, constructor: typeof Processor) => {
    assert.equal(name, 'wax-voice-processor')
    Processor = constructor
  },
})
await import('../src/audio/voice-processor.ts')

const waitFor = async (type: string) => {
  for (let attempt = 0; attempt < 200 && !posted.some((message) => message.type === type); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return posted.find((message) => message.type === type)
}

describe('AudioWorklet processor', () => {
  it('installs the text polyfills the wasm-bindgen glue needs', () => {
    assert.equal(typeof globalThis.TextEncoder, 'function')
    assert.equal(typeof globalThis.TextDecoder, 'function')
  })

  it('speaks a phrase sent by the interface, then reports the end', async () => {
    assert.ok(Processor, 'processor was not registered')
    const wasm = await readFile(new URL('../src/wasm/voice-engine/voice_engine_bg.wasm', import.meta.url))
    const processor = new Processor({
      processorOptions: {
        wasmModule: await WebAssembly.compile(wasm),
        phonemes: 'AA1',
        settings: { frequency: 120, intonation: 0.5, vocoder: 1, chord: 2 },
      },
    })
    assert.ok(await waitFor('ready'), `engine not ready: ${JSON.stringify(posted)}`)

    port.onmessage?.({ data: { type: 'phonemes', value: 'HH AH0 L OW1 , W ER1 L D .' } })
    port.onmessage?.({ data: { type: 'setting', name: 'rate', value: 1.2 } })
    port.onmessage?.({ data: { type: 'setting', name: 'melody', value: 'C3 G2' } })
    port.onmessage?.({ data: { type: 'setting', name: 'tempo', value: 120 } })
    port.onmessage?.({ data: { type: 'active' } })
    let energy = 0
    let blocks = 0
    while (!posted.some((message) => message.type === 'finished') && blocks < 2_000) {
      const channel = new Float32Array(128)
      assert.equal(processor.process([], [[channel]]), true)
      for (const sample of channel) energy += sample * sample
      blocks += 1
    }
    assert.ok(posted.some((message) => message.type === 'finished'), 'phrase never finished')
    assert.ok(posted.some((message) => message.type === 'meter'))
    assert.ok(energy > 1, `phrase was nearly silent (${energy})`)
    const seconds = (blocks * 128) / 48_000
    assert.ok(seconds > 0.8 && seconds < 2.5, `unexpected phrase length ${seconds} s`)
    assert.ok(!posted.some((message) => message.type === 'error'))
  })
})
