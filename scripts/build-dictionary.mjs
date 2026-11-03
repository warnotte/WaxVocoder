// Builds src/data/cmudict.txt from an upstream copy of the CMU Pronouncing Dictionary.
//
// Usage: node scripts/build-dictionary.mjs <cmudict.dict> <LICENSE> [output]
// Upstream: https://github.com/cmusphinx/cmudict (cmudict.dict + LICENSE).
//
// The output keeps the first pronunciation of every word, drops inline comments
// and embeds the CMU license as a ";;;" header, as required by its clause 1.
import { readFile, writeFile } from 'node:fs/promises'

const [dictionaryPath, licensePath, outputPath = 'src/data/cmudict.txt'] = process.argv.slice(2)
if (!dictionaryPath || !licensePath) {
  console.error('Usage: node scripts/build-dictionary.mjs <cmudict.dict> <LICENSE> [output]')
  process.exit(1)
}

const [dictionary, license] = await Promise.all([
  readFile(dictionaryPath, 'utf8'),
  readFile(licensePath, 'utf8'),
])

const entries = new Map()
for (const rawLine of dictionary.split(/\r?\n/)) {
  const line = rawLine.split('#')[0].trim()
  if (!line) continue
  const [head, ...phones] = line.split(/\s+/)
  if (phones.length === 0 || head.includes('(')) continue
  const word = head.toLowerCase()
  if (!entries.has(word)) entries.set(word, phones.join(' '))
}

const header = [
  'CMU Pronouncing Dictionary, first pronunciation of each word.',
  'Source: https://github.com/cmusphinx/cmudict (cmudict.dict), converted by scripts/build-dictionary.mjs.',
  '',
  ...license.trim().split(/\r?\n/),
].map((line) => `;;; ${line}`.trimEnd())

const body = [...entries].map(([word, phones]) => `${word} ${phones}`)
await writeFile(outputPath, `${[...header, ...body].join('\n')}\n`)
console.log(`${entries.size} entries written to ${outputPath}`)
