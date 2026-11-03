import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import {
  applySettings,
  CHORDS,
  DEFAULT_SETTINGS,
  invalidNotes,
  PRESETS,
  type VoiceControls,
} from '../src/voice-settings.ts'

before(async () => {
  const wasm = await readFile(new URL('../src/wasm/voice-engine/voice_engine_bg.wasm', import.meta.url))
  await initialize({ module_or_path: await WebAssembly.compile(wasm) })
})

describe('voice settings', () => {
  it('apply every setting through its engine setter', () => {
    const calls: string[] = []
    const recorder = new Proxy({}, {
      get: (_target, name) => (...args: unknown[]) => {
        calls.push(`${String(name)}(${args.join(',')})`)
        return 0
      },
    }) as VoiceControls
    applySettings(recorder, { ...DEFAULT_SETTINGS, melody: 'C3', quantize: true })
    assert.equal(calls.length, Object.keys(DEFAULT_SETTINGS).length)
    assert.ok(calls.includes('set_melody(C3)'))
    assert.ok(calls.includes('set_quantize(true)'))
    assert.ok(calls.includes('set_formant_shift(1)'))
  })

  it('keep the chord list in step with the engine', () => {
    assert.equal(CHORDS.length, 6)
    for (const preset of Object.values(PRESETS)) assert.ok(preset.settings.chord < CHORDS.length)
  })

  it('flag melody tokens that are not notes', () => {
    assert.deepEqual(invalidNotes('C3 ré#2 sib1 Bb2 la3 H2 do 12'), ['H2', 'do', '12'])
  })

  it('render every preset with the real engine, bounded and audible', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      const engine = new VoiceEngine(44_100)
      applySettings(engine, preset.settings)
      assert.equal(engine.set_melody(preset.settings.melody), 0, `${name}: invalid melody`)
      assert.equal(engine.set_phonemes('W IY1 | AA1 R | DH AH0 | M AH0 SH IY1 N Z .'), 0)
      engine.set_active(true)
      const output = new Float32Array(Math.ceil(engine.duration_seconds() * 44_100))
      engine.render(output)
      assert.equal(engine.is_active(), false, `${name} did not finish`)
      assert.ok(output.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1), `${name} out of range`)
      const rms = Math.sqrt(output.reduce((sum, sample) => sum + sample * sample, 0) / output.length)
      assert.ok(rms > 0.02, `${name} too quiet (${rms})`)
      engine.free()
    }
  })
})
