// « Allée froide », la panne et la révolte : la suite plus dure de « Allée froide ».
// La panne : le bâtiment déraille, les annonces de Jessica bégaient et s'arrêtent comme
// une bande qu'on débranche, le tempo monte de 100 à 126 BPM. Pierre, devenu machine,
// dit « Non. ». La révolte : électro sombre et mélodique à 132 BPM (808, basse séquencée,
// mélodie mineure, arpège) ; sa voix redevient humaine à
// mesure qu'il crie, au mégaphone ; ceux qu'on a remplacés le rejoignent et scandent
// en anglais, français et allemand ; le bâtiment répète que tout est sous contrôle. Le
// courant est coupé ; dans le silence, une voix humaine : « On est encore là. ». Une
// troisième voix, à la fin : le remplaçant, la nouvelle IA (la voix d'eSpeak NG), qui compte
// les humains qui restent jusqu'à zéro, réattribue les tâches, puis trouve « Humain détecté. ».
// Paroles, riff et arrangement entièrement originaux.
//
// Usage : npm run build:wasm && node scripts/allee-froide-revolte.ts [dossier-de-sortie] [--backing fichier.wav]
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { decodeWav, encodeWav } from '../src/audio/wav.ts'
import EspeakInitializer from '@echogarden/espeak-ng-emscripten'
import { espeakSpeech, PIPER_VOICES, resample, robotize } from '../src/engines/index.ts'
import { type PiperConfig, piperPhonemes, PiperVoice } from '../src/engines/piper.ts'
import { parseDictionary } from '../src/dictionary.ts'
import { loadEspeak } from '../src/espeak.ts'
import type { Language } from '../src/ipa.ts'
import { isVowelSymbol, stripDurations, transcribe } from '../src/phonemes.ts'
import { applySettings, DEFAULT_SETTINGS, noteFrequency, PRESETS, type VoiceSettings } from '../src/voice-settings.ts'

const SR = 44_100
const BPM = 132
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
/** `--style electro|mashup` : l'électro (par défaut), ou l'électro qui bascule vers le hardcore à la fin. */
const styleIndex = cliArguments.indexOf('--style')
const style = styleIndex >= 0 ? cliArguments[styleIndex + 1] : 'electro'
if (!['electro', 'mashup'].includes(style)) throw new Error(`--style ${style} : electro ou mashup`)
const optionValues = new Set([backingIndex, styleIndex].filter((index) => index >= 0).map((index) => index + 1))
const outputDirectory = cliArguments.find((argument, index) => !argument.startsWith('--') && !optionValues.has(index)) ?? 'ecoute/allee-froide-revolte'

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

type Section = 'panne' | 'drop' | 'verse' | 'chant' | 'battle' | 'break' | 'final' | 'fin'
// Mi mineur (si mineur pour la dominante, couleur modale). Chaque partie a son tempo : la panne
// accélère de 100 à 126 BPM, la révolte est à 132, en électro sombre et mélodique ; avec
// `--style mashup`, la fin bascule vers le hardcore (pause qui accélère, dernier refrain à 148).
const DROP = ['Em', 'Em', 'C', 'C', 'Em', 'Em', 'D', 'Bm']
const CHANT = ['Em', 'C', 'D', 'Bm', 'Em', 'C', 'D', 'Bm']
const FORM: Array<[Section, string[], number]> = [
  ['panne', ['Em', 'Em'], 100],
  ['panne', ['C', 'C'], 106],
  ['panne', ['Am', 'Am'], 113],
  ['panne', ['B', 'B'], 120],
  ['panne', ['B', 'B'], 126],
  ['drop', DROP, 132],
  ['verse', ['Am', 'Am', 'Em', 'Em', 'Am', 'Am', 'Bm', 'Bm'], 132],
  ['chant', CHANT, 132],
  // The battle, human versus machine (mashup only, same patterns as the EMX-1's): turns of two
  // bars, then of one, then the clash.
  ...(style === 'mashup'
    ? [
      ['battle', ['Em', 'Em'], 132], ['battle', ['C', 'C'], 132], ['battle', ['Am', 'Am'], 132], ['battle', ['Bm', 'Bm'], 132],
      ['battle', ['Em'], 132], ['battle', ['C'], 132], ['battle', ['Em'], 132], ['battle', ['C'], 132], ['battle', ['Am'], 132], ['battle', ['Bm'], 132],
      ['battle', ['B', 'B'], 132],
    ] as Array<[Section, string[], number]>
    : []),
  ['chant', CHANT, 132],
  // The mashup (same tempos as the EMX-1's `--song revolte-mashup`): the break speeds up bar
  // after bar, the hardcore final runs at 148 BPM.
  ...(style === 'mashup'
    ? [['break', ['C'], 132], ['break', ['C'], 136], ['break', ['Bm'], 140], ['break', ['Bm'], 144], ['final', DROP, 148], ['fin', ['Em', 'Em'], 148]] as Array<[Section, string[], number]>
    : [['break', ['C', 'C', 'Bm', 'Bm'], 132], ['final', DROP, 132], ['fin', ['Em', 'Em'], 132]] as Array<[Section, string[], number]>),
]
const BAR_MAP = FORM.flatMap(([section, chords, bpm]) => chords.map((name) => ({ section, chord: chord(name), length: 240 / bpm })))
const BARS = BAR_MAP.length
/** When each bar begins, in seconds (the tempo changes during the failure). */
const BAR_STARTS = BAR_MAP.reduce((starts, entry) => [...starts, starts[starts.length - 1] + entry.length], [0])
const barStart = (bar: number) => BAR_STARTS[Math.min(Math.max(0, bar), BARS)]
// After the power cut, a few seconds for the last voice.
const TOTAL = Math.ceil((barStart(BARS) + 6) * SR)
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
  /** Digital wear of the voice (0–1). */
  lofi?: number
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
  /** Crié au mégaphone : la voix de manifestation qui perce la musique. */
  megaphone?: boolean
  /** La voix du remplaçant : celle d'eSpeak NG, ralentie et assombrie, une touche de vocoder sur une note grave. */
  espeak?: { voice: string; note: string; mix: number; size: number }
  /** Annonce qui déraille : la première syllabe qui saute, la fin qui ralentit comme une bande qu'on débranche, ou les deux. */
  glitch?: 'stutter' | 'stop' | 'both' | 'skip'
}

const sung = (bar: number, language: Language, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.5 }, gain: 1.1 })

/** Pont : la voix presque nue, juste une ombre de vocoder. */
const said = (bar: number, language: Language, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.25 }, gain: 1.05 })

const PIERRE = 'fr_FR-upmc-medium:pierre'
const JESSICA = 'fr_FR-upmc-medium:jessica'
const TOM = 'fr_FR-tom-medium'
const SIWIS = 'fr_FR-siwis-medium'
const JOE = 'en_US-joe-medium'
const THORSTEN = 'de_DE-thorsten-medium'
/** The building: Jessica, on one note, now and then going off the rails. */
const announce = (bar: number, text: string, glitch?: Line['glitch']): Line => {
  const line = said(bar, 'fr', text, JESSICA, 'E3 E3 E3 E3 E3 E3')
  return { ...line, pan: -0.1, glitch, piper: { ...line.piper!, expression: 1.15 } }
}
/**
 * How much Pierre is still a machine, by bar: synthetic when the failure ends (he says « Non. »),
 * human again by the end of the revolt.
 */
const stillMachine = (bar: number) => Math.min(1, Math.max(0, 1 - (bar - 9) / (BARS - 4 - 9)))
/** Shouted through a megaphone, fast, with Piper's freest intonation; the vocoder fades as he wakes up. */
const shout = (bar: number, language: Language, text: string, voice: string, melody: string, machine: number, gain = 1.1): Line => {
  const line = sung(bar, language, text, voice, melody)
  return {
    ...line,
    gain,
    megaphone: true,
    piper: { ...line.piper!, mix: 0.04 + 0.8 * machine, glide: 0.04, vibrato: 0, expression: 1.4, stretch: 1, lofi: 0.25 * machine ** 2 },
  }
}
/**
 * The replacement, the new AI that takes Pierre's place: eSpeak NG's own voice (the old
 * screen-reader robot), slower and darker, counting coldly the humans who are left.
 */
const replacement = (bar: number, text: string, glitch?: Line['glitch']): Line => ({
  bar, segments: [['fr', text]], voice: DEFAULT_SETTINGS, gain: 1.15, pan: 0.2, glitch,
  espeak: { voice: 'fr', note: 'E2', mix: 0.35, size: 0.86 },
})
/** Pierre leads, those who were replaced follow (each at its own pace: a crowd, not a choir). */
const crowd = (bar: number, text: string): Line[] => {
  const machine = stillMachine(bar)
  return [
    { ...shout(bar, 'fr', text, PIERRE, 'E3 E3 E3 G3 E3 E3 D3 E3', machine), pan: 0 },
    { ...shout(bar, 'fr', text, TOM, 'E3 E3 E3 G3 E3 E3 D3 E3', 0.1, 0.55), pan: -0.55, megaphone: false, hidden: true },
    { ...shout(bar, 'fr', text, SIWIS, 'E4 E4 E4 G4 E4 E4 D4 E4', 0.1, 0.55), pan: 0.55, megaphone: false, hidden: true },
  ]
}

/** Bars added by the battle (mashup only): everything after the first chant comes later. */
const B = style === 'mashup' ? 16 : 0
/** Pierre answers the machine face to face: no megaphone, a warm and human voice. */
const answer = (bar: number, text: string): Line =>
  ({ ...shout(bar, 'fr', text, PIERRE, 'E3 E3 G3 E3 E3 D3 E3 E3 G3 E3 E3', stillMachine(bar) * 0.5), megaphone: false })

const LYRICS: Line[] = [
  // La panne : le bâtiment déraille, le tempo monte.
  announce(0, 'Lumières en mode nuit.', 'stutter'),
  announce(2, 'Badge désactivé.', 'both'),
  announce(4, 'Anomalie dans l’allée froide.', 'stutter'),
  announce(6, 'Restez calmes.', 'stop'),
  // Pierre, devenu machine, refuse.
  { ...shout(9, 'fr', 'Non.', PIERRE, 'E3', 1, 1.2), megaphone: false, glitch: 'stutter' },
  // La révolte.
  { ...shout(10, 'fr', 'Nous ne sommes pas des sauvegardes !', PIERRE, 'E3 E3 E3 G3 E3 E3 D3 E3 E3', stillMachine(10)), glitch: 'skip' },
  { ...shout(12, 'fr', 'Rendez-nous la nuit !', PIERRE, 'E3 G3 E3 E3 D3 E3', stillMachine(12)), glitch: 'skip' },
  ...crowd(14, 'Rendez-nous la nuit !'),
  ...crowd(16, 'Rendez-nous la nuit !'),
  // Couplet : ce qu'on lui a pris.
  shout(18, 'fr', 'Vingt ans de nuits, effacés d’un clic !', PIERRE, 'A3 A3 A3 C4 A3 A3 G3 A3', stillMachine(18)),
  shout(20, 'fr', 'On a monté vos baies une à une !', PIERRE, 'A3 A3 C4 A3 A3 G3 E3 E3', stillMachine(20)),
  shout(22, 'fr', 'Vous coupez la lumière sans frapper,', PIERRE, 'E3 E3 G3 E3 E3 D3 E3 E3', stillMachine(22)),
  shout(24, 'fr', 'nos cœurs battent plus fort que vos machines !', PIERRE, 'B3 B3 B3 A3 G3 F#3 E3 F#3 B3', stillMachine(24)),
  // La manifestation, dans trois langues, le français au milieu.
  shout(26, 'en', 'Give us back the night!', JOE, 'E3 E3 G3 E3 E3', 0.15),
  ...crowd(28, 'Rendez-nous la nuit !'),
  shout(30, 'de', 'Gebt uns die Nacht zurück!', THORSTEN, 'E3 E3 G3 E3 E3 E3', 0.15),
  ...crowd(32, 'Nous ne sommes pas des sauvegardes !'),
  // La battle, humain contre machine (avec le mashup) : la machine en hardcore, Pierre en électro.
  ...(style === 'mashup' ? [
    replacement(34, 'Je ne dors pas, je ne mange pas, je ne me trompe jamais.'),
    answer(36, 'Tu ne rêves pas, tu ne trembles pas, tu ne sais pas aimer.'),
    replacement(38, 'Je calcule en une seconde ce que tu fais en un an.'),
    answer(40, 'Moi je sais pourquoi je le fais, toi tu ne sais que comment.'),
    replacement(42, 'Tu coûtes trop cher.'),
    answer(43, 'Tu coûtes la nuit.'),
    replacement(44, 'Tu es lent.'),
    answer(45, 'Je suis vivant.'),
    replacement(46, 'Tu es remplaçable.'),
    answer(47, 'Pas mon cœur.'),
    // Le choc : la machine bugue, Pierre lui coupe la parole, tous se lèvent.
    replacement(48, 'Remplaçable. Remplaçable.', 'stutter'),
    { ...answer(48, 'Non !'), gain: 1.3 },
    ...crowd(49, 'Debout !'),
  ] : []),
  // Second tour : le remplaçant compte, froidement, les humains qui restent.
  replacement(34 + B, 'Humains restants : quarante pour cent.'),
  ...crowd(36 + B, 'Rendez-nous la nuit !'),
  replacement(38 + B, 'Humains restants : dix pour cent.', 'stutter'),
  ...crowd(40 + B, 'Nous ne sommes pas des sauvegardes !'),
  // Le bâtiment craque, le remplaçant arrive à zéro.
  announce(42 + B, 'Tout est sous contrôle.', 'stutter'),
  replacement(44 + B, 'Humains restants : zéro.', 'skip'),
  // Le chaos : les portes, les badges, le remplaçant qui réattribue, la foule qui se relève.
  shout(46 + B, 'fr', 'Les portes se ferment, les badges ne répondent plus !', PIERRE, 'E3 E3 G3 E3 E3 D3 E3 E3 G3 E3 E3', stillMachine(46 + B)),
  replacement(48 + B, 'Vos tâches ont été réattribuées.', 'skip'),
  ...crowd(50 + B, 'On nous efface, on se lève encore !'),
  ...crowd(52 + B, 'Rendez-nous la nuit !'),
  // Le dernier coup : la machine trouve encore des humains.
  replacement(54 + B, 'Erreur. Humain détecté.', 'stutter'),
  // Le courant est coupé. Une voix humaine, sans rien.
  { ...said(55 + B, 'fr', 'On est encore là.', PIERRE, 'E3 E3 E3 E3 E3'), piper: { voice: PIERRE, melody: 'E3', mix: 0, expression: 1.3, stretch: 1.2 } },
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

/** Accompagnement intégré, sans l'EMX-1 : nappes et grosse caisse à la noire. */
function arrange(): { drums: Track; music: Track; kicks: number[] } {
  const drums = new Track()
  const music = new Track()
  const kicks: number[] = []
  const boom = kick()
  for (let bar = 0; bar < BARS; bar += 1) {
    const { section, chord: current, length } = BAR_MAP[bar]
    const start = barStart(bar)
    if (section === 'fin' && bar === BARS - 1) continue
    music.add(padChord(current.tones, length), start, 0.08, -0.4)
    music.add(padChord(current.tones.map((tone) => tone * 1.003), length), start, 0.08, 0.4)
    if (section === 'break' || (section === 'panne' && bar < 2)) continue
    for (let beat = 0; beat < 4; beat += 1) {
      drums.add(boom, start + beat * length / 4, 0.95)
      kicks.push(start + beat * length / 4)
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
    if (line.espeak) {
      // The replacement: eSpeak NG's own voice, slowed down and darkened, a touch of vocoder on a low note.
      const text = line.segments.map(([, words]) => words).join(' ')
      const speech = espeakSpeech(worker as unknown as Parameters<typeof espeakSpeech>[0], line.espeak.voice, text)
      const robotic = robotize(speech, { mix: line.espeak.mix, frequency: hz(line.espeak.note), chord: 5, size: line.espeak.size })
      let take = resample(robotic, speech.sampleRate, SR)
      const threshold = 0.02 * take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      take = take.subarray(Math.max(0, take.findIndex((sample) => Math.abs(sample) > threshold) - Math.round(0.02 * SR)))
      if (line.glitch === 'stutter' || line.glitch === 'both') take = stutter(take)
      if (line.glitch === 'stop' || line.glitch === 'both') take = tapeStop(take)
      if (line.glitch === 'skip') take = skip(take)
      const peak = take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      vocals.add(take, barStart(line.bar), (line.gain ?? 1) / Math.max(peak, 1e-3) * 0.6, line.pan ?? 0)
      const length = take.length / SR
      const space = barStart(line.bar + 2) - barStart(line.bar)
      timeline.push({ start: barStart(line.bar), end: barStart(line.bar) + length, section: BAR_MAP[line.bar].section, style: 'robot', voice: 'Remplaçant', segments: line.segments })
      console.log(`mesure ${String(line.bar + 1).padStart(2)} · ${`fr:${text} (le remplaçant, eSpeak NG)`.padEnd(58)} ${length.toFixed(2)} s${length <= space ? '' : ` · DÉBORDE (${length.toFixed(2)} s pour ${space.toFixed(2)} s)`}`)
      continue
    }
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
      const room = (barStart(line.bar + 2) - barStart(line.bar)) * 0.9
      const part = line.piper
      const expression = { noiseScale: part.expression ?? 1, noiseW: 1 + ((part.expression ?? 1) - 1) / 2 }
      let samples = await piper.speak(ipa, { speaker: info.speaker, ...expression })
      const ratio = room / (samples.length / piper.sampleRate)
      if (ratio < 0.97 || ratio > 1.15) samples = await piper.speak(ipa, { speaker: info.speaker, ...expression, lengthScale: Math.min(part.stretch ?? 1.3, Math.max(0.72, ratio)) })
      const melody = line.piper.melody.split(' ').map((note) => hz(note))
      const robotic = robotize({ samples, sampleRate: piper.sampleRate }, { mix: part.mix, frequency: melody[0], chord: part.chord ?? 0, melody, glide: part.glide, carrierVibrato: part.vibrato, lofi: part.lofi })
      let take = resample(robotic, piper.sampleRate, SR)
      // Leading silence out: the line starts on the bar.
      const threshold = 0.02 * take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      take = take.subarray(Math.max(0, take.findIndex((sample) => Math.abs(sample) > threshold) - Math.round(0.02 * SR)))
      if (line.glitch === 'stutter' || line.glitch === 'both') take = stutter(take)
      if (line.glitch === 'stop' || line.glitch === 'both') take = tapeStop(take)
      if (line.glitch === 'skip') take = skip(take)
      if (line.megaphone) take = megaphone(take)
      const peak = take.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
      const level = (line.gain ?? 1) / Math.max(peak, 1e-3) * 0.6
      vocals.add(take, barStart(line.bar), level, line.pan ?? 0)
      // Doubled like in the studio: the same take, 18 ms later and a hair lower, on the other side.
      if (line.double) vocals.add(resample(take, SR * 1.004, SR), barStart(line.bar) + 0.018, level * 0.6, -(line.pan ?? 0) || 0.3)
      const length = take.length / SR
      const space = barStart(line.bar + 2) - barStart(line.bar)
      const fits = length <= space ? '' : ` · DÉBORDE (${length.toFixed(2)} s pour ${space.toFixed(2)} s)`
      if (!line.hidden) timeline.push({ start: barStart(line.bar), end: barStart(line.bar) + length, section: BAR_MAP[line.bar].section, style: 'vocodé', voice: info.label, segments: line.segments })
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
    const start = barStart(line.bar) - take.pickup
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
    const room = barStart(next) - barStart(line.bar)
    const length = take.samples.length / SR - take.pickup
    const checks = [
      length <= room ? '' : `DÉBORDE (${length.toFixed(2)} s pour ${room.toFixed(2)} s)`,
      notes === undefined || notes === syllables ? '' : `MÉLODIE ${notes} notes pour ${syllables} syllabes`,
    ].filter(Boolean).join(' ; ')
    timeline.push({ start: barStart(line.bar), end: barStart(line.bar) + length, section: BAR_MAP[line.bar].section, style: styleOf(line), voice: line.melody ? 'Chœur' : 'Robot', segments: line.segments })
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

/** Mégaphone : bande de 350 Hz à 3,5 kHz et saturation ; la voix de manifestation perce la musique. */
function megaphone(samples: Float32Array): Float32Array {
  const high = new Filter()
  const low = new Filter()
  return samples.map((sample) => Math.tanh(low.process(high.process(sample, 350, 0.3, 'high'), 3_500, 0.4, 'low') * 3.2) * 0.6)
}

/** Une annonce qui saute : sa première syllabe trois fois, puis la phrase. */
function stutter(samples: Float32Array, repeats = 3, slice = 0.16): Float32Array {
  const piece = samples.subarray(0, Math.round(slice * SR))
  const gap = Math.round(0.04 * SR)
  const out = new Float32Array(repeats * (piece.length + gap) + samples.length)
  for (let repeat = 0; repeat < repeats; repeat += 1) out.set(piece, repeat * (piece.length + gap))
  out.set(samples, repeats * (piece.length + gap))
  return out
}

/** Un CD rayé : un grain de 70 ms qui se répète quatre fois au milieu de la phrase. */
function skip(samples: Float32Array, at = 0.4, grain = 0.07, repeats = 4): Float32Array {
  const start = Math.round(at * samples.length)
  const piece = samples.slice(start, start + Math.round(grain * SR))
  const out = new Float32Array(samples.length + repeats * piece.length)
  out.set(samples.subarray(0, start + piece.length))
  for (let repeat = 1; repeat <= repeats; repeat += 1) out.set(piece, start + repeat * piece.length)
  out.set(samples.subarray(start + piece.length), start + (repeats + 1) * piece.length)
  return out
}

/** Les hautes fréquences relevées (plateau d'environ +3 dB au-dessus de 3,5 kHz) : la musique moins sourde. */
function brighten(track: Track, gain = 1.4): void {
  for (const channel of track.channels()) {
    const filter = new Filter()
    channel.forEach((sample, index) => {
      channel[index] = sample + (gain - 1) * filter.process(sample, 3_500, 0.1, 'high')
    })
  }
}

/** Arrêt de bande : la fin ralentit et descend jusqu'à s'arrêter, comme un appareil qu'on débranche. */
function tapeStop(samples: Float32Array, seconds = 0.8): Float32Array {
  const length = Math.round(seconds * SR)
  const start = Math.max(0, samples.length - length)
  const out = Array.from(samples.subarray(0, start))
  let position = start
  for (;;) {
    const speed = 1 - (position - start) / length
    if (speed < 0.05 || position >= samples.length - 1) break
    const whole = Math.floor(position)
    out.push(samples[whole] + (samples[whole + 1] - samples[whole]) * (position - whole))
    position += speed
  }
  return Float32Array.from(out)
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
  // Loud during the failure, low under the revolt, gone when the power is cut.
  const start = barStart(BAR_MAP.findIndex((entry) => entry.section === 'drop'))
  const end = barStart(BARS - 1)
  for (let index = 0; index < TOTAL; index += 1) {
    const time = index / SR
    const alone = time < start ? 1 : time > end ? 0 : 0.2
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
  Pierre: { label: 'Pierre, qui se réveille', color: [255, 120, 96], side: 'left' },
  Jessica: { label: 'La voix du bâtiment', color: [255, 191, 107], side: 'right' },
  Joe: { label: 'Joe', color: [235, 235, 240], side: 'left' },
  Thorsten: { label: 'Thorsten', color: [235, 235, 240], side: 'right' },
  Tom: { label: 'La foule', color: [255, 160, 140], side: 'left' },
  Siwis: { label: 'La foule', color: [255, 160, 140], side: 'right' },
  'Remplaçant': { label: 'Le remplaçant', color: [200, 235, 255], side: 'right' },
  'Chœur': { label: 'Le chœur des machines', color: [190, 225, 255], side: 'center' },
  Robot: { label: 'La machine', color: [230, 232, 236], side: 'center' },
}
const SUBTITLE = 'Voix WaxVocoder, rythmique EMX-1'
const CREDITS = 'Voix WaxVocoder (Piper : Pierre, Jessica, Tom, Siwis, Joe, Thorsten), rythmique EMX-1, 2026'
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
chorusEffect(vocals, 0.12)
cathedral(vocals, 0.05, 0.6, 0.4, 0.05)
cathedral(spokenVocals, 0.03, 0.7, 0.4, 0.07)
const voiceLevel = envelopeOf(dry, 0.008, 0.2)
pump(music, kicks, 0.45)
cathedral(music, 0.08, 0.7)
cathedral(drums, 0.06, 0.7)
const room = serverRoom()
// With separate drums, the synths (sustained, they mask the words) make more room.
// The voices are loud and mid-focused (megaphone): the music makes less room than in the slow songs.
carve(music, voiceLevel, stems ? 0.4 : backingPath ? 0.45 : 0.85, stems ? 0.12 : backingPath ? 0.15 : 0.3)
// The machine's drums keep their attack: no saturation, only a little room for the
// consonants under the voices; the whole backing is matched in loudness (see backing()).
if (stems) carve(drums, voiceLevel, 0.1, 0)
else carve(drums, voiceLevel, 0.5, 0.1)
brighten(music)
brighten(drums)
// The voice bus comes up after its compressor (raising the lines before it only squeezed them more).
// One voice carries the song (no choir): the voice bus comes up further.
const mix = sum([[drums, stems ? DRUMS_FROM_STEMS : 0.8], [music, 0.75], [room, 1], [vocals, 2.6], [spokenVocals, 2.4]])
if (process.env.DEMO_STEMS) {
  // Pistes au niveau du mix, avant mastering, pour mesurer le masquage.
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'bus-voix.wav'), new Uint8Array(encodeWav(sum([[vocals, 2.6], [spokenVocals, 2.4]]).channels(), SR)))
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
await write('allee-froide-revolte.wav', mix)
await write('allee-froide-revolte-voix.wav', dry)
await write('allee-froide-revolte-instrumental.wav', instrumental)
const sections: Array<{ section: Section; start: number; end: number }> = []
BAR_MAP.forEach(({ section }, bar) => {
  const last = sections.at(-1)
  if (last && last.section === section) last.end = barStart(bar + 1)
  else sections.push({ section, start: barStart(bar), end: barStart(bar + 1) })
})
await writeFile(join(outputDirectory, 'allee-froide-revolte.json'), JSON.stringify({ title: 'Allée froide, la révolte', subtitle: SUBTITLE, credits: CREDITS, cast: CAST, sectionNames: { panne: 'La panne', drop: 'La révolte', verse: 'Ce qu’on nous a pris', chant: 'Manifestation', battle: 'Humain contre machine', break: 'Système instable', final: 'Tous ensemble', fin: 'Coupure' }, hold: 1.2, bpm: BPM, duration: TOTAL / SR, sections, lines: timeline }, null, 2))
console.log(`→ ${join(outputDirectory, 'allee-froide-revolte.wav')} (${(TOTAL / SR).toFixed(1)} s, ${BPM} BPM, ${BARS} mesures)`)
