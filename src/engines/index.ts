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

/** Piper voices offered per language, all under licences that allow any use. */
export const PIPER_VOICES: Partial<Record<Language, { id: string; path: string; licence: string }>> = {
  fr: { id: 'fr_FR-siwis-medium', path: 'fr/fr_FR/siwis/medium', licence: 'CC BY 4.0 (SIWIS, université d’Édimbourg)' },
  'fr-CA': { id: 'fr_FR-siwis-medium', path: 'fr/fr_FR/siwis/medium', licence: 'CC BY 4.0 (SIWIS, université d’Édimbourg)' },
  'fr-BE': { id: 'fr_FR-siwis-medium', path: 'fr/fr_FR/siwis/medium', licence: 'CC BY 4.0 (SIWIS, université d’Édimbourg)' },
}

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
