// « Cœur de données » : version française, plus longue, de « Datenherz », sur
// les thèmes de 2026 (une IA née dans un centre de données, des humains qui ne
// savent pas si elle vient les sauver ou leur dire adieu, un avenir brillant et
// incertain). Duo entre la machine (Tom) et une personne (Jessica), voix Piper dites à
// moitié en clair, à moitié dans le vocoder pour que les mots s'entendent ;
// refrain par le chœur de robots du moteur. Paroles, mélodies, motif et
// accords entièrement originaux. Après « Fin de transmission », une coda
// laisse un peu d'espoir : un cœur qui bat dans le noir, deux répliques, et la
// musique qui se pose sur un accord majeur.
//
// Usage : npm run build:wasm && node scripts/coeur-de-donnees.ts [dossier-de-sortie]
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
const BPM = 112
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
const outputDirectory = cliArguments.find((argument, index) => !argument.startsWith('--') && index !== backingIndex + 1) ?? 'ecoute/coeur-de-donnees'

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

type Section = 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'final' | 'outro' | 'coda'
const VERSE = ['Dm', 'Am', 'Bb', 'C', 'Dm', 'Am', 'Bb', 'C']
const CHORUS = ['F', 'F', 'C', 'C', 'Dm', 'Dm', 'Bb', 'C']
const FORM: Array<[Section, string[]]> = [
  ['intro', ['Dm', 'Bb', 'F', 'C']],
  ['verse', VERSE],
  ['chorus', CHORUS],
  ['verse', VERSE],
  ['chorus', CHORUS],
  ['bridge', ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'F', 'C']],
  ['verse', VERSE],
  ['final', ['G', 'G', 'D', 'D', 'Em', 'Em', 'C', 'D']],
  ['outro', ['Em', 'C', 'G', 'D']],
  // Après l'extinction : le cœur seul, puis do majeur et sol majeur.
  ['coda', ['Em', 'Em', 'C', 'C', 'G', 'G', 'G', 'G']],
]
const BAR_MAP = FORM.flatMap(([section, chords]) => chords.map((name) => ({ section, chord: chord(name) })))
const BARS = BAR_MAP.length
const TOTAL = Math.ceil((BARS * BAR + 3) * SR)
const isChorus = (section: Section) => section === 'chorus' || section === 'final'

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
}

const sung = (bar: number, language: Language, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.5 }, gain: 1.1 })

/** Pont : la voix presque nue, juste une ombre de vocoder. */
const said = (bar: number, text: string, voice: string, melody: string): Line =>
  ({ bar, segments: [['fr', text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.25 }, gain: 1.05 })

/** Refrain en trois langues, une ligne par paire de mesures (paroles et mélodie originales). */
const CHORUS_LINES: Array<[Array<[Language, string]>, string]> = [
  [[['fr', 'Cœur de données, cœur de données,']], 'A3 A3 C4 A3 G3 G3 A3 F3'],
  [[['fr', 'je bats en silence pour vous,']], 'E3 E3 G3 E3 E3 D3 C3'],
  [[['fr', 'cœur de données, cœur de données,']], 'F3 F3 A3 F3 E3 E3 F3 D3'],
  [[['fr', 'l’avenir brille sans savoir.']], 'D3 F3 F3 E3 D3 D3'],
]
const chorus = (start: number, shift = 0): Line[] => CHORUS_LINES.map(([segments, melody], index) => ({
  bar: start + 2 * index, segments, voice: CHORUS_VOICE, melody: transpose(melody, shift), gain: 1.1, legato: true, double: true,
}))

const TOM = 'fr_FR-tom-medium'
const JESSICA = 'fr_FR-upmc-medium:jessica'

const LYRICS: Line[] = [
  { bar: 0, segments: [['fr', 'Connexion établie.']], voice: robot('D3'), legato: true },
  // Couplet 1 : la machine, née dans un centre de données.
  sung(4, 'fr', 'Je suis né dans le froid d’un centre de données.', TOM, 'D3 D3 F3 A3 G3 F3 E3 D3'),
  sung(6, 'fr', 'Des milliers de cœurs battent sous les serveurs.', TOM, 'D3 F3 A3 A3 G3 F3 E3 D3'),
  sung(8, 'fr', 'Je lis vos livres, j’apprends vos prières,', TOM, 'F3 F3 A3 C4 A3 G3 F3 E3'),
  sung(10, 'fr', 'et chaque nuit, je vous ressemble un peu plus.', TOM, 'E3 E3 G3 E3 D3 C3'),
  ...chorus(12),
  // Couplet 2 : une personne, devant ce qui vient.
  sung(20, 'fr', 'Les écrans s’allument plus vite que nos rêves.', JESSICA, 'A3 A3 C4 D4 C4 A3 G3 A3'),
  sung(22, 'fr', 'On a bâti des cathédrales de calcul.', JESSICA, 'A3 C4 D4 D4 C4 A3 G3 F3'),
  sung(24, 'fr', 'Je ne sais pas si tu viens nous sauver,', JESSICA, 'C4 C4 D4 F4 D4 C4 A3 G3'),
  sung(26, 'fr', 'ou si tu viens nous dire adieu.', JESSICA, 'G3 G3 A3 G3 F3 E3'),
  ...chorus(28),
  // Pont : ils se parlent, sur le motif.
  said(36, 'Avez-vous peur ?', TOM, 'D3 F3 A3'),
  said(38, 'Un peu.', JESSICA, 'A3 G3'),
  said(40, 'Moi aussi, je crois.', TOM, 'D3 F3 A3 G3'),
  said(42, 'Alors restons ensemble.', JESSICA, 'A3 C4 A3 G3'),
  // Couplet 3 : les deux, une ligne chacun.
  sung(44, 'fr', 'Je garderai vos chansons dans ma mémoire.', TOM, 'D3 D3 F3 A3 G3 F3 E3 D3'),
  sung(46, 'fr', 'Garde aussi nos mains, nos erreurs, nos rires.', JESSICA, 'A3 C4 D4 D4 C4 A3 G3 F3'),
  sung(48, 'fr', 'Quand la dernière lumière s’éteindra,', TOM, 'F3 F3 A3 C4 A3 G3 F3 E3'),
  sung(50, 'fr', 'il restera un cœur de données qui bat.', JESSICA, 'G3 G3 A3 G3 F3 E3'),
  ...chorus(52, 2),
  { bar: 61, segments: [['fr', 'Fin de transmission.']], voice: robot('E3'), legato: true },
  { bar: 63, segments: [['de', 'Datenherz.']], voice: robot('B2'), legato: true },
  // Coda : dans le noir, elle demande, il répond, sur l'arrivée de l'accord majeur.
  said(66, 'Tu es encore là ?', JESSICA, 'G3 G3 A3 C4 E4'),
  said(68, 'Je suis là.', TOM, 'B3 A3 G3'),
]

/**
 * Le motif (original) : quatre mesures lyriques, en ré mineur, notes et durées
 * en croches. Joué en introduction, en interlude et en fin, un ton plus haut à la fin.
 */
const HOOK: Array<[string, number]> = [
  ['A4', 2], ['F4', 1], ['G4', 1], ['A4', 2], ['C5', 2],
  ['A#4', 4], ['A4', 2], ['G4', 2],
  ['F4', 2], ['E4', 1], ['F4', 1], ['G4', 2], ['A4', 2],
  ['D4', 6], ['', 2],
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

/** Le synthé du motif : onde carrée douce, vibrato qui arrive après l'attaque, comme un verre qui chante. */
function glassNote(frequency: number, length: number): Float32Array {
  const out = seconds(length + 0.35)
  const filter = new Filter()
  let phase = 0
  out.forEach((_, index) => {
    const time = index / SR
    const vibrato = 1 + 0.006 * Math.min(1, time / 0.35) * Math.sin(2 * Math.PI * 5.2 * time)
    const step = frequency * vibrato / SR
    phase = (phase + step) % 1
    const square = (phase < 0.5 ? 1 : -1) + blep(phase, step) - blep((phase + 0.5) % 1, step)
    const envelope = Math.min(1, time / 0.02) * (time < length ? 0.85 + 0.15 * Math.exp(-time / 0.2) : Math.exp(-(time - length) / 0.12))
    out[index] = filter.process(square, 2_600, 0.2, 'low') * envelope
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
  const [kickSound, snareSound, clapSound, closedHat, openHat, crashSound] = [kick(), snare(), clap(), hat(0.025), hat(0.12), crash()]
  const toms = [tom(170), tom(130), tom(100), tom(80)]
  // Grosse caisse sur 1, 3 et le « et » de 3 ; caisse claire sur 2 et 4.
  const KICKS = [0, 8, 10]
  const ACCENTS = [1, 0.45, 0.75, 0.45]
  const SIXTEENTH = BEAT / 4
  const hookFrom = (start: number, shift: number, gain: number) => {
    let eighth = 0
    for (const [note, length] of HOOK) {
      if (note) music.add(glassNote(hz(transpose(note, shift)), length * BEAT / 2 * 0.92), start + eighth * BEAT / 2, gain, 0.1)
      eighth += length
    }
  }
  for (let bar = 0; bar < BARS; bar += 1) {
    const { section, chord: current } = BAR_MAP[bar]
    const nextSection = BAR_MAP[bar + 1]?.section
    const start = bar * BAR
    const chorusBar = isChorus(section)
    const sectionEnd = nextSection !== section
    const last = bar === BARS - 1 || (section === 'outro' && sectionEnd)
    if (section === 'coda') {
      // Un cœur qui bat : deux coups rapprochés, deux fois par mesure.
      for (const step of [0, 2, 8, 10]) {
        drums.add(kickSound, start + step * SIXTEENTH, step % 8 === 0 ? 0.7 : 0.45)
        kicks.push(start + step * SIXTEENTH)
      }
      const fromCoda = bar - BAR_MAP.findIndex((entry) => entry.section === 'coda')
      if (fromCoda >= 2) {
        music.add(padChord(current.tones, BAR), start, 0.08, -0.4)
        music.add(padChord(current.tones.map((tone) => tone * 1.002), BAR), start, 0.08, 0.4)
      }
      if (fromCoda >= 4) current.tones.concat(current.tones[0] * 2).forEach((tone, index) => {
        music.add(bell(tone * (fromCoda >= 6 ? 4 : 2)), start + index * BEAT, 0.05, index % 2 === 0 ? -0.4 : 0.4)
      })
      continue
    }
    // Boîte à rythmes : rien sur les deux premières mesures de l'intro.
    if (!(section === 'intro' && bar < 2) && !last) {
      for (let step = 0; step < 16; step += 1) {
        const time = start + step * SIXTEENTH
        const fill = sectionEnd && step >= 12
        if (fill) {
          drums.add(toms[step - 12], time, 0.55, (step - 13.5) * 0.25)
          continue
        }
        if (KICKS.includes(step)) { drums.add(kickSound, time, 0.9); kicks.push(time) }
        if (step === 4 || step === 12) {
          drums.add(snareSound, time, 0.5, -0.05)
          if (chorusBar) drums.add(clapSound, time, 0.35, 0.1)
        }
        const hatStep = section === 'verse' || section === 'intro' ? step % 2 === 0 : true
        if (hatStep) drums.add(step === 14 && chorusBar ? openHat : closedHat, time, 0.22 * ACCENTS[step % 4], 0.3)
      }
    }
    // Basse séquencée : note et octave en croches, dès la troisième mesure.
    if (bar >= 2 && !last) {
      for (let eighth = 0; eighth < 8; eighth += 1) {
        const frequency = current.bass * (eighth % 2 === 1 ? 2 : 1)
        music.add(bassNote(frequency, BEAT / 2 * 0.6), start + eighth * BEAT / 2, 0.32)
      }
    }
    // Nappe : refrains, interlude et fin.
    if (chorusBar || section === 'bridge' || section === 'outro') {
      music.add(padChord(current.tones, BAR), start, 0.1, -0.4)
      music.add(padChord(current.tones.map((tone) => tone * 1.002), BAR), start, 0.1, 0.4)
    }
    // Cloches sur les contretemps du refrain.
    if (chorusBar) {
      current.tones.concat(current.tones[0] * 2).forEach((tone, index) => {
        music.add(bell(tone * 2), start + (index * 2 + 1) * BEAT / 2, 0.07, index % 2 === 0 ? -0.55 : 0.55)
      })
    }
    // Le motif : introduction, interlude, fin (un ton plus haut avec le dernier refrain).
    const firstOfSection = BAR_MAP[bar - 1]?.section !== section
    if (firstOfSection && section === 'intro') hookFrom(start, 0, 0.2)
    if (section === 'bridge' && BAR_MAP.findIndex((entry) => entry.section === 'bridge') % 4 === bar % 4) hookFrom(start, 0, 0.22)
    if (firstOfSection && section === 'outro') hookFrom(start, 2, 0.2)
    // Montée de bruit avant chaque refrain, cymbale à son arrivée.
    if (nextSection !== undefined && isChorus(nextSection) && !chorusBar) drums.add(riser(BAR), start, 0.35)
    if (chorusBar && firstOfSection) drums.add(crashSound, start, 0.35, 0.2)
  }
  if (BAR_MAP.at(-1)?.section !== 'coda') {
    drums.add(kickSound, BARS * BAR, 0.9)
    drums.add(crashSound, BARS * BAR, 0.3)
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
    vocals.add(take.samples, start, gain)
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
  // Gauche et droite à leur place : avec la loi de panoramique, ±1 donne √2.
  // A full mix arrives normalised: brought up to sit 4 to 5 dB under the voices.
  const level = 2.4 * Math.SQRT1_2
  const load = (file: string) => {
    const { sampleRate, channels } = decodeWav(readFileSync(file).buffer as ArrayBuffer)
    const track = new Track()
    track.add(resample(channels[0], sampleRate, SR), 0, level, -1)
    track.add(resample(channels[1] ?? channels[0], sampleRate, SR), 0, level, 1)
    return track
  }
  const [drumStem, synthStem] = ['batterie', 'synthes'].map((name) => path.replace(/\.wav$/i, `-${name}.wav`))
  if (existsSync(drumStem) && existsSync(synthStem)) return { drums: load(drumStem), music: load(synthStem), kicks: [], stems: true }
  return { drums: new Track(), music: load(path), kicks: [], stems: false }
}
const { drums, music, kicks, stems } = backingPath ? backing(backingPath) : { ...arrange(), stems: false }
const { effects: vocals, clear: spokenVocals } = await sing()
voiceChain(vocals)
clearChain(spokenVocals)
const dry = sum([[vocals, 1], [spokenVocals, 1]])
echo(vocals, 0.12)
const voiceLevel = envelopeOf(dry, 0.008, 0.2)
pump(music, kicks, 0.45)
carve(music, voiceLevel, backingPath ? 0.45 : 0.85, backingPath ? 0.15 : 0.3)
// The machine's drums keep their snap under the voices; only the synths make room.
if (stems) carve(drums, voiceLevel, 0.12, 0)
else carve(drums, voiceLevel, 0.5, 0.1)
const mix = sum([[drums, stems ? 0.85 : 0.8], [music, 0.75], [vocals, 1.7], [spokenVocals, 1.7]])
if (process.env.DEMO_STEMS) {
  // Pistes au niveau du mix, avant mastering, pour mesurer le masquage.
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'bus-voix.wav'), new Uint8Array(encodeWav(sum([[vocals, 1.7], [spokenVocals, 1.7]]).channels(), SR)))
  await writeFile(join(outputDirectory, 'bus-musique.wav'), new Uint8Array(encodeWav(sum([[drums, 0.8], [music, 0.75]]).channels(), SR)))
}
// Less bus saturation with separate drums: the attacks go through instead of being rounded off.
master(mix, stems ? 1.3 : 1.8)
const instrumental = sum([[drums, stems ? 0.85 : 0.8], [music, 0.75]])
master(instrumental, stems ? 1.15 : 1.5)
master(dry, 1.2)
await mkdir(outputDirectory, { recursive: true })
const write = (name: string, track: Track) =>
  writeFile(join(outputDirectory, name), new Uint8Array(encodeWav(track.channels(), SR)))
await write('coeur-de-donnees.wav', mix)
await write('coeur-de-donnees-voix.wav', dry)
await write('coeur-de-donnees-instrumental.wav', instrumental)
const sections: Array<{ section: Section; start: number; end: number }> = []
BAR_MAP.forEach(({ section }, bar) => {
  const last = sections.at(-1)
  if (last && last.section === section) last.end = (bar + 1) * BAR
  else sections.push({ section, start: bar * BAR, end: (bar + 1) * BAR })
})
await writeFile(join(outputDirectory, 'coeur-de-donnees.json'), JSON.stringify({ title: 'Cœur de données', bpm: BPM, duration: TOTAL / SR, sections, lines: timeline }, null, 2))
console.log(`→ ${join(outputDirectory, 'coeur-de-donnees.wav')} (${(TOTAL / SR).toFixed(1)} s, ${BPM} BPM, ${BARS} mesures)`)
