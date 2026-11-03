/**
 * Parses the compact CMUdict file produced by scripts/build-dictionary.mjs:
 * ";;;" header lines, then one "word PHONES" entry per line.
 */
export function parseDictionary(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith(';;;')) continue
    const separator = line.indexOf(' ')
    if (separator > 0) entries.set(line.slice(0, separator), line.slice(separator + 1).trim())
  }
  return entries
}

export async function loadDictionary(url: string): Promise<Map<string, string>> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`dictionnaire indisponible (${response.status})`)
  return parseDictionary(await response.text())
}
