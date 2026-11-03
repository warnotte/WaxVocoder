import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { before, describe, it } from 'node:test'
import initialize from '../src/wasm/voice-engine/voice_engine.js'
import { espeakSpeech, PIPER_VOICES, resample, robotize } from '../src/engines/index.ts'
import { phonemeIds, type PiperConfig, piperPhonemes, PiperVoice } from '../src/engines/piper.ts'
import { type EspeakTranscriber, type EspeakWorker, loadEspeak } from '../src/espeak.ts'

let espeak: EspeakTranscriber

before(async () => {
  const wasm = await readFile(new URL('../src/wasm/voice-engine/voice_engine_bg.wasm', import.meta.url))
  await initialize({ module_or_path: await WebAssembly.compile(wasm) })
  espeak = await loadEspeak()
})

const MAP = { _: [0], '^': [1], $: [2], ' ': [3], ',': [8], '.': [10], b: [15], 'ɔ': [54], '̃': [141], ʒ: [108], ˈ: [120], u: [33], ʁ: [94] }

describe('Piper input', () => {
  it('turns IPA into phoneme ids padded between the start and end marks', () => {
    // « ɔ̃ » is two code points once decomposed: the vowel and the tilde.
    assert.deepEqual(phonemeIds('bɔ̃ʒˈuʁ.', MAP), {
      ids: [1, 0, 15, 0, 54, 0, 141, 0, 108, 0, 120, 0, 33, 0, 94, 0, 10, 0, 2],
      missing: [],
    })
    assert.deepEqual(phonemeIds('bɸ', MAP).missing, ['ɸ'])
  })

  it('phonemizes clause by clause with eSpeak NG, keeping the punctuation', () => {
    const worker: EspeakWorker = {
      set_voice: () => 0,
      synthesize_ipa: (text) => ({ ipa: text === 'Bonjour' ? 'b_ɔ̃_ʒ_ˈu_ʁ\n' : 'l_ə- (en)f_ˈʌ_n(fr)\n' }),
    }
    assert.equal(piperPhonemes(worker, 'fr', 'Bonjour, le fun.'), 'bɔ̃ʒˈuʁ, lə fˈʌn.')
    assert.throws(() => piperPhonemes({ ...worker, set_voice: () => 2 }, 'xx', 'Bonjour'), /voice « xx »/)
  })

  it('matches real eSpeak NG output to the French voice’s symbols', async () => {
    const config = { phoneme_id_map: MAP } as unknown as PiperConfig
    const ipa = piperPhonemes(espeak.worker, 'fr', 'Bonjour.')
    assert.equal(ipa, 'bɔ̃ʒˈuʁ.')
    assert.deepEqual(phonemeIds(ipa, config.phoneme_id_map).missing, [])
  })
})

describe('engines and robot stage', () => {
  it('give eSpeak NG’s own voice', () => {
    const { samples, sampleRate } = espeakSpeech(espeak.worker, 'fr', 'Bonjour, je suis une machine.')
    assert.equal(sampleRate, 22_050)
    assert.ok(samples.length > 0.8 * sampleRate)
    assert.ok(samples.every(Number.isFinite) && samples.some((sample) => Math.abs(sample) > 0.1))
  })

  it('vocode any voice, and leave it alone at mix 0', () => {
    const speech = espeakSpeech(espeak.worker, 'fr', 'Bonjour.')
    assert.equal(robotize(speech, { mix: 0, frequency: 98, chord: 5 }), speech.samples)
    const robot = robotize(speech, { mix: 1, frequency: 98, chord: 5 })
    assert.equal(robot.length, speech.samples.length)
    const peak = robot.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
    assert.ok(Math.abs(peak - 0.89) < 1e-3, `peak ${peak}`)
  })

  it('resample between rates', () => {
    const ramp = Float32Array.from({ length: 100 }, (_, index) => index)
    const up = resample(ramp, 22_050, 44_100)
    assert.equal(up.length, 200)
    assert.equal(up[101], 50.5)
    assert.equal(resample(ramp, 48_000, 48_000), ramp)
  })
})

const french = PIPER_VOICES.fr!
const model = new URL(`../voices/${french.id}/${french.id}.onnx`, import.meta.url)
describe('Piper voice', { skip: existsSync(model) ? false : `voix absente : voices/${french.id}/ (voir README)` }, () => {
  it('speaks French as long as the sentence needs', async () => {
    const config = JSON.parse(await readFile(new URL(`${french.id}.onnx.json`, model), 'utf8')) as PiperConfig
    const voice = await PiperVoice.load(await import('onnxruntime-web'), await readFile(model), config)
    const samples = await voice.speak(piperPhonemes(espeak.worker, config.espeak.voice, 'Bonjour, je suis une machine qui parle.'))
    const seconds = samples.length / voice.sampleRate
    assert.ok(seconds > 1.5 && seconds < 4, `${seconds} s`)
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
    assert.ok(rms > 0.02, `rms ${rms}`)
    const slower = await voice.speak(piperPhonemes(espeak.worker, 'fr', 'Bonjour.'), { lengthScale: 1.5 })
    const normal = await voice.speak(piperPhonemes(espeak.worker, 'fr', 'Bonjour.'))
    assert.ok(slower.length > 1.3 * normal.length)
  })
})
