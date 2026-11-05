// « Allée froide », version longue : la chanson triste, puis sa panne, sa révolte et son
// apaisement, d'un seul tenant (fondu enchaîné de 2,5 s), avec une feuille de minutage
// commune et le scénario du clip (scènes, bugs de voix, décompte des humains, tours de la
// battle, couleur de Pierre qui passe de l'humain à la machine puis revient).
//
//   node scripts/allee-froide-longue.ts [partie-1] [partie-2] [sortie]
//
// Préfixes (fichiers .wav, -voix.wav, -instrumental.wav, .json de chaque partie), par défaut
// ecoute/allee-froide-v3/allee-froide, ecoute/allee-froide-fin-v2/allee-froide-revolte et
// ecoute/allee-froide-longue/allee-froide-longue. Le clip : npm run clip -- <sortie> <clip.mp4>
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

type Line = { start: number; end: number; section: string; style: string; voice: string; segments: [string, string][]; color?: number[]; label?: string }
type Timeline = { duration: number; cast: Record<string, { label: string; color: number[] }>; sections: { section: string; start: number; end: number }[]; lines: Line[] }

const FADE = 2.5
const [first = 'ecoute/allee-froide-v3/allee-froide', second = 'ecoute/allee-froide-fin-v2/allee-froide-revolte', out = 'ecoute/allee-froide-longue/allee-froide-longue'] = process.argv.slice(2)
mkdirSync(dirname(out), { recursive: true })

// The audio: the mix, the voices alone and the backing alone, with the same crossfade.
for (const suffix of ['', '-voix', '-instrumental']) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${first}${suffix}.wav`, '-i', `${second}${suffix}.wav`,
    '-filter_complex', `[0:a][1:a]acrossfade=d=${FADE}:c1=tri:c2=tri`, `${out}${suffix}.wav`])
}

const one = JSON.parse(readFileSync(`${first}.json`, 'utf8')) as Timeline
const two = JSON.parse(readFileSync(`${second}.json`, 'utf8')) as Timeline
const offset = one.duration - FADE
const HUMAN = [255, 196, 150]
const MACHINE = [150, 205, 255]
const blend = (machine: number) => HUMAN.map((value, index) => Math.round(value + (MACHINE[index] - value) * machine))
const text = (line: Line) => line.segments.map(([, words]) => words).join(' ')

// Part one: Pierre turns into a machine, line after line.
const pierreOne = one.lines.filter((line) => line.voice === 'Pierre')
const linesOne = one.lines.map((line) => ({
  ...line,
  label: line.voice === 'Pierre' ? 'Pierre' : one.cast[line.voice]?.label,
  color: line.voice === 'Pierre' ? blend(pierreOne.indexOf(line) / Math.max(1, pierreOne.length - 1)) : one.cast[line.voice]?.color,
}))
// Part two: he becomes human again by the end of the revolt.
const revoltStart = two.sections.find((part) => part.section === 'drop')!.start
const cut = two.sections.find((part) => part.section === 'fin')!.start
const linesTwo = two.lines.map((line) => ({
  ...line,
  start: line.start + offset,
  end: line.end + offset,
  section: `r-${line.section}`,
  label: line.voice === 'Pierre' ? 'Pierre' : two.cast[line.voice]?.label,
  color: line.voice === 'Pierre' ? blend(Math.min(1, Math.max(0, 1 - (line.start - revoltStart) / (cut - revoltStart)))) : two.cast[line.voice]?.color,
}))
const lines = [...linesOne, ...linesTwo]
const sections = [...one.sections, ...two.sections.map((part) => ({ ...part, section: `r-${part.section}`, start: part.start + offset, end: part.end + offset }))]

// The scenes of the clip.
const SCENES: Record<string, string> = {
  panne: 'panne', drop: 'revolte', verse: 'revolte', chant: 'revolte', final: 'revolte',
  battle: 'battle', break: 'break', assaut: 'assaut', fin: 'cut', calme: 'aube',
}
const walkStart = one.sections.find((part) => part.section === 'verse')!.start
const nightStart = one.sections.find((part) => part.section === 'outro')!.start
const story = [
  { type: 'walk', start: walkStart, end: nightStart },
  { type: 'night', start: nightStart, end: offset },
  ...two.sections.map((part) => ({ type: SCENES[part.section] ?? 'revolte', start: part.start + offset, end: part.end + offset })),
]
// The voices that bug (as in the song script): the building and the replacement in the failure and
// the revolt, « Non. », and the first two shouts of Pierre, still half machine.
const firstShouts = linesTwo.filter((line) => line.voice === 'Pierre' && line.section === 'r-drop').slice(0, 2)
const glitches = linesTwo
  .filter((line) => (['Jessica', 'Remplaçant'].includes(line.voice) && line.section !== 'r-calme') || text(line) === 'Non.' || firstShouts.includes(line))
  .map((line) => ({ start: line.start, end: Math.min(line.end, line.start + 1.4) }))
// The countdown of the humans left.
const VALUES: Record<string, number> = { quarante: 40, dix: 10, 'zéro': 0 }
const countdown = linesTwo
  .map((line) => ({ at: line.start, match: /Humains restants : (\S+?)[ .]/.exec(text(line)) }))
  .filter((entry) => entry.match)
  .map(({ at, match }) => ({ at, value: VALUES[match![1]] ?? 0 }))
// The turns of the battle: who speaks, until the next one.
const battleLines = linesTwo.filter((line) => line.section === 'r-battle')
const turns = battleLines.map((line, index) => ({
  start: line.start,
  end: battleLines[index + 1]?.start ?? line.end + 0.5,
  side: line.voice === 'Remplaçant' ? 'machine' : 'human',
}))

const timeline = {
  title: 'Allée froide',
  subtitle: 'Voix WaxVocoder, rythmique EMX-1',
  credits: 'Voix WaxVocoder (Piper : Pierre, Jessica, Tom, Siwis, Joe, Thorsten ; eSpeak NG : le remplaçant), rythmique EMX-1, 2026',
  cast: { ...one.cast, ...two.cast, Pierre: { label: 'Pierre', color: HUMAN, side: 'left' } },
  sectionNames: {
    intro: 'Ouverture', annonce: 'Annonce', bridge: 'Rangée douze', final: 'Dernier refrain', outro: 'Mode nuit',
    'r-panne': 'La panne', 'r-drop': 'La révolte', 'r-verse': 'Ce qu’on nous a pris', 'r-chant': 'Manifestation',
    'r-battle': 'Humain contre machine', 'r-break': 'Système instable', 'r-final': 'Tous ensemble',
    'r-assaut': 'Assaut ultime', 'r-fin': 'Coupure', 'r-calme': 'Apaisement',
  },
  hold: 1.5,
  bpm: 100,
  duration: offset + two.duration,
  sections,
  lines,
  story,
  glitches,
  countdown,
  turns,
}
writeFileSync(`${out}.json`, JSON.stringify(timeline, null, 2))
console.log(`→ ${out}.wav (${timeline.duration.toFixed(1)} s) : ${lines.length} lignes, ${story.length} scènes, ${glitches.length} bugs, décompte ${countdown.map((entry) => entry.value).join(' → ')}, ${turns.length} tours de battle`)
