import './style.css'
import processorUrl from './audio/voice-processor.ts?worker&url'
import wasmUrl from './wasm/voice-engine/voice_engine_bg.wasm?url'
import dictionaryUrl from './data/cmudict.txt?url'
import espeakDataUrl from '@echogarden/espeak-ng-emscripten/espeak-ng.data?url'
import initWasm, { VoiceEngine } from './wasm/voice-engine/voice_engine.js'
import { encodeWav } from './audio/wav'
import { loadDictionary } from './dictionary'
import { BufferPlayer, synthesize } from './engines/browser'
import { type EngineName, ENGINES, PIPER_VOICES, piperVoicesFor, robotSettings, type Speech } from './engines/index'
import { type EspeakTranscriber, loadEspeak } from './espeak'
import { BandMeter } from './visualizer'
import { EffectsRack, type EffectSettings, NO_EFFECTS, renderEffects } from './audio/effects-rack'
import { ESPEAK_LANGUAGES, type Language } from './ipa'
import { type Lexicon, transcribe, unknownPhonemeTokens } from './phonemes'
import { applySettings, CHORDS, DEFAULT_SETTINGS, invalidNotes, PRESETS, type VoiceSettings } from './voice-settings'

const element = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

const playButton = element<HTMLButtonElement>('#play')
const exportButton = element<HTMLButtonElement>('#export')
const languageControl = element<HTMLSelectElement>('#language')
const engineControl = element<HTMLSelectElement>('#engine')
const engineHint = element<HTMLElement>('#engine-hint')
const voiceControl = element<HTMLSelectElement>('#voice')
const voiceLabel = element<HTMLElement>('label[for="voice"]')
const phraseTitle = element<HTMLElement>('#phrase-title')
const phraseControl = element<HTMLTextAreaElement>('#phrase')
const phonemeControl = element<HTMLTextAreaElement>('#phonemes')
const phonemeHint = element<HTMLElement>('#phoneme-hint')
const presetKeys = element<HTMLElement>('#presets')
const playLabel = element<HTMLElement>('#play .key-label')
const chordControl = element<HTMLSelectElement>('#chord')
const melodyControl = element<HTMLInputElement>('#melody')
const melodyHint = element<HTMLElement>('#melody-hint')
const quantizeControl = element<HTMLInputElement>('#quantize')
const rhythmControl = element<HTMLInputElement>('#natural-rhythm')
const status = element<HTMLElement>('#status')

type NumericSetting = 'frequency' | 'rate' | 'intonation' | 'presence' | 'vocoder' | 'tempo' | 'lofi' | 'formantShift' | 'vibrato' | 'glide'
const percent = (value: number) => `${Math.round(value * 100)} %`
const sliders: Array<{ name: NumericSetting; input: HTMLInputElement; output: HTMLOutputElement; format: (value: number) => string }> = [
  ['frequency', 'pitch', (value: number) => `${value} Hz`],
  ['rate', 'rate', (value: number) => `× ${value.toFixed(2)}`],
  ['intonation', 'intonation', percent],
  ['presence', 'presence', percent],
  ['vocoder', 'vocoder', percent],
  ['tempo', 'tempo', (value: number) => (value > 0 ? `${value} BPM` : 'libre')],
  ['lofi', 'lofi', percent],
  ['formantShift', 'formant-shift', (value: number) =>
    value > 1.04 ? `petit robot × ${value.toFixed(2)}` : value < 0.96 ? `géant × ${value.toFixed(2)}` : 'normale'],
  ['vibrato', 'vibrato', (value: number) => `${value.toFixed(1)} demi-ton`],
  ['glide', 'glide', (value: number) => `${Math.round(value * 1000)} ms`],
].map(([name, id, format]) => ({
  name: name as NumericSetting,
  input: element<HTMLInputElement>(`#${id as string}`),
  output: element<HTMLOutputElement>(`#${id as string}-value`),
  format: format as (value: number) => string,
}))

// The syntax help sits in the label's tooltip; the display only shows problems.
const PHONEME_HELP = 'ARPAbet (CMUdict) et extensions E A O U UE EU OE AX, nasales AN ON IN UN, RX NY UY X CC. 1 / 2 / 0 = accent principal / secondaire / atone ; « | » sépare les mots, « _ » insère une courte pause, « , » « . » « ? » marquent la ponctuation ; « A1:90 » impose une durée en millisecondes.'
element<HTMLLabelElement>('label[for="phonemes"]').title = PHONEME_HELP
const MELODY_HELP = 'Notes anglaises (C3, D#3, Bb2 ; A4 = 440 Hz) ou françaises (do2, ré#2, sib1 ; la3 = 440 Hz), une par voyelle, en boucle. Vide : intonation parlée.'

const SAMPLES: Record<Language, string> = {
  en: 'Hello, I am Wax Vocoder, a machine that talks and sings. Type your own words here, pick a voice, and press play. I can sound like a talking toy from nineteen eighty, or sing with a whole choir of robots.',
  fr: 'Bonjour, je suis Wax Vocoder, une machine qui parle et qui chante. Écris ton texte ici, choisis une voix, puis appuie sur Lire. Je peux parler comme un jouet des années quatre-vingt, ou chanter avec tout un chœur de robots.',
  'fr-CA': 'Salut, je suis Wax Vocoder, une machine qui jase pis qui chante. Écris ton texte ici, choisis une voix, pis appuie sur Lire. Il fait frette à matin, mais mes circuits sont ben au chaud.',
  'fr-BE': 'Bonjour, je suis Wax Vocoder, une machine qui parle et qui chante. Écris ton texte ici, choisis une voix, puis appuie sur Lire. Je compte jusqu’à septante, et même jusqu’à nonante, sans me tromper, une fois !',
  de: 'Hallo, ich bin Wax Vocoder, eine Maschine, die spricht und singt. Schreib deinen Text hier hinein, wähle eine Stimme und hör mir zu. Ich klinge wie ein sprechendes Spielzeug aus den Achtzigern oder wie ein ganzer Chor von Robotern.',
}

let lexicon: Lexicon | undefined
let espeak: Promise<EspeakTranscriber> | undefined
let transcription = 0
let transcriptionTimer: ReturnType<typeof setTimeout> | undefined
let phonemesEdited = false
/** The transcription with eSpeak NG's durations (`A1:93`), sent instead of the editor while it is untouched. */
let timedPhonemes: string | undefined
let wasmModule: Promise<WebAssembly.Module> | undefined
let context: AudioContext | undefined
let voiceNode: AudioWorkletNode | undefined
let playing = false
let engineReady = false
let engineFailed = false
let initializing = false

for (const [code, language] of Object.entries(ESPEAK_LANGUAGES)) languageControl.add(new Option(language.label, code))
for (const [code, engine] of Object.entries(ENGINES)) engineControl.add(new Option(engine.label, code))
updateVoices()
voiceControl.addEventListener('change', () => {
  player.stop()
  updateEngineHint()
})
engineControl.addEventListener('change', () => {
  player.stop()
  setPlayLabel(playing ? 'Arrêter la voix' : 'Lire la phrase')
  updateEngineHint()
})
/** Lights the key of the active preset; none is lit once a setting is changed by hand. */
function showPreset(selected: string): void {
  for (const key of presetKeys.querySelectorAll<HTMLButtonElement>('button[data-preset]')) {
    key.setAttribute('aria-pressed', String(key.dataset.preset === selected))
  }
}
for (const [name, preset] of Object.entries(PRESETS)) {
  const key = document.createElement('button')
  key.type = 'button'
  key.className = 'key'
  key.dataset.preset = name
  key.innerHTML = '<span class="led" aria-hidden="true"></span>'
  key.append(preset.label)
  key.addEventListener('click', () => {
    // A preset is heard whole: every module back in the signal.
    for (const module of ['voice', 'robot', 'effects'] as const) setBypass(module, false)
    showSettings(preset.settings)
    showEffects({ ...NO_EFFECTS, ...preset.effects })
    sendAllSettings()
    showPreset(name)
  })
  presetKeys.append(key)
}

/** The play key's label, and its LED lit while the voice plays. */
function setPlayLabel(text: string): void {
  playLabel.textContent = text
  playButton.classList.toggle('is-playing', text === 'Arrêter la voix')
}
CHORDS.forEach((label, index) => chordControl.add(new Option(label, String(index))))

/** Modules switched off with their bypass key: their controls keep their values but act as neutral. */
const bypassed = { voice: false, robot: false, effects: false }
const NEUTRAL_ROBOT: Partial<VoiceSettings> = {
  vocoder: 0, tempo: 0, lofi: 0, formantShift: 1, vibrato: 0, glide: 0, melody: '', quantize: false,
}

/** What the voice uses: the controls, with bypassed modules neutral. */
function currentSettings(): VoiceSettings {
  const settings: VoiceSettings = {
    ...DEFAULT_SETTINGS,
    chord: Number(chordControl.value),
    melody: melodyControl.value.trim(),
    quantize: quantizeControl.checked,
  }
  for (const { name, input } of sliders) settings[name] = Number(input.value)
  if (bypassed.voice) {
    const { frequency, rate, intonation, presence } = DEFAULT_SETTINGS
    Object.assign(settings, { frequency, rate, intonation, presence })
  }
  if (bypassed.robot) Object.assign(settings, NEUTRAL_ROBOT)
  return settings
}

function showSettings(settings: VoiceSettings): void {
  for (const { name, input, output, format } of sliders) {
    input.value = String(settings[name])
    output.value = format(settings[name])
  }
  chordControl.value = String(settings.chord)
  melodyControl.value = settings.melody
  quantizeControl.checked = settings.quantize
  updateMelodyHint()
}

function sendSetting<Name extends keyof VoiceSettings>(name: Name, value: VoiceSettings[Name]): void {
  voiceNode?.port.postMessage({ type: 'setting', name, value })
}

function sendAllSettings(): void {
  const settings = currentSettings()
  for (const name of Object.keys(settings) as Array<keyof VoiceSettings>) sendSetting(name, settings[name])
}

function compileWasm(): Promise<WebAssembly.Module> {
  wasmModule ??= fetch(wasmUrl).then(async (response) => {
    if (!response.ok) throw new Error(`WASM indisponible (${response.status})`)
    return WebAssembly.compile(await response.arrayBuffer())
  })
  wasmModule.catch(() => { wasmModule = undefined })
  return wasmModule
}

function updatePhonemeHint(): void {
  const unknown = unknownPhonemeTokens(phonemeControl.value)
  phonemeHint.textContent = unknown.length > 0
    ? `Symboles inconnus, ignorés par le moteur : ${unknown.join(', ')}`
    : ''
  phonemeHint.classList.toggle('warning', unknown.length > 0)
}

function updateMelodyHint(): void {
  const invalid = invalidNotes(melodyControl.value)
  melodyHint.textContent = invalid.length > 0 ? `Notes non reconnues, ignorées : ${invalid.join(', ')}` : MELODY_HELP
  melodyHint.classList.toggle('warning', invalid.length > 0)
}

/** What the engine speaks: the timed transcription, unless the rhythm is off or the editor was changed. */
function enginePhonemes(): string {
  return !phonemesEdited && rhythmControl.checked && timedPhonemes ? timedPhonemes : phonemeControl.value
}

function sendPhonemes(): void {
  updatePhonemeHint()
  voiceNode?.port.postMessage({ type: 'phonemes', value: enginePhonemes() })
}

const player = new BufferPlayer()
const meter = new BandMeter(element<HTMLCanvasElement>('#meter'))

/** The effects after the voice, one rack per audio context (the voice's, the player's). */
let effects: EffectSettings = { ...NO_EFFECTS }
const racks = new Map<BaseAudioContext, EffectsRack>()
function rackFor(context: AudioContext): EffectsRack {
  let rack = racks.get(context)
  if (!rack) {
    rack = new EffectsRack(context)
    rack.setNow(activeEffects())
    rack.output.connect(context.destination)
    meter.attach(context, rack.output)
    racks.set(context, rack)
  }
  return rack
}
player.route = (context, source) => {
  source.connect(rackFor(context).input)
  meter.wake()
  return () => source.disconnect()
}

const effectSliders: Array<{ name: keyof EffectSettings; input: HTMLInputElement; output: HTMLOutputElement; format: (value: number) => string }> = [
  ['echo', 'echo', (value: number) => `${Math.round(value * 100)} %`],
  ['echoTime', 'echo-time', (value: number) => `${Math.round(value * 1000)} ms`],
  ['space', 'space', (value: number) => `${Math.round(value * 100)} %`],
  ['metal', 'metal', (value: number) => `${Math.round(value * 100)} %`],
  ['radio', 'radio', (value: number) => `${Math.round(value * 100)} %`],
  ['width', 'width', (value: number) => `${Math.round(value * 100)} %`],
].map(([name, id, format]) => ({
  name: name as keyof EffectSettings,
  input: element<HTMLInputElement>(`#${id as string}`),
  output: element<HTMLOutputElement>(`#${id as string}-value`),
  format: format as (value: number) => string,
}))

/** The effects heard: none while the module is bypassed. */
const activeEffects = (): EffectSettings => (bypassed.effects ? { ...NO_EFFECTS } : effects)

function showEffects(next: EffectSettings): void {
  effects = { ...next }
  for (const { name, input, output, format } of effectSliders) {
    input.value = String(effects[name])
    output.value = format(effects[name])
  }
  for (const rack of racks.values()) rack.set(activeEffects())
}

/** The voice of an export through the effects: stereo, with the echo and reverberation tails. */
async function withEffects(samples: Float32Array, sampleRate: number): Promise<Float32Array[]> {
  const heard = activeEffects()
  const silent = Object.entries(heard).every(([name, value]) => name === 'echoTime' || value === 0)
  return silent ? [samples] : renderEffects(samples, sampleRate, heard)
}

/** A module's bypass key: lit while the module is in the signal, dark (and the module dimmed) when bypassed. */
for (const key of document.querySelectorAll<HTMLButtonElement>('button[data-bypass]')) {
  const module = key.dataset.bypass as keyof typeof bypassed
  key.addEventListener('click', () => setBypass(module, !bypassed[module]))
}
function setBypass(module: keyof typeof bypassed, off: boolean): void {
  bypassed[module] = off
  const key = element<HTMLButtonElement>(`button[data-bypass="${module}"]`)
  key.setAttribute('aria-pressed', String(off))
  key.closest('.module')?.classList.toggle('is-bypassed', off)
  if (module === 'effects') {
    for (const rack of racks.values()) rack.set(activeEffects())
  } else {
    sendAllSettings()
  }
}
const currentEngine = () => engineControl.value as EngineName
const ENGINE_HELP = 'Avec ce moteur, l’étage robot applique le vocoder (hauteur, porteuse, mélodie à une note par syllabe), le lo-fi, la taille et le vibrato ; débit, intonation, tempo, présence et glissando concernent WaxVocoder.'

/** The Piper voice chosen in the « Voix » menu. */
const currentVoice = () => PIPER_VOICES.find((voice) => voice.key === voiceControl.value)

/** Fills the « Voix » menu with the language's Piper voices, keeping the choice when it still fits. */
function updateVoices(): void {
  const previous = voiceControl.value
  const voices = piperVoicesFor(currentLanguage())
  voiceControl.replaceChildren(...voices.map((voice) => new Option(voice.label, voice.key)))
  if (voices.some((voice) => voice.key === previous)) voiceControl.value = previous
}

function updateEngineHint(): void {
  const engine = currentEngine()
  engineHint.hidden = engine === 'waxvocoder'
  voiceLabel.hidden = engine !== 'piper'
  const voice = currentVoice()
  engineHint.textContent = engine === 'piper' && !voice
    ? 'Pas encore de voix Piper pour cette langue : choisis le français, l’anglais ou l’allemand, ou un autre moteur.'
    : engine === 'piper' ? `${ENGINE_HELP} Voix ${voice?.label} (${voice?.id}), ${voice?.licence}.` : ENGINE_HELP
  engineHint.classList.toggle('warning', engine === 'piper' && !voice)
}

/** Speech from eSpeak NG or Piper, with the robot stage set by the vocoder controls. */
async function otherEngineSpeech(): Promise<Speech> {
  const engine = currentEngine()
  if (engine === 'waxvocoder') throw new Error('WaxVocoder passe par le moteur temps réel')
  const settings = currentSettings()
  // The robot stage runs WaxVocoder's vocoder here, on the page (the voice itself runs in the AudioWorklet).
  await initWasm({ module_or_path: await compileWasm() })
  const transcriber = await loadTranscriber()
  return synthesize(engine, phraseControl.value, currentLanguage(), transcriber, robotSettings(settings), {
    voice: currentVoice(),
    onProgress: (fraction) => { status.textContent = `Téléchargement de la voix Piper : ${Math.round(fraction * 100)} %` },
  })
}

function currentLanguage(): Language {
  return languageControl.value as Language
}

function loadTranscriber(): Promise<EspeakTranscriber> {
  espeak ??= loadEspeak({ dataUrl: espeakDataUrl })
  espeak.catch(() => { espeak = undefined })
  return espeak
}

/** English uses CMUdict; other languages go through eSpeak NG, loaded on first use. */
async function retranscribe(): Promise<void> {
  const language = currentLanguage()
  const request = ++transcription
  rhythmControl.disabled = language === 'en'
  if (language === 'en') {
    timedPhonemes = undefined
    phonemeControl.value = transcribe(phraseControl.value, lexicon)
    sendPhonemes()
    return
  }
  const loading = !espeak
  if (loading) status.textContent = 'Chargement d’eSpeak NG (≈ 25 Mo, une seule fois)…'
  try {
    const transcriber = await loadTranscriber()
    if (request !== transcription) return
    const { phonemes, timed, unknown } = transcriber.transcribeTimed(phraseControl.value, language)
    phonemeControl.value = phonemes
    timedPhonemes = timed
    sendPhonemes()
    if (unknown.length > 0) status.textContent = `Sons non pris en charge, ignorés : ${[...new Set(unknown)].join(' ')}`
    else if (loading || status.textContent?.startsWith('eSpeak NG prêt')) {
      status.textContent = `eSpeak NG prêt : transcription ${ESPEAK_LANGUAGES[language].label.toLowerCase()}.`
    }
  } catch (error) {
    if (request === transcription) status.textContent = `eSpeak NG indisponible : ${String(error)}`
  }
}

function scheduleTranscription(): void {
  clearTimeout(transcriptionTimer)
  transcriptionTimer = setTimeout(() => void retranscribe(), currentLanguage() === 'en' ? 0 : 150)
}

function markCustom(): void {
  showPreset('custom')
}

phraseControl.addEventListener('input', () => {
  phonemesEdited = false
  scheduleTranscription()
})

languageControl.addEventListener('change', () => {
  const language = currentLanguage()
  phraseTitle.textContent = `Texte (${ESPEAK_LANGUAGES[language].label.toLowerCase()})`
  if (Object.values(SAMPLES).includes(phraseControl.value.trim())) phraseControl.value = SAMPLES[language]
  voiceNode?.port.postMessage({ type: 'language', value: language })
  updateVoices()
  updateEngineHint()
  phonemesEdited = false
  void retranscribe()
})

phonemeControl.addEventListener('input', () => {
  phonemesEdited = true
  sendPhonemes()
})

rhythmControl.addEventListener('change', sendPhonemes)

for (const { name, input, output, format } of sliders) {
  input.addEventListener('input', () => {
    output.value = format(Number(input.value))
    sendSetting(name, currentSettings()[name])
    markCustom()
  })
}
for (const { name, input, output, format } of effectSliders) {
  input.addEventListener('input', () => {
    output.value = format(Number(input.value))
    showEffects({ ...effects, [name]: Number(input.value) })
    markCustom()
  })
}
chordControl.addEventListener('change', () => {
  sendSetting('chord', currentSettings().chord)
  markCustom()
})
melodyControl.addEventListener('input', () => {
  updateMelodyHint()
  sendSetting('melody', currentSettings().melody)
  markCustom()
})
quantizeControl.addEventListener('change', () => {
  sendSetting('quantize', currentSettings().quantize)
  markCustom()
})

showSettings(DEFAULT_SETTINGS)
showPreset('natural')
updatePhonemeHint()
void loadDictionary(dictionaryUrl).then((loaded) => {
  lexicon = loaded
  if (!phonemesEdited && currentLanguage() === 'en') void retranscribe()
  if (!playing) status.textContent = `Dictionnaire CMUdict chargé (${loaded.size.toLocaleString('fr')} mots).`
}).catch((error: unknown) => {
  status.textContent = `Dictionnaire indisponible, transcription approximative par règles : ${String(error)}`
})

playButton.addEventListener('click', async () => {
  if (initializing) return
  if (currentEngine() !== 'waxvocoder') {
    if (player.playing) {
      player.stop()
      setPlayLabel('Lire la phrase')
      status.textContent = 'Lecture arrêtée.'
      return
    }
    if (playing) {
      playing = false
      voiceNode?.port.postMessage({ type: 'stop' })
    }
    playButton.disabled = true
    status.textContent = `Synthèse avec ${ENGINES[currentEngine()].label}…`
    try {
      const speech = await otherEngineSpeech()
      await player.play(speech, () => {
        setPlayLabel('Lire la phrase')
        status.textContent = 'Phrase terminée.'
      })
      setPlayLabel('Arrêter la voix')
      status.textContent = `Lecture (${ENGINES[currentEngine()].label}, ${(speech.samples.length / speech.sampleRate).toFixed(1)} s).`
    } catch (error) {
      status.textContent = `Synthèse impossible : ${error instanceof Error ? error.message : String(error)}`
    } finally {
      playButton.disabled = false
    }
    return
  }
  if (!window.isSecureContext) {
    // AudioWorklet only exists in secure contexts.
    status.textContent = 'La voix demande une page en HTTPS (ou sur localhost) : sans connexion sécurisée, le navigateur bloque le moteur audio.'
    return
  }
  const startingEngine = !voiceNode
  if (startingEngine) {
    initializing = true
    playButton.disabled = true
    setPlayLabel('Chargement du moteur…')
    status.textContent = 'Initialisation du moteur audio et chargement WASM…'
  }
  let pendingContext: AudioContext | undefined
  try {
    if (!voiceNode) {
      pendingContext = new AudioContext()
      const audioStart = pendingContext.resume()
      const module = await compileWasm()
      await pendingContext.audioWorklet.addModule(processorUrl)
      const pendingNode = new AudioWorkletNode(pendingContext, 'wax-voice-processor', {
        processorOptions: {
          wasmModule: module,
          phonemes: enginePhonemes(),
          settings: currentSettings(),
          language: currentLanguage(),
        },
      })
      pendingNode.port.onmessage = (event: MessageEvent<{ type: string; message?: string; peak?: number }>) => {
        if (event.data.type === 'ready') {
          engineReady = true
          status.textContent = playing ? 'Phrase en lecture.' : 'Moteur Rust/WASM initialisé.'
        }
        if (event.data.type === 'error') {
          engineFailed = true
          status.textContent = `Échec du chargement WASM : ${event.data.message ?? 'erreur inconnue'}`
        }
        if (event.data.type === 'finished') {
          playing = false
          setPlayLabel('Lire la phrase')
          status.textContent = 'Phrase terminée.'
        }
        if (event.data.type === 'meter' && playing && engineReady && !engineFailed) {
          status.textContent = `Lecture · crête ${((event.data.peak ?? 0) * 100).toFixed(1)} %`
        }
      }
      pendingNode.onprocessorerror = () => {
        engineFailed = true
        status.textContent = 'Le processeur audio s’est arrêté sur une erreur.'
      }
      pendingNode.connect(rackFor(pendingContext).input)
      await audioStart
      context = pendingContext
      pendingContext = undefined
      voiceNode = pendingNode
    } else {
      await context?.resume()
    }

    playing = !playing
    voiceNode.port.postMessage({ type: playing ? 'active' : 'stop' })
    setPlayLabel(playing ? 'Arrêter la voix' : 'Lire la phrase')
    if (playing) meter.wake()
    status.textContent = engineFailed
      ? 'Le moteur WASM a échoué ; recharge la page après correction.'
      : !engineReady
        ? 'Audio activé, attente du moteur WASM…'
        : playing
          ? 'Phrase en lecture.'
          : 'Moteur vocal prêt.'
  } catch (error) {
    await pendingContext?.close()
    status.textContent = `Impossible de démarrer le moteur vocal : ${String(error)}`
  } finally {
    if (startingEngine) {
      initializing = false
      playButton.disabled = false
      if (!voiceNode) setPlayLabel('Réessayer')
    }
  }
})

exportButton.addEventListener('click', async () => {
  exportButton.disabled = true
  try {
    if (currentEngine() !== 'waxvocoder') {
      const { samples, sampleRate } = await otherEngineSpeech()
      const channels = await withEffects(samples, sampleRate)
      const url = URL.createObjectURL(new Blob([encodeWav(channels, sampleRate)], { type: 'audio/wav' }))
      const link = Object.assign(document.createElement('a'), { href: url, download: `wax-vocoder-${currentEngine()}.wav` })
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      status.textContent = `WAV exporté (${ENGINES[currentEngine()].label}, ${(channels[0].length / sampleRate).toFixed(2)} s, ${sampleRate} Hz, ${channels.length > 1 ? 'stéréo' : 'mono'}).`
      return
    }
    await initWasm({ module_or_path: await compileWasm() })
    const sampleRate = 44_100
    const engine = new VoiceEngine(sampleRate)
    try {
      applySettings(engine, currentSettings())
      engine.set_language(currentLanguage())
      engine.set_phonemes(enginePhonemes())
      if (engine.phone_count() === 0) {
        status.textContent = 'Rien à exporter : aucun phonème reconnu.'
        return
      }
      engine.set_active(true)
      const samples = new Float32Array(Math.ceil(engine.duration_seconds() * sampleRate))
      engine.render(samples)
      const channels = await withEffects(samples, sampleRate)
      const url = URL.createObjectURL(new Blob([encodeWav(channels, sampleRate)], { type: 'audio/wav' }))
      const link = Object.assign(document.createElement('a'), { href: url, download: 'wax-vocoder.wav' })
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      status.textContent = `WAV exporté (${(channels[0].length / sampleRate).toFixed(2)} s, ${sampleRate} Hz, ${channels.length > 1 ? 'stéréo' : 'mono'}).`
    } finally {
      engine.free()
    }
  } catch (error) {
    status.textContent = `Export impossible : ${String(error)}`
  } finally {
    exportButton.disabled = false
  }
})
