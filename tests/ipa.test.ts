import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type EspeakEvent, EspeakTranscriber, type EspeakWorker, phonemeTimings, splitClauses } from '../src/espeak.ts'
import { ipaToPhonemes } from '../src/ipa.ts'
import { unknownPhonemeTokens } from '../src/phonemes.ts'

// Fixtures: real eSpeak NG output (scripts/espeak-ipa.mjs, 2026-11-03).
const convert = (ipa: string, language: 'en' | 'fr' | 'fr-CA' | 'de') => {
  const result = ipaToPhonemes(ipa, language)
  assert.deepEqual(result.unknown, [], `unknown IPA in ${ipa}`)
  assert.deepEqual(unknownPhonemeTokens(result.phonemes), [], `unknown symbols in ${result.phonemes}`)
  return result.phonemes
}

describe('eSpeak NG IPA → engine phonemes', () => {
  it('converts French with nasal vowels, uvular R and group-final stress', () => {
    assert.equal(convert('b_ɔ̃_ʒ_ˈu_ʁ', 'fr'), 'B ON2 ZH U1 RX')
    assert.equal(convert('œ̃ b_ˈɔ̃ v_ˈɛ̃ b_l_ˈɑ̃', 'fr'), 'UN2 | B ON1 | V IN1 | B L AN1')
    assert.equal(convert('y_n b_ʁ_ˈy_n e l_ə- ʃ_ˈa', 'fr'), 'UE2 N | B RX UE1 N | E2 | L AX2 | SH A1')
    assert.equal(convert('n_u s_ɔ_m l_e- m_a_ʃ_ˈi_n', 'fr'), 'N U2 | S AO2 M | L E2 | M A2 SH IY1 N')
  })

  it('turns French /y/ before a vowel into the glide /ɥ/', () => {
    assert.equal(convert('ʒ_ə- s_y_ˌi l_ˈa', 'fr'), 'ZH AX2 | S UY IY2 | L A1')
    assert.equal(convert('_w_ˈi', 'fr'), 'W IY1')
  })

  it('converts English with reduced vowels and r-colouring', () => {
    assert.equal(
      convert('w_ˈɛ_l_k_ʌ_m t_ə ð_ɪ_ ᵻ_l_ɛ_k_t_ɹ_ˈɑː_n_ɪ_k l_ˈæ_b_ɹ_ə_t_ˌɔː_ɹ_i', 'en'),
      'W EH1 L K AH0 M | T AH0 | DH IH0 | IH0 L EH0 K T R AA1 N IH0 K | L AE1 B R AH0 T AO2 R IY0',
    )
  })

  it('converts German with ich-Laut, front rounded vowels and diphthongs', () => {
    assert.equal(
      convert('_ɪ_ç b_ɪ_n _ˌaɪ_n_ə ʃ_p_ɾ_ˌɛ_ç_m_a_ʃ_ˈiː_n_ə_ _ˌaʊ_s d_eː_m l_ˈɑ_b_oː_ɾ', 'de'),
      'IH0 CC | B IH0 N | AY2 N AX0 | SH P RX EH2 CC M A0 SH IY1 N AX0 | AW2 S | D E0 M | L AA1 B O0 RX',
    )
    assert.equal(
      convert('ʃ_ˈøː_n_ə ɡ_ɾ_ˈyː_s_ə_ _ˌaʊ_s m_ˈʏ_n_ç_ə_n', 'de'),
      'SH EU1 N AX0 | G RX UE1 S AX0 | AW2 S | M UE1 N CC AX0 N',
    )
  })

  it('gives Québec French its [ts] and [dz] before /i/ and /y/', () => {
    assert.equal(convert('t_y d_ˈi', 'fr-CA'), 'T S UE2 | D Z IY1')
    assert.equal(convert('t_y d_ˈi', 'fr'), 'T UE2 | D IY1')
  })

  it('ignores the language switches eSpeak NG puts around loanwords', () => {
    assert.equal(convert('l_ə (en)f_ˈʌ_n(fr) m_ɔ̃ (en)tʃ_ˈʌ_m(fr)', 'fr-CA'), 'L AX2 | F AH1 N | M ON2 | CH AH1 M')
  })

  it('carries eSpeak NG durations onto the phones', () => {
    assert.equal(ipaToPhonemes('k_a_ˈo s_ə-', 'fr', [80, 93, 147, 73, 82]).phonemes, 'K:80 A2:93 O1:147 | S:73 AX2:82')
    // A segment that becomes two phones shares its time; a mismatched list is ignored.
    assert.equal(ipaToPhonemes('ts_ˈaɪ_t', 'de', [100, 150, 60]).phonemes, 'T:50 S:50 AY1:150 T:60')
    assert.equal(ipaToPhonemes('ts_ˈaɪ_t', 'de', [100, 150]).phonemes, 'T S AY1 T')
  })

  it('lengthens consonants too short for the engine from the longer neighbouring vowel', () => {
    // eSpeak NG blends /ʁ/ between vowels into them (« arrive »).
    assert.equal(ipaToPhonemes('a_ʁ_ˈi', 'fr', [113, 14, 192]).phonemes, 'A2:113 RX:35 IY1:171')
  })

  it('gives the Québec [ts] its own time', () => {
    assert.equal(ipaToPhonemes('t_y', 'fr-CA', [60, 100]).phonemes, 'T:33 S:52 UE2:75')
  })

  it('reports IPA it cannot map instead of failing', () => {
    const result = ipaToPhonemes('b_ˈa_ʙ', 'fr')
    assert.equal(result.phonemes, 'B A1')
    assert.deepEqual(result.unknown, ['ʙ'])
  })
})

describe('clauses and transcription', () => {
  it('splits text at punctuation and keeps the strongest mark', () => {
    assert.deepEqual(splitClauses('Bonjour, nous sommes là. Oui ?! Fin'), [
      { text: 'Bonjour', boundary: ',' },
      { text: 'nous sommes là', boundary: '.' },
      { text: 'Oui', boundary: '?' },
      { text: 'Fin', boundary: '' },
    ])
  })

  it('transcribes clause by clause with the language voice', () => {
    const calls: string[] = []
    const worker: EspeakWorker = {
      set_voice: (voice) => { calls.push(`voice ${voice}`) },
      synthesize_ipa: (text) => {
        calls.push(text)
        return { ipa: text === 'Bonjour' ? 'b_ɔ̃_ʒ_ˈu_ʁ\n' : 'ʃ_ˈa\n' }
      },
    }
    const result = new EspeakTranscriber(worker).transcribe('Bonjour, chat ?', 'fr')
    assert.equal(result.phonemes, 'B ON2 ZH U1 RX , SH A1 ?')
    assert.deepEqual(calls, ['voice fr', 'Bonjour', 'chat'])
    const missing: EspeakWorker = { set_voice: () => 2, synthesize_ipa: () => ({ ipa: '' }) }
    assert.throws(() => new EspeakTranscriber(missing).transcribe('Bonjour', 'fr'), /voice « fr »/)
  })

  it('times each clause from the synthesis events, or falls back to the rules', () => {
    const phoneme = (id: string, audio_position: number): EspeakEvent => ({ type: 'phoneme', id, audio_position })
    const worker: EspeakWorker = {
      set_voice: () => {},
      synthesize_ipa: (text) => ({ ipa: text === 'chat' ? 'ʃ_ˈa\n' : 'b_ˈa\n' }),
      synthesize: (text, callback) => {
        const events = text === 'chat'
          ? [phoneme('ʃ', 0), phoneme('ˈa', 90), phoneme('', 240)]
          : [phoneme('b', 0), phoneme('o', 60), phoneme('', 200)]
        callback(new Int16Array(5000).fill(8000), events)
      },
    }
    const result = new EspeakTranscriber(worker).transcribeTimed('chat, bas.', 'fr')
    assert.equal(result.phonemes, 'SH A1 , B A1 .')
    // « bas » : the events name another vowel, so the clause keeps the rules.
    assert.equal(result.timed, 'SH:90 A1:150 , B A1 .')
    assert.deepEqual([result.timedClauses, result.clauses], [1, 2])
  })
})

describe('eSpeak NG phoneme timings', () => {
  it('hands the silent closure filed under the previous phoneme back to the stop', () => {
    const rate = 22_050
    const audio = new Int16Array(Math.round(0.25 * rate))
    audio.forEach((_, index) => {
      const ms = (index / rate) * 1000
      audio[index] = ms < 60 || ms >= 100 ? (index % 2 ? 9000 : -9000) : 0
    })
    const events: EspeakEvent[] = [
      { type: 'phoneme', id: 'a', audio_position: 0 },
      { type: 'phoneme', id: 't', audio_position: 100 },
      { type: 'phoneme', id: 'ˈa', audio_position: 130 },
      { type: 'phoneme', id: '', audio_position: 250 },
    ]
    assert.deepEqual(phonemeTimings(audio, events, rate), { ids: ['a', 't', 'ˈa'], ms: [60, 70, 120] })
  })
})
