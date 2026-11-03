// Prints the IPA transcription produced by eSpeak NG (WASM build), to check
// the dependency and to collect reference output for the IPA → phoneme mapping.
//
// Usage: node scripts/espeak-ipa.mjs [voice] [text...]
//        node scripts/espeak-ipa.mjs            (built-in French / English / German samples)
import EspeakInitializer from '@echogarden/espeak-ng-emscripten'

const [voiceArgument, ...words] = process.argv.slice(2)
const samples = voiceArgument
  ? [[voiceArgument, words.join(' ') || 'Bonjour']]
  : [
      ['fr', 'Bonjour, nous sommes les machines.'],
      ['fr', 'Un bon vin blanc, une brune et le chat.'],
      ['fr', 'Est-ce que tu viens ? Oui, je suis là !'],
      ['en-us', 'Welcome to the electronic laboratory.'],
      ['de', 'Ich bin eine Sprechmaschine aus dem Labor.'],
      ['de', 'Die Maschine spricht. Schöne Grüße aus München.'],
    ]

const started = performance.now()
const module = await EspeakInitializer()
const worker = new module.eSpeakNGWorker()
console.log(`eSpeak NG prêt en ${(performance.now() - started).toFixed(0)} ms`)
for (const [voice, text] of samples) {
  worker.set_voice(voice)
  const result = worker.synthesize_ipa(text)
  console.log(`${voice.padEnd(6)} ${JSON.stringify(text)}\n       → ${JSON.stringify(result.ipa)}`)
}
