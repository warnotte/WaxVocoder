// Renders text (English, or French/German with --lang through eSpeak NG) or
// phonemes (--phonemes) to a WAV file, for
// listening tests without a browser. Run `npm run build:wasm` first.
//
// French and German follow the rhythm of eSpeak NG (one duration per phone);
// --rules uses the engine's own duration rules instead.
//
// Usage: npm run render -- "Welcome to the laboratory." labo.wav [--preset kraftwerk] [--lang en|fr|fr-CA|fr-BE|de]
//        [--phonemes] [--rules] [--pitch 110] [--rate 1] [--intonation 0.6] [--vocoder 1]
//        [--chord 0-5] [--melody "C3 D#3 G2"] [--quantize] [--tempo 112] [--lofi 0.8]
//        [--formant-shift 1.3] [--vibrato 1] [--glide 0.1] [--sample-rate 44100]
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { encodeWav } from '../src/audio/wav.ts'
import { parseDictionary } from '../src/dictionary.ts'
import { loadEspeak } from '../src/espeak.ts'
import { ESPEAK_LANGUAGES, type Language } from '../src/ipa.ts'
import { transcribe } from '../src/phonemes.ts'
import { applySettings, PRESETS, type VoiceSettings } from '../src/voice-settings.ts'

const numeric = ['pitch', 'rate', 'intonation', 'presence', 'vocoder', 'chord', 'tempo', 'lofi', 'formant-shift', 'vibrato', 'glide'] as const
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: 'string', default: 'natural' },
    lang: { type: 'string', default: 'en' },
    phonemes: { type: 'boolean', default: false },
    rules: { type: 'boolean', default: false },
    melody: { type: 'string' },
    quantize: { type: 'boolean' },
    'sample-rate': { type: 'string', default: '44100' },
    ...Object.fromEntries(numeric.map((name) => [name, { type: 'string' as const }])),
  },
})
const [input, output = 'wax-vocoder.wav'] = positionals
const preset = PRESETS[values.preset ?? 'natural']
const language = (values.lang ?? 'en') as Language
if (!input || !preset || !(language in ESPEAK_LANGUAGES)) {
  console.error(`Usage: npm run render -- "text" [output.wav] [--preset ${Object.keys(PRESETS).join('|')}] [options]`)
  process.exit(1)
}

const settings: VoiceSettings = { ...preset.settings }
const names: Record<(typeof numeric)[number], keyof VoiceSettings> = {
  pitch: 'frequency', rate: 'rate', intonation: 'intonation', presence: 'presence', vocoder: 'vocoder', chord: 'chord', tempo: 'tempo',
  lofi: 'lofi', 'formant-shift': 'formantShift', vibrato: 'vibrato', glide: 'glide',
}
for (const option of numeric) {
  const value = values[option]
  if (typeof value === 'string') Object.assign(settings, { [names[option]]: Number(value) })
}
if (values.melody !== undefined) settings.melody = values.melody
if (values.quantize !== undefined) settings.quantize = values.quantize

const root = new URL('../', import.meta.url)
const wasm = await readFile(new URL('src/wasm/voice-engine/voice_engine_bg.wasm', root))
await initialize({ module_or_path: await WebAssembly.compile(wasm) })

async function toPhonemes(): Promise<string> {
  if (values.phonemes) return input
  if (language !== 'en') {
    const transcription = (await loadEspeak()).transcribeTimed(input, language)
    return values.rules ? transcription.phonemes : transcription.timed
  }
  return transcribe(input, parseDictionary(await readFile(new URL('src/data/cmudict.txt', root), 'utf8')))
}
const phonemes = await toPhonemes()
const sampleRate = Number(values['sample-rate'])
const engine = new VoiceEngine(sampleRate)
applySettings(engine, settings)
engine.set_language(language)
const unknown = engine.set_phonemes(phonemes)
engine.set_active(true)
const samples = new Float32Array(Math.ceil(engine.duration_seconds() * sampleRate))
engine.render(samples)
engine.free()
await writeFile(output, new Uint8Array(encodeWav(samples, sampleRate)))
console.log(`${preset.label} · ${phonemes}\n→ ${output} (${(samples.length / sampleRate).toFixed(2)} s${unknown ? `, ${unknown} symbole(s) inconnu(s) ignoré(s)` : ''})`)
