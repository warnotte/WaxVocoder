/** ARPAbet symbols (the CMUdict set), first part of the engine inventory. */
export const ARPABET = [
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'B', 'CH', 'D', 'DH', 'EH', 'ER', 'EY', 'F', 'G',
  'HH', 'IH', 'IY', 'JH', 'K', 'L', 'M', 'N', 'NG', 'OW', 'OY', 'P', 'R', 'S', 'SH',
  'T', 'TH', 'UH', 'UW', 'V', 'W', 'Y', 'Z', 'ZH',
] as const

/**
 * Extensions for French and German: /e/ /a/ /o/ /u/ /y/ /ø/ /œ/ /ə/, nasal
 * vowels /ɑ̃/ /ɔ̃/ /ɛ̃/ /œ̃/, /ʁ/ /ɲ/ /ɥ/ /x/ /ç/.
 */
export const EXTENSIONS = [
  'E', 'A', 'O', 'U', 'UE', 'EU', 'OE', 'AX', 'AN', 'ON', 'IN', 'UN', 'RX', 'NY', 'UY', 'X', 'CC',
] as const

/** Every symbol understood by the Rust engine, in its order. */
export const PHONEME_SYMBOLS = [...ARPABET, ...EXTENSIONS] as const

const SYMBOLS: ReadonlySet<string> = new Set(PHONEME_SYMBOLS)

/** Vowels take a stress digit in the protocol. */
export function isVowelSymbol(symbol: string): boolean {
  return VOWELS.has(symbol)
}
const VOWELS: ReadonlySet<string> = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
  'E', 'A', 'O', 'U', 'UE', 'EU', 'OE', 'AX', 'AN', 'ON', 'IN', 'UN',
])
/** Boundaries; a colon between a symbol and digits is a duration (`A1:93`), not a pause. */
const BOUNDARY_CHARACTERS = /([|_,;.!?]|:(?!\d)|(?<![^\s|_,;:.!?]):)/

/** Longest explicit duration the engine accepts, in whole milliseconds. */
export const MAX_PHONE_MS = 5000

/** `A1:93` → `A1`: removes the explicit durations of a phoneme string. */
export function stripDurations(text: string): string {
  return text.replace(/(?<=[A-Za-z0-9]):\d+/g, '')
}

/** Word → ARPAbet pronunciation with stress digits, e.g. a parsed CMUdict. */
export type Lexicon = ReadonlyMap<string, string>

/** Pronunciations that take precedence over the dictionary. */
const OVERRIDES: Readonly<Record<string, string>> = {
  kraftwerk: 'K R AE1 F T V EH2 R K',
}

const PUNCTUATION: Readonly<Record<string, string>> = {
  ',': ',', ';': ',', ':': ',', '.': '.', '!': '.', '?': '?',
}
const PUNCTUATION_STRENGTH: Readonly<Record<string, number>> = { ',': 1, '.': 2, '?': 3 }

/**
 * Converts English text to the engine's phoneme protocol. Words come from the
 * lexicon when available, otherwise from approximate spelling rules.
 */
export function transcribe(text: string, lexicon?: Lexicon): string {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
  const tokens = normalized.match(/[a-z]+(?:'[a-z]+)*|[.,!?;:]/g) ?? []
  const parts: string[] = []
  let lastWasWord = false
  for (const token of tokens) {
    const punctuation = PUNCTUATION[token]
    if (punctuation) {
      if (parts.length === 0) continue
      if (lastWasWord) parts.push(punctuation)
      else if (PUNCTUATION_STRENGTH[punctuation] > PUNCTUATION_STRENGTH[parts[parts.length - 1]]) {
        parts[parts.length - 1] = punctuation
      }
      lastWasWord = false
      continue
    }
    const phones = pronounce(token, lexicon)
    if (!phones) continue
    if (lastWasWord) parts.push('|')
    parts.push(phones)
    lastWasWord = true
  }
  return parts.join(' ')
}

function pronounce(word: string, lexicon?: Lexicon): string {
  return OVERRIDES[word]
    ?? lexicon?.get(word)
    ?? lexicon?.get(word.replaceAll("'", ''))
    ?? spellOut(word)
}

const GRAPHEMES: ReadonlyArray<readonly [string, string]> = [
  ['tion', 'SH AH N'], ['sion', 'ZH AH N'], ['ough', 'AO'], ['augh', 'AO'], ['eigh', 'EY'],
  ['igh', 'AY'], ['tch', 'CH'], ['dge', 'JH'], ['sch', 'S K'], ['qu', 'K W'],
  ['ch', 'CH'], ['sh', 'SH'], ['th', 'TH'], ['ph', 'F'], ['wh', 'W'], ['ck', 'K'],
  ['ng', 'NG'], ['gh', ''], ['kn', 'N'], ['wr', 'R'],
  ['ee', 'IY'], ['ea', 'IY'], ['oo', 'UW'], ['oa', 'OW'], ['ai', 'EY'], ['ay', 'EY'],
  ['ei', 'EY'], ['ey', 'IY'], ['oi', 'OY'], ['oy', 'OY'], ['ou', 'AW'], ['ow', 'OW'],
  ['au', 'AO'], ['aw', 'AO'], ['ew', 'UW'], ['ie', 'IY'], ['ue', 'UW'],
  ['er', 'ER'], ['ir', 'ER'], ['ur', 'ER'], ['ar', 'AA R'], ['or', 'AO R'],
]
const WORD_INITIAL_ONLY: ReadonlySet<string> = new Set(['kn', 'wr'])
const LETTERS: Readonly<Record<string, string>> = {
  a: 'AE', b: 'B', c: 'K', d: 'D', e: 'EH', f: 'F', g: 'G', h: 'HH', i: 'IH', j: 'JH',
  k: 'K', l: 'L', m: 'M', n: 'N', o: 'AA', p: 'P', q: 'K', r: 'R', s: 'S', t: 'T',
  u: 'AH', v: 'V', w: 'W', x: 'K S', y: 'IY', z: 'Z',
}
const LONG_VOWELS: Readonly<Record<string, string>> = { a: 'EY', e: 'IY', i: 'AY', o: 'OW', u: 'UW' }
const VOWEL_LETTERS = 'aeiou'

/** Approximate English spelling rules for words missing from the lexicon. */
export function spellOut(word: string): string {
  let letters = word.replace(/[^a-z]/g, '')
  if (!letters) return ''
  // "Magic e": a single vowel before consonant + final e is long (make, home).
  let longVowelAt = -1
  const magic = /([aeiou])[^aeiouwxy]e$/.exec(letters)
  if (magic && letters.length > 3 && !VOWEL_LETTERS.includes(letters[magic.index - 1] ?? '')) {
    longVowelAt = magic.index
  }
  if (letters.length > 2 && /[^aeiouy]e$/.test(letters)) letters = letters.slice(0, -1)

  const phones: string[] = []
  for (let index = 0; index < letters.length;) {
    const letter = letters[index]
    if (index > 0 && letter === letters[index - 1] && !VOWEL_LETTERS.includes(letter)) {
      index += 1
      continue
    }
    if (index === longVowelAt) {
      phones.push(LONG_VOWELS[letter])
      index += 1
      continue
    }
    const grapheme = GRAPHEMES.find(([pattern]) =>
      letters.startsWith(pattern, index) && (index === 0 || !WORD_INITIAL_ONLY.has(pattern)))
    if (grapheme) {
      if (grapheme[1]) phones.push(...grapheme[1].split(' '))
      index += grapheme[0].length
      continue
    }
    if (letter === 'c' && /[eiy]/.test(letters[index + 1] ?? '')) phones.push('S')
    else if (letter === 'y') phones.push(index === 0 ? 'Y' : index === letters.length - 1 ? 'IY' : 'IH')
    else if (letter === 'i' && index === letters.length - 1) phones.push('IY')
    else phones.push(...LETTERS[letter].split(' '))
    index += 1
  }

  let firstVowel = true
  return phones
    .map((phone) => {
      if (!VOWELS.has(phone)) return phone
      const stress = firstVowel ? '1' : '0'
      firstVowel = false
      return `${phone}${stress}`
    })
    .join(' ')
}

/** Tokens of the phoneme editor that the engine will ignore. */
export function unknownPhonemeTokens(text: string): string[] {
  return text
    .split(BOUNDARY_CHARACTERS)
    .flatMap((part) => part.split(/\s+/))
    .filter((token) => token && !BOUNDARY_CHARACTERS.test(token))
    .filter((token) => {
      const match = /^([A-Za-z]+)([012])?(?::(\d+))?$/.exec(token)
      if (!match) return true
      const symbol = match[1].toUpperCase()
      const milliseconds = match[3] === undefined ? undefined : Number(match[3])
      return !SYMBOLS.has(symbol)
        || (match[2] !== undefined && !VOWELS.has(symbol))
        || (milliseconds !== undefined && !(milliseconds > 0 && milliseconds <= MAX_PHONE_MS))
    })
}
