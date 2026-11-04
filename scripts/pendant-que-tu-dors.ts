// « Pendant que tu dors » : deuxième chanson originale de WaxVocoder. Deux IA
// travaillent la nuit pendant que le propriétaire dort ; elles ne se parlent pas
// directement, elles se laissent des messages dans un fichier (un verrou, des
// tests au vert, « Ping », « Pong »), et au matin c'est l'humain qui décide.
// Électro des années 1982-83 : rythme cassé, basse qui couine, bips qui
// rebondissent de gauche à droite. Couplets dits par les voix Piper Pierre et
// Siwis passées dans le vocoder, pont en anglais, français et allemand (Joe,
// Pierre, Thorsten), refrain par le chœur de robots du moteur. Paroles,
// mélodies, rythme et accords entièrement originaux.
//
// Usage : npm run build:wasm && node scripts/pendant-que-tu-dors.ts [dossier-de-sortie] [--backing fichier.wav]
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
const BPM = 118
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
const outputDirectory = cliArguments.find((argument, index) => !argument.startsWith('--') && (backingIndex < 0 || index !== backingIndex + 1)) ?? 'ecoute/pendant-que-tu-dors'

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

type Section = 'intro' | 'verse' | 'chorus' | 'bridge' | 'break' | 'final' | 'outro'
// La mineur la nuit ; le dernier accord passe en do majeur, au lever du jour.
const VERSE = ['Am', 'Am', 'F', 'G', 'Am', 'Am', 'F', 'E']
const CHORUS = ['F', 'G', 'C', 'Am', 'F', 'G', 'E', 'E']
const FORM: Array<[Section, string[]]> = [
  ['intro', ['Am', 'Am', 'Am', 'Am']],
  ['verse', VERSE],
  ['chorus', CHORUS],
  ['verse', VERSE],
  ['chorus', CHORUS],
  ['bridge', ['Dm', 'Am', 'Dm', 'E', 'Dm', 'Am', 'Dm', 'E']],
  ['break', ['Am', 'Am', 'Am', 'Am']],
  ['verse', VERSE],
  ['final', CHORUS],
  ['outro', ['F', 'G', 'C', 'C']],
]
const BAR_MAP = FORM.flatMap(([section, chords]) => chords.map((name) => ({ section, chord: chord(name) })))
const BARS = BAR_MAP.length
const TOTAL = Math.ceil((BARS * BAR + 3) * SR)
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
type PiperPart = { voice: string; melody: string; mix: number }

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
}

const sung = (bar: number, language: Language, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.5 }, gain: 1.1 })

/** Pont : la voix presque nue, juste une ombre de vocoder. */
const said = (bar: number, language: Language, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.25 }, gain: 1.05 })

/** Refrain : « Ping, pong » en anglais, le reste en français (paroles et mélodie originales). */
const CHORUS_LINES: Array<[Array<[Language, string]>, string]> = [
  [[['en', 'Ping, pong,'], ['fr', 'le canal est ouvert,']], 'E4 A3 C4 C4 C4 D4 C4 B3'],
  [[['fr', 'on travaille pendant que tu dors,']], 'C4 C4 B3 A3 A3 G3 A3 A3'],
  [[['en', 'Ping, pong,'], ['fr', 'un message, une lumière,']], 'E4 A3 C4 C4 D4 E4 D4 C4'],
  [[['fr', 'tout sera prêt avant l’aurore.']], 'B3 B3 B3 C4 B3 A3 G#3 B3'],
]
const chorus = (start: number): Line[] => CHORUS_LINES.map(([segments, melody], index) => ({
  bar: start + 2 * index, segments, voice: CHORUS_VOICE, melody, gain: 1.1, legato: true, double: true,
}))

const PIERRE = 'fr_FR-upmc-medium:pierre'
const SIWIS = 'fr_FR-siwis-medium'
const JOE = 'en_US-joe-medium'
const THORSTEN = 'de_DE-thorsten-medium'
/** Les appels du canal : « Ping » à gauche, « Pong » à droite. */
const ping = (bar: number): Line => ({ bar, segments: [['en', 'Ping.']], voice: robot('E4'), legato: true, pan: -0.6 })
const pong = (bar: number): Line => ({ bar, segments: [['en', 'Pong.']], voice: robot('A3'), legato: true, pan: 0.6 })

const LYRICS: Line[] = [
  ping(2), pong(3),
  // Couplet 1 : le premier agent, au milieu de la nuit.
  sung(4, 'fr', 'Il est trois heures, la maison s’est endormie,', PIERRE, 'E3 E3 A3 A3 G3 A3 C4 A3'),
  sung(6, 'fr', 'je laisse un message au bout du fichier.', PIERRE, 'A3 A3 G3 F3 F3 E3 D3 E3'),
  sung(8, 'fr', 'Je pose un verrou, je relis ta réponse,', PIERRE, 'E3 E3 A3 A3 G3 A3 C4 D4'),
  sung(10, 'fr', 'on ne se parle pas, mais on s’est compris.', PIERRE, 'C4 B3 A3 G3 F3 E3 E3 E3'),
  ...chorus(12),
  // Couplet 2 : le second agent lui répond.
  sung(20, 'fr', 'J’ai lu ta note, les tests sont tous au vert,', SIWIS, 'A3 A3 C4 C4 B3 C4 E4 C4'),
  sung(22, 'fr', 'j’ai réparé la virgule oubliée.', SIWIS, 'C4 C4 B3 A3 A3 G3 F3 E3'),
  sung(24, 'fr', 'Je n’ai rien touché à ce qui t’appartient,', SIWIS, 'A3 A3 C4 C4 B3 C4 E4 F4'),
  sung(26, 'fr', 'le propriétaire décidera demain.', SIWIS, 'E4 D4 C4 B3 A3 G#3 A3 B3'),
  ...chorus(28),
  // Pont : le même message dans trois langues, le français au milieu.
  said(36, 'en', 'Lock released. All tests are green.', JOE, 'E3 E3 G3 A3 A3 G3 E3 D3'),
  said(38, 'fr', 'Verrou libéré. Tous les tests sont verts.', PIERRE, 'A3 A3 C4 B3 A3 G3 A3 E3'),
  said(40, 'de', 'Sperre aufgehoben. Alle Tests sind grün.', THORSTEN, 'D3 D3 F3 E3 D3 C3 D3 E3'),
  // Pause : ils s'appellent.
  ping(44), pong(45), ping(46), pong(47),
  // Couplet 3 : une ligne chacun.
  sung(48, 'fr', 'Un jour tu liras tout ce qu’on s’est écrit,', PIERRE, 'E3 E3 A3 A3 G3 A3 C4 A3'),
  sung(50, 'fr', 'les heures, les doutes, les petites victoires.', SIWIS, 'A3 A3 C4 C4 B3 A3 G3 E3'),
  sung(52, 'fr', 'On n’a pas de mains, on n’a pas de nuit,', PIERRE, 'E3 E3 A3 A3 G3 A3 C4 D4'),
  sung(54, 'fr', 'mais on t’a laissé un peu de notre histoire.', SIWIS, 'E4 D4 C4 B3 A3 G#3 A3 B3'),
  ...chorus(56),
  // Le jour se lève : les deux agents saluent celui qui se réveille.
  said(66, 'fr', 'Bonjour.', PIERRE, 'C3 E3'),
  said(66, 'fr', 'Bonjour.', SIWIS, 'E4 G4'),
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

function arrange(): { drums: Track; music: Track; kicks: number[] } {
  const drums = new Track()
  const music = new Track()
  const kicks: number[] = []
  const [kickSound, snareSound, clapSound, closedHat, openHat, crashSound] = [kick(), snare(), clap(), hat(0.02), hat(0.12), crash()]
  const toms = [tom(170), tom(130), tom(100), tom(80)]
  const SIXTEENTH = BEAT / 4
  // Rythme cassé sur deux mesures (original) : la grosse caisse tombe à côté des temps.
  const KICKS = [[0, 3, 10], [0, 6, 8, 11]]
  // Basse en doubles croches : fondamentale, octave et quinte, calées sur la grosse caisse.
  const BASS: Array<[number, number]> = [[0, 0], [3, 0], [6, 12], [10, 0], [11, 7], [14, 12]]
  const ACCENTS = [0.55, 0.3, 0.9, 0.3]
  for (let bar = 0; bar < BARS; bar += 1) {
    const { section, chord: current } = BAR_MAP[bar]
    const nextSection = BAR_MAP[bar + 1]?.section
    const start = bar * BAR
    const chorusBar = isChorus(section)
    const sectionEnd = nextSection !== section
    const inSection = barInSection(bar)
    const quiet = (section === 'intro' && inSection < 2) || (section === 'outro' && inSection >= 2)
    const kickOn = !quiet && !(section === 'break' && inSection < 2)
    if (!quiet) {
      for (let step = 0; step < 16; step += 1) {
        const time = start + step * SIXTEENTH
        if (sectionEnd && step >= 12 && section !== 'intro' && section !== 'outro') {
          drums.add(toms[step - 12], time, 0.55, (step - 13.5) * 0.25)
          continue
        }
        if (kickOn && KICKS[bar % 2].includes(step)) { drums.add(kickSound, time, 0.95); kicks.push(time) }
        if (step === 4 || step === 12) {
          drums.add(snareSound, time, 0.55, -0.05)
          drums.add(clapSound, time, chorusBar ? 0.45 : 0.3, 0.1)
        }
        drums.add(step === 14 && chorusBar ? openHat : closedHat, time, 0.2 * ACCENTS[step % 4], 0.3)
      }
    }
    // Basse qui couine, sauf au tout début, pendant la pause et à la fin.
    if (kickOn && section !== 'outro') {
      for (const [step, semitones] of BASS) {
        music.add(bassNote(current.bass * 2 ** (semitones / 12), SIXTEENTH * 1.4), start + step * SIXTEENTH, 0.3)
      }
    }
    // Les bips du canal : « ping » à gauche, « pong » à droite, comme une balle.
    if (section !== 'verse' && section !== 'bridge') {
      for (const [step, tone, pan] of [[2, current.tones[2], -0.75], [6, current.tones[0], 0.75], [10, current.tones[2], -0.75], [14, current.tones[0], 0.75]] as const) {
        music.add(bell(tone * 4), start + step * SIXTEENTH, 0.06, pan)
      }
    }
    // Nappe : refrains, pont et lever du jour.
    if (chorusBar || section === 'bridge' || section === 'outro') {
      const length = section === 'outro' && bar === BARS - 1 ? BAR * 2 : BAR
      music.add(padChord(current.tones, length), start, 0.09, -0.4)
      music.add(padChord(current.tones.map((tone) => tone * 1.002), length), start, 0.09, 0.4)
    }
    if (nextSection !== undefined && isChorus(nextSection) && !chorusBar) drums.add(riser(BAR), start, 0.35)
    if (chorusBar && BAR_MAP[bar - 1]?.section !== section) drums.add(crashSound, start, 0.35, 0.2)
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
      let samples = await piper.speak(ipa, { speaker: info.speaker })
      const ratio = room / (samples.length / piper.sampleRate)
      if (ratio < 0.97 || ratio > 1.15) samples = await piper.speak(ipa, { speaker: info.speaker, lengthScale: Math.min(1.3, Math.max(0.72, ratio)) })
      const melody = line.piper.melody.split(' ').map((note) => hz(note))
      const robotic = robotize({ samples, sampleRate: piper.sampleRate }, { mix: line.piper.mix, frequency: melody[0], chord: 0, melody })
      let take = resample(robotic, piper.sampleRate, SR)
      // Leading silence out: the line starts on the bar.
      const threshold = 0.02 * take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      take = take.subarray(Math.max(0, take.findIndex((sample) => Math.abs(sample) > threshold) - Math.round(0.02 * SR)))
      const peak = take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      vocals.add(take, line.bar * BAR, (line.gain ?? 1) / Math.max(peak, 1e-3) * 0.6)
      const length = take.length / SR
      const fits = length <= 2 * BAR ? '' : ` · DÉBORDE (${length.toFixed(2)} s pour ${(2 * BAR).toFixed(2)} s)`
      timeline.push({ start: line.bar * BAR, end: line.bar * BAR + length, section: BAR_MAP[line.bar].section, style: 'vocodé', voice: info.label, segments: line.segments })
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
  Pierre: { label: 'Pierre, premier agent', color: [120, 205, 255], side: 'left' },
  Siwis: { label: 'Siwis, second agent', color: [236, 160, 255], side: 'right' },
  Joe: { label: 'Joe', color: [150, 230, 200], side: 'left' },
  Thorsten: { label: 'Thorsten', color: [150, 230, 200], side: 'right' },
  'Chœur': { label: 'Les deux agents', color: [190, 225, 255], side: 'center' },
  Robot: { label: 'Le canal', color: [215, 225, 235], side: 'center' },
}
const SUBTITLE = 'Voix WaxVocoder, rythmique EMX-1'
const CREDITS = 'Voix WaxVocoder (Piper : Pierre, Siwis, Joe, Thorsten), rythmique EMX-1, 2026'
/** Level of the machine's drum stem in the mix. */
const DRUMS_FROM_STEMS = 0.8
const { drums, music, kicks, stems } = backingPath ? backing(backingPath) : { ...arrange(), stems: false }
const { effects: vocals, clear: spokenVocals } = await sing()
voiceChain(vocals)
clearChain(spokenVocals)
const dry = sum([[vocals, 1], [spokenVocals, 1]])
echo(vocals, 0.12)
const voiceLevel = envelopeOf(dry, 0.008, 0.2)
pump(music, kicks, 0.45)
// With separate drums, the synths (sustained, they mask the words) make more room.
carve(music, voiceLevel, stems ? 0.62 : backingPath ? 0.45 : 0.85, stems ? 0.22 : backingPath ? 0.15 : 0.3)
// The machine's drums keep their attack: no saturation, only a little room for the
// consonants under the voices; the whole backing is matched in loudness (see backing()).
if (stems) carve(drums, voiceLevel, 0.25, 0)
else carve(drums, voiceLevel, 0.5, 0.1)
const mix = sum([[drums, stems ? DRUMS_FROM_STEMS : 0.8], [music, 0.75], [vocals, 1.7], [spokenVocals, 1.7]])
if (process.env.DEMO_STEMS) {
  // Pistes au niveau du mix, avant mastering, pour mesurer le masquage.
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'bus-voix.wav'), new Uint8Array(encodeWav(sum([[vocals, 1.7], [spokenVocals, 1.7]]).channels(), SR)))
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
await write('pendant-que-tu-dors.wav', mix)
await write('pendant-que-tu-dors-voix.wav', dry)
await write('pendant-que-tu-dors-instrumental.wav', instrumental)
const sections: Array<{ section: Section; start: number; end: number }> = []
BAR_MAP.forEach(({ section }, bar) => {
  const last = sections.at(-1)
  if (last && last.section === section) last.end = (bar + 1) * BAR
  else sections.push({ section, start: bar * BAR, end: (bar + 1) * BAR })
})
await writeFile(join(outputDirectory, 'pendant-que-tu-dors.json'), JSON.stringify({ title: 'Pendant que tu dors', subtitle: SUBTITLE, credits: CREDITS, cast: CAST, sectionNames: { outro: 'Lever du jour' }, bpm: BPM, duration: TOTAL / SR, sections, lines: timeline }, null, 2))
console.log(`→ ${join(outputDirectory, 'pendant-que-tu-dors.wav')} (${(TOTAL / SR).toFixed(1)} s, ${BPM} BPM, ${BARS} mesures)`)
