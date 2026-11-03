import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { parseDictionary } from '../src/dictionary.ts'
import { ARPABET, PHONEME_SYMBOLS, spellOut, stripDurations, transcribe, unknownPhonemeTokens } from '../src/phonemes.ts'

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
let lexicon: Map<string, string>

before(async () => {
  lexicon = parseDictionary(await read('../src/data/cmudict.txt'))
  const wasmBytes = await readFile(new URL('../src/wasm/voice-engine/voice_engine_bg.wasm', import.meta.url))
  await initialize({ module_or_path: await WebAssembly.compile(wasmBytes) })
})

describe('CMUdict lexicon', () => {
  it('keeps the license header out of the entries and the first pronunciation only', () => {
    assert.ok(lexicon.size > 120_000)
    assert.ok(![...lexicon.keys()].some((word) => word.startsWith(';;;')))
    assert.equal(lexicon.get('read'), 'R EH1 D')
    assert.equal(parseDictionary(';;; header\nab AE1 B\nab AA1 B\n').get('ab'), 'AA1 B')
  })

  it('embeds the CMU copyright notice in the shipped data', async () => {
    const data = await read('../src/data/cmudict.txt')
    assert.match(data.slice(0, 2_000), /;;; Copyright \(C\) 1993-2015 Carnegie Mellon University/)
  })
})

describe('English transcription', () => {
  it('uses dictionary pronunciations with stress, word boundaries and punctuation', () => {
    assert.equal(transcribe('We are the robots.', lexicon), 'W IY1 | AA1 R | DH AH0 | R OW1 B AA2 T S .')
    assert.equal(transcribe('Hello, world!?', lexicon), 'HH AH0 L OW1 , W ER1 L D ?')
  })

  it('keeps the Kraftwerk demo pronunciation', () => {
    assert.equal(transcribe('Kraftwerk', lexicon), 'K R AE1 F T V EH2 R K')
  })

  it('normalises accents and typographic apostrophes', () => {
    assert.equal(transcribe('Don’t', lexicon), 'D OW1 N T')
    assert.equal(transcribe('café', lexicon), lexicon.get('cafe'))
  })

  it('returns an empty sequence for punctuation-only input', () => {
    assert.equal(transcribe('!? 123', lexicon), '')
  })

  it('falls back to spelling rules for unknown words and without a lexicon', () => {
    assert.equal(spellOut('make'), 'M EY1 K')
    assert.equal(spellOut('knight'), 'N AY1 T')
    assert.equal(spellOut('phone'), 'F OW1 N')
    assert.equal(spellOut('taxi'), 'T AE1 K S IY0')
    const rules = transcribe('zorgblat quickly', undefined)
    assert.ok(rules.length > 0)
    assert.deepEqual(unknownPhonemeTokens(rules), [])
  })

  it('matches the default phrase shown by the interface', async () => {
    const html = await read('../index.html')
    const phrase = /<textarea id="phrase"[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1]
    const phonemes = /<textarea id="phonemes"[^>]*>([^<]*)<\/textarea>/.exec(html)?.[1]
    assert.ok(phrase && phonemes)
    assert.equal(transcribe(phrase, lexicon), phonemes)
  })
})

describe('phoneme editor validation', () => {
  it('reports unknown symbols and stress digits on consonants', () => {
    assert.deepEqual(unknownPhonemeTokens('K XX AE1 T1 | , _ zh ah0.'), ['XX', 'T1'])
    assert.deepEqual(unknownPhonemeTokens('B ON1 ZH U1 RX | UE EU2 AN IN UN NY UY X CC RX1'), ['RX1'])
  })

  it('accepts explicit durations and keeps the other colons as pauses', () => {
    assert.deepEqual(unknownPhonemeTokens('K:42 A2:93 O1:99 : L AX2:60, B:0 T:99999 S:x'), ['B:0', 'T:99999'])
    assert.equal(stripDurations('K:42 A2:93 | L AX2:60, S : X'), 'K A2 | L AX2, S : X')
  })
})

describe('Rust/WASM protocol compatibility', () => {
  it('exposes exactly the symbol set used by the interface, ARPAbet first', () => {
    const symbols = VoiceEngine.supported_phonemes().split(' ')
    assert.deepEqual(symbols, [...PHONEME_SYMBOLS])
    assert.deepEqual(symbols.slice(0, ARPABET.length), [...ARPABET])
  })

  it('accepts and renders every transcription of a reference corpus', () => {
    const corpus = [
      'We are the robots.',
      'Computer world, trans Europe express!',
      'Is this the voice of the machine?',
      'The quick brown fox jumps over the lazy dog.',
      'Kraftwerk zorgblat café.',
    ]
    for (const sentence of corpus) {
      const phonemes = transcribe(sentence, lexicon)
      const engine = new VoiceEngine(48_000)
      assert.equal(engine.set_phonemes(phonemes), 0, `unknown symbols in ${phonemes}`)
      assert.ok(engine.phone_count() > 0)
      engine.set_active(true)
      const output = new Float32Array(Math.ceil(engine.duration_seconds() * 48_000))
      engine.render(output)
      assert.equal(engine.is_active(), false)
      assert.ok(output.every((sample) => Number.isFinite(sample) && Math.abs(sample) < 1))
      assert.ok(Math.sqrt(output.reduce((sum, sample) => sum + sample * sample, 0) / output.length) > 0.01)
      engine.free()
    }
  })

  it('stays silent and inactive for pause-only input', () => {
    const engine = new VoiceEngine(48_000)
    assert.equal(engine.set_phonemes('_ , .'), 0)
    engine.set_active(true)
    assert.equal(engine.is_active(), false)
    assert.equal(engine.duration_seconds(), 0)
    engine.free()
  })
})
