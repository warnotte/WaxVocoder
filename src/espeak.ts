import { type Conversion, ESPEAK_LANGUAGES, ipaToPhonemes, ipaTokens, type Language } from './ipa.ts'

/** An event of eSpeak NG's synthesis callback; `audio_position` is in milliseconds. */
export type EspeakEvent = { type: string; id?: string | number; audio_position: number }

/** The part of eSpeak NG's `eSpeakNGWorker` used for transcription. */
export interface EspeakWorker {
  /** Returns eSpeak NG's error code (0 when the voice is loaded). */
  set_voice(voice: string): number | void
  synthesize_ipa(text: string): { ipa: string }
  /** Synthesizes the text; the callback receives audio chunks and events, and stops it by returning true. */
  synthesize?(text: string, callback: (audio: Int16Array, events: EspeakEvent[]) => boolean): unknown
}

/** Sample rate of eSpeak NG's audio. */
export const ESPEAK_SAMPLE_RATE = 22_050

export type Clause = { text: string; boundary: '' | ',' | '.' | '?' }

/** Splits text at punctuation, which eSpeak NG drops from its IPA output. */
export function splitClauses(text: string): Clause[] {
  const clauses: Clause[] = []
  for (const [, body, punctuation] of text.matchAll(/([^.,;:!?]+)([.,;:!?]*)/g)) {
    const clause = body.trim()
    if (!clause) continue
    const boundary = punctuation.includes('?') ? '?'
      : /[.!]/.test(punctuation) ? '.'
        : /[,;:]/.test(punctuation) ? ','
          : ''
    clauses.push({ text: clause, boundary })
  }
  return clauses
}

/** Stops and affricates, whose silent closure eSpeak NG files under the previous phoneme. */
const STOPS = new Set(['p', 't', 'k', 'b', 'd', 'ɡ', 'g', 'c', 'ɟ', 'q', 'tʃ', 'dʒ', 'ts', 'pf'])
const baseSegment = (id: string) => id.replace(/[ˈˌː\-]/g, '').normalize('NFC')

export type PhonemeTiming = { ids: string[]; ms: number[] }

/**
 * Duration of each phoneme eSpeak NG spoke, in milliseconds, from its events
 * and audio. eSpeak marks a stop at its burst and leaves the silent closure at
 * the end of the phoneme before; that silence is measured and handed back to
 * the stop, as the engine's stops contain their closure.
 */
export function phonemeTimings(audio: Int16Array, events: readonly EspeakEvent[], sampleRate = ESPEAK_SAMPLE_RATE): PhonemeTiming {
  // Language switches around loanwords, « (en) », take no time.
  const marks = events.filter((event) => event.type === 'phoneme' && !/^\([a-z-]+\)$/i.test(String(event.id)))
  const total = (audio.length / sampleRate) * 1000
  const ids: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  marks.forEach((mark, index) => {
    if (typeof mark.id !== 'string' || !mark.id) return
    ids.push(mark.id)
    starts.push(mark.audio_position)
    ends.push(marks[index + 1]?.audio_position ?? events.find((event) => event.type === 'end')?.audio_position ?? total)
  })
  const ms = starts.map((start, index) => Math.max(0, ends[index] - start))

  const window = Math.max(1, Math.round(0.005 * sampleRate))
  const rms = (fromMs: number) => {
    const from = Math.max(0, Math.round((fromMs / 1000) * sampleRate))
    const to = Math.min(audio.length, from + window)
    let sum = 0
    for (let sample = from; sample < to; sample += 1) sum += audio[sample] * audio[sample]
    return to > from ? Math.sqrt(sum / (to - from)) : 0
  }
  let peak = 0
  for (let time = 0; time < total; time += 5) peak = Math.max(peak, rms(time))
  const silence = Math.max(60, 0.03 * peak)

  for (let index = 0; index < ids.length; index += 1) {
    if (!STOPS.has(baseSegment(ids[index]))) continue
    if (index === 0) {
      // The leading silence is the closure of an initial stop.
      ms[0] += Math.min(starts[0], 40)
      continue
    }
    const floor = starts[index] - ms[index - 1] + Math.max(25, 0.35 * ms[index - 1])
    let onset = starts[index]
    while (onset - 5 >= floor && rms(onset - 5) < silence) onset -= 5
    const moved = starts[index] - onset
    ms[index - 1] -= moved
    ms[index] += moved
  }
  return { ids, ms }
}

/** A transcription with the untimed phonemes for display and the timed ones for the engine. */
export type TimedConversion = Conversion & {
  /** Phonemes with eSpeak NG's durations (`A1:93`), or untimed where they could not be aligned. */
  timed: string
  /** Clauses that got durations, out of all clauses. */
  timedClauses: number
  clauses: number
}

export class EspeakTranscriber {
  /** The eSpeak NG worker, also used for its own voice and to phonemize for Piper. */
  readonly worker: EspeakWorker

  constructor(worker: EspeakWorker) {
    this.worker = worker
  }

  /** Text → engine phonemes, keeping punctuation as protocol boundaries. */
  transcribe(text: string, language: Language): Conversion {
    const { phonemes, unknown } = this.convert(text, language, false)
    return { phonemes, unknown }
  }

  /**
   * Like {@link transcribe}, and also with the rhythm of eSpeak NG: each phone
   * carries the duration eSpeak gave it, so the engine speaks with the timing of
   * the language instead of its generic rules.
   */
  transcribeTimed(text: string, language: Language): TimedConversion {
    return this.convert(text, language, true)
  }

  private convert(text: string, language: Language, withTiming: boolean): TimedConversion {
    const { voice } = ESPEAK_LANGUAGES[language]
    // A missing voice is not an error for eSpeak NG: it would keep the previous one.
    const code = this.worker.set_voice(voice)
    if (typeof code === 'number' && code !== 0) throw new Error(`eSpeak NG cannot load the voice « ${voice} » (code ${code})`)
    const parts: string[] = []
    const timedParts: string[] = []
    const unknown: string[] = []
    let clauses = 0
    let timedClauses = 0
    for (const clause of splitClauses(text)) {
      const ipa = this.worker.synthesize_ipa(clause.text).ipa.replace(/\s+/g, ' ').trim()
      const converted = ipaToPhonemes(ipa, language)
      unknown.push(...converted.unknown)
      if (!converted.phonemes) continue
      clauses += 1
      const durations = withTiming ? this.durations(clause.text, ipa) : undefined
      const timed = durations ? ipaToPhonemes(ipa, language, durations).phonemes : converted.phonemes
      if (durations) timedClauses += 1
      parts.push(converted.phonemes)
      timedParts.push(timed)
      if (clause.boundary) {
        parts.push(clause.boundary)
        timedParts.push(clause.boundary)
      }
    }
    return { phonemes: parts.join(' '), timed: timedParts.join(' '), unknown, timedClauses, clauses }
  }

  /** Durations of the IPA segments, or undefined when eSpeak's events do not match them. */
  private durations(text: string, ipa: string): number[] | undefined {
    if (!this.worker.synthesize) return undefined
    const chunks: Int16Array[] = []
    const events: EspeakEvent[] = []
    this.worker.synthesize(text, (audio, list) => {
      if (audio) chunks.push(audio)
      events.push(...list)
      return false
    })
    const audio = new Int16Array(chunks.reduce((length, chunk) => length + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      audio.set(chunk, offset)
      offset += chunk.length
    }
    const timing = phonemeTimings(audio, events)
    const tokens = ipaTokens(ipa).map((token) => token.normalize('NFC'))
    const aligned = timing.ids.length === tokens.length
      && timing.ids.every((id, index) => id.normalize('NFC') === tokens[index])
    return aligned ? timing.ms : undefined
  }
}

export type EspeakOptions = {
  /**
   * Address of `espeak-ng.data` (≈ 24 MB of language data). Required in a
   * browser: eSpeak NG looks for the file beside its own script, which a
   * bundler moves (Vite's dependency cache, hashed chunks). The data is then
   * fetched here and handed to eSpeak NG. Node reads the file beside the package.
   */
  dataUrl?: string
}

/** eSpeak NG's data package, as the browser fetches it; rejects anything but the data file. */
async function fetchEspeakData(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`espeak-ng.data: HTTP ${response.status} at ${url}`)
  if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error(`espeak-ng.data not found at ${url}: the server answered with a web page`)
  }
  return response.arrayBuffer()
}

/** Loads the eSpeak NG WebAssembly build (≈ 25 MB with its language data). */
export async function loadEspeak(options: EspeakOptions = {}): Promise<EspeakTranscriber> {
  const { default: initialize } = await import('@echogarden/espeak-ng-emscripten')
  const data = options.dataUrl ? await fetchEspeakData(options.dataUrl) : undefined
  // Emscripten's hook for a data package fetched by the host (eSpeak NG overrides `locateFile`).
  const module = await initialize(data ? { getPreloadedPackage: () => data } : undefined)
  return new EspeakTranscriber(new module.eSpeakNGWorker())
}
