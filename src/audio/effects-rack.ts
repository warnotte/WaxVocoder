/**
 * Effects after any voice, with native Web Audio nodes, so that they work live
 * (AudioContext) and in exports (OfflineAudioContext) for every engine.
 *
 *   input ─ radio (band-pass and drive) ─ metal (ring modulator) ─┬─ dry ────────────┐
 *                                                                 ├─ width (doubles) ─┼─ output (stereo)
 *                                                                 ├─ echo (feedback) ─┤
 *                                                                 └─ space (reverb) ──┘
 */
export type EffectSettings = {
  /** Echo level (0–1); its feedback grows with it. */
  echo: number
  /** Echo time in seconds (0.05–0.8). */
  echoTime: number
  /** Reverberation level (0–1). */
  space: number
  /** Ring modulator (0–1): the metallic robot. */
  metal: number
  /** Loudspeaker: band-pass and drive (0–1). */
  radio: number
  /** Stereo doubling (0–1). */
  width: number
}

export const NO_EFFECTS: Readonly<EffectSettings> = { echo: 0, echoTime: 0.3, space: 0, metal: 0, radio: 0, width: 0 }

const RING_HZ = 52
const REVERB_SECONDS = 2.6

/** Seconds of sound the effects add after the voice ends (echo and reverberation tails). */
export function effectTail(settings: EffectSettings): number {
  const echo = settings.echo > 0 ? Math.min(4, settings.echoTime * 8) : 0
  return Math.max(echo, settings.space > 0 ? REVERB_SECONDS : 0, settings.width > 0 ? 0.05 : 0)
}

/** A stereo room: decaying noise, darker as it fades, different on each side. */
function impulseResponse(context: BaseAudioContext): AudioBuffer {
  const length = Math.round(REVERB_SECONDS * context.sampleRate)
  const impulse = context.createBuffer(2, length, context.sampleRate)
  let seed = 0x5eed
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel)
    let smooth = 0
    for (let index = 0; index < length; index += 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
      const noise = seed / 0x7fffffff - 0.5
      const progress = index / length
      // A one-pole low-pass whose cutoff falls with time: highs die first.
      const brightness = 0.6 - 0.5 * progress
      smooth += brightness * (noise - smooth)
      const predelay = index < 0.018 * context.sampleRate ? 0 : 1
      data[index] = predelay * smooth * (1 - progress) ** 3.2
    }
  }
  return impulse
}

/** A soft saturation curve for the loudspeaker. */
function driveCurve(): Float32Array {
  return Float32Array.from({ length: 1024 }, (_, index) => {
    const x = (index / 1023) * 2 - 1
    return Math.tanh(4 * x) / Math.tanh(4)
  })
}

export class EffectsRack {
  readonly input: GainNode
  readonly output: GainNode
  private readonly context: BaseAudioContext
  private readonly radioDry: GainNode
  private readonly radioWet: GainNode
  private readonly metalDry: GainNode
  private readonly metalWet: GainNode
  private readonly echoDelay: DelayNode
  private readonly echoFeedback: GainNode
  private readonly echoWet: GainNode
  private readonly spaceWet: GainNode
  private readonly widthWet: GainNode

  constructor(context: BaseAudioContext) {
    this.context = context
    const gain = (value = 1) => new GainNode(context, { gain: value })
    this.input = gain()
    this.output = gain()

    // Radio: telephone band, a nasal bump, then drive.
    this.radioDry = gain()
    this.radioWet = gain(0)
    const highPass = new BiquadFilterNode(context, { type: 'highpass', frequency: 420, Q: 0.9 })
    const lowPass = new BiquadFilterNode(context, { type: 'lowpass', frequency: 3_400, Q: 0.9 })
    const bump = new BiquadFilterNode(context, { type: 'peaking', frequency: 1_600, Q: 1.2, gain: 7 })
    const drive = new WaveShaperNode(context, { curve: driveCurve(), oversample: '2x' })
    const radioOut = gain()
    this.input.connect(this.radioDry).connect(radioOut)
    this.input.connect(highPass).connect(lowPass).connect(bump).connect(drive).connect(this.radioWet).connect(radioOut)

    // Metal: the voice multiplied by a low sine (a gain driven at audio rate from zero).
    this.metalDry = gain()
    this.metalWet = gain(0)
    const ring = gain(0)
    const oscillator = new OscillatorNode(context, { type: 'sine', frequency: RING_HZ })
    oscillator.connect(ring.gain)
    oscillator.start()
    const voice = gain()
    radioOut.connect(this.metalDry).connect(voice)
    radioOut.connect(ring).connect(this.metalWet).connect(voice)

    // Dry voice, centred.
    voice.connect(this.output)

    // Width: two short delays swaying slowly, one on each side.
    this.widthWet = gain(0)
    for (const [time, pan, rate] of [[0.013, -0.85, 0.31], [0.021, 0.85, 0.23]] as const) {
      const delay = new DelayNode(context, { delayTime: time, maxDelayTime: 0.05 })
      const sway = new OscillatorNode(context, { frequency: rate })
      const depth = gain(0.0025)
      sway.connect(depth).connect(delay.delayTime)
      sway.start()
      voice.connect(delay).connect(new StereoPannerNode(context, { pan })).connect(this.widthWet)
    }
    this.widthWet.connect(this.output)

    // Echo with feedback, a little to the side.
    this.echoDelay = new DelayNode(context, { delayTime: NO_EFFECTS.echoTime, maxDelayTime: 1 })
    this.echoFeedback = gain(0)
    this.echoWet = gain(0)
    const echoTone = new BiquadFilterNode(context, { type: 'lowpass', frequency: 3_800 })
    voice.connect(this.echoDelay)
    this.echoDelay.connect(echoTone).connect(this.echoFeedback).connect(this.echoDelay)
    echoTone.connect(this.echoWet).connect(new StereoPannerNode(context, { pan: 0.25 })).connect(this.output)

    // Space: convolution with a generated room.
    this.spaceWet = gain(0)
    voice.connect(new ConvolverNode(context, { buffer: impulseResponse(context) })).connect(this.spaceWet).connect(this.output)
  }

  /** Each parameter and the value the settings give it. */
  private targets(settings: EffectSettings): Array<[AudioParam, number]> {
    const clamp = (value: number) => Math.min(1, Math.max(0, value))
    const radio = clamp(settings.radio)
    const metal = clamp(settings.metal)
    const echo = clamp(settings.echo)
    return [
      [this.radioDry.gain, 1 - radio],
      [this.radioWet.gain, 0.75 * radio],
      [this.metalDry.gain, 1 - metal],
      [this.metalWet.gain, 1.4 * metal],
      [this.widthWet.gain, 0.6 * clamp(settings.width)],
      [this.echoDelay.delayTime, Math.min(0.8, Math.max(0.05, settings.echoTime))],
      [this.echoFeedback.gain, echo > 0 ? 0.2 + 0.45 * echo : 0],
      [this.echoWet.gain, 0.55 * echo],
      [this.spaceWet.gain, 0.9 * clamp(settings.space)],
    ]
  }

  /** Applies the settings, gliding over 30 ms to avoid clicks. */
  set(settings: EffectSettings): void {
    const now = this.context.currentTime
    for (const [param, value] of this.targets(settings)) param.setTargetAtTime(value, now, 0.03)
  }

  /** Sets every parameter at once, e.g. before an offline rendering. */
  setNow(settings: EffectSettings): void {
    for (const [param, value] of this.targets(settings)) {
      param.cancelScheduledValues(0)
      param.value = value
    }
  }
}

/** A finished voice through the effects, offline: stereo channels, with the tails. */
export async function renderEffects(samples: Float32Array, sampleRate: number, settings: EffectSettings): Promise<Float32Array[]> {
  const length = samples.length + Math.ceil(effectTail(settings) * sampleRate)
  const context = new OfflineAudioContext(2, length, sampleRate)
  const buffer = context.createBuffer(1, samples.length, sampleRate)
  buffer.copyToChannel(Float32Array.from(samples), 0)
  const source = new AudioBufferSourceNode(context, { buffer })
  const rack = new EffectsRack(context)
  rack.setNow(settings)
  source.connect(rack.input)
  rack.output.connect(context.destination)
  source.start()
  const rendered = await context.startRendering()
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)].map((channel) => Float32Array.from(channel))
  const peak = channels.reduce((max, channel) => channel.reduce((value, sample) => Math.max(value, Math.abs(sample)), max), 0)
  if (peak > 0.98) for (const channel of channels) channel.forEach((sample, index) => { channel[index] = (sample / peak) * 0.98 })
  return channels
}
