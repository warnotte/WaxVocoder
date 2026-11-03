/**
 * The display's band meter: one column of segments per frequency band, like
 * the LED bars of a hardware vocoder, lit by whatever voice is playing. Unlit
 * segments stay faintly visible, as on a real vacuum fluorescent display.
 */
const BANDS = 24
const SEGMENTS = 12
const LOW_HZ = 90
const HIGH_HZ = 9_000
/** dB range mapped onto the column: quieter is dark, louder fills it. */
const FLOOR_DB = -92
const CEILING_DB = -28

export class BandMeter {
  private readonly canvas: HTMLCanvasElement
  private readonly analysers = new Set<AnalyserNode>()
  private readonly levels = new Float32Array(BANDS)
  private readonly peaks = new Float32Array(BANDS)
  private frame = 0
  private quietFrames = 0
  private spectrum = new Float32Array(0)

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    new ResizeObserver(() => this.draw()).observe(canvas)
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw())
  }

  /** Listens to `node` (an AudioWorklet voice or a buffer source); returns a function that stops listening. */
  attach(context: BaseAudioContext, node: AudioNode): () => void {
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.55
    node.connect(analyser)
    this.analysers.add(analyser)
    this.start()
    return () => {
      this.analysers.delete(analyser)
      try {
        node.disconnect(analyser)
      } catch {
        // Already disconnected with its context.
      }
    }
  }

  /** Starts drawing again, e.g. when a voice that is already attached plays again. */
  wake(): void {
    this.start()
  }

  private start(): void {
    this.quietFrames = 0
    if (!this.frame) this.frame = requestAnimationFrame(this.tick)
  }

  private readonly tick = () => {
    this.frame = 0
    this.measure()
    this.draw()
    const loud = this.levels.some((level) => level > 0.02) || this.peaks.some((peak) => peak > 0.02)
    this.quietFrames = loud ? 0 : this.quietFrames + 1
    if (this.analysers.size > 0 && this.quietFrames < 90) this.frame = requestAnimationFrame(this.tick)
  }

  private measure(): void {
    const next = new Float32Array(BANDS)
    for (const analyser of this.analysers) {
      if (this.spectrum.length !== analyser.frequencyBinCount) this.spectrum = new Float32Array(analyser.frequencyBinCount)
      analyser.getFloatFrequencyData(this.spectrum)
      const binHz = analyser.context.sampleRate / analyser.fftSize
      for (let band = 0; band < BANDS; band += 1) {
        const low = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (band / BANDS)
        const high = LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((band + 1) / BANDS)
        let power = 0
        let count = 0
        for (let bin = Math.floor(low / binHz); bin <= Math.ceil(high / binHz) && bin < this.spectrum.length; bin += 1) {
          power += 10 ** (this.spectrum[bin] / 10)
          count += 1
        }
        // Speech falls about 6 dB per octave: tilt it up so the highs show.
        const tilt = 6 * Math.log2(Math.sqrt(low * high) / 500)
        const decibels = 10 * Math.log10(power / Math.max(1, count) + 1e-20) + tilt
        next[band] = Math.max(next[band], Math.min(1, Math.max(0, (decibels - FLOOR_DB) / (CEILING_DB - FLOOR_DB))))
      }
    }
    for (let band = 0; band < BANDS; band += 1) {
      this.levels[band] = next[band]
      this.peaks[band] = Math.max(next[band], this.peaks[band] - 0.012)
    }
  }

  private draw(): void {
    const { canvas } = this
    const ratio = Math.min(2, devicePixelRatio || 1)
    const width = Math.round(canvas.clientWidth * ratio)
    const height = Math.round(canvas.clientHeight * ratio)
    if (!width || !height) return
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const context = canvas.getContext('2d')
    if (!context) return
    const styles = getComputedStyle(canvas)
    const lit = styles.getPropertyValue('--glow').trim() || '#8cf5d2'
    const unlit = styles.getPropertyValue('--glow-faint').trim() || '#2f5c50'
    context.clearRect(0, 0, width, height)
    const gap = Math.max(2, Math.round(width / BANDS / 6))
    const columnWidth = (width - gap * (BANDS - 1)) / BANDS
    const rowGap = Math.max(2, Math.round(height / SEGMENTS / 5))
    const segmentHeight = (height - rowGap * (SEGMENTS - 1)) / SEGMENTS
    for (let band = 0; band < BANDS; band += 1) {
      const x = band * (columnWidth + gap)
      const litSegments = Math.round(this.levels[band] * SEGMENTS)
      const peakSegment = Math.round(this.peaks[band] * SEGMENTS) - 1
      for (let segment = 0; segment < SEGMENTS; segment += 1) {
        const y = height - (segment + 1) * segmentHeight - segment * rowGap
        const on = segment < litSegments || (segment === peakSegment && segment > 0)
        context.globalAlpha = on ? 1 : 0.32
        context.fillStyle = on ? lit : unlit
        context.shadowColor = on ? lit : 'transparent'
        context.shadowBlur = on ? 8 * ratio : 0
        context.fillRect(x, y, columnWidth, segmentHeight)
      }
    }
    context.globalAlpha = 1
    context.shadowBlur = 0
  }
}
