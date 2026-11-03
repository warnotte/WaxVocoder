// Passes an audio file through the WaxVocoder vocoder: the voice band is
// imprinted on a sawtooth carrier, lows and highs pass through unchanged.
// Run `npm run build:wasm` first; convert other formats to WAV with ffmpeg.
//
// Usage: npm run vocode -- input.wav output.wav [--note F2 | --frequency 87.3]
//        [--chord 0-5] [--mix 1] [--split 150,6000]
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import initialize, { AudioVocoderEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { decodeWav, encodeWav } from '../src/audio/wav.ts'
import { CHORDS, noteFrequency } from '../src/voice-settings.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    note: { type: 'string', default: 'A2' },
    frequency: { type: 'string' },
    chord: { type: 'string', default: '0' },
    mix: { type: 'string', default: '1' },
    split: { type: 'string', default: '150,6000' },
  },
})
const [inputPath, outputPath] = positionals
const frequency = values.frequency ? Number(values.frequency) : noteFrequency(values.note ?? 'A2')
const [low, high] = (values.split ?? '').split(',').map(Number)
if (!inputPath || !outputPath || !frequency || !(low < high)) {
  console.error('Usage: npm run vocode -- input.wav output.wav [--note F2] [--chord 0-5] [--mix 1] [--split 150,6000]')
  process.exit(1)
}

const root = new URL('../', import.meta.url)
await initialize({ module_or_path: await WebAssembly.compile(await readFile(new URL('src/wasm/voice-engine/voice_engine_bg.wasm', root))) })

const started = performance.now()
const { sampleRate, channels } = decodeWav((await readFile(inputPath)).buffer as ArrayBuffer)
const block = sampleRate
// The sawtooth carrier is peakier than speech: process with 6 dB of headroom,
// then normalise the result to -1 dBFS.
const HEADROOM = 0.5
const processed = channels.map((original) => {
  const input = original.map((sample) => sample * HEADROOM)
  const vocoder = new AudioVocoderEngine(sampleRate)
  vocoder.set_frequency(frequency)
  vocoder.set_chord(Number(values.chord))
  vocoder.set_mix(Number(values.mix))
  vocoder.set_split(low, high)
  const output = new Float32Array(input.length)
  for (let start = 0; start < input.length; start += block) {
    const end = Math.min(start + block, input.length)
    const chunk = new Float32Array(end - start)
    vocoder.process(input.subarray(start, end), chunk)
    output.set(chunk, start)
  }
  vocoder.free()
  return output
})
const peak = processed.reduce((max, channel) => channel.reduce((value, sample) => Math.max(value, Math.abs(sample)), max), 0)
const gain = peak > 0 ? 0.89 / peak : 1
for (const channel of processed) channel.forEach((sample, index) => { channel[index] = sample * gain })
await writeFile(outputPath, new Uint8Array(encodeWav(processed, sampleRate)))
const seconds = channels[0].length / sampleRate
console.log(`${seconds.toFixed(1)} s, ${channels.length} canal(aux), porteuse ${frequency.toFixed(1)} Hz « ${CHORDS[Number(values.chord)] ?? '?'} », bande ${low}–${high} Hz → ${outputPath} (${((performance.now() - started) / 1000).toFixed(1)} s de calcul)`)
