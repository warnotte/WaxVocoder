/**
 * Browser side of the speech engines: Piper voices fetched on first use
 * (served next to the page under voices/, or from Hugging Face), and playback
 * of a synthesized buffer.
 */
import type { EspeakTranscriber } from '../espeak.ts'
import { ESPEAK_LANGUAGES, type Language } from '../ipa.ts'
import { type EngineName, espeakSpeech, PIPER_VOICE_BASE, PIPER_VOICES, robotize, type RobotSettings, type Speech } from './index.ts'
import { type PiperConfig, piperPhonemes, PiperVoice } from './piper.ts'

const voices = new Map<string, Promise<PiperVoice>>()

/** The first of these addresses that answers with the file (not with a web page). */
async function fetchFirst(urls: string[], onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  let lastError: unknown
  for (const url of urls) {
    try {
      const response = await fetch(url)
      if (!response.ok || /text\/html/i.test(response.headers.get('content-type') ?? '')) {
        lastError = new Error(`${url} : ${response.status}`)
        continue
      }
      const total = Number(response.headers.get('content-length') ?? 0)
      if (!response.body || !total || !onProgress) return new Uint8Array(await response.arrayBuffer())
      const reader = response.body.getReader()
      const bytes = new Uint8Array(total)
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes.set(value, received)
        received += value.length
        onProgress(received / total)
      }
      return bytes.subarray(0, received)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Loads (once) the Piper voice of a language; `onProgress` follows the model download. */
export function loadPiperVoice(language: Language, onProgress?: (fraction: number) => void): Promise<PiperVoice> {
  const voice = PIPER_VOICES[language]
  if (!voice) return Promise.reject(new Error(`pas encore de voix Piper pour « ${ESPEAK_LANGUAGES[language].label} »`))
  let loading = voices.get(voice.id)
  if (!loading) {
    const sources = (file: string) => [`voices/${voice.id}/${file}`, `${PIPER_VOICE_BASE}/${voice.path}/${file}`]
    loading = (async () => {
      const ort = await import('onnxruntime-web/wasm')
      // Threads need cross-origin isolation, which a plain static site does not have.
      ort.env.wasm.numThreads = 1
      const config = JSON.parse(new TextDecoder().decode(await fetchFirst(sources(`${voice.id}.onnx.json`)))) as PiperConfig
      const model = await fetchFirst(sources(`${voice.id}.onnx`), onProgress)
      return PiperVoice.load(ort, model, config)
    })()
    loading.catch(() => voices.delete(voice.id))
    voices.set(voice.id, loading)
  }
  return loading
}

/** Speech of `text` with an engine other than WaxVocoder's own, robot stage included. */
export async function synthesize(
  engine: Exclude<EngineName, 'waxvocoder'>,
  text: string,
  language: Language,
  transcriber: EspeakTranscriber,
  robot: RobotSettings,
  onProgress?: (fraction: number) => void,
): Promise<Speech> {
  let speech: Speech
  if (engine === 'espeak') {
    speech = espeakSpeech(transcriber.worker, ESPEAK_LANGUAGES[language].voice, text)
  } else {
    const voice = await loadPiperVoice(language, onProgress)
    const samples = await voice.speak(piperPhonemes(transcriber.worker, voice.config.espeak.voice, text))
    speech = { samples, sampleRate: voice.sampleRate }
  }
  return { samples: robotize(speech, robot), sampleRate: speech.sampleRate }
}

/** Plays one buffer at a time. */
export class BufferPlayer {
  private context: AudioContext | undefined
  private source: AudioBufferSourceNode | undefined
  private release: (() => void) | undefined
  /** Connects each new source (to effects, a meter…) and returns how to let it go; by default, the speakers. */
  route: ((context: AudioContext, node: AudioNode) => () => void) | undefined

  async play(speech: Speech, onEnded: () => void): Promise<void> {
    this.stop()
    this.context ??= new AudioContext()
    await this.context.resume()
    const buffer = this.context.createBuffer(1, speech.samples.length, speech.sampleRate)
    buffer.copyToChannel(Float32Array.from(speech.samples), 0)
    const source = this.context.createBufferSource()
    source.buffer = buffer
    if (this.route) {
      this.release = this.route(this.context, source)
    } else {
      source.connect(this.context.destination)
      this.release = () => source.disconnect()
    }
    source.onended = () => {
      if (this.source === source) this.source = undefined
      this.release?.()
      this.release = undefined
      onEnded()
    }
    this.source = source
    source.start()
  }

  stop(): void {
    const source = this.source
    this.source = undefined
    if (source) {
      source.onended = null
      source.stop()
    }
    this.release?.()
    this.release = undefined
  }

  get playing(): boolean {
    return this.source !== undefined
  }
}
