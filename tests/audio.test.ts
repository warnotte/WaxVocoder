import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import initialize, { AudioVocoderEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { decodeWav, encodeWav } from '../src/audio/wav.ts'
import { noteFrequency } from '../src/voice-settings.ts'
import { Utf8Decoder, Utf8Encoder } from '../src/audio/worklet-polyfills.ts'

describe('WAV export', () => {
  it('writes a 16-bit mono PCM header and clamps samples', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 2, Number.NaN]), 44_100))
    const text = (offset: number) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4))
    assert.equal(text(0), 'RIFF')
    assert.equal(text(8), 'WAVE')
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint32(24, true), 44_100)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(view.getUint32(40, true), 10)
    assert.deepEqual([0, 1, 2, 3, 4].map((index) => view.getInt16(44 + index * 2, true)), [0, 32767, -32767, 32767, 0])
  })
})

describe('AudioWorklet text polyfills', () => {
  const samples = ['K R AE1 F T', 'Wax Vocoder — café', '🎛 voix']

  it('encode like the native TextEncoder', () => {
    const native = new TextEncoder()
    for (const sample of samples) assert.deepEqual(new Utf8Encoder().encode(sample), native.encode(sample))
  })

  it('encodeInto stops before a character that does not fit', () => {
    const destination = new Uint8Array(5)
    assert.deepEqual(new Utf8Encoder().encodeInto('ab—c', destination), { read: 3, written: 5 })
    assert.deepEqual([...destination], [0x61, 0x62, 0xe2, 0x80, 0x94])
  })

  it('decode what the encoder produced', () => {
    for (const sample of samples) assert.equal(new Utf8Decoder().decode(new Utf8Encoder().encode(sample)), sample)
  })
})

describe('WAV import', () => {
  it('round-trips mono and stereo 16-bit files', () => {
    const left = Float32Array.from([0, 0.5, -0.5, 0.25])
    const right = Float32Array.from([1, -1, 0, 0.125])
    const stereo = decodeWav(encodeWav([left, right], 48_000))
    assert.equal(stereo.sampleRate, 48_000)
    assert.equal(stereo.channels.length, 2)
    stereo.channels.forEach((channel, index) => {
      const source = index === 0 ? left : right
      channel.forEach((sample, frame) => assert.ok(Math.abs(sample - source[frame]) < 1e-4))
    })
    assert.equal(decodeWav(encodeWav(left, 22_050)).channels.length, 1)
  })

  it('rejects files that are not PCM WAV', () => {
    assert.throws(() => decodeWav(new ArrayBuffer(64)), /WAV/)
  })
})

describe('note names', () => {
  it('follow the engine conventions', () => {
    for (const [name, expected] of [['A4', 440], ['la3', 440], ['F2', 87.31], ['fa1', 87.31], ['C#3', 138.59], ['sib1', 116.54]] as const) {
      assert.ok(Math.abs(noteFrequency(name)! - expected) < 0.01, name)
    }
    assert.equal(noteFrequency('H2'), undefined)
  })
})

describe('external audio vocoder (WASM)', () => {
  it('passes audio through at zero mix and stays bounded when vocoding', async () => {
    const wasm = await readFile(new URL('../src/wasm/voice-engine/voice_engine_bg.wasm', import.meta.url))
    await initialize({ module_or_path: await WebAssembly.compile(wasm) })
    const input = Float32Array.from({ length: 48_000 }, (_, index) => 0.4 * Math.sin(index * 0.06) + 0.2 * Math.sin(index * 0.9))
    const engine = new AudioVocoderEngine(48_000)
    engine.set_mix(0)
    const dry = new Float32Array(input.length)
    engine.process(input, dry)
    dry.forEach((sample, index) => assert.ok(Math.abs(sample - input[index]) < 1e-4))
    engine.reset()
    engine.set_mix(1)
    engine.set_frequency(87.3)
    engine.set_chord(2)
    const wet = new Float32Array(input.length)
    engine.process(input, wet)
    assert.ok(wet.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1))
    assert.ok(wet.some((sample, index) => Math.abs(sample - input[index]) > 0.05), 'vocoding changed nothing')
    engine.free()
  })
})
