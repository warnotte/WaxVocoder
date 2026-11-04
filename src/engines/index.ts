/**
 * Speech engines behind one interface: WaxVocoder's own formant voice (robot,
 * singing, real time), eSpeak NG's voice and Piper's neural voices (natural
 * speech). Any engine's audio can go through the robot stage: the channel
 * vocoder with its chords, as Kraftwerk sang into theirs.
 */
import type { EspeakWorker } from '../espeak.ts'
import { ESPEAK_SAMPLE_RATE } from '../espeak.ts'
import type { Language } from '../ipa.ts'

export const ENGINES = {
  waxvocoder: { label: 'WaxVocoder' },
  espeak: { label: 'eSpeak NG' },
  piper: { label: 'Piper (voix naturelle)' },
} as const
export type EngineName = keyof typeof ENGINES

/** A Piper voice: a model file and, for a model with several speakers, one of them. */
export type PiperVoiceInfo = {
  /** Unique key, e.g. `fr_FR-upmc-medium:pierre`. */
  key: string
  /** Model file name without extension (`<id>.onnx`, `<id>.onnx.json`). */
  id: string
  /** Folder in rhasspy/piper-voices. */
  path: string
  label: string
  licence: string
  languages: readonly Language[]
  speaker?: number
}

const FRENCH: readonly Language[] = ['fr', 'fr-CA', 'fr-BE']

/**
 * Piper voices, all under free licences (none forbids commercial use); the
 * first of a language is its default. Left out: fr_FR-gilles-low (its model
 * has no nasal vowels: « bon » would be « bo »), fr_FR-mls (125 speakers of
 * uneven quality), and voices under non-commercial licences (lessac, ryan, hfc).
 */
export const PIPER_VOICES: readonly PiperVoiceInfo[] = [
  { key: 'fr_FR-siwis-medium', id: 'fr_FR-siwis-medium', path: 'fr/fr_FR/siwis/medium', label: 'Siwis', licence: 'CC BY 4.0 (SIWIS, université d’Édimbourg)', languages: FRENCH },
  { key: 'fr_FR-tom-medium', id: 'fr_FR-tom-medium', path: 'fr/fr_FR/tom/medium', label: 'Tom', licence: 'AGPL-3.0 (Tjiho)', languages: FRENCH },
  { key: 'fr_FR-upmc-medium:pierre', id: 'fr_FR-upmc-medium', path: 'fr/fr_FR/upmc/medium', label: 'Pierre', licence: 'CC BY-SA 4.0 (UPMC, MaryTTS)', languages: FRENCH, speaker: 1 },
  { key: 'fr_FR-upmc-medium:jessica', id: 'fr_FR-upmc-medium', path: 'fr/fr_FR/upmc/medium', label: 'Jessica', licence: 'CC BY-SA 4.0 (UPMC, MaryTTS)', languages: FRENCH, speaker: 0 },
  { key: 'en_US-joe-medium', id: 'en_US-joe-medium', path: 'en/en_US/joe/medium', label: 'Joe', licence: 'CC0 (OHF-Voice)', languages: ['en'] },
  { key: 'de_DE-thorsten-medium', id: 'de_DE-thorsten-medium', path: 'de/de_DE/thorsten/medium', label: 'Thorsten', licence: 'CC0 (Thorsten-Voice)', languages: ['de'] },
]

/** The Piper voices of a language, its default first. */
export const piperVoicesFor = (language: Language): PiperVoiceInfo[] =>
  PIPER_VOICES.filter((voice) => voice.languages.includes(language))

/** Where Piper voices are fetched from when they are not served next to the page. */
export const PIPER_VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'

import type { Speech } from './robot.ts'

export { robotize, robotSettings, type RobotSettings, type Speech } from './robot.ts'

/** eSpeak NG's own voice for a text (its audio, unchanged). */
export function espeakSpeech(worker: EspeakWorker, voice: string, text: string): Speech {
  if (!worker.synthesize) throw new Error('eSpeak NG worker without synthesis')
  const code = worker.set_voice(voice)
  if (typeof code === 'number' && code !== 0) throw new Error(`eSpeak NG cannot load the voice « ${voice} » (code ${code})`)
  const chunks: Int16Array[] = []
  worker.synthesize(text, (audio) => {
    if (audio) chunks.push(audio)
    return false
  })
  const samples = new Float32Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) samples[offset + index] = chunk[index] / 32768
    offset += chunk.length
  }
  return { samples, sampleRate: ESPEAK_SAMPLE_RATE }
}

/** Linear resampling, e.g. 22.05 kHz voices into a 44.1 or 48 kHz context. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples
  const output = new Float32Array(Math.floor((samples.length * to) / from))
  const ratio = from / to
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const before = Math.floor(position)
    const after = Math.min(before + 1, samples.length - 1)
    output[index] = samples[before] + (samples[after] - samples[before]) * (position - before)
  }
  return output
}
