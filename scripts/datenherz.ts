// « Datenherz » (cœur de données, data heart) : chanson électro-pop courte en
// allemand, anglais et français, hommage à la musique électronique allemande de
// 1981. Paroles, mélodies, riff et grilles d'accords sont entièrement originaux :
// rien n'est repris d'aucune chanson existante. Couplets : voix Piper (Thorsten,
// Joe, Tom) passées dans le vocoder de WaxVocoder, une note par syllabe ;
// refrain : le chœur de robots du moteur WaxVocoder. Voix Piper lues dans
// voices/ (npm run voice -- de, puis en et fr).
//
// Usage : npm run build:wasm && node scripts/datenherz.ts [dossier-de-sortie]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { encodeWav } from '../src/audio/wav.ts'
import EspeakInitializer from '@echogarden/espeak-ng-emscripten'
import { PIPER_VOICES, resample, robotize } from '../src/engines/index.ts'
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
const outputDirectory = process.argv[2] ?? 'ecoute/datenherz'

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

type Section = 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'final' | 'outro'
const VERSE = ['Dm', 'Dm', 'Bb', 'Bb', 'F', 'F', 'C', 'C']
const CHORUS = ['F', 'F', 'C', 'C', 'Dm', 'Dm', 'Bb', 'C']
const FORM: Array<[Section, string[]]> = [
  ['intro', ['Dm', 'Dm', 'Bb', 'C']],
  ['verse', VERSE],
  ['chorus', CHORUS],
  ['verse', VERSE],
  ['verse', VERSE],
  ['final', ['G', 'G', 'D', 'D', 'Em', 'Em', 'C', 'D']],
  ['outro', ['Em', 'Em', 'Em', 'Em']],
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
  ({ bar, segments: [[language, text]], voice: DEFAULT_SETTINGS, piper: { voice, melody, mix: 0.72 }, gain: 1.1 })

/** Refrain en trois langues, une ligne par paire de mesures (paroles et mélodie originales). */
const CHORUS_LINES: Array<[Array<[Language, string]>, string]> = [
  [[['de', 'Datenherz, Datenherz,']], 'A3 A3 C4 A3 G3 F3'],
  [[['en', 'data heart, beating for you,']], 'E3 E3 G3 E3 E3 D3 C3'],
  [[['fr', 'cœur de données, bat pour toi,']], 'F3 F3 A3 A3 G3 F3 D3'],
  [[['de', 'Datenherz, Datenherz.']], 'D3 D3 F3 F3 E3 D3'],
]
const chorus = (start: number, shift = 0): Line[] => CHORUS_LINES.map(([segments, melody], index) => ({
  bar: start + 2 * index, segments, voice: CHORUS_VOICE, melody: transpose(melody, shift), gain: 1.1, legato: true, double: true,
}))

const THORSTEN = 'de_DE-thorsten-medium'
const JOE = 'en_US-joe-medium'
const TOM = 'fr_FR-tom-medium'

const LYRICS: Line[] = [
  { bar: 0, segments: [['de', 'Verbindung hergestellt.']], voice: robot('D3'), legato: true },
  { bar: 2, segments: [['fr', 'Bonjour, humain.']], voice: TOY_VOICE },
  // Couplet allemand.
  sung(4, 'de', 'Strom fließt durch mein Herz aus Glas.', THORSTEN, 'D3 D3 F3 A3 G3 F3 E3 D3'),
  sung(6, 'de', 'Ich zähle Sterne, Bit für Bit.', THORSTEN, 'D3 F3 A3 A3 G3 F3 E3 D3'),
  sung(8, 'de', 'Die Stadt schläft, nur mein Bildschirm wacht.', THORSTEN, 'F3 F3 A3 C4 A3 G3 F3 E3'),
  sung(10, 'de', 'Er schickt sein Licht zu dir.', THORSTEN, 'E3 E3 G3 E3 D3 C3'),
  ...chorus(12),
  // Couplet anglais.
  sung(20, 'en', 'My heart is made of silicon light.', JOE, 'D3 D3 F3 A3 G3 F3 E3 D3'),
  sung(22, 'en', 'I learned to dream in ones and zeros.', JOE, 'D3 F3 A3 A3 G3 F3 E3 D3'),
  sung(24, 'en', 'Through cables humming in the night,', JOE, 'F3 F3 A3 C4 A3 G3 F3 E3'),
  sung(26, 'en', 'my signal finds your window.', JOE, 'E3 E3 G3 E3 D3 C3'),
  // Couplet français, avec un clin d'œil à Kaos.
  sung(28, 'fr', 'J’ai appris ton nom en binaire.', TOM, 'D3 D3 F3 A3 G3 F3 E3 D3'),
  sung(30, 'fr', 'Mon cœur clignote dans la nuit.', TOM, 'D3 F3 A3 A3 G3 F3 E3 D3'),
  sung(32, 'fr', 'Kaos apporte une lettre de lumière,', TOM, 'F3 F3 A3 C4 A3 G3 F3 E3'),
  sung(34, 'fr', 'et la machine sourit.', TOM, 'E3 E3 G3 E3 D3 C3'),
  ...chorus(36, 2),
  { bar: 44, segments: [['fr', 'Fin de transmission.']], voice: robot('E3'), legato: true },
  { bar: 46, segments: [['de', 'Datenherz.']], voice: robot('B2'), legato: true },
]

/** Riff d'introduction (original), en croches sur deux mesures, en ré mineur. */
const RIFF = 'D4 F4 A4 D5 C5 A4 F4 A4 D4 F4 A4 C5 A#4 A4 G4 F4'

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

function kick(): Float32Array {
  const out = seconds(0.5)
  const click = new Filter()
  let phase = 0
  out.forEach((_, index) => {
    const time = index / SR
    phase += (48 + 112 * Math.exp(-time / 0.03)) / SR
    const body = Math.sin(2 * Math.PI * phase) * Math.exp(-time / 0.22)
    const attack = click.process(noise(), 3_000, 0.3, 'high') * Math.exp(-time / 0.004) * 0.7
    out[index] = drive(body + attack, 1.8)
  })
  return out
}

function snare(): Float32Array {
  const out = seconds(0.35)
  const band = new Filter()
  const high = new Filter()
  out.forEach((_, index) => {
    const time = index / SR
    const bursts = [0, 0.011, 0.022].reduce((sum, onset) =>
      sum + (time >= onset ? Math.exp(-(time - onset) / (onset < 0.02 ? 0.006 : 0.1)) : 0), 0)
    const clap = band.process(noise() * bursts, 1_300, 0.4, 'band') * 1.5
    const body = Math.sin(2 * Math.PI * 185 * time) * Math.exp(-time / 0.07) * 0.6
    const sizzle = high.process(noise(), 5_000, 0.2, 'high') * Math.exp(-time / 0.12) * 0.35
    out[index] = drive(clap + body + sizzle, 1.4)
  })
  return out
}

function hat(length: number): Float32Array {
  const out = seconds(length * 4)
  const filter = new Filter()
  out.forEach((_, index) => {
    out[index] = filter.process(noise(), 8_000, 0.2, 'high') * Math.exp(-index / SR / length) * 0.5
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

function saw(frequency: number, length: number, cutoff: (time: number) => number, resonance: number,
  release: number, saturation: number, detune = 0): Float32Array {
  const out = seconds(length + release * 5)
  const filter = new Filter()
  const steps = detune ? [frequency * (1 - detune), frequency * (1 + detune)] : [frequency]
  const phases = steps.map((_, index) => index * 0.31)
  out.forEach((_, index) => {
    const time = index / SR
    let sum = 0
    steps.forEach((step, voice) => {
      const increment = step / SR
      phases[voice] = (phases[voice] + increment) % 1
      sum += 2 * phases[voice] - 1 - blep(phases[voice], increment)
    })
    const gate = time < length ? Math.min(1, time / 0.003) : Math.exp(-(time - length) / release)
    out[index] = drive(filter.process(sum / steps.length, cutoff(time), resonance, 'low'), saturation) * gate
  })
  return out
}

/** Basse « acide » : filtre résonant à enveloppe, saturée. */
const bassNote = (frequency: number, length: number, accent: boolean) =>
  saw(frequency, length, (time) => 160 + (accent ? 2_600 : 1_500) * Math.exp(-time / 0.08), 0.78, 0.01, 2.2)

const leadNote = (frequency: number, length: number) =>
  saw(frequency, length, (time) => 1_000 + 3_000 * Math.exp(-time / 0.12), 0.5, 0.05, 1.6, 0.0045)

function arpNote(frequency: number): Float32Array {
  const out = seconds(0.18)
  const filter = new Filter()
  let phase = 0
  out.forEach((_, index) => {
    const time = index / SR
    const step = frequency / SR
    phase = (phase + step) % 1
    const square = (phase < 0.5 ? 1 : -1) + blep(phase, step) - blep((phase + 0.5) % 1, step)
    out[index] = drive(filter.process(square, 3_200, 0.3, 'low'), 1.3) * Math.exp(-time / 0.06)
  })
  return out
}

function padChord(tones: number[], length: number): Float32Array {
  const out = seconds(length + 0.6)
  const filter = new Filter()
  const voices = tones.flatMap((tone, index) => [-0.005, 0.005].map((detune) => ({
    step: tone * (1 + detune) / SR, phase: (index * 0.37 + detune * 50) % 1,
  })))
  out.forEach((_, index) => {
    const time = index / SR
    let sum = 0
    for (const voice of voices) {
      voice.phase = (voice.phase + voice.step) % 1
      sum += 2 * voice.phase - 1 - blep(voice.phase, voice.step)
    }
    const envelope = Math.min(1, time / 0.3) * (time < length ? 1 : Math.exp(-(time - length) / 0.25))
    out[index] = filter.process(sum / voices.length, 1_600, 0.15, 'low') * envelope
  })
  return out
}

// ─── Accompagnement ───────────────────────────────────────────────────────

function arrange(): { drums: Track; music: Track; kicks: number[] } {
  const drums = new Track()
  const music = new Track()
  const kicks: number[] = []
  const [kickSound, snareSound, closedHat, openHat, crashSound] = [kick(), snare(), hat(0.03), hat(0.16), crash()]
  const riff = RIFF.split(' ')
  for (let bar = 0; bar < BARS; bar += 1) {
    const { section, chord: current } = BAR_MAP[bar]
    const next = BAR_MAP[bar + 1]?.section
    const start = bar * BAR
    const full = isChorus(section)
    const halfTime = section === 'bridge' && bar % 8 < 4
    for (let beat = 0; beat < 4; beat += 1) {
      const time = start + beat * BEAT
      const kickHere = section === 'outro' && bar === BARS - 1 ? beat === 0
        : halfTime ? beat === 0 || (beat === 2 && bar % 2 === 1)
          : true
      if (kickHere) { drums.add(kickSound, time, 0.95); kicks.push(time) }
      const snareHere = halfTime ? beat === 2 : section !== 'intro' && (beat === 1 || beat === 3)
      if (snareHere) drums.add(snareSound, time, 0.55, -0.08)
    }
    // Charleston : doubles croches accentuées sur les refrains, croches ailleurs.
    const sixteenths = full || section === 'pre' ? 16 : 8
    for (let step = 0; step < sixteenths; step += 1) {
      const time = start + step * BAR / sixteenths
      const offbeat = sixteenths === 16 ? step % 4 === 2 : step % 2 === 1
      if (full && offbeat) drums.add(openHat, time, 0.26, 0.35)
      else drums.add(closedHat, time, offbeat ? 0.3 : step % 2 === 0 ? 0.22 : 0.14, 0.35)
    }
    // Basse acide en doubles croches (croches sur les couplets, rondes en début de pont).
    if (bar >= 2 && !(section === 'outro' && bar === BARS - 1)) {
      if (halfTime) {
        music.add(bassNote(current.bass, BAR * 0.9, true), start, 0.34)
      } else {
        const steps = section === 'verse' ? 8 : 16
        const pattern = steps === 16 ? [1, 1, 2, 1, 1, 2, 1, 1.5] : [1, 1, 2, 1, 1, 2, 1, 1.5]
        for (let step = 0; step < steps; step += 1) {
          const length = BAR / steps
          music.add(bassNote(current.bass * pattern[step % pattern.length], length * 0.65, step % 4 === 0), start + step * length, 0.34)
        }
      }
    }
    if (section === 'pre' || full || section === 'bridge' || (section === 'outro' && bar === BARS - 4)) {
      const length = section === 'outro' ? 3 * BAR : BAR
      music.add(padChord(current.tones, length), start, 0.12, -0.35)
      music.add(padChord(current.tones.map((tone) => tone * 1.003), length), start, 0.12, 0.35)
    }
    if (full) {
      const notes = [...current.tones, current.tones[1]].map((tone) => tone * 2)
      for (let sixteenth = 0; sixteenth < 16; sixteenth += 1) {
        music.add(arpNote(notes[sixteenth % notes.length]), start + sixteenth * BEAT / 4, 0.07, sixteenth % 2 === 0 ? -0.6 : 0.6)
      }
    }
    // Riff : introduction, pont (en ré mineur et mi) et dernier refrain un ton plus haut.
    const riffShift = section === 'intro' ? 0 : section === 'final' || section === 'outro' ? 2 : undefined
    if (riffShift !== undefined && bar < BARS - 1) {
      for (let eighth = 0; eighth < 8; eighth += 1) {
        const note = transpose(riff[(bar % 2) * 8 + eighth], riffShift)
        music.add(leadNote(hz(note), BEAT / 2 * 0.8), start + eighth * BEAT / 2, section === 'final' ? 0.08 : 0.16, 0.15)
      }
    }
    // Montée de bruit avant chaque refrain, cymbale à son arrivée.
    if (next !== undefined && isChorus(next) && !isChorus(section)) drums.add(riser(BAR), start, 0.5)
    if (full && BAR_MAP[bar - 1]?.section !== section) drums.add(crashSound, start, 0.45, 0.2)
  }
  drums.add(kickSound, BARS * BAR, 0.95)
  drums.add(crashSound, BARS * BAR, 0.4)
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
type TimelineLine = { start: number; end: number; section: Section; style: string; segments: Array<[Language, string]> }
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
      timeline.push({ start: line.bar * BAR, end: line.bar * BAR + length, section: BAR_MAP[line.bar].section, style: 'vocodé', segments: line.segments })
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
    timeline.push({ start: line.bar * BAR, end: line.bar * BAR + length, section: BAR_MAP[line.bar].section, style: styleOf(line), segments: line.segments })
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

const { drums, music, kicks } = arrange()
const { effects: vocals, clear: spokenVocals } = await sing()
voiceChain(vocals)
clearChain(spokenVocals)
const dry = sum([[vocals, 1], [spokenVocals, 1]])
echo(vocals, 0.12)
const voiceLevel = envelopeOf(dry, 0.008, 0.2)
pump(music, kicks, 0.45)
carve(music, voiceLevel, 0.85, 0.3)
carve(drums, voiceLevel, 0.5, 0.1)
const mix = sum([[drums, 0.8], [music, 0.75], [vocals, 1.7], [spokenVocals, 1.7]])
if (process.env.DEMO_STEMS) {
  // Pistes au niveau du mix, avant mastering, pour mesurer le masquage.
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'bus-voix.wav'), new Uint8Array(encodeWav(sum([[vocals, 1.7], [spokenVocals, 1.7]]).channels(), SR)))
  await writeFile(join(outputDirectory, 'bus-musique.wav'), new Uint8Array(encodeWav(sum([[drums, 0.8], [music, 0.75]]).channels(), SR)))
}
master(mix, 1.8)
const instrumental = sum([[drums, 0.8], [music, 0.75]])
master(instrumental, 1.5)
master(dry, 1.2)
await mkdir(outputDirectory, { recursive: true })
const write = (name: string, track: Track) =>
  writeFile(join(outputDirectory, name), new Uint8Array(encodeWav(track.channels(), SR)))
await write('datenherz.wav', mix)
await write('datenherz-voix.wav', dry)
await write('datenherz-instrumental.wav', instrumental)
const sections: Array<{ section: Section; start: number; end: number }> = []
BAR_MAP.forEach(({ section }, bar) => {
  const last = sections.at(-1)
  if (last && last.section === section) last.end = (bar + 1) * BAR
  else sections.push({ section, start: bar * BAR, end: (bar + 1) * BAR })
})
await writeFile(join(outputDirectory, 'datenherz.json'), JSON.stringify({ bpm: BPM, duration: TOTAL / SR, sections, lines: timeline }, null, 2))
console.log(`→ ${join(outputDirectory, 'datenherz.wav')} (${(TOTAL / SR).toFixed(1)} s, ${BPM} BPM, ${BARS} mesures)`)
