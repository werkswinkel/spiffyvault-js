/**
 * The app's X3DH and first ratchet step (lib/signal/session_builder.dart,
 * lib/signal/group_messaging/message_ratchet.dart). Differs from Signal:
 * no 0xFF×32 prefix in the IKM, custom HKDF labels.
 */

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, utf8 } from '../bytes.ts'

const ZEROS = new Uint8Array(32)

/** HKDF-SHA256 (RFC 5869) with a 32-byte zero salt, as both Dart implementations use. */
export function hkdf32 (ikm: Uint8Array, info: string, length = 32): Uint8Array {
  return hkdf(sha256, ikm, ZEROS, utf8(info), length)
}

/** X25519; the private key is a raw 32-byte scalar, clamped here (as Dart's newKeyPairFromSeed does). */
export function dh (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey)
}

export function x25519Public (privateKey: Uint8Array): Uint8Array { return x25519.getPublicKey(privateKey) }

export interface X3dhInitiator {
  dh1: Uint8Array
  dh2: Uint8Array
  dh3: Uint8Array
  dh4?: Uint8Array
  sk: Uint8Array
}

/**
 * The payer's X3DH:
 * DH1 = X25519(IKa, SPKb), DH2 = X25519(EKa, IKb), DH3 = X25519(EKa, SPKb),
 * DH4 = X25519(EKa, OPKb) when a one-time prekey is used;
 * SK = HKDF(DH1‖DH2‖DH3[‖DH4], zeros32, "X3DH_SK_Derivation", 32).
 */
export function x3dhInitiator (keys: {
  identityPrivate: Uint8Array
  ephemeralPrivate: Uint8Array
  theirIdentity: Uint8Array
  theirSignedPreKey: Uint8Array
  theirOneTimePreKey?: Uint8Array
}): X3dhInitiator {
  const dh1 = dh(keys.identityPrivate, keys.theirSignedPreKey)
  const dh2 = dh(keys.ephemeralPrivate, keys.theirIdentity)
  const dh3 = dh(keys.ephemeralPrivate, keys.theirSignedPreKey)
  const dh4 = keys.theirOneTimePreKey !== undefined ? dh(keys.ephemeralPrivate, keys.theirOneTimePreKey) : undefined
  const sk = hkdf32(dh4 !== undefined ? concat(dh1, dh2, dh3, dh4) : concat(dh1, dh2, dh3), 'X3DH_SK_Derivation')
  return { dh1, dh2, dh3, ...(dh4 !== undefined ? { dh4 } : {}), sk }
}

/** CK0 (the initiator's sending chain), MK0 (its first message key), CK1 (the chain after it). */
export function firstChain (sk: Uint8Array): { ck0: Uint8Array, mk0: Uint8Array, ck1: Uint8Array } {
  const ck0 = hkdf32(sk, 'ChainKey_InitiatorToResponder')
  return { ck0, mk0: hkdf32(ck0, 'MessageKey'), ck1: hkdf32(ck0, 'ChainKey') }
}
