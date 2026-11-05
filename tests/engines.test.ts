import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { before, describe, it } from 'node:test'
import initialize from '../src/wasm/voice-engine/voice_engine.js'
import { espeakSpeech, PIPER_VOICES, piperVoicesFor, resample, robotize, robotSettings } from '../src/engines/index.ts'
import { changeSpeed, framePitch, lofi, syllableBoundaries, vibrato } from '../src/engines/robot.ts'
import { PRESETS } from '../src/voice-settings.ts'
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

  it('apply every robot preset to an outside voice', () => {
    const speech = espeakSpeech(espeak.worker, 'fr', 'Bonjour, je suis une machine qui parle.')
    for (const [name, preset] of Object.entries(PRESETS)) {
      const robot = robotize(speech, robotSettings(preset.settings))
      assert.ok(robot.every(Number.isFinite), name)
      // A preset changes the voice in the robot stage, or in the effects that follow it (in the browser).
      if (name !== 'natural' && !preset.effects) assert.notEqual(robot, speech.samples, `${name} leaves the voice unchanged`)
    }
    // Size: a small robot is higher and faster, a giant lower and slower.
    assert.equal(robotize(speech, robotSettings(PRESETS.tinyRobot.settings)).length, Math.floor(speech.samples.length / 1.4))
    assert.equal(robotize(speech, robotSettings(PRESETS.giant.settings)).length, Math.floor(speech.samples.length / 0.72))
  })

  it('find one boundary between syllables, for one note each', () => {
    const rate = 22_050
    // Three 150 ms « vowels » separated by 80 ms of near silence.
    const samples = Float32Array.from({ length: Math.round(0.69 * rate) }, (_, index) => {
      const time = index / rate
      const vowel = time % 0.23 < 0.15
      return (vowel ? 0.5 : 0.01) * Math.sin(2 * Math.PI * 150 * time)
    })
    const boundaries = syllableBoundaries(samples, rate)
    assert.equal(boundaries.length, 2, JSON.stringify(boundaries))
    boundaries.forEach((boundary, index) => {
      const seconds = boundary / rate
      assert.ok(seconds > 0.15 + index * 0.23 - 0.03 && seconds < 0.23 + index * 0.23 + 0.03, `${seconds} s`)
    })
  })

  it('sing a melody with a glide and a vibrato on the carrier', () => {
    const speech = { samples: Float32Array.from({ length: 22_050 }, (_, index) => 0.3 * Math.sin(index / 7) * (index % 5000 < 3500 ? 1 : 0.01)), sampleRate: 22_050 }
    const melody = [220, 247, 262]
    const stepped = robotize(speech, { mix: 0.8, frequency: 220, chord: 0, melody })
    const sung = robotize(speech, { mix: 0.8, frequency: 220, chord: 0, melody, glide: 0.08, carrierVibrato: 0.4 })
    assert.equal(sung.length, stepped.length)
    assert.ok(sung.every(Number.isFinite))
    assert.ok(sung.some((sample, index) => Math.abs(sample - stepped[index]) > 1e-3), 'the glide and the vibrato change the sound')
    assert.deepEqual(robotize(speech, { mix: 0.8, frequency: 220, chord: 0, melody, glide: 0, carrierVibrato: 0 }), stepped, 'off by default')
  })

  it('follow the voice’s own pitch for the pop correction', () => {
    const rate = 22_050
    const voiced = Float32Array.from({ length: rate }, (_, index) => {
      const phase = ((index * 147) / rate) % 1
      return 0.4 * Math.exp(-5 * phase) * Math.sin(2 * Math.PI * 3 * phase)
    })
    const pitch = framePitch(voiced, rate / 2, rate)
    assert.ok(pitch !== undefined && Math.abs(pitch - 147) < 2, `pitch ${pitch}`)
    assert.equal(framePitch(new Float32Array(rate), rate / 2, rate), undefined)
    const pop = robotSettings(PRESETS.popRobot.settings)
    assert.equal(pop.follow, true)
    assert.equal(robotSettings(PRESETS.kraftwerk.settings).follow, false, 'Kraftwerk keeps its fixed note')
  })

  it('change speed, swing the pitch and crush the sound like the engine', () => {
    const tone = Float32Array.from({ length: 22_050 }, (_, index) => Math.sin((2 * Math.PI * 200 * index) / 22_050))
    assert.equal(changeSpeed(tone, 2).length, 11_025)
    assert.equal(changeSpeed(tone, 1), tone)
    const wobbly = vibrato(tone, 22_050, 2)
    assert.equal(wobbly.length, tone.length)
    assert.ok(wobbly.some((sample, index) => Math.abs(sample - tone[index]) > 0.1))
    const crushed = lofi(tone, 22_050, 1)
    assert.ok(new Set(crushed).size < 200, 'few distinct levels at full lo-fi')
    assert.equal(lofi(tone, 22_050, 0), tone)
  })

  it('resample between rates', () => {
    const ramp = Float32Array.from({ length: 100 }, (_, index) => index)
    const up = resample(ramp, 22_050, 44_100)
    assert.equal(up.length, 200)
    assert.equal(up[101], 50.5)
    assert.equal(resample(ramp, 48_000, 48_000), ramp)
  })
})

const SAMPLES = {
  fr: 'Bonjour, je suis une machine qui parle.',
  en: 'Hello, I am a machine that talks.',
  de: 'Hallo, ich bin eine Maschine, die spricht.',
} as const

describe('Piper voice catalogue', () => {
  it('offers voices for French, English and German, each key unique', () => {
    assert.equal(new Set(PIPER_VOICES.map((voice) => voice.key)).size, PIPER_VOICES.length)
    for (const language of ['fr', 'fr-CA', 'fr-BE', 'en', 'de'] as const) assert.ok(piperVoicesFor(language).length > 0, language)
    assert.deepEqual(piperVoicesFor('fr').map((voice) => voice.label).slice(0, 2), ['Siwis', 'Tom'])
  })
})

for (const voice of PIPER_VOICES) {
  const model = new URL(`../voices/${voice.id}/${voice.id}.onnx`, import.meta.url)
  const language = voice.languages[0] as keyof typeof SAMPLES
  describe(`Piper voice ${voice.key}`, { skip: existsSync(model) ? false : `voix absente : voices/${voice.id}/ (npm run voice -- ${language})` }, () => {
    it('speaks its language with every symbol known to the model', async () => {
      const config = JSON.parse(await readFile(new URL(`${voice.id}.onnx.json`, model), 'utf8')) as PiperConfig
      const ipa = piperPhonemes(espeak.worker, config.espeak.voice, SAMPLES[language])
      assert.deepEqual(phonemeIds(ipa, config.phoneme_id_map).missing, [], ipa)
      const piper = await PiperVoice.load(await import('onnxruntime-web'), await readFile(model), config)
      const samples = await piper.speak(ipa, { speaker: voice.speaker })
      const seconds = samples.length / piper.sampleRate
      assert.ok(seconds > 1 && seconds < 5, `${seconds} s`)
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
      assert.ok(rms > 0.02, `rms ${rms}`)
      // Piper draws its durations with some randomness: twice as slow is clearly longer, whatever the draw.
      const slower = await piper.speak(piperPhonemes(espeak.worker, config.espeak.voice, SAMPLES[language]), { lengthScale: 2, speaker: voice.speaker })
      assert.ok(slower.length > 1.15 * samples.length, `${(slower.length / samples.length).toFixed(2)} × only`)
    })
  })
}
