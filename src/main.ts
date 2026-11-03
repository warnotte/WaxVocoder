import './style.css'
import processorUrl from './audio/voice-processor.ts?worker&url'
import wasmUrl from './wasm/voice-engine/voice_engine_bg.wasm?url'
import dictionaryUrl from './data/cmudict.txt?url'
import espeakDataUrl from '@echogarden/espeak-ng-emscripten/espeak-ng.data?url'
import initWasm, { VoiceEngine } from './wasm/voice-engine/voice_engine.js'
import { encodeWav } from './audio/wav'
import { loadDictionary } from './dictionary'
import { BufferPlayer, synthesize } from './engines/browser'
import { type EngineName, ENGINES, PIPER_VOICES, robotSettings, type Speech } from './engines/index'
import { type EspeakTranscriber, loadEspeak } from './espeak'
import { ESPEAK_LANGUAGES, type Language } from './ipa'
import { type Lexicon, transcribe, unknownPhonemeTokens } from './phonemes'
import { applySettings, CHORDS, DEFAULT_SETTINGS, invalidNotes, PRESETS, type VoiceSettings } from './voice-settings'

const element = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

const playButton = element<HTMLButtonElement>('#play')
const exportButton = element<HTMLButtonElement>('#export')
const languageControl = element<HTMLSelectElement>('#language')
const engineControl = element<HTMLSelectElement>('#engine')
const engineHint = element<HTMLElement>('#engine-hint')
const phraseTitle = element<HTMLElement>('#phrase-title')
const phraseControl = element<HTMLTextAreaElement>('#phrase')
const phonemeControl = element<HTMLTextAreaElement>('#phonemes')
const phonemeHint = element<HTMLElement>('#phoneme-hint')
const presetControl = element<HTMLSelectElement>('#preset')
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

const PHONEME_HELP = 'ARPAbet (CMUdict) et extensions E A O U UE EU OE AX, nasales AN ON IN UN, RX NY UY X CC. 1 / 2 / 0 = accent principal / secondaire / atone ; « | » sépare les mots, « _ » insère une courte pause, « , » « . » « ? » marquent la ponctuation ; « A1:90 » impose une durée en millisecondes.'
const MELODY_HELP = 'Notes anglaises (C3, D#3, Bb2 ; A4 = 440 Hz) ou françaises (do2, ré#2, sib1 ; la3 = 440 Hz), une par voyelle, en boucle. Vide : intonation parlée.'

const SAMPLES: Record<Language, string> = {
  en: 'Hello, I am a talking machine.',
  fr: 'Bonjour, je suis une machine qui parle.',
  'fr-CA': 'Salut, je suis une machine qui jase. Il fait frette à matin.',
  'fr-BE': 'Bonjour, je suis une machine qui parle nonante fois par jour.',
  de: 'Hallo, ich bin eine sprechende Maschine.',
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
engineControl.addEventListener('change', () => {
  player.stop()
  playButton.textContent = playing ? 'Arrêter la voix' : 'Lire la phrase'
  updateEngineHint()
})
for (const [key, preset] of Object.entries(PRESETS)) presetControl.add(new Option(preset.label, key))
presetControl.add(new Option('Personnalisé', 'custom'))
CHORDS.forEach((label, index) => chordControl.add(new Option(label, String(index))))

function currentSettings(): VoiceSettings {
  const settings: VoiceSettings = {
    ...DEFAULT_SETTINGS,
    chord: Number(chordControl.value),
    melody: melodyControl.value.trim(),
    quantize: quantizeControl.checked,
  }
  for (const { name, input } of sliders) settings[name] = Number(input.value)
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
    : PHONEME_HELP
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
const currentEngine = () => engineControl.value as EngineName
const ENGINE_HELP = 'Avec ce moteur, l’étage robot applique le vocoder (hauteur, porteuse, mélodie à une note par syllabe), le lo-fi, la taille et le vibrato ; débit, intonation, tempo, présence et glissando concernent WaxVocoder.'

function updateEngineHint(): void {
  const engine = currentEngine()
  engineHint.hidden = engine === 'waxvocoder'
  const voice = PIPER_VOICES[currentLanguage()]
  engineHint.textContent = engine === 'piper' && !voice
    ? 'Pas encore de voix Piper pour cette langue : choisis le français, ou un autre moteur.'
    : engine === 'piper' ? `${ENGINE_HELP} Voix ${voice?.id}, ${voice?.licence}.` : ENGINE_HELP
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
  return synthesize(engine, phraseControl.value, currentLanguage(), transcriber, robotSettings(settings), (fraction) => { status.textContent = `Téléchargement de la voix Piper : ${Math.round(fraction * 100)} %` })
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
  presetControl.value = 'custom'
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
    sendSetting(name, Number(input.value))
    markCustom()
  })
}
chordControl.addEventListener('change', () => {
  sendSetting('chord', Number(chordControl.value))
  markCustom()
})
melodyControl.addEventListener('input', () => {
  updateMelodyHint()
  sendSetting('melody', melodyControl.value.trim())
  markCustom()
})
quantizeControl.addEventListener('change', () => {
  sendSetting('quantize', quantizeControl.checked)
  markCustom()
})
presetControl.addEventListener('change', () => {
  const preset = PRESETS[presetControl.value]
  if (!preset) return
  showSettings(preset.settings)
  sendAllSettings()
})

showSettings(DEFAULT_SETTINGS)
presetControl.value = 'natural'
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
      playButton.textContent = 'Lire la phrase'
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
        playButton.textContent = 'Lire la phrase'
        status.textContent = 'Phrase terminée.'
      })
      playButton.textContent = 'Arrêter la voix'
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
    playButton.textContent = 'Chargement du moteur…'
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
          playButton.textContent = 'Lire la phrase'
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
      pendingNode.connect(pendingContext.destination)
      await audioStart
      context = pendingContext
      pendingContext = undefined
      voiceNode = pendingNode
    } else {
      await context?.resume()
    }

    playing = !playing
    voiceNode.port.postMessage({ type: playing ? 'active' : 'stop' })
    playButton.textContent = playing ? 'Arrêter la voix' : 'Lire la phrase'
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
      if (!voiceNode) playButton.textContent = 'Réessayer'
    }
  }
})

exportButton.addEventListener('click', async () => {
  exportButton.disabled = true
  try {
    if (currentEngine() !== 'waxvocoder') {
      const { samples, sampleRate } = await otherEngineSpeech()
      const url = URL.createObjectURL(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }))
      const link = Object.assign(document.createElement('a'), { href: url, download: `wax-vocoder-${currentEngine()}.wav` })
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      status.textContent = `WAV exporté (${ENGINES[currentEngine()].label}, ${(samples.length / sampleRate).toFixed(2)} s, ${sampleRate} Hz).`
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
      const url = URL.createObjectURL(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }))
      const link = Object.assign(document.createElement('a'), { href: url, download: 'wax-vocoder.wav' })
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      status.textContent = `WAV exporté (${engine.duration_seconds().toFixed(2)} s, ${sampleRate} Hz).`
    } finally {
      engine.free()
    }
  } catch (error) {
    status.textContent = `Export impossible : ${String(error)}`
  } finally {
    exportButton.disabled = false
  }
})
