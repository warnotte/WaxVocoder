// AudioWorkletGlobalScope may lack TextDecoder/TextEncoder, which the
// wasm-bindgen glue uses to pass strings (phonemes in, symbol list out).

export class Utf8Decoder {
  readonly encoding = 'utf-8'

  decode(input: ArrayBuffer | ArrayBufferView = new Uint8Array()): string {
    const bytes = input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    let encoded = ''
    for (const byte of bytes) encoded += `%${byte.toString(16).padStart(2, '0')}`
    return decodeURIComponent(encoded)
  }
}

function appendUtf8(codePoint: number, output: number[]): void {
  const code = codePoint >= 0xd800 && codePoint <= 0xdfff ? 0xfffd : codePoint
  if (code < 0x80) output.push(code)
  else if (code < 0x800) output.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
  else if (code < 0x10000) output.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  else output.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
}

export class Utf8Encoder {
  readonly encoding = 'utf-8'

  encode(input = ''): Uint8Array {
    const bytes: number[] = []
    for (const character of input) appendUtf8(character.codePointAt(0) ?? 0, bytes)
    return new Uint8Array(bytes)
  }

  encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
    let read = 0
    let written = 0
    for (const character of input) {
      const bytes: number[] = []
      appendUtf8(character.codePointAt(0) ?? 0, bytes)
      if (written + bytes.length > destination.length) break
      destination.set(bytes, written)
      written += bytes.length
      read += character.length
    }
    return { read, written }
  }
}

if (typeof globalThis.TextDecoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextDecoder', { value: Utf8Decoder })
}
if (typeof globalThis.TextEncoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextEncoder', { value: Utf8Encoder })
}
