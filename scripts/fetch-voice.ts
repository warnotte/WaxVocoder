// Downloads the Piper voices of a language, or one voice (model, configuration,
// model card) into voices/<id>/, for the scripts, the tests and the
// development server. A deployed site needs nothing: the page fetches a voice
// from Hugging Face on first use, unless a voices/<id>/ folder is uploaded next to it.
//
// Usage: node scripts/fetch-voice.ts [fr | en | de | <voice id>]
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { PIPER_VOICE_BASE, PIPER_VOICES } from '../src/engines/index.ts'
import type { Language } from '../src/ipa.ts'

const wanted = process.argv[2] ?? 'fr'
const chosen = PIPER_VOICES.filter((voice) => voice.languages.includes(wanted as Language) || voice.id === wanted)
if (chosen.length === 0) {
  console.error(`Pas de voix Piper pour « ${wanted} » (langues : fr, fr-CA, fr-BE, en, de ; voix : ${[...new Set(PIPER_VOICES.map((voice) => voice.id))].join(', ')}).`)
  process.exit(1)
}
for (const voice of new Map(chosen.map((voice) => [voice.id, voice])).values()) {
  const folder = new URL(`../voices/${voice.id}/`, import.meta.url)
  await mkdir(folder, { recursive: true })
  for (const file of [`${voice.id}.onnx.json`, 'MODEL_CARD', `${voice.id}.onnx`]) {
    if (existsSync(new URL(file, folder))) {
      console.log(`${file} : déjà là`)
      continue
    }
    const response = await fetch(`${PIPER_VOICE_BASE}/${voice.path}/${file}`)
    if (!response.ok) throw new Error(`${file} : HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await writeFile(new URL(file, folder), bytes)
    console.log(`${file} (${(bytes.length / 1e6).toFixed(1)} Mo)`)
  }
  console.log(`→ voices/${voice.id}/ · ${voice.licence}`)
}
