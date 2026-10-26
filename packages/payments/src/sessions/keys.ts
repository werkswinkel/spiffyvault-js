/**
 * Keys of the peer-session format (SpiffyVault doc/peer-sessions.md, as
 * package:double_ratchet writes them): `Encode(PK)`, the identity's X25519
 * form (RFC 7748 map of the Ed25519 key), X25519 agreement and the KDFs of
 * Appendix A.5.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { concat, utf8 } from '../bytes.ts'

/** The `application` of every app's SessionCipher (section 1). */
export const APPLICATION = 'peer-sessions/1'
export const PROTOCOL_VERSION = 1
/** `Encode(PK)` starts with this byte. */
export const DJB_TYPE = 0x05
export const ENCODED_KEY_LENGTH = 33

const ZEROS = new Uint8Array(32)

/** `Encode(PK)`: 0x05 ‖ the 32-byte X25519 key. */
export function encodeKey (key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError('an X25519 key is 32 bytes')
  return concat(new Uint8Array([DJB_TYPE]), key)
}

/** The 32 bytes of an `Encode(PK)`. Throws when it is not one. */
export function decodeKey (encoded: Uint8Array): Uint8Array {
  if (encoded.length !== ENCODED_KEY_LENGTH || encoded[0] !== DJB_TYPE) throw new RangeError('not an encoded X25519 key')
  return encoded.slice(1)
}

/** The X25519 form of an Ed25519 public key (RFC 7748 birational map). */
export function edPublicToX25519 (ed25519Public: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(ed25519Public)
}

/**
 * The identity of an Ed25519 seed (32 bytes, or the 64-byte seed ‖ public
 * form libp2p keeps): the Ed25519 public key and the X25519 private key,
 * SHA-512(seed)[0..32] (X25519 clamps it), as IdentityKeyPair.fromSeed.
 */
export function identityOfSeed (seed: Uint8Array): { ed25519: Uint8Array, x25519Private: Uint8Array } {
  if (seed.length !== 32 && seed.length !== 64) throw new RangeError('an Ed25519 private key is 32 or 64 bytes')
  const s = seed.subarray(0, 32)
  return { ed25519: ed25519.getPublicKey(s), x25519Private: sha512(s).slice(0, 32) }
}

export function x25519Public (privateKey: Uint8Array): Uint8Array { return x25519.getPublicKey(privateKey) }

/** DH(private, public). Throws for a low-order point (an all-zero secret), as the library does. */
export function dh (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let out: Uint8Array
  // noble refuses an all-zero secret itself; the check stays for any other.
  try { out = x25519.getSharedSecret(privateKey, publicKey) } catch { throw new RangeError('low-order X25519 key') }
  if (out.every(b => b === 0)) throw new RangeError('low-order X25519 key')
  return out
}

/** HKDF-SHA256 over 32 × 0xFF ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4], zero salt: SK. */
export function kdfX3dh (dhs: Uint8Array[]): Uint8Array {
  return hkdf(sha256, concat(new Uint8Array(32).fill(0xff), ...dhs), ZEROS, utf8(`${APPLICATION} X3DH`), 32)
}

/** `KDF_RK(rk, dh_out)`: the new root key and a chain key. */
export function kdfRk (rootKey: Uint8Array, dhOut: Uint8Array): { rootKey: Uint8Array, chainKey: Uint8Array } {
  const out = hkdf(sha256, dhOut, rootKey, utf8(`${APPLICATION} Ratchet`), 64)
  return { rootKey: out.slice(0, 32), chainKey: out.slice(32) }
}

/** `KDF_CK(ck)`: the message key (HMAC over 0x01) and the next chain key (over 0x02). */
export function kdfCk (chainKey: Uint8Array): { messageKey: Uint8Array, nextChainKey: Uint8Array } {
  return { messageKey: hmac(sha256, chainKey, new Uint8Array([0x01])), nextChainKey: hmac(sha256, chainKey, new Uint8Array([0x02])) }
}

/** The AES-256 key, HMAC key and IV of a message key. */
export function messageKeys (messageKey: Uint8Array): { aesKey: Uint8Array, hmacKey: Uint8Array, iv: Uint8Array } {
  const out = hkdf(sha256, messageKey, ZEROS, utf8(`${APPLICATION} MessageKeys`), 80)
  return { aesKey: out.slice(0, 32), hmacKey: out.slice(32, 64), iv: out.slice(64) }
}
