/** Byte helpers: hex, base64url, UTF-8. Plain Uint8Array, no Node.js Buffer. */

const HEX = '0123456789abcdef'

export function toHex (bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += HEX[(b >> 4) & 15]! + HEX[b & 15]!
  return s
}

/** Bytes of a lowercase or uppercase hex string; throws on anything else. */
export function fromHex (hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError('not a hex string')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b)

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding (RFC 4648 section 5). */
export function toBase64Url (bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    s += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!
    if (i + 1 < bytes.length) s += B64URL[(n >> 6) & 63]!
    if (i + 2 < bytes.length) s += B64URL[n & 63]!
  }
  return s
}

/** Bytes of base64url, with or without padding; throws on anything else. */
export function fromBase64Url (text: string): Uint8Array {
  const s = text.replace(/=+$/, '')
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new TypeError('not base64url')
  const out: number[] = []
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map(j => (i + j < s.length ? B64URL.indexOf(s[i + j]!) : 0))
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!
    out.push((n >> 16) & 255)
    if (i + 2 < s.length) out.push((n >> 8) & 255)
    if (i + 3 < s.length) out.push(n & 255)
  }
  return Uint8Array.from(out)
}

/** `count` random bytes from the platform's CSPRNG. */
export function randomBytes (count: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(count))
}
