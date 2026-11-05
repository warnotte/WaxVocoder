// « Allée froide » : quatrième chanson originale de WaxVocoder, une chanson triste.
// Le dernier technicien de nuit d'un centre de données entièrement automatisé (Pierre)
// marche une dernière fois dans l'allée froide, le couloir glacé entre les baies de
// serveurs ; on l'a remercié par un message automatique. La voix du bâtiment (Jessica)
// fait ses annonces, calme, comme dans une gare ; au pont, l'annonce passe en anglais,
// français et allemand (Joe, Jessica, Thorsten). Boîte à rythmes douce de 1980, basse
// pulsée, nappes dans le chorus, motif mélancolique, arpège qui clignote, souffle des
// ventilateurs. 100 BPM, mi mineur. Paroles, mélodies, motif et accords entièrement
// originaux (seule l'atmosphère rappelle la new wave de 1980).
//
// Usage : npm run build:wasm && node scripts/allee-froide.ts [dossier-de-sortie] [--backing fichier.wav]
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { decodeWav, encodeWav } from '../src/audio/wav.ts'
import EspeakInitializer from '@echogarden/espeak-ng-emscripten'
import { PIPER_VOICES, resample, robotize } from '../src/engines/index.ts'
import { type PiperConfig, piperPhonemes, PiperVoice } from '../src/engines/piper.ts'
import { parseDictionary } from '../src/dictionary.ts'
import { loadEspeak } from '../src/espeak.ts'
import type { Language } from '../src/ipa.ts'
import { isVowelSymbol, stripDurations, transcribe } from '../src/phonemes.ts'
import { applySettings, DEFAULT_SETTINGS, noteFrequency, PRESETS, type VoiceSettings } from '../src/voice-settings.ts'

const SR = 44_100
const BPM = 100
const BEAT = 60 / BPM
const BAR = 4 * BEAT
const cliArguments = process.argv.slice(2)
/**
 * `--backing fichier.wav` : un accompagnement rendu ailleurs (par exemple par l'émulateur EMX-1), aligné sur la mesure 1.
 * Si `fichier-batterie.wav` et `fichier-synthes.wav` sont à côté, la batterie et les synthés sont mixés séparément :
 * la batterie garde son attaque sous les voix, seuls les synthés s'effacent.
 */
const backingIndex = cliArguments.indexOf('--backing')
const backingPath = backingIndex >= 0 ? cliArguments[backingIndex + 1] : undefined
const outputDirectory = cliArguments.find((argument, index) => !argument.startsWith('--') && (backingIndex < 0 || index !== backingIndex + 1)) ?? 'ecoute/allee-froide'

// ─── Harmonie et forme ────────────────────────────────────────────────────

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const hz = (name: string) => noteFrequency(name) ?? 110

function transpose(melody: string, semitones: number): string {
  return melody.split(' ').map((note) => {
    const [, name, octave] = /^([A-G]#?)(\d)$/.exec(note)!
    const index = NAMES.indexOf(name) + semitones + 12 * Number(octave)
    return `${NAMES[((index % 12) + 12) % 12]}${Math.floor(index / 12)}`
  }).join(' ')
}

function chord(name: string) {
  const minor = name.endsWith('m')
  const index = NAMES.indexOf(minor ? name.slice(0, -1) : name)
  const note = (offset: number, octave: number) =>
    hz(`${NAMES[(index + offset) % 12]}${octave + Math.floor((index + offset) / 12)}`)
  return { bass: note(0, 1), tones: [note(0, 3), note(minor ? 3 : 4, 3), note(7, 3)] }
}

type Section = 'intro' | 'verse' | 'annonce' | 'chorus' | 'bridge' | 'final' | 'outro'
// Mi mineur, du début à la fin.
const VERSE = ['Em', 'Em', 'C', 'C', 'Am', 'Am', 'B', 'B']
const ANNONCE = ['Em', 'C', 'Am', 'B']
const CHORUS = ['C', 'D', 'Em', 'Em', 'C', 'D', 'B', 'B']
const FORM: Array<[Section, string[]]> = [
  ['intro', ['Em', 'Em', 'C', 'C', 'Em', 'Em', 'C', 'B']],
  ['verse', VERSE],
  ['annonce', ANNONCE],
  ['chorus', CHORUS],
  ['verse', VERSE],
  ['annonce', ANNONCE],
  ['chorus', CHORUS],
  ['bridge', ['Am', 'Am', 'Em', 'Em', 'Am', 'Am', 'B', 'B']],
  ['final', CHORUS],
  ['outro', ['Em', 'C', 'Am', 'B', 'Em', 'Em']],
]
const BAR_MAP = FORM.flatMap(([section, chords]) => chords.map((name) => ({ section, chord: chord(name) })))
const BARS = BAR_MAP.length
// The fans keep blowing a little after the last chord.
const TOTAL = Math.ceil((BARS * BAR + 5) * SR)
const isChorus = (section: Section) => section === 'chorus' || section === 'final'
/** Rang d'une mesure dans sa partie (0 pour la première). */
const barInSection = (bar: number) => {
  let first = bar
  while (first > 0 && BAR_MAP[first - 1].section === BAR_MAP[bar].section) first -= 1
  return bar - first
}

// ─── Voix et paroles ──────────────────────────────────────────────────────

const CHORUS_VOICE: VoiceSettings = { ...DEFAULT_SETTINGS, quantize: true, tempo: BPM / 2, vocoder: 0.55, chord: 4, glide: 0.03, presence: 0.8 }
const ROBOT_VOICE: VoiceSettings = { ...DEFAULT_SETTINGS, intonation: 0, quantize: true, tempo: BPM, vocoder: 0.6, chord: 5, presence: 0.9 }
const TOY_VOICE: VoiceSettings = { ...PRESETS.speakSpell.settings, intonation: 0.3, presence: 0.6 }
const robot = (note: string): VoiceSettings => ({ ...ROBOT_VOICE, frequency: hz(note) })

/** A verse sung by a Piper voice through the vocoder: one note of `melody` per syllable. */
type PiperPart = {
  voice: string
  melody: string
  mix: number
  /** Carrier chord of the vocoder (see the engine's CHORDS): 5 adds an octave below. */
  chord?: number
  /** Seconds the sung note slides from one syllable to the next. */
  glide?: number
  /** Vibrato (semitones) arriving on the held part of each note. */
  vibrato?: number
  /** Times Piper's own intonation and rhythm variation: above 1 more expressive. */
  expression?: number
  /** Longest stretch of the line to fill its two bars (slower is more sung). */
  stretch?: number
}

/**
 * `segments` : une ou plusieurs langues dans la même ligne. `legato` : sans pause de ponctuation.
 * `piper` : la ligne est dite par une voix Piper, passée dans le vocoder.
 */
type Line = {
  bar: number
  segments: Array<[Language, string]>
  voice: VoiceSettings
  melody?: string
  gain?: number
  legato?: boolean
  double?: boolean
  clear?: boolean
  piper?: PiperPart
  /** Place dans la stéréo, de -1 (gauche) à 1 (droite). */
  pan?: number
  /** Voix d'appoint (le chœur des voix Piper) : absente des paroles affichées. */
  hidden?: boolean
}

const sung = (bar: number, language: Language, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.5 }, gain: 1.1 })

/** Pont : la voix presque nue, juste une ombre de vocoder. */
const said = (bar: number, language: Language, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.25 }, gain: 1.05 })

const PIERRE = 'fr_FR-upmc-medium:pierre'
const JESSICA = 'fr_FR-upmc-medium:jessica'
const JOE = 'en_US-joe-medium'
const THORSTEN = 'de_DE-thorsten-medium'
/** La voix du bâtiment : Jessica, sur une seule note, calme, comme une annonce en gare. */
const announce = (bar: number, language: Language, text: string, voice = JESSICA): Line => {
  const line = said(bar, language, text, voice, 'E3 E3 E3 E3 E3 E3')
  return { ...line, pan: -0.1, piper: { ...line.piper!, expression: 1.15 } }
}
/** Pierre sings rather than says: more vocoder on the notes, notes that slide, a vibrato, a freer voice, slower. */
const sings = (bar: number, text: string, melody: string, low = false): Line => {
  const line = sung(bar, 'fr', text, PIERRE, melody)
  return { ...line, pan: 0.1, piper: { ...line.piper!, mix: 0.62, glide: 0.08, vibrato: 0.3, expression: 1.3, stretch: 1.42, chord: low ? 5 : 0 } }
}
/** Le refrain, chanté par Pierre, doublé comme en studio (paroles et mélodie originales). */
const chorus = (start: number): Line[] => [
  { ...sings(start, 'Allée froide, lumière bleue,', 'G3 G3 E4 D4 C4 B3 A3', true), double: true },
  { ...sings(start + 2, 'je suis le dernier à veiller.', 'B3 B3 B3 A3 G3 G3 E3 E3', true), double: true },
  { ...sings(start + 4, 'Allée froide, rien ne bouge,', 'G3 G3 E4 D4 C4 B3 A3', true), double: true },
  { ...sings(start + 6, 'le monde tourne sans moi.', 'A3 A3 B3 F#3 D#3 E3', true), double: true },
]

const LYRICS: Line[] = [
  announce(2, 'fr', 'Allée froide, rangée douze. Il est quatre heures.'),
  // Couplet 1 : il marche entre les machines.
  sings(8, 'Je marche seul entre les baies qui clignotent,', 'E3 E3 G3 B3 B3 A3 G3 F#3'),
  sings(10, 'mes pas résonnent sur le sol perforé,', 'G3 G3 E3 G3 C4 B3 A3 G3'),
  sings(12, 'personne ne m’attend au bout du couloir,', 'A3 A3 C4 B3 A3 G3 F#3 E3'),
  sings(14, 'les machines savent déjà ce que j’allais faire.', 'F#3 F#3 A3 B3 A3 G3 F#3 D#3'),
  announce(16, 'fr', 'Température stable. Aucune intervention requise.'),
  ...chorus(20),
  // Couplet 2 : vingt ans de nuits, et un message automatique.
  sings(28, 'J’ai changé des disques pendant vingt ans,', 'E3 E3 G3 B3 B3 A3 G3 F#3'),
  sings(30, 'je connaissais chaque bruit, chaque ventilateur,', 'G3 G3 E3 G3 C4 B3 A3 G3'),
  sings(32, 'ce soir mon badge n’ouvrira plus la porte,', 'A3 A3 C4 B3 A3 G3 F#3 E3'),
  sings(34, 'on m’a remercié par un message automatique.', 'F#3 F#3 A3 B3 A3 G3 F#3 D#3'),
  announce(36, 'fr', 'Badge désactivé. Merci pour votre travail.'),
  ...chorus(40),
  // Pont : l'annonce dans trois langues, le français au milieu ; puis la voix du bâtiment raconte.
  announce(48, 'en', 'Cold aisle, row twelve. No one on duty.', JOE),
  announce(50, 'fr', 'Allée froide, rangée douze. Personne en service.'),
  announce(52, 'de', 'Kalter Gang, Reihe zwölf. Niemand im Dienst.', THORSTEN),
  announce(54, 'fr', 'Il pose la main sur une machine tiède.'),
  ...chorus(56),
  // Fin : il dit bonsoir aux machines, le bâtiment passe en mode nuit.
  sings(64, 'Bonne nuit, les machines.', 'B3 A3 G3 F#3 E3 E3'),
  announce(66, 'fr', 'Lumières en mode nuit.'),
]

// ─── Synthèse ─────────────────────────────────────────────────────────────

let noiseState = 0x1234_5678
function noise(): number {
  noiseState ^= noiseState << 13
  noiseState ^= noiseState >>> 17
  noiseState ^= noiseState << 5
  return (noiseState >>> 0) / 0xffff_ffff * 2 - 1
}

const drive = (value: number, amount: number) => Math.tanh(value * amount) / Math.tanh(amount)

function blep(phase: number, step: number): number {
  if (phase < step) { const t = phase / step; return t + t - t * t - 1 }
  if (phase > 1 - step) { const t = (phase - 1) / step; return t * t + t + t + 1 }
  return 0
}

/** Filtre à variables d'état (passe-bas, passe-haut ou passe-bande), toujours stable. */
class Filter {
  private low = 0
  private band = 0
  process(input: number, cutoff: number, resonance: number, mode: 'low' | 'high' | 'band'): number {
    const damping = 2 - 1.9 * resonance
    const limit = -damping + Math.sqrt(damping * damping + 3.6)
    const f = Math.min(2 * Math.sin(Math.PI * Math.min(cutoff, SR / 4) / SR), limit)
    const high = input - this.low - damping * this.band
    this.band += f * high
    this.low += f * this.band
    return mode === 'low' ? this.low : mode === 'high' ? high : this.band
  }
}

class Track {
  readonly left = new Float32Array(TOTAL)
  readonly right = new Float32Array(TOTAL)
  add(samples: ArrayLike<number>, at: number, gain = 1, pan = 0): void {
    const start = Math.round(at * SR)
    const left = gain * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2
    const right = gain * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2
    for (let index = Math.max(0, -start); index < samples.length && start + index < TOTAL; index += 1) {
      this.left[start + index] += samples[index] * left
      this.right[start + index] += samples[index] * right
    }
  }
  channels(): Float32Array[] {
    return [this.left, this.right]
  }
}

const seconds = (duration: number) => new Float32Array(Math.ceil(duration * SR))

/** Grosse caisse de boîte à rythmes analogique : courte, sans grondement. */
function kick(): Float32Array {
  const out = seconds(0.3)
  let phase = 0
  out.forEach((_, index) => {
    const time = index / SR
    phase += (52 + 120 * Math.exp(-time / 0.012)) / SR
    out[index] = drive(Math.sin(2 * Math.PI * phase) * Math.exp(-time / 0.11), 1.4)
  })
  return out
}

/** Caisse claire « bruit » : une rafale filtrée et un ton bref. */
function snare(): Float32Array {
  const out = seconds(0.25)
  const band = new Filter()
  out.forEach((_, index) => {
    const time = index / SR
    const hiss = band.process(noise(), 2_200, 0.35, 'band') * Math.exp(-time / 0.05) * 1.6
    const tone = Math.sin(2 * Math.PI * 225 * time) * Math.exp(-time / 0.03) * 0.5
    out[index] = drive(hiss + tone, 1.3)
  })
  return out
}

/** Clap : trois rafales rapprochées puis une queue. */
function clap(): Float32Array {
  const out = seconds(0.3)
  const band = new Filter()
  out.forEach((_, index) => {
    const time = index / SR
    const bursts = [0, 0.009, 0.018].reduce((sum, onset) => sum + (time >= onset ? Math.exp(-(time - onset) / (onset < 0.018 ? 0.004 : 0.09)) : 0), 0)
    out[index] = band.process(noise() * bursts, 1_100, 0.45, 'band') * 1.4
  })
  return out
}

/** Charleston métallique : six oscillateurs carrés inharmoniques, filtrés vers le haut. */
function hat(length: number): Float32Array {
  const out = seconds(length * 4)
  const filter = new Filter()
  const ratios = [263, 400, 421, 474, 587, 845]
  const phases = ratios.map(() => 0)
  out.forEach((_, index) => {
    let sum = 0
    ratios.forEach((frequency, voice) => {
      phases[voice] = (phases[voice] + frequency * 1.9 / SR) % 1
      sum += phases[voice] < 0.5 ? 1 : -1
    })
    out[index] = filter.process(sum / ratios.length, 7_500, 0.3, 'high') * Math.exp(-index / SR / length) * 0.7
  })
  return out
}

/** Tom électronique : un sinus qui descend. */
function tom(frequency: number): Float32Array {
  const out = seconds(0.35)
  let phase = 0
  out.forEach((_, index) => {
    const time = index / SR
    phase += frequency * (1 + 0.6 * Math.exp(-time / 0.05)) / SR
    out[index] = Math.sin(2 * Math.PI * phase) * Math.exp(-time / 0.16) * 0.9
  })
  return out
}

function crash(): Float32Array {
  const out = seconds(2.5)
  const filter = new Filter()
  out.forEach((_, index) => {
    out[index] = filter.process(noise(), 4_500, 0.15, 'high') * Math.exp(-index / SR / 0.7) * 0.5
  })
  return out
}

function riser(length: number): Float32Array {
  const out = seconds(length)
  const filter = new Filter()
  out.forEach((_, index) => {
    const progress = index / out.length
    out[index] = filter.process(noise(), 400 + 7_600 * progress ** 2, 0.5, 'band') * progress ** 2 * 0.6
  })
  return out
}

/** Basse séquencée : impulsion étroite, courte, filtre qui se referme vite. */
function bassNote(frequency: number, length: number): Float32Array {
  const out = seconds(length + 0.05)
  const filter = new Filter()
  let phase = 0
  out.forEach((_, index) => {
    const time = index / SR
    const step = frequency / SR
    phase = (phase + step) % 1
    const pulse = (phase < 0.3 ? 1 : -1) + blep(phase, step) - blep((phase + 0.7) % 1, step)
    const gate = time < length ? 1 : Math.exp(-(time - length) / 0.01)
    out[index] = drive(filter.process(pulse, 220 + 1_400 * Math.exp(-time / 0.05), 0.35, 'low'), 1.6) * gate
  })
  return out
}

/** Cloche : sinus modulé en fréquence (rapport 3,5), pour les contretemps du refrain. */
function bell(frequency: number): Float32Array {
  const out = seconds(0.9)
  out.forEach((_, index) => {
    const time = index / SR
    const modulator = Math.sin(2 * Math.PI * frequency * 3.5 * time) * 2.2 * Math.exp(-time / 0.25)
    out[index] = Math.sin(2 * Math.PI * frequency * time + modulator) * Math.exp(-time / 0.45) * 0.6
  })
  return out
}

/** Nappe façon machine à cordes : attaque lente, chœur de scies légèrement désaccordées. */
function padChord(tones: number[], length: number): Float32Array {
  const out = seconds(length + 0.8)
  const filter = new Filter()
  const voices = tones.flatMap((tone, index) => [-0.006, 0, 0.006].map((detune) => ({
    step: tone * (1 + detune) / SR, phase: (index * 0.37 + detune * 70 + 0.5) % 1,
  })))
  out.forEach((_, index) => {
    const time = index / SR
    let sum = 0
    for (const voice of voices) {
      voice.phase = (voice.phase + voice.step) % 1
      sum += 2 * voice.phase - 1 - blep(voice.phase, voice.step)
    }
    const envelope = Math.min(1, time / 0.6) * (time < length ? 1 : Math.exp(-(time - length) / 0.4))
    out[index] = filter.process(sum / voices.length, 1_300, 0.1, 'low') * envelope
  })
  return out
}

// ─── Accompagnement ───────────────────────────────────────────────────────

/** Accompagnement intégré, sans l'EMX-1 : nappes, basse en croches, grosse caisse et caisse claire. */
function arrange(): { drums: Track; music: Track; kicks: number[] } {
  const drums = new Track()
  const music = new Track()
  const kicks: number[] = []
  const [kickSound, snareSound, closedHat] = [kick(), snare(), hat(0.02)]
  for (let bar = 0; bar < BARS; bar += 1) {
    const { section, chord: current } = BAR_MAP[bar]
    const start = bar * BAR
    music.add(padChord(current.tones, BAR), start, 0.08, -0.4)
    music.add(padChord(current.tones.map((tone) => tone * 1.003), BAR), start, 0.08, 0.4)
    if (section === 'intro' && bar < 6) continue
    if (section === 'outro' && bar >= BARS - 4) continue
    for (let eighth = 0; eighth < 8; eighth += 1) {
      const time = start + eighth * BEAT / 2
      music.add(bassNote(current.bass, BEAT / 2 * 0.7), time, 0.28)
      drums.add(closedHat, time, 0.12, 0.3)
      if (eighth % 4 === 0) { drums.add(kickSound, time, 0.8); kicks.push(time) }
      if (eighth % 4 === 2) drums.add(snareSound, time, 0.45)
    }
  }
  return { drums, music, kicks }
}

// ─── Voix ─────────────────────────────────────────────────────────────────

type Render = { samples: Float32Array; pickup: number; phonemes: string }

function render(phonemes: string, voice: VoiceSettings, melody: string, language: Language, shift = 1): Render {
  const make = (text: string) => {
    const engine = new VoiceEngine(SR)
    applySettings(engine, { ...voice, melody, formantShift: voice.formantShift * shift })
    engine.set_language(language)
    engine.set_phonemes(text)
    return engine
  }
  const engine = make(phonemes)
  engine.set_active(true)
  const samples = new Float32Array(Math.ceil(engine.duration_seconds() * SR))
  engine.render(samples)
  engine.free()
  // Consonnes avant la première voyelle : la voyelle doit tomber sur le temps.
  const tokens = phonemes.split(/\s+/)
  const symbolOf = (token: string) => token.replace(/:\d+$/, '').replace(/\d$/, '')
  const firstVowel = tokens.findIndex((token) => isVowelSymbol(symbolOf(token)))
  const lead = tokens.slice(0, Math.max(0, firstVowel)).filter((token) => /^[A-Z]+(:\d+)?$/.test(token))
  let pickup = 0
  if (lead.length > 0) {
    const probe = make(lead.join(' '))
    pickup = Math.max(0, probe.duration_seconds() - 0.06)
    probe.free()
  }
  return { samples, pickup, phonemes }
}

/** Chronologie exportée pour l'affichage des parties et des paroles. */
/** `voice` : qui chante la ligne (une voix Piper, le chœur, le robot), pour un clip ou des sous-titres. */
type TimelineLine = { start: number; end: number; section: Section; style: string; voice: string; segments: Array<[Language, string]> }
const timeline: TimelineLine[] = []

function styleOf(line: Line): string {
  if (line.voice === TOY_VOICE) return 'jouet'
  if (line.clear) return 'parlé'
  if (line.melody) return 'chanté'
  return 'robot'
}

async function sing(): Promise<{ effects: Track; clear: Track }> {
  const root = new URL('../', import.meta.url)
  await initialize({ module_or_path: await WebAssembly.compile(await readFile(new URL('src/wasm/voice-engine/voice_engine_bg.wasm', root))) })
  const lexicon = parseDictionary(await readFile(new URL('src/data/cmudict.txt', root), 'utf8'))
  const espeak = await loadEspeak()
  const worker = new (await EspeakInitializer()).eSpeakNGWorker()
  const ort = await import('onnxruntime-web')
  const piperVoices = new Map<string, PiperVoice>()
  const effects = new Track()
  const clear = new Track()
  for (const line of LYRICS) {
    const vocals = line.clear ? clear : effects
    if (line.piper) {
      const info = PIPER_VOICES.find((voice) => voice.key === line.piper!.voice)!
      let piper = piperVoices.get(info.id)
      if (!piper) {
        const folder = new URL(`voices/${info.id}/`, root)
        const config = JSON.parse(await readFile(new URL(`${info.id}.onnx.json`, folder), 'utf8')) as PiperConfig
        piper = await PiperVoice.load(ort, await readFile(new URL(`${info.id}.onnx`, folder)), config)
        piperVoices.set(info.id, piper)
      }
      const text = line.segments.map(([, words]) => words).join(' ')
      const ipa = piperPhonemes(worker, piper.config.espeak.voice, text)
      // Fit the line to its two bars: say it again faster or slower if needed.
      const room = 2 * BAR * 0.9
      const part = line.piper
      const expression = { noiseScale: part.expression ?? 1, noiseW: 1 + ((part.expression ?? 1) - 1) / 2 }
      let samples = await piper.speak(ipa, { speaker: info.speaker, ...expression })
      const ratio = room / (samples.length / piper.sampleRate)
      if (ratio < 0.97 || ratio > 1.15) samples = await piper.speak(ipa, { speaker: info.speaker, ...expression, lengthScale: Math.min(part.stretch ?? 1.3, Math.max(0.72, ratio)) })
      const melody = line.piper.melody.split(' ').map((note) => hz(note))
      const robotic = robotize({ samples, sampleRate: piper.sampleRate }, { mix: part.mix, frequency: melody[0], chord: part.chord ?? 0, melody, glide: part.glide, carrierVibrato: part.vibrato })
      let take = resample(robotic, piper.sampleRate, SR)
      // Leading silence out: the line starts on the bar.
      const threshold = 0.02 * take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      take = take.subarray(Math.max(0, take.findIndex((sample) => Math.abs(sample) > threshold) - Math.round(0.02 * SR)))
      const peak = take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      const level = (line.gain ?? 1) / Math.max(peak, 1e-3) * 0.6
      vocals.add(take, line.bar * BAR, level, line.pan ?? 0)
      // Doubled like in the studio: the same take, 18 ms later and a hair lower, on the other side.
      if (line.double) vocals.add(resample(take, SR * 1.004, SR), line.bar * BAR + 0.018, level * 0.6, -(line.pan ?? 0) || 0.3)
      const length = take.length / SR
      const fits = length <= 2 * BAR ? '' : ` · DÉBORDE (${length.toFixed(2)} s pour ${(2 * BAR).toFixed(2)} s)`
      if (!line.hidden) timeline.push({ start: line.bar * BAR, end: line.bar * BAR + length, section: BAR_MAP[line.bar].section, style: 'vocodé', voice: info.label, segments: line.segments })
      console.log(`mesure ${String(line.bar + 1).padStart(2)} · ${`${line.segments[0][0]}:${text} (${info.label})`.padEnd(58)} ${length.toFixed(2)} s${fits}`)
      continue
    }
    const phonemes = line.segments.map(([language, text]) => {
      const clean = line.legato ? text.replace(/[,;:.!?]/g, '') : text
      if (language === 'en') return transcribe(clean, lexicon)
      // Parlé : le rythme d'eSpeak NG (durée de chaque phonème) ; chanté : la grille du tempo.
      return line.clear ? espeak.transcribeTimed(clean, language).timed : espeak.transcribe(clean, language).phonemes
    }).join(' | ')
    const language = line.segments[0][0]
    const take = render(phonemes, line.voice, line.melody ?? '', language)
    const peak = take.samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
    const gain = (line.gain ?? 1) / Math.max(peak, 1e-3) * 0.6
    const start = line.bar * BAR - take.pickup
    vocals.add(take.samples, start, gain, line.pan ?? 0)
    if (line.double) {
      // Doublage : deux prises légèrement différentes, ouvertes en stéréo.
      for (const [shift, delay, pan] of [[1.03, 0.012, -0.65], [0.97, 0.021, 0.65]] as const) {
        const double = render(phonemes, line.voice, line.melody ?? '', language, shift)
        vocals.add(double.samples, start + delay, gain * 0.3, pan)
      }
    }
    const syllables = stripDurations(phonemes).split(/\s+/).filter((token) => isVowelSymbol(token.replace(/\d$/, ''))).length
    const notes = line.melody?.split(' ').length
    const next = LYRICS.map((other) => other.bar).filter((bar) => bar > line.bar).sort((a, b) => a - b)[0] ?? BARS
    const room = (next - line.bar) * BAR
    const length = take.samples.length / SR - take.pickup
    const checks = [
      length <= room ? '' : `DÉBORDE (${length.toFixed(2)} s pour ${room.toFixed(2)} s)`,
      notes === undefined || notes === syllables ? '' : `MÉLODIE ${notes} notes pour ${syllables} syllabes`,
    ].filter(Boolean).join(' ; ')
    timeline.push({ start: line.bar * BAR, end: line.bar * BAR + length, section: BAR_MAP[line.bar].section, style: styleOf(line), voice: line.melody ? 'Chœur' : 'Robot', segments: line.segments })
    const text = line.segments.map(([lang, words]) => `${lang}:${words}`).join(' + ')
    console.log(`mesure ${String(line.bar + 1).padStart(2)} · ${text.padEnd(58)} ${length.toFixed(2)} s${checks ? ` · ${checks}` : ''}`)
  }
  return { effects, clear }
}

// ─── Traitements ──────────────────────────────────────────────────────────

/** Coupe-bas, compression et saturation légère de la voix. */
function voiceChain(track: Track): void {
  const attack = 1 - Math.exp(-1 / (0.003 * SR))
  const release = 1 - Math.exp(-1 / (0.08 * SR))
  for (const channel of track.channels()) {
    let previousIn = 0
    let previousOut = 0
    let envelope = 0
    const coefficient = Math.exp(-2 * Math.PI * 110 / SR)
    channel.forEach((sample, index) => {
      const high = coefficient * (previousOut + sample - previousIn)
      previousIn = sample
      previousOut = high
      const level = Math.abs(high)
      envelope += (level - envelope) * (level > envelope ? attack : release)
      const threshold = 0.12
      const gain = envelope > threshold ? (threshold / envelope) ** 0.75 : 1
      channel[index] = drive(high * gain * 2.2, 1.3) * 0.55
    })
  }
}

/** Voix claire : coupe-bas et compression douce, sans saturation. */
function clearChain(track: Track): void {
  const attack = 1 - Math.exp(-1 / (0.005 * SR))
  const release = 1 - Math.exp(-1 / (0.12 * SR))
  for (const channel of track.channels()) {
    let previousIn = 0
    let previousOut = 0
    let envelope = 0
    const coefficient = Math.exp(-2 * Math.PI * 90 / SR)
    channel.forEach((sample, index) => {
      const high = coefficient * (previousOut + sample - previousIn)
      previousIn = sample
      previousOut = high
      const level = Math.abs(high)
      envelope += (level - envelope) * (level > envelope ? attack : release)
      const gain = envelope > 0.15 ? (0.15 / envelope) ** 0.6 : 1
      channel[index] = high * gain * 1.6
    })
  }
}

/**
 * Chorus stéréo des années 80 : chaque côté passe par une ligne à retard d'environ 12 ms,
 * modulée de ± 3 ms (0,6 Hz à gauche, 0,8 Hz à droite), mêlée au son direct.
 */
function chorusEffect(track: Track, mix: number): void {
  const base = 0.012 * SR
  const depth = 0.003 * SR
  for (const [channel, rate, phase] of [[track.left, 0.6, 0], [track.right, 0.8, Math.PI / 2]] as const) {
    const input = Float32Array.from(channel)
    for (let index = 0; index < TOTAL; index += 1) {
      const position = index - (base + depth * Math.sin(2 * Math.PI * rate * index / SR + phase))
      const whole = Math.floor(position)
      const fraction = position - whole
      const a = whole >= 0 ? input[whole] : 0
      const b = whole + 1 >= 0 ? input[whole + 1] ?? 0 : 0
      channel[index] = input[index] * (1 - 0.5 * mix) + (a + (b - a) * fraction) * mix
    }
  }
}

/**
 * Le souffle de la salle des serveurs : ventilateurs (bruit grave filtré), un léger sifflement,
 * et le ronflement du courant. Plus présent au début et à la fin, quand la musique se tait.
 */
function serverRoom(): Track {
  const room = new Track()
  const [lowLeft, lowRight, hissLeft, hissRight] = [new Filter(), new Filter(), new Filter(), new Filter()]
  const start = BAR_MAP.findIndex((entry) => entry.section === 'verse') * BAR
  const end = BAR_MAP.findIndex((entry) => entry.section === 'outro') * BAR + 2 * BAR
  for (let index = 0; index < TOTAL; index += 1) {
    const time = index / SR
    const alone = time < start ? 1 : time > end ? 1 : 0.35
    const fade = Math.min(1, time / 3) * Math.min(1, (TOTAL / SR - time) / 2)
    const hum = 0.012 * Math.sin(2 * Math.PI * 100 * time) + 0.006 * Math.sin(2 * Math.PI * 200 * time)
    const left = lowLeft.process(noise(), 380, 0.2, 'low') * 0.5 + hissLeft.process(noise(), 5200, 0.1, 'band') * 0.05 + hum
    const right = lowRight.process(noise(), 360, 0.2, 'low') * 0.5 + hissRight.process(noise(), 5600, 0.1, 'band') * 0.05 + hum
    room.left[index] = left * 0.18 * alone * fade
    room.right[index] = right * 0.18 * alone * fade
  }
  return room
}

/**
 * Réverbération de cathédrale : algorithme de type Freeverb (huit filtres en peigne amortis en
 * parallèle, quatre passe-tout en série), en stéréo, avec un pré-délai pour garder les mots nets.
 * Environ 5 à 6 secondes de queue.
 */
function cathedral(track: Track, wet: number, size = 0.84, damping = 0.35, preDelay = 0.045): void {
  const scale = SR / 44_100
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((length) => Math.round(length * scale * 1.5))
  const allpasses = [556, 441, 341, 225].map((length) => Math.round(length * scale))
  const feedback = 0.7 + 0.28 * size
  const delay = Math.round(preDelay * SR)
  const input = new Float32Array(TOTAL)
  for (let index = delay; index < TOTAL; index += 1) input[index] = (track.left[index - delay] + track.right[index - delay]) * 0.5 * 0.015
  const [left, right] = [0, 23].map((spread) => {
    const out = new Float32Array(TOTAL)
    for (const base of combs) {
      const buffer = new Float32Array(base + spread)
      let position = 0
      let store = 0
      for (let index = 0; index < TOTAL; index += 1) {
        const output = buffer[position]
        store = output * (1 - damping) + store * damping
        buffer[position] = input[index] + store * feedback
        out[index] += output
        position = position + 1 === buffer.length ? 0 : position + 1
      }
    }
    for (const base of allpasses) {
      const buffer = new Float32Array(base + spread)
      let position = 0
      for (let index = 0; index < TOTAL; index += 1) {
        const delayed = buffer[position]
        const value = out[index]
        out[index] = delayed - value
        buffer[position] = value + delayed * 0.5
        position = position + 1 === buffer.length ? 0 : position + 1
      }
    }
    return out
  })
  for (let index = 0; index < TOTAL; index += 1) {
    track.left[index] += left[index] * wet * 3
    track.right[index] += right[index] * wet * 3
  }
}

/** Écho ping-pong à la croche pointée. */
function echo(track: Track, mix: number): void {
  const delay = Math.round(BEAT * 0.75 * SR)
  for (let index = delay; index < TOTAL; index += 1) {
    track.left[index] += track.right[index - delay] * mix
    track.right[index] += track.left[index - delay] * mix
  }
}

function envelopeOf(track: Track, attackSeconds: number, releaseSeconds: number): Float32Array {
  const attack = 1 - Math.exp(-1 / (attackSeconds * SR))
  const release = 1 - Math.exp(-1 / (releaseSeconds * SR))
  const out = new Float32Array(TOTAL)
  let envelope = 0
  for (let index = 0; index < TOTAL; index += 1) {
    const level = Math.max(Math.abs(track.left[index]), Math.abs(track.right[index]))
    envelope += (level - envelope) * (level > envelope ? attack : release)
    out[index] = envelope
  }
  return out
}

/**
 * Creuse la musique sous la voix : les médiums et aigus (au-dessus de 900 Hz,
 * là où se jouent les consonnes) baissent davantage que les graves.
 */
function carve(track: Track, voice: Float32Array, highDepth: number, lowDepth: number): void {
  for (const channel of track.channels()) {
    const filter = new Filter()
    channel.forEach((sample, index) => {
      const high = filter.process(sample, 900, 0.1, 'high')
      const low = sample - high
      const amount = Math.min(1, voice[index] / 0.12)
      channel[index] = low * (1 - lowDepth * amount) + high * (1 - highDepth * amount)
    })
  }
}

/** Pompage : la musique respire au rythme de la grosse caisse. */
function pump(track: Track, kicks: number[], depth: number): void {
  const gain = new Float32Array(TOTAL).fill(1)
  for (const kickTime of kicks) {
    const start = Math.round(kickTime * SR)
    for (let index = 0; index < 0.3 * SR && start + index < TOTAL; index += 1) {
      gain[start + index] = Math.min(gain[start + index], 1 - depth * Math.exp(-index / SR / 0.11))
    }
  }
  for (const channel of track.channels()) channel.forEach((sample, index) => { channel[index] = sample * gain[index] })
}

function sum(parts: Array<[Track, number]>): Track {
  const out = new Track()
  for (const [track, gain] of parts) {
    out.add(track.left, 0, gain, -1)
    out.add(track.right, 0, gain, 1)
  }
  return out
}

/** Saturation douce de bus, crête à −1,5 dBFS (crête réelle sous 0 dBFS). */
function master(track: Track, loudness: number): void {
  const peak = Math.max(...track.channels().map((channel) => channel.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)))
  for (const channel of track.channels()) {
    channel.forEach((sample, index) => { channel[index] = drive(sample / peak, loudness) * 0.84 })
  }
}

// ─── Mixage ───────────────────────────────────────────────────────────────

function backing(path: string): { drums: Track; music: Track; kicks: number[]; stems: boolean } {
  const decode = (file: string) => {
    const bytes = readFileSync(file)
    return decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer)
  }
  // Gauche et droite à leur place : avec la loi de panoramique, ±1 donne √2.
  // The backing is set by its average loudness, not its peak: a denser render (tubes,
  // accents) would otherwise come in louder and bury the voices. Reference: the EMX-1
  // render whose balance was approved by ear (RMS 0.1026 at 2.4 / √2), then 1.6 dB lower
  // because the voices were still found a little buried.
  const full = decode(path).channels
  const loudness = Math.sqrt(full.reduce((sum, channel) => sum + channel.reduce((total, sample) => total + sample * sample, 0), 0) / full.reduce((count, channel) => count + channel.length, 0))
  const level = 2.4 * Math.SQRT1_2 * 0.085 / Math.max(loudness, 1e-4)
  const load = (file: string) => {
    const { sampleRate, channels } = decode(file)
    const track = new Track()
    track.add(resample(channels[0], sampleRate, SR), 0, level, -1)
    track.add(resample(channels[1] ?? channels[0], sampleRate, SR), 0, level, 1)
    return track
  }
  const [drumStem, synthStem] = ['batterie', 'synthes'].map((name) => path.replace(/\.wav$/i, `-${name}.wav`))
  if (existsSync(drumStem) && existsSync(synthStem)) return { drums: load(drumStem), music: load(synthStem), kicks: [], stems: true }
  return { drums: new Track(), music: load(path), kicks: [], stems: false }
}
/** Pour le clip : nom affiché, couleur et côté de chaque voix. */
const CAST = {
  Pierre: { label: 'Pierre, le dernier technicien', color: [170, 205, 235], side: 'left' },
  Jessica: { label: 'La voix du bâtiment', color: [255, 191, 107], side: 'right' },
  Joe: { label: 'Annonce', color: [255, 191, 107], side: 'right' },
  Thorsten: { label: 'Durchsage', color: [255, 191, 107], side: 'right' },
  'Chœur': { label: 'Le chœur des machines', color: [190, 225, 255], side: 'center' },
  Robot: { label: 'La machine', color: [230, 232, 236], side: 'center' },
}
const SUBTITLE = 'Voix WaxVocoder, rythmique EMX-1'
const CREDITS = 'Voix WaxVocoder (Piper : Pierre, Jessica, Joe, Thorsten), rythmique EMX-1, 2026'
/** Level of the machine's drum stem in the mix. */
const DRUMS_FROM_STEMS = 0.65
const { drums, music, kicks, stems } = backingPath ? backing(backingPath) : { ...arrange(), stems: false }
const { effects: vocals, clear: spokenVocals } = await sing()
voiceChain(vocals)
clearChain(spokenVocals)
const dry = sum([[vocals, 1], [spokenVocals, 1]])
// Only a shadow of the cathedral on the voices (a long pre-delay keeps the words clean):
// the space comes from the orchestra. With more, the words were lost.
// A cold, medium room on the voices, and the 80s chorus that widens them.
chorusEffect(vocals, 0.3)
cathedral(vocals, 0.06, 0.7, 0.4, 0.07)
cathedral(spokenVocals, 0.03, 0.7, 0.4, 0.07)
const voiceLevel = envelopeOf(dry, 0.008, 0.2)
pump(music, kicks, 0.45)
cathedral(music, 0.08, 0.7)
cathedral(drums, 0.06, 0.7)
const room = serverRoom()
// With separate drums, the synths (sustained, they mask the words) make more room.
carve(music, voiceLevel, stems ? 0.75 : backingPath ? 0.45 : 0.85, stems ? 0.32 : backingPath ? 0.15 : 0.3)
// The machine's drums keep their attack: no saturation, only a little room for the
// consonants under the voices; the whole backing is matched in loudness (see backing()).
if (stems) carve(drums, voiceLevel, 0.25, 0)
else carve(drums, voiceLevel, 0.5, 0.1)
// The voice bus comes up after its compressor (raising the lines before it only squeezed them more).
// One voice carries the song (no choir): the voice bus comes up further.
const mix = sum([[drums, stems ? DRUMS_FROM_STEMS : 0.8], [music, 0.75], [room, 1], [vocals, 3.3], [spokenVocals, 3]])
if (process.env.DEMO_STEMS) {
  // Pistes au niveau du mix, avant mastering, pour mesurer le masquage.
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'bus-voix.wav'), new Uint8Array(encodeWav(sum([[vocals, 3.3], [spokenVocals, 3]]).channels(), SR)))
  await writeFile(join(outputDirectory, 'bus-musique.wav'), new Uint8Array(encodeWav(sum([[drums, 0.8], [music, 0.75]]).channels(), SR)))
}
// Less bus saturation with separate drums: the attacks go through instead of being rounded off.
master(mix, stems ? 1.5 : 1.8)
const instrumental = sum([[drums, stems ? DRUMS_FROM_STEMS : 0.8], [music, 0.75]])
master(instrumental, stems ? 1.15 : 1.5)
master(dry, 1.2)
await mkdir(outputDirectory, { recursive: true })
const write = (name: string, track: Track) =>
  writeFile(join(outputDirectory, name), new Uint8Array(encodeWav(track.channels(), SR)))
await write('allee-froide.wav', mix)
await write('allee-froide-voix.wav', dry)
await write('allee-froide-instrumental.wav', instrumental)
const sections: Array<{ section: Section; start: number; end: number }> = []
BAR_MAP.forEach(({ section }, bar) => {
  const last = sections.at(-1)
  if (last && last.section === section) last.end = (bar + 1) * BAR
  else sections.push({ section, start: bar * BAR, end: (bar + 1) * BAR })
})
await writeFile(join(outputDirectory, 'allee-froide.json'), JSON.stringify({ title: 'Allée froide', subtitle: SUBTITLE, credits: CREDITS, cast: CAST, sectionNames: { annonce: 'Annonce', bridge: 'Rangée douze', final: 'Dernier refrain', outro: 'Mode nuit' }, hold: 2.5, bpm: BPM, duration: TOTAL / SR, sections, lines: timeline }, null, 2))
console.log(`→ ${join(outputDirectory, 'allee-froide.wav')} (${(TOTAL / SR).toFixed(1)} s, ${BPM} BPM, ${BARS} mesures)`)
