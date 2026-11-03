// Runs the real eSpeak NG WebAssembly build (GPL-3.0) through the transcriber.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import initialize, { VoiceEngine } from '../src/wasm/voice-engine/voice_engine.js'
import { type EspeakTranscriber, loadEspeak } from '../src/espeak.ts'
import { stripDurations, unknownPhonemeTokens } from '../src/phonemes.ts'

let espeak: EspeakTranscriber

before(async () => {
  const wasm = await readFile(new URL('../src/wasm/voice-engine/voice_engine_bg.wasm', import.meta.url))
  await initialize({ module_or_path: await WebAssembly.compile(wasm) })
  espeak = await loadEspeak()
})

const corpus = {
  fr: [
    'Bonjour, je suis une machine qui parle.',
    'Un bon vin blanc, une brune et le chat. Est-ce que tu viens ?',
    'Le robot compte : un, deux, trois, quatre-vingt-dix-neuf !',
    'Il fait beau à Liège et à Montréal ; j’ai vingt ans.',
  ],
  'fr-CA': [
    'Salut, il fait frette à matin, pis la malle est arrivée.',
    'Tu dis que c’est le facteur le plus l’fun du quartier, mon chum !',
  ],
  'fr-BE': [
    'Bonjour, il est septante-cinq fois plus rapide, une fois !',
  ],
  de: [
    'Hallo, ich bin eine sprechende Maschine.',
    'Die Maschine spricht. Schöne Grüße aus München!',
    'Zwölf Boxkämpfer jagen Viktor quer über den großen Sylter Deich.',
  ],
  en: [
    'Welcome to the electronic laboratory.',
    'The quick brown fox jumps over the lazy dog?',
  ],
} as const

describe('eSpeak NG data in a browser-like setting', () => {
  it('uses the data fetched by the host, wherever the script was bundled', async () => {
    // A dev server answers unknown paths with the page: that must be reported, not parsed.
    const data = await readFile(new URL('../node_modules/@echogarden/espeak-ng-emscripten/espeak-ng.data', import.meta.url))
    const server = createServer((request, response) => {
      if (request.url === '/assets/espeak-ng-hash.data') response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(data)
      else response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>WaxVocoder</title>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      const fetched = await loadEspeak({ dataUrl: `http://127.0.0.1:${port}/assets/espeak-ng-hash.data` })
      assert.equal(fetched.transcribe('Bonjour.', 'fr').phonemes, 'B ON2 ZH U1 RX .')
      await assert.rejects(loadEspeak({ dataUrl: `http://127.0.0.1:${port}/espeak-ng.data` }), /answered with a web page/)
    } finally {
      server.close()
    }
  })
})

describe('eSpeak NG transcription', () => {
  it('maps every sound of the reference sentences', () => {
    for (const [language, sentences] of Object.entries(corpus)) {
      for (const sentence of sentences) {
        const { phonemes, unknown } = espeak.transcribe(sentence, language as keyof typeof corpus)
        assert.deepEqual(unknown, [], `${language}: unmapped IPA in « ${sentence} »`)
        assert.deepEqual(unknownPhonemeTokens(phonemes), [], phonemes)
        assert.ok(phonemes.length > 0)
      }
    }
  })

  it('loads a real eSpeak NG voice for every language, whatever came before', () => {
    // eSpeak NG keeps the previous voice when one is missing (it has no Québec voice).
    espeak.transcribe('Hello.', 'en')
    assert.equal(espeak.transcribe('Tu dis.', 'fr-CA').phonemes, 'T S UE2 | D Z IY1 .')
    for (const language of Object.keys(corpus) as Array<keyof typeof corpus>) {
      assert.doesNotThrow(() => espeak.transcribe('Bonjour.', language), language)
    }
  })

  it('gives the expected French and German pronunciations', () => {
    assert.equal(espeak.transcribe('Bonjour.', 'fr').phonemes, 'B ON2 ZH U1 RX .')
    assert.match(espeak.transcribe('Ich spreche.', 'de').phonemes, /^IH\d CC \| SH P RX EH1 CC AX0 \.$/)
  })

  it('gives every clause the rhythm of eSpeak NG, which the engine follows', () => {
    for (const language of ['fr', 'fr-CA', 'fr-BE', 'de'] as const) {
      for (const sentence of corpus[language]) {
        const result = espeak.transcribeTimed(sentence, language)
        assert.equal(result.timedClauses, result.clauses, `${language}: unaligned clause in « ${sentence} »`)
        assert.deepEqual(unknownPhonemeTokens(result.timed), [], result.timed)
        assert.equal(stripDurations(result.timed), result.phonemes)
        const spoken = [...result.timed.matchAll(/:(\d+)/g)].reduce((sum, [, ms]) => sum + Number(ms), 0) / 1000
        const engine = new VoiceEngine(44_100)
        engine.set_language(language)
        assert.equal(engine.set_phonemes(result.timed), 0)
        // The phones last what eSpeak said; only the punctuation pauses and the tail are added.
        const extra = engine.duration_seconds() - spoken
        assert.ok(extra >= 0 && extra < 1.2, `${language}: ${extra.toFixed(3)} s besides the phones in « ${sentence} »`)
        engine.free()
      }
    }
  })

  it('feeds phonemes the engine renders with the language rules', () => {
    for (const [language, sentences] of Object.entries(corpus)) {
      const engine = new VoiceEngine(44_100)
      engine.set_language(language)
      assert.equal(engine.set_phonemes(espeak.transcribe(sentences[0], language as keyof typeof corpus).phonemes), 0)
      engine.set_active(true)
      const output = new Float32Array(Math.ceil(engine.duration_seconds() * 44_100))
      engine.render(output)
      assert.equal(engine.is_active(), false)
      const rms = Math.sqrt(output.reduce((sum, sample) => sum + sample * sample, 0) / output.length)
      assert.ok(rms > 0.02, `${language} too quiet`)
      engine.free()
    }
  })
})
