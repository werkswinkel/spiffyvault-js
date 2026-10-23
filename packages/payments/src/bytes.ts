/**
 * Byte helpers: hex, standard base64, UTF-8, big-endian integers. Plain
 * Uint8Array everywhere, no Node.js Buffer, so the browser entry stays free
 * of Node built-ins.
 */

const HEX = '0123456789abcdef'

/** Lowercase hex of `bytes`. */
export function toHex (bytes: Uint8Array | readonly number[]): string {
  let s = ''
  for (const b of bytes) s += HEX[(b >> 4) & 15]! + HEX[b & 15]!
  return s
}

/** Bytes of a hex string (either case). Throws on odd length or a non-hex character. */
export function fromHex (hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError('not a hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 with padding (RFC 4648 section 4), as Dart's base64Encode writes it. */
export function toBase64 (bytes: Uint8Array | readonly number[]): string {
  let s = ''
  const n = bytes.length
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < n ? bytes[i + 1]! : 0
    const c = i + 2 < n ? bytes[i + 2]! : 0
    const v = (a << 16) | (b << 8) | c
    s += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]!
    s += i + 1 < n ? B64[(v >> 6) & 63]! : '='
    s += i + 2 < n ? B64[v & 63]! : '='
  }
  return s
}

/** Bytes of standard base64 (padding required, as Dart's base64Decode wants it). */
export function fromBase64 (text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new TypeError('not standard base64')
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    const v = (B64.indexOf(text[i]!) << 18) | (B64.indexOf(text[i + 1]!) << 12) |
      ((text[i + 2] === '=' ? 0 : B64.indexOf(text[i + 2]!)) << 6) | (text[i + 3] === '=' ? 0 : B64.indexOf(text[i + 3]!))
    if (o < out.length) out[o++] = (v >> 16) & 255
    if (o < out.length) out[o++] = (v >> 8) & 255
    if (o < out.length) out[o++] = v & 255
  }
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function utf8 (text: string): Uint8Array { return encoder.encode(text) }
export function fromUtf8 (bytes: Uint8Array): string { return decoder.decode(bytes) }

export function concat (...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function u32be (n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`not a uint32: ${n}`)
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, false)
  return out
}

export function i64be (n: number): Uint8Array {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${n}`)
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, BigInt(n), false)
  return out
}

export function readU32be (bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new RangeError('read past the end')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false)
}

export function equalBytes (a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!
  return d === 0
}

export function randomBytes (n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** A random RFC 4122 version 4 UUID, lowercase. */
export function uuidV4 (): string {
  const b = randomBytes(16)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = toHex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Number of Unicode code points (Dart "runes"). */
export function runeLength (text: string): number { return Array.from(text).length }

/** The first `n` code points of `text`. */
export function takeRunes (text: string, n: number): string { return Array.from(text).slice(0, n).join('') }
