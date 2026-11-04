/**
 * The robot stage for any voice (eSpeak NG, Piper…), on a finished buffer:
 * the same effects as WaxVocoder's own presets, done on audio.
 *
 * Order: size (tape speed: higher and faster, or lower and slower), vibrato,
 * channel vocoder (on a fixed note, or one note of the melody per syllable),
 * lo-fi (the engine's sample-and-hold and bit reduction).
 */
import { AudioVocoderEngine } from '../wasm/voice-engine/voice_engine.js'
import { noteFrequency, type VoiceSettings } from '../voice-settings.ts'

export type Speech = { samples: Float32Array; sampleRate: number }

export type RobotSettings = {
  /** Vocoder: 0 the voice as it is, 1 fully vocoded. */
  mix: number
  /** Carrier pitch in Hz when there is no melody. */
  frequency: number
  /** Carrier chord (see the engine's CHORDS). */
  chord: number
  /** Notes in Hz, one per syllable (cycled); empty for a fixed carrier. */
  melody?: readonly number[]
  /** Lo-fi amount (0–1). */
  lofi?: number
  /** Tape speed: above 1 a small robot (higher, faster), below 1 a giant. */
  size?: number
  /** Vibrato depth in semitones. */
  vibrato?: number
  /**
   * The carrier follows the voice's own pitch, snapped to the nearest
   * semitone: the « corrected » pop voice, for voices whose pitch WaxVocoder
   * does not control. Replaces `frequency` and `melody`.
   */
  follow?: boolean
}

/** The robot stage that matches a WaxVocoder preset. */
export function robotSettings(settings: VoiceSettings): RobotSettings {
  const melody = settings.melody.split(/\s+/).map(noteFrequency).filter((note): note is number => note !== undefined)
  // « Notes justes » without a vocoder snaps WaxVocoder's own pitch; for another voice, the vocoder does it.
  const follow = settings.quantize && settings.vocoder === 0
  return {
    follow,
    mix: follow ? 0.9 : settings.vocoder,
    frequency: settings.frequency,
    chord: settings.chord,
    melody,
    lofi: settings.lofi,
    size: settings.formantShift,
    vibrato: settings.vibrato,
  }
}

const VIBRATO_HZ = 5.5

/** Tape speed change: every frequency and the tempo are multiplied by `factor`. */
export function changeSpeed(samples: Float32Array, factor: number): Float32Array {
  if (Math.abs(factor - 1) < 1e-3) return samples
  const output = new Float32Array(Math.floor(samples.length / factor))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * factor
    const before = Math.floor(position)
    const after = Math.min(before + 1, samples.length - 1)
    output[index] = samples[before] + (samples[after] - samples[before]) * (position - before)
  }
  return output
}

/** Vibrato by a modulated delay: the pitch swings ± `semitones` at 5.5 Hz. */
export function vibrato(samples: Float32Array, sampleRate: number, semitones: number): Float32Array {
  if (semitones <= 0) return samples
  // The delay's slope sets the pitch ratio: 1 − dD/dt reaches 2^(−semitones/12).
  const depth = ((1 - 2 ** (-semitones / 12)) / (2 * Math.PI * VIBRATO_HZ)) * sampleRate
  const output = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const delay = depth * (1 + Math.sin((2 * Math.PI * VIBRATO_HZ * index) / sampleRate))
    const position = Math.max(0, index - delay)
    const before = Math.floor(position)
    const after = Math.min(before + 1, samples.length - 1)
    output[index] = samples[before] + (samples[after] - samples[before]) * (position - before)
  }
  return output
}

/** WaxVocoder's lo-fi: sample-and-hold down to about 6 kHz and 5 bits at full amount. */
export function lofi(samples: Float32Array, sampleRate: number, amount: number): Float32Array {
  if (amount <= 0) return samples
  const level = Math.min(1, amount)
  const rate = sampleRate * (6_000 / sampleRate) ** level
  const steps = 2 ** (15 - 11 * level)
  const output = new Float32Array(samples.length)
  let phase = 1
  let held = 0
  for (let index = 0; index < samples.length; index += 1) {
    phase += rate / sampleRate
    if (phase >= 1) {
      phase -= Math.floor(phase)
      held = Math.round(samples[index] * steps) / steps
    }
    output[index] = held
  }
  return output
}

/**
 * Syllable boundaries of speech, in samples: the quietest point between two
 * loudness peaks (vowel nuclei) at least 90 ms apart.
 */
export function syllableBoundaries(samples: Float32Array, sampleRate: number): number[] {
  const hop = Math.round(0.01 * sampleRate)
  const envelope: number[] = []
  for (let start = 0; start + hop <= samples.length; start += hop) {
    let sum = 0
    for (let index = start; index < start + hop; index += 1) sum += samples[index] ** 2
    envelope.push(Math.sqrt(sum / hop))
  }
  // Smooth over 50 ms, so that a single vowel gives a single peak.
  const smooth = envelope.map((_, index) => {
    const window = envelope.slice(Math.max(0, index - 2), index + 3)
    return window.reduce((sum, value) => sum + value, 0) / window.length
  })
  const loudest = Math.max(0, ...smooth)
  const peaks: number[] = []
  smooth.forEach((value, index) => {
    if (value < 0.2 * loudest || value < (smooth[index - 1] ?? 0) || value < (smooth[index + 1] ?? 0)) return
    const last = peaks.at(-1)
    if (last !== undefined && index - last < 9) {
      if (value > smooth[last]) peaks[peaks.length - 1] = index
      return
    }
    peaks.push(index)
  })
  const boundaries: number[] = []
  for (let peak = 1; peak < peaks.length; peak += 1) {
    let quietest = peaks[peak - 1]
    for (let index = peaks[peak - 1]; index <= peaks[peak]; index += 1) if (smooth[index] < smooth[quietest]) quietest = index
    boundaries.push(quietest * hop)
  }
  return boundaries
}

/**
 * Pitch at `center` (samples) by normalised autocorrelation over 30 ms, the
 * shortest lag close to the best one; undefined when quiet or not periodic.
 */
export function framePitch(samples: Float32Array, center: number, sampleRate: number): number | undefined {
  const window = Math.round(0.03 * sampleRate)
  const minLag = Math.floor(sampleRate / 400)
  const maxLag = Math.ceil(sampleRate / 60)
  const start = Math.round(center - (window + maxLag) / 2)
  if (start < 0 || start + window + maxLag >= samples.length) return undefined
  let energy = 0
  for (let index = 0; index < window; index += 1) energy += samples[start + index] ** 2
  if (energy / window < 1e-5) return undefined
  const correlation = new Float64Array(maxLag + 2)
  let best = 0
  for (let lag = minLag; lag <= maxLag + 1; lag += 1) {
    let product = 0
    let lagged = 0
    for (let index = 0; index < window; index += 1) {
      product += samples[start + index] * samples[start + index + lag]
      lagged += samples[start + index + lag] ** 2
    }
    correlation[lag] = product / Math.sqrt(energy * lagged + 1e-12)
    if (lag <= maxLag) best = Math.max(best, correlation[lag])
  }
  if (best < 0.5) return undefined
  for (let lag = minLag + 1; lag <= maxLag; lag += 1) {
    if (correlation[lag] >= 0.9 * best && correlation[lag] >= correlation[lag - 1] && correlation[lag] >= correlation[lag + 1]) {
      return sampleRate / lag
    }
  }
  return undefined
}

const snapToSemitone = (frequency: number) => 440 * 2 ** (Math.round(12 * Math.log2(frequency / 440)) / 12)

/** The channel vocoder on a fixed note, on the melody (one note per syllable), or on the voice's own pitch. */
function vocode(samples: Float32Array, sampleRate: number, settings: RobotSettings): Float32Array {
  const vocoder = new AudioVocoderEngine(sampleRate)
  vocoder.set_chord(settings.chord)
  vocoder.set_mix(settings.mix)
  // The whole voice band is vocoded.
  vocoder.set_split(60, 0.45 * sampleRate)
  const input = samples.map((sample) => sample * 0.5)
  const output = new Float32Array(input.length)
  const melody = settings.melody ?? []
  if (settings.follow) {
    // Every 10 ms, the carrier jumps to the voice's pitch rounded to a semitone (held through unvoiced parts).
    const block = Math.round(0.01 * sampleRate)
    let carrier = settings.frequency
    for (let start = 0; start < input.length; start += block) {
      const end = Math.min(start + block, input.length)
      const pitch = framePitch(samples, start + block / 2, sampleRate)
      if (pitch !== undefined) carrier = snapToSemitone(pitch)
      vocoder.set_frequency(carrier)
      const chunk = new Float32Array(end - start)
      vocoder.process(input.subarray(start, end), chunk)
      output.set(chunk, start)
    }
  } else {
    const starts = melody.length > 0 ? [0, ...syllableBoundaries(samples, sampleRate)] : [0]
    starts.forEach((start, syllable) => {
      const end = starts[syllable + 1] ?? input.length
      vocoder.set_frequency(melody.length > 0 ? melody[syllable % melody.length] : settings.frequency)
      const chunk = new Float32Array(end - start)
      vocoder.process(input.subarray(start, end), chunk)
      output.set(chunk, start)
    })
  }
  vocoder.free()
  return output
}

/** Every robot effect of `settings` on a voice; normalised to −1 dBFS when anything changed. */
export function robotize(speech: Speech, settings: RobotSettings): Float32Array {
  const { sampleRate } = speech
  let samples = changeSpeed(speech.samples, Math.min(2, Math.max(0.5, settings.size ?? 1)))
  samples = vibrato(samples, sampleRate, Math.min(3, settings.vibrato ?? 0))
  if (settings.mix > 0) samples = vocode(samples, sampleRate, settings)
  samples = lofi(samples, sampleRate, settings.lofi ?? 0)
  if (samples === speech.samples) return samples
  const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
  return peak > 0 ? samples.map((sample) => (sample / peak) * 0.89) : samples
}
