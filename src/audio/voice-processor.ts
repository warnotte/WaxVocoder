import './worklet-polyfills.ts'
import init, { VoiceEngine } from '../wasm/voice-engine/voice_engine.js'
import { applySetting, applySettings, DEFAULT_SETTINGS, type VoiceSettings } from '../voice-settings.ts'

type ProcessorMessage =
  | { type: 'phonemes' | 'language'; value: string }
  | { [Name in keyof VoiceSettings]: { type: 'setting'; name: Name; value: VoiceSettings[Name] } }[keyof VoiceSettings]
  | { type: 'active' | 'stop' }

class VoiceProcessor extends AudioWorkletProcessor {
  private engine: VoiceEngine | null = null
  private phonemes: string
  private language: string
  private settings: VoiceSettings
  private active = false
  private meterFrames = 0

  constructor(options?: AudioWorkletNodeOptions) {
    super()
    const processorOptions = options?.processorOptions ?? {}
    this.phonemes = String(processorOptions.phonemes ?? '')
    this.language = String(processorOptions.language ?? 'en')
    this.settings = { ...DEFAULT_SETTINGS, ...(processorOptions.settings as Partial<VoiceSettings> | undefined) }
    this.port.onmessage = (event: MessageEvent<ProcessorMessage>) => this.handle(event.data)

    const wasmModule = processorOptions.wasmModule as WebAssembly.Module | undefined
    if (!wasmModule) {
      this.port.postMessage({ type: 'error', message: 'Module WASM absent des options du processeur.' })
      return
    }
    void init({ module_or_path: wasmModule }).then(() => {
      const engine = new VoiceEngine(sampleRate)
      applySettings(engine, this.settings)
      engine.set_language(this.language)
      engine.set_phonemes(this.phonemes)
      engine.set_active(this.active)
      this.engine = engine
      this.port.postMessage({ type: 'ready' })
    }).catch((error: unknown) => {
      this.port.postMessage({ type: 'error', message: String(error) })
    })
  }

  private handle(message: ProcessorMessage): void {
    switch (message.type) {
      case 'phonemes':
        this.phonemes = message.value
        this.engine?.set_phonemes(message.value)
        break
      case 'language':
        this.language = message.value
        this.engine?.set_language(message.value)
        break
      case 'setting':
        this.settings = { ...this.settings, [message.name]: message.value }
        if (this.engine) applySetting(this.engine, message.name, message.value)
        break
      case 'active':
        this.active = true
        this.engine?.set_active(true)
        break
      case 'stop':
        this.active = false
        this.engine?.set_active(false)
        break
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channel = outputs[0]?.[0]
    if (channel) {
      if (this.engine) this.engine.render(channel)
      else channel.fill(0)
      if (this.active && this.engine && !this.engine.is_active()) {
        this.active = false
        this.port.postMessage({ type: 'finished' })
      }
      if (++this.meterFrames >= 12) {
        let peak = 0
        for (const sample of channel) peak = Math.max(peak, Math.abs(sample))
        this.port.postMessage({ type: 'meter', peak })
        this.meterFrames = 0
      }
    }
    return true
  }
}

registerProcessor('wax-voice-processor', VoiceProcessor)
