/**
 * Piper (neural, VITS) voices through ONNX Runtime: natural speech from a
 * model trained on a real speaker. Text is phonemized by the same eSpeak NG as
 * the rest of WaxVocoder, as Piper expects, then turned into Piper's phoneme ids.
 */
import type { EspeakWorker } from '../espeak.ts'
import { splitClauses } from '../espeak.ts'

/** The fields of a Piper voice's `.onnx.json` that synthesis needs. */
export type PiperConfig = {
  audio: { sample_rate: number }
  espeak: { voice: string }
  inference: { noise_scale: number; length_scale: number; noise_w: number }
  num_speakers: number
  phoneme_id_map: Record<string, number[]>
}

export type PiperOptions = {
  /** Above 1 slower, below 1 faster. */
  lengthScale?: number
  /** Speaker of a multi-speaker voice. */
  speaker?: number
}

/** Language switches eSpeak NG inserts around loanwords, e.g. `(en)fʌn(fr)`. */
const LANGUAGE_SWITCH = /\([a-z]{2,3}(?:-[a-z]+)?\)/gi

/**
 * Text → IPA as Piper's eSpeak NG phonemizer gives it: one stretch per
 * clause, words separated by spaces, the clause's punctuation kept.
 */
export function piperPhonemes(worker: EspeakWorker, voice: string, text: string): string {
  const code = worker.set_voice(voice)
  if (typeof code === 'number' && code !== 0) throw new Error(`eSpeak NG cannot load the voice « ${voice} » (code ${code})`)
  return splitClauses(text)
    .map(({ text: clause, boundary }) => {
      const ipa = worker.synthesize_ipa(clause).ipa
        .replace(LANGUAGE_SWITCH, '')
        // The phoneme separator and syllable marks of eSpeak NG's trace output.
        .replace(/[_-]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      return ipa ? `${ipa}${boundary}` : ''
    })
    .filter(Boolean)
    .join(' ')
}

/** Piper's input: each phoneme's id followed by the pad, between the start and end marks. */
export function phonemeIds(ipa: string, map: PiperConfig['phoneme_id_map']): { ids: number[]; missing: string[] } {
  const pad = map._ ?? [0]
  const ids = [...(map['^'] ?? [1]), ...pad]
  const missing: string[] = []
  for (const symbol of ipa.normalize('NFD')) {
    const id = map[symbol]
    if (!id) {
      missing.push(symbol)
      continue
    }
    ids.push(...id, ...pad)
  }
  ids.push(...(map.$ ?? [2]))
  return { ids, missing }
}

type Ort = typeof import('onnxruntime-web')

export class PiperVoice {
  readonly config: PiperConfig
  private readonly ort: Ort
  private readonly session: import('onnxruntime-web').InferenceSession

  private constructor(ort: Ort, session: import('onnxruntime-web').InferenceSession, config: PiperConfig) {
    this.ort = ort
    this.session = session
    this.config = config
  }

  /**
   * Loads a voice from its model (`.onnx`) and configuration (`.onnx.json`).
   * `ort` is ONNX Runtime: `onnxruntime-web/wasm` in a browser (WASM only,
   * the smallest), `onnxruntime-web` under Node.
   */
  static async load(ort: Ort, model: Uint8Array | ArrayBuffer, config: PiperConfig): Promise<PiperVoice> {
    const session = await ort.InferenceSession.create(model instanceof Uint8Array ? model : new Uint8Array(model), {
      executionProviders: ['wasm'],
    })
    return new PiperVoice(ort, session, config)
  }

  get sampleRate(): number {
    return this.config.audio.sample_rate
  }

  /** Speaks IPA (from {@link piperPhonemes}); returns mono audio at {@link sampleRate}. */
  async speak(ipa: string, options: PiperOptions = {}): Promise<Float32Array> {
    const { ids } = phonemeIds(ipa, this.config.phoneme_id_map)
    const { Tensor } = this.ort
    const { noise_scale, length_scale, noise_w } = this.config.inference
    const feeds: Record<string, import('onnxruntime-web').Tensor> = {
      input: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new Tensor('int64', BigInt64Array.of(BigInt(ids.length)), [1]),
      scales: new Tensor('float32', Float32Array.of(noise_scale, length_scale * (options.lengthScale ?? 1), noise_w), [3]),
    }
    if (this.config.num_speakers > 1) feeds.sid = new Tensor('int64', BigInt64Array.of(BigInt(options.speaker ?? 0)), [1])
    const results = await this.session.run(feeds)
    const output = results[this.session.outputNames[0]]
    return Float32Array.from(output.data as Float32Array)
  }
}
