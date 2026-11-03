import { isVowelSymbol, MAX_PHONE_MS } from './phonemes.ts'

/**
 * Languages transcribed through eSpeak NG. eSpeak NG has no Québec voice:
 * Québec French uses the French one, and WaxVocoder adds its traits ([ts] [dz]).
 */
export const ESPEAK_LANGUAGES = {
  en: { label: 'Anglais', voice: 'en-us' },
  fr: { label: 'Français', voice: 'fr' },
  'fr-CA': { label: 'Français (Québec)', voice: 'fr' },
  'fr-BE': { label: 'Français (Belgique)', voice: 'fr-be' },
  de: { label: 'Allemand', voice: 'de' },
} as const

export type Language = keyof typeof ESPEAK_LANGUAGES

/** IPA segments shared by every language, mapped to engine symbols. */
const COMMON: Readonly<Record<string, string>> = {
  // Diphthongs and affricates first: the matcher takes the longest key.
  'eɪ': 'EY', 'aɪ': 'AY', 'ɔɪ': 'OY', 'aʊ': 'AW', 'oʊ': 'OW', 'əʊ': 'OW', 'ɔʏ': 'OY', 'ɔø': 'OY',
  'tʃ': 'CH', 'dʒ': 'JH', 'ts': 'T S', 'pf': 'P F', 'ɪə': 'IH AX', 'eə': 'EH AX', 'ʊə': 'UH AX',
  // Nasal vowels (vowel + combining tilde).
  'ɛ̃': 'IN', 'ɑ̃': 'AN', 'ɔ̃': 'ON', 'œ̃': 'UN',
  // Oral vowels.
  'i': 'IY', 'ɪ': 'IH', 'ᵻ': 'IH', 'e': 'E', 'ɛ': 'EH', 'æ': 'AE', 'a': 'A', 'ɑ': 'AA', 'ɒ': 'AO',
  'ɔ': 'AO', 'o': 'O', 'ʊ': 'UH', 'ʌ': 'AH', 'ɐ': 'AH', 'ɜ': 'ER', 'ɚ': 'ER', 'ɝ': 'ER',
  'y': 'UE', 'ʏ': 'UE', 'ø': 'EU', 'œ': 'OE',
  // Consonants.
  'p': 'P', 'b': 'B', 't': 'T', 'd': 'D', 'k': 'K', 'ɡ': 'G', 'g': 'G', 'f': 'F', 'v': 'V',
  'θ': 'TH', 'ð': 'DH', 's': 'S', 'z': 'Z', 'ʃ': 'SH', 'ʒ': 'ZH', 'h': 'HH', 'x': 'X', 'χ': 'X',
  'ç': 'CC', 'm': 'M', 'n': 'N', 'ŋ': 'NG', 'ɲ': 'NY', 'l': 'L', 'ɫ': 'L', 'j': 'Y', 'w': 'W',
  'ɥ': 'UY', 'ʁ': 'RX', 'ʔ': '',
}

const FRENCH: Readonly<Record<string, string>> = { 'ə': 'AX', 'u': 'U', 'ɹ': 'RX', 'r': 'RX', 'ɾ': 'RX' }

/** Language-specific choices for segments that differ between languages. */
const BY_LANGUAGE: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  // English schwa is the reduced AH, /u/ is diphthongised UW, /ɾ/ is a flapped t or d.
  en: { 'ə': 'AH', 'u': 'UW', 'ɹ': 'R', 'r': 'R', 'ɾ': 'D' },
  fr: FRENCH,
  'fr-CA': FRENCH,
  'fr-BE': FRENCH,
  de: { 'ə': 'AX', 'u': 'U', 'ɹ': 'RX', 'r': 'RX', 'ɾ': 'RX' },
}

const isFrench = (language: Language) => language.startsWith('fr')

/** Language switches eSpeak NG inserts around loanwords, e.g. `(en)fʌn(fr)`. */
const LANGUAGE_SWITCH = /\([a-z]{2,3}(?:-[a-z]+)?\)/gi

/** Marks that carry no segment: length, syllable marks, ties, syllabicity. */
const IGNORED = /[ːˑ\-‿̩̯͜͡]/gu

export type Conversion = { phonemes: string; unknown: string[] }

/** One engine phone during conversion: symbol, stress digit and optional duration in ms. */
type Phone = { symbol: string; stress: string; ms?: number }

/** Segments of an IPA string, in the order eSpeak NG reports its phoneme events. */
export function ipaTokens(ipa: string): string[] {
  return ipa.replace(LANGUAGE_SWITCH, '').split(/[\s_]+/).filter(Boolean)
}

/**
 * Converts eSpeak NG IPA (segments joined by `_`, words separated by spaces)
 * into the engine protocol. Unstressed vowels take `0` in English and German;
 * French has no lexical stress, so they take `2` and only the group-final
 * vowel marked by eSpeak gets `1`.
 *
 * `durations`, when given, holds one duration in milliseconds per segment of
 * {@link ipaTokens}; the phones then carry them (`A1:93`) and the engine
 * follows that rhythm instead of its own rules.
 */
export function ipaToPhonemes(ipa: string, language: Language, durations?: readonly number[]): Conversion {
  const table: Record<string, string> = { ...COMMON, ...BY_LANGUAGE[language] }
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  const unstressed = isFrench(language) ? '2' : '0'
  const timed = durations !== undefined && durations.length === ipaTokens(ipa).length
  const unknown: string[] = []
  const words: Phone[][] = []
  let tokenIndex = 0
  // Duration of segments without a phone (glottal stop), given to the next phone.
  let carried = 0
  for (const word of ipa.replace(LANGUAGE_SWITCH, '').split(/\s+/)) {
    const phones: Phone[] = []
    for (const token of word.split('_')) {
      if (!token) continue
      const milliseconds = timed ? durations[tokenIndex] : undefined
      tokenIndex += 1
      const stress = token.includes('ˈ') ? '1' : token.includes('ˌ') ? '2' : undefined
      const segment = token.replace(/[ˈˌ]/g, '').replace(IGNORED, '').normalize('NFC')
      const produced: Phone[] = []
      let vowelSeen = false
      for (let index = 0; index < segment.length;) {
        const key = keys.find((candidate) => segment.startsWith(candidate.normalize('NFC'), index))
        if (!key) {
          unknown.push(segment[index])
          index += 1
          continue
        }
        index += key.normalize('NFC').length
        for (const symbol of table[key].split(' ').filter(Boolean)) {
          if (isVowelSymbol(symbol)) {
            produced.push({ symbol, stress: !vowelSeen && stress ? stress : unstressed })
            vowelSeen = true
          } else {
            produced.push({ symbol, stress: '' })
          }
        }
      }
      if (milliseconds === undefined) {
        phones.push(...produced)
      } else if (produced.length === 0) {
        carried += milliseconds
      } else {
        const share = (milliseconds + carried) / produced.length
        carried = 0
        phones.push(...produced.map((phone) => ({ ...phone, ms: share })))
      }
    }
    if (isFrench(language)) glideFrenchU(phones)
    if (language === 'fr-CA') assibilate(phones)
    if (phones.length > 0) words.push(phones)
  }
  const last = words.at(-1)?.at(-1)
  if (carried > 0 && last?.ms !== undefined) last.ms += carried
  if (timed) giveConsonantsTime(words.flat())
  return { phonemes: words.map((phones) => phones.map(formatPhone).join(' ')).join(' | '), unknown }
}

function formatPhone({ symbol, stress, ms }: Phone): string {
  if (ms === undefined) return `${symbol}${stress}`
  return `${symbol}${stress}:${Math.min(MAX_PHONE_MS, Math.max(1, Math.round(ms)))}`
}

/** Shortest consonant the engine can make heard; eSpeak NG blends some (/ʁ/ between vowels) into the vowels. */
const MIN_CONSONANT_MS = 35
const MIN_VOWEL_MS = 45

/** Shortest vowel kept: eSpeak NG sometimes leaves an unstressed vowel only a few periods long. */
const SHORTEST_VOWEL_MS = 40

/** Lengthens phones too short for the engine; a consonant takes the time from a neighbouring vowel. */
function giveConsonantsTime(phones: Phone[]): void {
  phones.forEach((phone, index) => {
    if (phone.ms === undefined) return
    if (isVowelSymbol(phone.symbol)) {
      phone.ms = Math.max(phone.ms, SHORTEST_VOWEL_MS)
      return
    }
    if (phone.ms >= MIN_CONSONANT_MS) return
    const missing = MIN_CONSONANT_MS - phone.ms
    const donor = [phones[index - 1], phones[index + 1]]
      .filter((other): other is Phone & { ms: number } => other?.ms !== undefined && isVowelSymbol(other.symbol))
      .sort((a, b) => b.ms - a.ms)[0]
    const given = donor ? Math.max(0, Math.min(missing, donor.ms - MIN_VOWEL_MS)) : 0
    if (donor) donor.ms -= given
    phone.ms += given
  })
}

const FRONT_CLOSE = ['IY', 'UE', 'Y', 'UY']

/**
 * Québec French: /t/ and /d/ become [ts] and [dz] before /i/, /y/ and their
 * glides (« tu dis »). With durations, the stop shares its time with the new
 * fricative, which also borrows a little from a long vowel.
 */
function assibilate(phones: Phone[]): void {
  for (let index = phones.length - 2; index >= 0; index -= 1) {
    const stop = phones[index]
    const next = phones[index + 1]
    if (!FRONT_CLOSE.includes(next.symbol)) continue
    const fricative = stop.symbol === 'T' ? 'S' : stop.symbol === 'D' ? 'Z' : undefined
    if (!fricative) continue
    const inserted: Phone = { symbol: fricative, stress: '' }
    if (stop.ms !== undefined) {
      const borrowed = next.ms === undefined ? 0 : Math.max(0, Math.min(25, next.ms - 50))
      inserted.ms = 0.45 * stop.ms + borrowed
      stop.ms *= 0.55
      if (next.ms !== undefined) next.ms -= borrowed
    }
    phones.splice(index + 1, 0, inserted)
  }
}

/** French /y/ before another vowel is the glide /ɥ/ (« suis », « nuit »). */
function glideFrenchU(phones: Phone[]): void {
  for (let index = 0; index + 1 < phones.length; index += 1) {
    if (phones[index].symbol === 'UE' && isVowelSymbol(phones[index + 1].symbol)) {
      phones[index] = { symbol: 'UY', stress: '', ms: phones[index].ms }
    }
  }
}
