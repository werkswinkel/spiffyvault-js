/**
 * A key for each site (SpiffyVault doc/sign-in.md section 5), and the
 * app's half of a sign-in: what the SpiffyVault app does when the user
 * approves. Sites do not need signChallenge; it is here for tests and for
 * JS wallets that sign in as SpiffyVault does.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, toHex, utf8 } from './bytes.ts'
import { ChallengeError, checkChallenge, signedText } from './challenge.ts'
import type { Challenge } from './challenge.ts'

/** What the app posts to the callback (section 4). */
export interface SignInResponse {
  v: 2
  nonce: string
  /** The site key, 32 bytes as lowercase hex. */
  public_key: string
  /** Ed25519 over the signed text, 64 bytes as lowercase hex. */
  signature: string
}

/** HKDF-SHA256(identity seed, salt `OIAP-v2`, info `site key\n` + domain), 32 bytes. */
export function siteSeed (identitySeed: Uint8Array, domain: string): Uint8Array {
  if (identitySeed.length !== 32) throw new RangeError('an identity seed is 32 bytes')
  return hkdf(sha256, identitySeed, utf8('OIAP-v2'), utf8(`site key\n${domain}`), 32)
}

/** The site key's public half, lowercase hex. */
export function siteKey (identitySeed: Uint8Array, domain: string): string {
  return toHex(ed25519.getPublicKey(siteSeed(identitySeed, domain)))
}

/**
 * The response the app sends after the user approves `c` (and typed
 * `code` in mode `code`). Checks `c` first, as the app does.
 */
export function signChallenge (identitySeed: Uint8Array, c: Challenge, code?: string, now?: number): SignInResponse {
  checkChallenge(c, now)
  if (c.mode === 'code' && (code === undefined || !/^\d{6}$/.test(code))) throw new ChallengeError('the code is not 6 digits')
  const seed = siteSeed(identitySeed, c.domain)
  return {
    v: 2,
    nonce: c.nonce,
    public_key: toHex(ed25519.getPublicKey(seed)),
    signature: toHex(ed25519.sign(utf8(signedText(c, code)), seed))
  }
}

/** True when `response` signs `c` (with `code`) under its `public_key`. Never throws. */
export function verifyResponse (c: Challenge, response: SignInResponse, code?: string): boolean {
  try {
    const key = fromHex(response.public_key)
    const sig = fromHex(response.signature)
    if (key.length !== 32 || sig.length !== 64) return false
    return ed25519.verify(sig, utf8(signedText(c, code)), key)
  } catch {
    return false
  }
}
