// Visite guidée audio de Wax Vocoder : une voix Piper présente chaque technique,
// puis la fait entendre (moteurs, langues, rythme, voix, vocoder, mélodie,
// préréglages, effets, chanson). Les effets, faits en Web Audio dans
// l'application, sont reproduits ici par un équivalent hors navigateur.
//
// Usage : npm run build:wasm && node scripts/visite-guidee.ts [dossier-de-sortie]
// (voix Piper dans voices/ : npm run voice -- fr, puis en et de ;
// extrait de chanson : node scripts/datenherz.ts d'abord).
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import EspeakInitializer from '@echogarden/espeak-ng-emscripten'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { decodeWav, encodeWav } from '../src/audio/wav.ts'
import { parseDictionary } from '../src/dictionary.ts'
import { espeakSpeech, PIPER_VOICES, resample, robotize, robotSettings, type RobotSettings } from '../src/engines/index.ts'
import { type PiperConfig, piperPhonemes, PiperVoice } from '../src/engines/piper.ts'
import { loadEspeak } from '../src/espeak.ts'
import { ESPEAK_LANGUAGES, type Language } from '../src/ipa.ts'
import { transcribe } from '../src/phonemes.ts'
import { applySettings, DEFAULT_SETTINGS, PRESETS, type VoiceSettings } from '../src/voice-settings.ts'

const SR = 44_100
const outputDirectory = process.argv[2] ?? 'ecoute/visite'
const root = new URL('../', import.meta.url)
await initialize({ module_or_path: await WebAssembly.compile(await readFile(new URL('src/wasm/voice-engine/voice_engine_bg.wasm', root))) })
const lexicon = parseDictionary(await readFile(new URL('src/data/cmudict.txt', root), 'utf8'))
const transcriber = await loadEspeak()
const worker = new (await EspeakInitializer()).eSpeakNGWorker()
const ort = await import('onnxruntime-web')

type Stereo = [Float32Array, Float32Array]
const mono = (samples: Float32Array): Stereo => [samples, samples]
const silence = (seconds: number): Stereo => mono(new Float32Array(Math.round(seconds * SR)))

/** Same peak for every example, a little louder for the narration. */
function level(stereo: Stereo, peakTarget = 0.7): Stereo {
  const peak = stereo.reduce((max, channel) => channel.reduce((value, sample) => Math.max(value, Math.abs(sample)), max), 0)
  return stereo.map((channel) => channel.map((sample) => (sample / Math.max(peak, 1e-4)) * peakTarget)) as Stereo
}

// ─── Voices ──────────────────────────────────────────────────────────────

function phonemesOf(text: string, language: Language, timed = true): string {
  if (language === 'en') return transcribe(text, lexicon)
  const result = transcriber.transcribeTimed(text, language)
  return timed ? result.timed : result.phonemes
}

/** WaxVocoder's own voice. */
function wax(text: string, language: Language, settings: VoiceSettings = DEFAULT_SETTINGS, timed = true): Float32Array {
  const engine = new VoiceEngine(SR)
  applySettings(engine, settings)
  engine.set_language(language)
  engine.set_phonemes(phonemesOf(text, language, timed))
  engine.set_active(true)
  const samples = new Float32Array(Math.ceil(engine.duration_seconds() * SR))
  engine.render(samples)
  engine.free()
  return samples
}

const piperVoices = new Map<string, PiperVoice>()
/** A Piper voice (by key), at 44.1 kHz, optionally through the robot stage. */
async function piper(text: string, key: string, robot?: RobotSettings): Promise<Float32Array> {
  const info = PIPER_VOICES.find((voice) => voice.key === key)!
  let voice = piperVoices.get(info.id)
  if (!voice) {
    const folder = new URL(`voices/${info.id}/`, root)
    const config = JSON.parse(await readFile(new URL(`${info.id}.onnx.json`, folder), 'utf8')) as PiperConfig
    voice = await PiperVoice.load(ort, await readFile(new URL(`${info.id}.onnx`, folder)), config)
    piperVoices.set(info.id, voice)
  }
  let samples = await voice.speak(piperPhonemes(worker, voice.config.espeak.voice, text), { speaker: info.speaker })
  if (robot) samples = robotize({ samples, sampleRate: voice.sampleRate }, robot)
  return resample(samples, voice.sampleRate, SR)
}

const NARRATOR = 'fr_FR-siwis-medium'
const say = async (text: string): Promise<Stereo> => level(mono(await piper(text, NARRATOR)), 0.78)

// ─── Effects (an offline equivalent of src/audio/effects-rack.ts) ────────

class Biquad {
  private b = [1, 0, 0]
  private a = [0, 0]
  private x = [0, 0]
  private y = [0, 0]
  constructor(type: 'lowpass' | 'highpass' | 'peaking', frequency: number, q: number, gainDb = 0) {
    const w = (2 * Math.PI * frequency) / SR
    const alpha = Math.sin(w) / (2 * q)
    const cos = Math.cos(w)
    const big = 10 ** (gainDb / 40)
    let b: number[]
    let a: number[]
    if (type === 'lowpass') { b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]; a = [1 + alpha, -2 * cos, 1 - alpha] }
    else if (type === 'highpass') { b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]; a = [1 + alpha, -2 * cos, 1 - alpha] }
    else { b = [1 + alpha * big, -2 * cos, 1 - alpha * big]; a = [1 + alpha / big, -2 * cos, 1 - alpha / big] }
    this.b = b.map((value) => value / a[0])
    this.a = [a[1] / a[0], a[2] / a[0]]
  }
  process(input: number): number {
    const output = this.b[0] * input + this.b[1] * this.x[0] + this.b[2] * this.x[1] - this.a[0] * this.y[0] - this.a[1] * this.y[1]
    this.x = [input, this.x[0]]
    this.y = [output, this.y[0]]
    return output
  }
}

type Effects = { echo?: number; echoTime?: number; space?: number; metal?: number; radio?: number; width?: number }

function applyEffects(samples: Float32Array, effects: Effects): Stereo {
  const tail = Math.round(((effects.space ?? 0) > 0 ? 2.6 : (effects.echo ?? 0) > 0 ? 1.5 : 0.05) * SR)
  const length = samples.length + tail
  const input = new Float32Array(length)
  input.set(samples)
  // Radio: telephone band, nasal bump, drive.
  const radio = effects.radio ?? 0
  const high = new Biquad('highpass', 420, 0.9)
  const low = new Biquad('lowpass', 3_400, 0.9)
  const bump = new Biquad('peaking', 1_600, 1.2, 7)
  // Metal: ring modulation by a 52 Hz sine.
  const metal = effects.metal ?? 0
  const voice = input.map((sample, index) => {
    const band = bump.process(low.process(high.process(sample)))
    const radioed = (1 - radio) * sample + 0.75 * radio * (Math.tanh(4 * band) / Math.tanh(4))
    return (1 - metal) * radioed + 1.4 * metal * radioed * Math.sin((2 * Math.PI * 52 * index) / SR)
  })
  const left = Float32Array.from(voice)
  const right = Float32Array.from(voice)
  // Width: two short delays, one on each side.
  const width = 0.6 * (effects.width ?? 0)
  if (width > 0) {
    const [d1, d2] = [Math.round(0.013 * SR), Math.round(0.021 * SR)]
    for (let index = 0; index < length; index += 1) {
      left[index] += width * 0.92 * (voice[index - d1] ?? 0)
      right[index] += width * 0.92 * (voice[index - d2] ?? 0)
    }
  }
  // Echo with feedback, a little to the right.
  const echo = effects.echo ?? 0
  if (echo > 0) {
    const delay = Math.round((effects.echoTime ?? 0.3) * SR)
    const feedback = 0.2 + 0.45 * echo
    const tone = new Biquad('lowpass', 3_800, 0.7)
    const line = new Float32Array(length)
    for (let index = 0; index < length; index += 1) {
      const back = index >= delay ? line[index - delay] : 0
      const fed = (index >= delay ? voice[index - delay] : 0) + feedback * back
      line[index] = tone.process(fed)
      left[index] += 0.55 * echo * 0.85 * line[index]
      right[index] += 0.55 * echo * line[index]
    }
  }
  // Space: a Schroeder–Moorer room (combs and all-passes, different on each side).
  const space = 0.9 * (effects.space ?? 0)
  if (space > 0) {
    for (const [channel, spread] of [[left, 0], [right, 23]] as const) {
      const combs = [1557, 1617, 1491, 1422].map((size) => ({ buffer: new Float32Array(size + spread), position: 0, store: 0 }))
      const passes = [225, 556].map((size) => ({ buffer: new Float32Array(size + spread), position: 0 }))
      for (let index = 0; index < length; index += 1) {
        let wet = 0
        for (const comb of combs) {
          const out = comb.buffer[comb.position]
          comb.store = out * 0.75 + comb.store * 0.25
          comb.buffer[comb.position] = voice[index] * 0.015 + comb.store * 0.84
          comb.position = (comb.position + 1) % comb.buffer.length
          wet += out
        }
        for (const pass of passes) {
          const out = pass.buffer[pass.position]
          pass.buffer[pass.position] = wet + out * 0.5
          wet = out - wet * 0.5
          pass.position = (pass.position + 1) % pass.buffer.length
        }
        channel[index] += space * wet
      }
    }
  }
  return [left, right]
}

const withPreset = (samples: Float32Array, name: string): Stereo => applyEffects(samples, PRESETS[name].effects ?? {})

// ─── The tour ────────────────────────────────────────────────────────────

const pieces: Stereo[] = []
const chapters: string[] = []
let time = 0
const add = (stereo: Stereo) => { pieces.push(stereo); time += stereo[0].length / SR }
const chapter = (title: string) => chapters.push(`${String(Math.floor(time / 60)).padStart(2, '0')}:${String(Math.floor(time % 60)).padStart(2, '0')}  ${title}`)
async function part(title: string, narration: string, examples: Array<Stereo | Promise<Stereo>>) {
  chapter(title)
  add(await say(narration))
  add(silence(0.45))
  for (const example of examples) {
    add(level(await example))
    add(silence(0.55))
  }
  add(silence(0.6))
}

const FR = 'Bonjour, je suis une machine qui parle et qui chante.'
add(silence(0.3))
chapter('Introduction')
add(await say('Bienvenue dans Wax Vocoder. Voici une petite visite guidée de tout ce que la machine sait faire.'))
add(silence(0.9))

await part('Le moteur WaxVocoder', 'Un. Le moteur WaxVocoder fabrique la voix de toutes pièces, avec des formants, comme les synthétiseurs vocaux des années quatre-vingt.', [
  mono(wax('Hello, I am a talking machine.', 'en')),
  mono(wax(FR, 'fr')),
])
await part('Les langues', 'Deux. Il parle anglais, allemand, et français de France, du Québec et de Belgique.', [
  mono(wax('Hallo, ich bin eine sprechende Maschine.', 'de')),
  mono(wax('Tu dis qu’il fait frette à matin.', 'fr-CA')),
  mono(wax('Septante-deux lettres et nonante colis, une fois !', 'fr-BE')),
])
await part('Le rythme de la langue', 'Trois. Le rythme de la langue. D’abord avec les règles du moteur, puis avec la durée de chaque son reprise à eSpeak.', [
  mono(wax(FR, 'fr', DEFAULT_SETTINGS, false)),
  mono(wax(FR, 'fr')),
])
await part('Le moteur eSpeak NG', 'Quatre. Le moteur eSpeak, avec sa propre voix.', [
  (() => { const speech = espeakSpeech(worker, ESPEAK_LANGUAGES.fr.voice, FR); return mono(resample(speech.samples, speech.sampleRate, SR)) })(),
])
await part('Les voix naturelles Piper', 'Cinq. Piper : des voix naturelles, apprises sur de vraies personnes.', [
  piper('Je m’appelle Siwis. Je lis tes textes avec plaisir.', 'fr_FR-siwis-medium').then(mono),
  piper('Je m’appelle Tom. Je lis tes textes avec plaisir.', 'fr_FR-tom-medium').then(mono),
  piper('Je m’appelle Pierre. Je lis tes textes avec plaisir.', 'fr_FR-upmc-medium:pierre').then(mono),
  piper('Je m’appelle Jessica. Je lis tes textes avec plaisir.', 'fr_FR-upmc-medium:jessica').then(mono),
  piper('My name is Joe. I will read your words.', 'en_US-joe-medium').then(mono),
  piper('Ich heiße Thorsten. Ich lese deine Texte.', 'de_DE-thorsten-medium').then(mono),
])
const ROBOT_LINE = 'Je suis un robot, et je chante sur une note.'
await part('Le vocodeur et ses porteuses', 'Six. Le vocodeur, avec ses porteuses : à l’unisson, en accord mineur, puis en accord majeur.', [0, 3, 4].map((chord) =>
  mono(wax(ROBOT_LINE, 'fr', { ...DEFAULT_SETTINGS, vocoder: 1, chord, intonation: 0, frequency: 110 }))))
await part('La mélodie et le tempo', 'Sept. La mélodie, une note par voyelle, calée sur le tempo.', [
  mono(wax('La machine chante pour toi ce soir', 'fr', {
    ...DEFAULT_SETTINGS, vocoder: 0.6, chord: 4, quantize: true, tempo: 104, intonation: 0, melody: 'D3 F3 A3 A3 G3 F3 E3 D3 D3', glide: 0.03,
  })),
])
chapter('Les préréglages')
add(await say('Huit. Les préréglages, chacun avec ses effets.'))
add(silence(0.5))
for (const [name, preset] of Object.entries(PRESETS)) {
  add(await say(`${preset.label}.`))
  add(silence(0.2))
  add(level(withPreset(wax('Je suis la voix de Wax Vocoder.', 'fr', preset.settings), name)))
  add(silence(0.5))
}
add(silence(0.4))
await part('Une vraie voix dans le vocodeur', 'Neuf. Une voix naturelle dans le vocodeur : la méthode des robots de l’époque.', [
  piper('Strom fließt durch mein Herz aus Glas.', 'de_DE-thorsten-medium', robotSettings(PRESETS.kraftwerk.settings)).then((samples) => applyEffects(samples, { echo: 0.18, echoTime: 0.27, space: 0.15 })),
])
await part('La correction pop', 'Dix. La correction pop : le vocodeur suit la hauteur de la voix, arrondie au demi-ton.', [
  piper('Ce soir je chante pour toi sous les néons de la ville.', 'fr_FR-upmc-medium:jessica', robotSettings(PRESETS.popRobot.settings)).then(mono),
])
const EFFECT_LINE = 'Le facteur arrive avec une lettre pour toi.'
const dry = await piper(EFFECT_LINE, 'fr_FR-tom-medium')
await part('Les effets', 'Onze. Les effets : écho, espace, métal, radio, et largeur.', [
  applyEffects(dry, { echo: 0.6, echoTime: 0.32 }),
  applyEffects(dry, { space: 0.7 }),
  applyEffects(dry, { metal: 0.85 }),
  applyEffects(dry, { radio: 0.8 }),
  applyEffects(dry, { width: 1 }),
])
const song = new URL('ecoute/datenherz/datenherz.wav', root)
if (existsSync(song)) {
  const { sampleRate, channels } = decodeWav((await readFile(song)).buffer as ArrayBuffer)
  const bar = (4 * 60) / 132
  const [from, to] = [Math.round(12 * bar * sampleRate), Math.round(20 * bar * sampleRate)]
  const excerpt = channels.map((channel) => {
    const part = resample(channel.subarray(from, to), sampleRate, SR)
    return part.map((sample, index) => sample * Math.min(1, index / (0.05 * SR), (part.length - index) / (1.2 * SR)))
  }) as Stereo
  await part('La chanson Datenherz', 'Et pour finir, un extrait de Datenherz, notre chanson en trois langues.', [excerpt])
}
chapter('Fin')
add(await say('Merci d’avoir écouté. Fin de la visite.'))
add(silence(1))

const total = pieces.reduce((length, [left]) => length + left.length, 0)
const out: Stereo = [new Float32Array(total), new Float32Array(total)]
let offset = 0
for (const [left, right] of pieces) {
  out[0].set(left, offset)
  out[1].set(right, offset)
  offset += left.length
}
await mkdir(outputDirectory, { recursive: true })
await writeFile(join(outputDirectory, 'visite-guidee.wav'), new Uint8Array(encodeWav(out, SR)))
await writeFile(join(outputDirectory, 'chapitres.txt'), `Wax Vocoder, visite guidée (${(total / SR / 60).toFixed(1)} min)\n\n${chapters.join('\n')}\n`)
console.log(chapters.join('\n'))
console.log(`→ ${join(outputDirectory, 'visite-guidee.wav')} (${(total / SR).toFixed(1)} s)`)

