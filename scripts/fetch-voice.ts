// Downloads a Piper voice (model, configuration, model card) into voices/<id>/,
// for the scripts, the tests and the development server. A deployed site needs
// nothing: the page fetches the voice from Hugging Face on first use, unless a
// voices/<id>/ folder is uploaded next to it.
//
// Usage: node scripts/fetch-voice.ts [fr]
import { mkdir, writeFile } from 'node:fs/promises'
import { PIPER_VOICE_BASE, PIPER_VOICES } from '../src/engines/index.ts'
import type { Language } from '../src/ipa.ts'

const language = (process.argv[2] ?? 'fr') as Language
const voice = PIPER_VOICES[language]
if (!voice) {
  console.error(`Pas de voix Piper pour « ${language} » (disponibles : ${Object.keys(PIPER_VOICES).join(', ')}).`)
  process.exit(1)
}
const folder = new URL(`../voices/${voice.id}/`, import.meta.url)
await mkdir(folder, { recursive: true })
for (const file of [`${voice.id}.onnx.json`, 'MODEL_CARD', `${voice.id}.onnx`]) {
  const response = await fetch(`${PIPER_VOICE_BASE}/${voice.path}/${file}`)
  if (!response.ok) throw new Error(`${file} : HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  await writeFile(new URL(file, folder), bytes)
  console.log(`${file} (${(bytes.length / 1e6).toFixed(1)} Mo)`)
}
console.log(`→ voices/${voice.id}/ · ${voice.licence}`)
