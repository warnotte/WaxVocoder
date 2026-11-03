/** Encodes samples in [-1, 1] as a 16-bit PCM WAV file (mono, or one array per channel). */
export function encodeWav(samples: Float32Array | Float32Array[], sampleRate: number): ArrayBuffer {
  const channels = Array.isArray(samples) ? samples : [samples]
  const frames = Math.min(...channels.map((channel) => channel.length))
  const blockAlign = channels.length * 2
  const dataBytes = frames * blockAlign
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let frame = 0; frame < frames; frame += 1) {
    channels.forEach((channel, index) => {
      const sample = channel[frame]
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
      view.setInt16(44 + frame * blockAlign + index * 2, Math.round(clamped * 32767), true)
    })
  }
  return buffer
}

/** Decodes a PCM WAV file (16-bit integer or 32-bit float) into one array per channel. */
export function decodeWav(buffer: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const view = new DataView(buffer)
  const text = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4))
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE') throw new Error('pas un fichier WAV')
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | undefined
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const id = text(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data' && format) {
      const { audioFormat, channels: count, sampleRate, bits } = format
      const integer = audioFormat === 1 && bits === 16
      const float = audioFormat === 3 && bits === 32
      if (!integer && !float) throw new Error(`format WAV non pris en charge (${audioFormat}, ${bits} bits)`)
      const frameBytes = count * (bits / 8)
      const frames = Math.floor(Math.min(size, buffer.byteLength - body) / frameBytes)
      const channels = Array.from({ length: count }, () => new Float32Array(frames))
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < count; channel += 1) {
          const position = body + frame * frameBytes + channel * (bits / 8)
          channels[channel][frame] = integer ? view.getInt16(position, true) / 32768 : view.getFloat32(position, true)
        }
      }
      return { sampleRate, channels }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('données WAV introuvables')
}
