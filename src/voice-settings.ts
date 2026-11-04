/** Every live setting of the voice engine, shared by the UI, the worklet and scripts. */
export type VoiceSettings = {
  /** Base pitch in Hz. */
  frequency: number
  /** Speaking rate multiplier. */
  rate: number
  /** 0 monotone robot, 1 lively contour. */
  intonation: number
  /** Vocoder mix, 0 dry to 1 fully vocoded. */
  vocoder: number
  /** Carrier chord index (see CHORDS). */
  chord: number
  /** Notes sung on successive vowels, e.g. "C3 D#3 G2" or "do2 ré#2 sol1". */
  melody: string
  /** Snap the pitch to semitones. */
  quantize: boolean
  /** Robot rhythm in BPM, 0 for natural timing. */
  tempo: number
  /** Talking-toy grit, 0 to 1. */
  lofi: number
  /** Resonance scale: above 1 small robot, below 1 giant. */
  formantShift: number
  /** Vibrato depth in semitones. */
  vibrato: number
  /** Pitch glide time in seconds. */
  glide: number
  /** Intelligibility in a mix: sharper source, louder consonants, brighter highs (0 to 1). */
  presence: number
}

/** The setters of the WASM VoiceEngine used to apply settings. */
export interface VoiceControls {
  set_frequency(frequency: number): void
  set_rate(rate: number): void
  set_intonation(amount: number): void
  set_vocoder(mix: number): void
  set_chord(chord: number): void
  set_melody(notes: string): number
  set_quantize(quantize: boolean): void
  set_tempo(bpm: number): void
  set_lofi(amount: number): void
  set_formant_shift(factor: number): void
  set_vibrato(semitones: number): void
  set_glide(seconds: number): void
  set_presence(amount: number): void
}

export const CHORDS = ['Unisson', 'Octave', 'Quinte + octave', 'Accord mineur', 'Accord majeur', 'Octave grave'] as const

export const DEFAULT_SETTINGS: Readonly<VoiceSettings> = {
  frequency: 110,
  rate: 1,
  intonation: 0.6,
  vocoder: 0,
  chord: 0,
  melody: '',
  quantize: false,
  tempo: 0,
  lofi: 0,
  formantShift: 1,
  vibrato: 0,
  glide: 0,
  presence: 0.5,
}

export const PRESETS: Readonly<Record<string, { label: string; settings: Readonly<VoiceSettings> }>> = {
  natural: { label: 'Voix naturelle', settings: DEFAULT_SETTINGS },
  kraftwerk: {
    label: 'Robot Kraftwerk',
    settings: { ...DEFAULT_SETTINGS, frequency: 98, intonation: 0, vocoder: 1, chord: 5, quantize: true, tempo: 112, presence: 0.8 },
  },
  singer: {
    label: 'Robot chanteur',
    settings: { ...DEFAULT_SETTINGS, vocoder: 0.85, chord: 2, melody: 'C3 C3 D#3 C3 G2 G2 A#2 C3', tempo: 100, intonation: 0, presence: 0.8 },
  },
  speakSpell: {
    label: 'Jouet parlant 1980',
    settings: { ...DEFAULT_SETTINGS, frequency: 120, intonation: 0.8, lofi: 0.85, formantShift: 1.08 },
  },
  tinyRobot: {
    label: 'Petit robot',
    settings: { ...DEFAULT_SETTINGS, frequency: 230, intonation: 1, formantShift: 1.4, vibrato: 0.6, glide: 0.06 },
  },
  giant: {
    label: 'Robot géant',
    settings: { ...DEFAULT_SETTINGS, frequency: 62, rate: 0.75, intonation: 0.5, formantShift: 0.72, glide: 0.15 },
  },
  wobbly: {
    label: 'Robot en panne',
    settings: { ...DEFAULT_SETTINGS, frequency: 140, intonation: 1, vibrato: 2.5, glide: 0.2, lofi: 0.4, rate: 0.85 },
  },
  // Spoken intonation snapped to semitones with a near-instant glide: the « corrected » pop voice.
  popRobot: {
    label: 'Pop robotique',
    settings: { ...DEFAULT_SETTINGS, frequency: 150, intonation: 1, quantize: true, glide: 0.012, presence: 0.8 },
  },
  // Parallel major chords on a simple tune: a choir of machines.
  choir: {
    label: 'Chœur de robots',
    settings: {
      ...DEFAULT_SETTINGS, vocoder: 1, chord: 4, melody: 'C3 E3 G3 E3 F3 A3 G3 E3', tempo: 92, intonation: 0, presence: 0.7,
    },
  },
  // Octave carrier sliding through a minor pentatonic, as a guitar talk box.
  talkBox: {
    label: 'Talk-box funk',
    settings: {
      ...DEFAULT_SETTINGS, vocoder: 0.85, chord: 1, melody: 'A2 C3 D3 E3 G3 E3 D3 C3', tempo: 104, glide: 0.08, vibrato: 0.35, intonation: 0, presence: 0.55,
    },
  },
  // Narrow, buzzy loudspeaker, slow and deliberate.
  station: {
    label: 'Annonce de gare',
    settings: { ...DEFAULT_SETTINGS, frequency: 125, rate: 0.88, intonation: 0.75, lofi: 0.45, presence: 1 },
  },
  // Calm, slightly synthetic ship computer: higher, restrained, a touch of vocoder.
  shipComputer: {
    label: 'Ordinateur de bord',
    settings: {
      ...DEFAULT_SETTINGS, frequency: 172, rate: 0.88, intonation: 0.25, formantShift: 1.12, vocoder: 0.22, chord: 1, glide: 0.04, presence: 0.8,
    },
  },
}

const SETTERS: { [Name in keyof VoiceSettings]: (engine: VoiceControls, value: VoiceSettings[Name]) => void } = {
  frequency: (engine, value) => engine.set_frequency(value),
  rate: (engine, value) => engine.set_rate(value),
  intonation: (engine, value) => engine.set_intonation(value),
  vocoder: (engine, value) => engine.set_vocoder(value),
  chord: (engine, value) => engine.set_chord(value),
  melody: (engine, value) => { engine.set_melody(value) },
  quantize: (engine, value) => engine.set_quantize(value),
  tempo: (engine, value) => engine.set_tempo(value),
  lofi: (engine, value) => engine.set_lofi(value),
  formantShift: (engine, value) => engine.set_formant_shift(value),
  vibrato: (engine, value) => engine.set_vibrato(value),
  glide: (engine, value) => engine.set_glide(value),
  presence: (engine, value) => engine.set_presence(value),
}

export function applySetting<Name extends keyof VoiceSettings>(
  engine: VoiceControls,
  name: Name,
  value: VoiceSettings[Name],
): void {
  SETTERS[name](engine, value)
}

export function applySettings(engine: VoiceControls, settings: VoiceSettings): void {
  for (const name of Object.keys(SETTERS) as Array<keyof VoiceSettings>) {
    applySetting(engine, name, settings[name])
  }
}

const NOTE = /^(?:[a-g]|do|ré|re|mi|fa|sol|la|si)(?:#|b|♯|♭)?-?\d$/i
const SOLFEGE: Readonly<Record<string, number>> = { do: 0, re: 2, mi: 4, fa: 5, sol: 7, la: 9, si: 11 }
const LETTERS: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

/**
 * Frequency of a note name, with the same conventions as the engine:
 * scientific pitch (A4 = 440 Hz) or French solfège (la3 = 440 Hz).
 */
export function noteFrequency(name: string): number | undefined {
  const match = /^(do|ré|re|mi|fa|sol|la|si|[a-g])(#|b|♯|♭)?(-?\d)$/i.exec(name.trim())
  if (!match) return undefined
  const base = match[1].toLowerCase().replace('é', 'e')
  const french = base in SOLFEGE
  const accidental = match[2] === '#' || match[2] === '♯' ? 1 : match[2] ? -1 : 0
  const midi = 12 * (Number(match[3]) + (french ? 2 : 1)) + (french ? SOLFEGE[base] : LETTERS[base]) + accidental
  return 440 * 2 ** ((midi - 69) / 12)
}

/** Melody tokens that are not note names (the engine also rejects out-of-range notes). */
export function invalidNotes(melody: string): string[] {
  return melody.split(/\s+/).filter((token) => token && !NOTE.test(token))
}
