// Clip « paroles » d'une chanson rendue par les scripts de chansons : écran de
// verre avec les barres du vocodeur (calculées sur la vraie voix, image par
// image), paroles tapées au rythme du chant, couleur par voix, centre de données
// dont les voyants suivent la batterie. La page scripts/clip/clip.html dessine
// chaque image ; un navigateur sans interface (Edge ou Chrome) la photographie
// et ffmpeg monte les images avec le son. Un fichier .srt accompagne la vidéo.
//
//   node scripts/clip.ts <chanson> <sortie.mp4> [options]
//
// <chanson> est le préfixe des fichiers rendus, par exemple
// ecoute/coeur-de-donnees-clip/coeur-de-donnees : il faut <chanson>.wav et
// <chanson>.json ; <chanson>-voix.wav et <chanson>-instrumental.wav sont
// utilisés s'ils existent (barres sur la voix seule, voyants sur la batterie).
//
// Options :
//   --title "…"      titre affiché (sinon tiré du nom de fichier)
//   --subtitle "…"   ligne sous le titre
//   --credits "…"    ligne de la carte de fin
//   --lang fr        langue principale (les autres sont signalées à l'écran)
//   --until 20       ne rend que les 20 premières secondes (essai)
//   --stills 5,30,80 ne fait que des images fixes (JPEG) à ces instants
//   --browser <exe>  navigateur à utiliser (sinon Edge, puis Chrome)
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { decodeWav } from '../src/audio/wav.ts'

const FPS = 30
const BANDS = 24
const WINDOW = 2048

type Timeline = {
  title?: string
  subtitle?: string
  credits?: string
  /** Name, colour and side of each voice, for songs that bring their own cast. */
  /** Names shown for the parts of the song, when they differ from the usual ones. */
  sectionNames?: Record<string, string>
  /** « aube » : the song ends at daybreak instead of the lights going out. */
  ending?: string
  /** Bips of the music (seconds, side -1 or 1, colours of both sides), drawn as a ping-pong ball. */
  bips?: { times: number[]; sides: number[]; colors: [number[], number[]] }
  /** Messages typed on the display during the break (seconds, side, header, text, colour). */
  log?: Array<{ at: number; side: number; header: string; text: string; color: number[] }>
  /** Pointed arches over the racks, lighting up stone after stone over the song. */
  nave?: boolean
  /** Seconds a line stays displayed after it is sung (0.9 by default). */
  hold?: number
  /** Story mode (a long song told in scenes): scenes, voice bugs, countdown, battle turns. */
  story?: Array<{ type: string; start: number; end: number }>
  glitches?: Array<{ start: number; end: number }>
  countdown?: Array<{ at: number; value: number }>
  turns?: Array<{ start: number; end: number; side: string }>
  cast?: Record<string, { label: string; color: [number, number, number]; side: 'left' | 'right' | 'center' }>
  bpm: number
  duration: number
  sections: { section: string; start: number; end: number }[]
  lines: { start: number; end: number; section: string; voice?: string; segments: [string, string][]; color?: number[]; label?: string }[]
}

// ----- Arguments -----

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  if (index < 0) return undefined
  const [, value] = args.splice(index, 2)
  return value
}
const titleOption = option('title')
const subtitleOption = option('subtitle')
const creditsOption = option('credits')
const mainLanguage = option('lang') ?? 'fr'
const until = option('until')
const stillsOption = option('stills')
const browserOption = option('browser')
const [songPrefix, outputPath] = args
if (!songPrefix || !outputPath) {
  console.error('Usage : node scripts/clip.ts <chanson> <sortie.mp4> [--until s] [--stills t1,t2] [--title …]')
  process.exit(1)
}

function defaultTitle(name: string) {
  const words = name.replace(/-clip$/, '').split('-')
  const text = words.join(' ').replace(/\bcoeur\b/g, 'cœur')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ----- Audio analysis -----

function mono(path: string) {
  const bytes = readFileSync(path)
  const { sampleRate, channels } = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer)
  const samples = new Float32Array(channels[0].length)
  for (const channel of channels) for (let i = 0; i < samples.length; i += 1) samples[i] += channel[i] / channels.length
  return { sampleRate, samples }
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k += 1) {
        const cos = Math.cos(step * k)
        const sin = Math.sin(step * k)
        const a = start + k
        const b = a + size / 2
        const tr = re[b] * cos - im[b] * sin
        const ti = re[b] * sin + im[b] * cos
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

/** Power spectrum (dB) of every video frame, in the given frequency bands. */
function bandLevels(samples: Float32Array, sampleRate: number, frames: number, edges: number[]) {
  const hann = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)))
  const binWidth = sampleRate / WINDOW
  const ranges = edges.slice(0, -1).map((low, band) => {
    const first = Math.max(1, Math.floor(low / binWidth))
    return [first, Math.max(first + 1, Math.ceil(edges[band + 1] / binWidth))]
  })
  const re = new Float64Array(WINDOW)
  const im = new Float64Array(WINDOW)
  const levels: Float64Array[] = []
  for (let frame = 0; frame < frames; frame += 1) {
    const centre = Math.round((frame / FPS) * sampleRate)
    for (let i = 0; i < WINDOW; i += 1) {
      re[i] = (samples[centre - WINDOW / 2 + i] ?? 0) * hann[i]
      im[i] = 0
    }
    fft(re, im)
    levels.push(Float64Array.from(ranges, ([first, last]) => {
      let power = 0
      for (let bin = first; bin < last; bin += 1) power += re[bin] * re[bin] + im[bin] * im[bin]
      return 10 * Math.log10(power / (last - first) + 1e-12)
    }))
  }
  return levels
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const round = (value: number) => Math.round(value * 100) / 100

/** The vocoder meter: 24 log-spaced bands, fast attack, slow release, falling peaks. */
function meterFrames(samples: Float32Array, sampleRate: number, frames: number) {
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => 90 * 100 ** (i / BANDS))
  const levels = bandLevels(samples, sampleRate, frames, edges)
  const loud = levels.flatMap((frame) => [...frame]).filter((value) => value > -100)
  const globalTop = percentile(loud, 0.995)
  // Each band is measured against its own loud moments (the voice is much
  // stronger in the low bands), pulled a little towards the global level.
  const tops = Array.from({ length: BANDS }, (_, band) => 0.55 * percentile(levels.map((frame) => frame[band]), 0.985) + 0.45 * globalTop)
  const range = 40
  const shown = new Float64Array(BANDS)
  const peaks = new Float64Array(BANDS)
  const holds = new Float64Array(BANDS)
  const bands: number[][] = []
  const peakFrames: number[][] = []
  for (const frame of levels) {
    for (let band = 0; band < BANDS; band += 1) {
      const target = clamp((frame[band] - (tops[band] - range)) / range) ** 1.2
      shown[band] += (target - shown[band]) * (target > shown[band] ? 0.75 : 0.22)
      if (shown[band] >= peaks[band]) {
        peaks[band] = shown[band]
        holds[band] = 14
      } else if (holds[band] > 0) holds[band] -= 1
      else peaks[band] = Math.max(shown[band], peaks[band] - 0.025)
    }
    bands.push(Array.from(shown, round))
    peakFrames.push(Array.from(peaks, round))
  }
  return { bands, peaks: peakFrames }
}

/** Kick pulses (low-band onsets) and overall energy of the backing, per frame. */
function rhythm(samples: Float32Array, sampleRate: number, frames: number) {
  const [low, all] = [[35, 140], [35, 12_000]].map((edges) => bandLevels(samples, sampleRate, frames, edges).map((frame) => frame[0]))
  const flux = low.map((value, frame) => Math.max(0, value - (low[frame - 1] ?? value)))
  const fluxTop = Math.max(1e-6, percentile(flux.filter((value) => value > 0), 0.97))
  const quiet = percentile(all, 0.1)
  const strong = percentile(all, 0.99)
  let pulse = 0
  let energy = 0
  const kick: number[] = []
  const energies: number[] = []
  for (let frame = 0; frame < frames; frame += 1) {
    pulse = Math.max(clamp(flux[frame] / fluxTop), pulse * 0.8)
    energy += (clamp((all[frame] - quiet) / Math.max(1, strong - quiet)) - energy) * 0.08
    kick.push(round(pulse))
    energies.push(round(energy))
  }
  return { kick, energy: energies }
}

// ----- Subtitles -----

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

function subtitles(lines: { start: number; end: number; text: string }[]) {
  return lines.map((line, index) => {
    const next = lines[index + 1]?.start ?? Infinity
    const end = Math.max(line.start + 0.5, Math.min(line.end + 0.9, next - 0.02))
    return `${index + 1}\n${srtTime(line.start)} --> ${srtTime(end)}\n${line.text}\n`
  }).join('\n')
}

// ----- DevTools protocol -----

class Page {
  private next = 0
  private readonly pending = new Map<number, (message: { result?: any; error?: { message: string } }) => void>()
  private readonly socket: WebSocket
  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      this.pending.get(message.id)?.(message)
      this.pending.delete(message.id)
    })
  }
  static async open(debugUrl: string) {
    const target = await (await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })).json()
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((done, fail) => {
      socket.addEventListener('open', done)
      socket.addEventListener('error', fail)
    })
    return new Page(socket)
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.next
    return new Promise((done, fail) => {
      this.pending.set(id, (message) => (message.error ? fail(new Error(`${method} : ${message.error.message}`)) : done(message.result)))
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(`Page : ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
    return result.value as T
  }
  close() {
    this.socket.close()
  }
}

function findBrowser() {
  const candidates = [
    browserOption,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  const found = candidates.find((path) => path && existsSync(path))
  if (!found) throw new Error('Aucun navigateur trouvé : indiquer --browser <chemin vers Edge ou Chrome>.')
  return found
}

async function launchBrowser(profile: string): Promise<{ browser: ChildProcess; debugUrl: string }> {
  const browser = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1920,1080', 'about:blank',
  ], { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (port) return { browser, debugUrl: `http://127.0.0.1:${port}` }
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  browser.kill()
  throw new Error('Le navigateur ne répond pas.')
}

// ----- Main -----

const timeline = JSON.parse(readFileSync(`${songPrefix}.json`, 'utf8')) as Timeline
const title = titleOption ?? timeline.title ?? defaultTitle(basename(songPrefix))
const subtitle = subtitleOption ?? timeline.subtitle ?? 'Voix WaxVocoder, rythmique EMX-1'
const credits = creditsOption ?? timeline.credits ?? 'Voix WaxVocoder (Piper : Tom, Jessica), rythmique EMX-1, 2026'
const mix = mono(`${songPrefix}.wav`)
const voice = existsSync(`${songPrefix}-voix.wav`) ? mono(`${songPrefix}-voix.wav`) : mix
const backing = existsSync(`${songPrefix}-instrumental.wav`) ? mono(`${songPrefix}-instrumental.wav`) : mix
const duration = mix.samples.length / mix.sampleRate
const frames = Math.ceil(duration * FPS)

console.log(`Analyse du son : ${duration.toFixed(1)} s, ${frames} images…`)
const meter = meterFrames(voice.samples, voice.sampleRate, frames)
// The backing shows dimly behind the voice, so the display lives between the lines too.
const music = backing === voice ? undefined : meterFrames(backing.samples, backing.sampleRate, frames).bands
const beat = rhythm(backing.samples, backing.sampleRate, frames)
const lines = timeline.lines.map((line) => ({
  start: line.start,
  end: line.end,
  section: line.section,
  voice: line.voice ?? 'Robot',
  text: line.segments.map(([, text]) => text).join(' '),
  parts: line.segments,
  langs: line.segments.map(([lang]) => lang),
  color: line.color,
  label: line.label,
}))
const pageData = JSON.stringify({
  fps: FPS, bpm: timeline.bpm, duration, title, subtitle, credits, mainLanguage,
  cast: timeline.cast, sectionNames: timeline.sectionNames, ending: timeline.ending, bips: timeline.bips, log: timeline.log, nave: timeline.nave, hold: timeline.hold,
  story: timeline.story, glitches: timeline.glitches, countdown: timeline.countdown, turns: timeline.turns, sections: timeline.sections, lines, frames: meter.bands, peaks: meter.peaks, music, kick: beat.kick, energy: beat.energy,
})

const output = resolve(outputPath)
mkdirSync(dirname(output), { recursive: true })
const stills = stillsOption?.split(',').map(Number).filter((time) => Number.isFinite(time))
if (!stills) writeFileSync(output.replace(/\.mp4$/i, '') + '.srt', subtitles(lines))

const server = await createServer({
  configFile: false,
  root: resolve(import.meta.dirname, 'clip'),
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5199 },
})
await server.listen()
const pageUrl = `${server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/'}clip.html`
const profile = mkdtempSync(join(tmpdir(), 'waxvocoder-clip-'))
const { browser, debugUrl } = await launchBrowser(profile)

try {
  const page = await Page.open(debugUrl)
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: pageUrl })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate<boolean>("typeof window.clipReady === 'object'").catch(() => false)) break
    await new Promise((done) => setTimeout(done, 100))
  }
  await page.evaluate('window.clipReady')
  await page.evaluate(`setClipData(${JSON.stringify(pageData)})`)
  const frame = async (index: number) => {
    const url = await page.evaluate<string>(`renderFrame(${index})`)
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
  }

  if (stills) {
    for (const time of stills) {
      const file = output.replace(/\.mp4$/i, '') + `-${String(time).replace('.', '_')}s.jpg`
      writeFileSync(file, await frame(Math.min(frames - 1, Math.round(time * FPS))))
      console.log(file)
    }
  } else {
    const last = until ? Math.min(frames, Math.ceil(Number(until) * FPS)) : frames
    const ffmpeg = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-i', resolve(`${songPrefix}.wav`), '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '256k', '-t', String(last / FPS), '-movflags', '+faststart', output,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })
    const finished = new Promise<number>((done) => ffmpeg.on('close', (code) => done(code ?? 1)))
    const started = Date.now()
    for (let index = 0; index < last; index += 1) {
      if (!ffmpeg.stdin.write(await frame(index))) await new Promise((done) => ffmpeg.stdin.once('drain', done))
      if (index % 300 === 299) {
        const rate = (index + 1) / ((Date.now() - started) / 1000)
        console.log(`  ${index + 1}/${last} images (${rate.toFixed(1)} par seconde, reste ${Math.round((last - index) / rate)} s)`)
      }
    }
    ffmpeg.stdin.end()
    if ((await finished) !== 0) throw new Error('ffmpeg a échoué.')
    console.log(`Clip : ${output}`)
  }
  page.close()
} finally {
  browser.kill()
  await server.close()
  await new Promise((done) => setTimeout(done, 500))
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
