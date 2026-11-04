// Same text through every speech engine, then through the robot stage:
// WaxVocoder, eSpeak NG, Piper, Piper in the vocoder, WaxVocoder Kraftwerk.
// Piper voices are read from voices/<id>/ (see README, « Moteurs de voix »).
//
// Usage: npm run build:wasm && node scripts/compare-engines.ts [dossier] ["texte"]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import EspeakInitializer from '@echogarden/espeak-ng-emscripten'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { encodeWav } from '../src/audio/wav.ts'
import { espeakSpeech, piperVoicesFor, resample, robotize, robotSettings, type Speech } from '../src/engines/index.ts'
import { type PiperConfig, piperPhonemes, PiperVoice } from '../src/engines/piper.ts'
import { loadEspeak } from '../src/espeak.ts'
import { applySettings, DEFAULT_SETTINGS, PRESETS, type VoiceSettings } from '../src/voice-settings.ts'

const SR = 44_100
const [out = 'ecoute/moteurs', text = 'Kaos, il se levait tous les matins à quatre heures, et distribuait le courrier à contrecœur. Bonjour madame, je vous apporte une lettre de Paris.'] = process.argv.slice(2)

await initialize({ module_or_path: await WebAssembly.compile(await readFile(new URL('../src/wasm/voice-engine/voice_engine_bg.wasm', import.meta.url))) })
const transcriber = await loadEspeak()
const worker = new (await EspeakInitializer()).eSpeakNGWorker()
const voice = piperVoicesFor('fr')[0]
const folder = new URL(`../voices/${voice.id}/`, import.meta.url)
const config = JSON.parse(await readFile(new URL(`${voice.id}.onnx.json`, folder), 'utf8')) as PiperConfig
const piper = await PiperVoice.load(await import('onnxruntime-web'), await readFile(new URL(`${voice.id}.onnx`, folder)), config)

function waxvocoder(settings: VoiceSettings): Speech {
  const engine = new VoiceEngine(SR)
  applySettings(engine, settings)
  engine.set_language('fr')
  engine.set_phonemes(transcriber.transcribeTimed(text, 'fr').timed)
  engine.set_active(true)
  const samples = new Float32Array(Math.ceil(engine.duration_seconds() * SR))
  engine.render(samples)
  engine.free()
  return { samples, sampleRate: SR }
}
const piperSpeech = async (words: string): Promise<Speech> =>
  ({ samples: await piper.speak(piperPhonemes(worker, config.espeak.voice, words)), sampleRate: piper.sampleRate })
const toOutput = ({ samples, sampleRate }: Speech) => {
  const resampled = resample(samples, sampleRate, SR)
  const peak = resampled.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
  return resampled.map((sample) => (sample / Math.max(peak, 1e-3)) * 0.7)
}

const piperVoice = await piperSpeech(text)
const kraftwerk = PRESETS.kraftwerk.settings
const VERSIONS: Array<[string, string, Speech]> = [
  ['1-waxvocoder', 'Un. WaxVocoder.', waxvocoder(DEFAULT_SETTINGS)],
  ['2-espeak-ng', 'Deux. eSpeak.', espeakSpeech(worker, 'fr', text)],
  ['3-piper', 'Trois. Piper.', piperVoice],
  ['4-piper-robot', 'Quatre. Piper dans le vocodeur.', {
    samples: robotize(piperVoice, robotSettings(kraftwerk)),
    sampleRate: piper.sampleRate,
  }],
  ['5-waxvocoder-kraftwerk', 'Cinq. WaxVocoder, robot Kraftwerk.', waxvocoder(kraftwerk)],
]

await mkdir(out, { recursive: true })
const pieces: Float32Array[] = []
for (const [name, announcement, speech] of VERSIONS) {
  const samples = toOutput(speech)
  await writeFile(`${out}/${name}.wav`, new Uint8Array(encodeWav(samples, SR)))
  pieces.push(toOutput(await piperSpeech(announcement)).map((sample) => sample * 0.8), new Float32Array(SR * 0.4), samples, new Float32Array(SR))
  console.log(`${name.padEnd(24)} ${(samples.length / SR).toFixed(1)} s`)
}
const all = new Float32Array(pieces.reduce((length, piece) => length + piece.length, 0))
let offset = 0
for (const piece of pieces) {
  all.set(piece, offset)
  offset += piece.length
}
await writeFile(`${out}/comparaison.wav`, new Uint8Array(encodeWav(all, SR)))
console.log(`→ ${out}/comparaison.wav (${(all.length / SR).toFixed(1)} s) · voix Piper ${voice.id}, ${voice.licence}`)
