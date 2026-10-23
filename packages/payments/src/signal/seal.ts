/**
 * Seals one message for a payee as the first message of a new session: a
 * PreKeySignalMessage exactly as the app's SessionBuilder + SessionCipher
 * write it. A stateless payer sends a fresh one for every payment, with a
 * fresh ephemeral key (the payee refuses a reused base key as stale).
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { concat, fromBase64, fromHex, randomBytes, u32be } from '../bytes.ts'
import type { PrekeyBundle } from './bundle.ts'
import { firstChain, x25519Public, x3dhInitiator } from './kdf.ts'
import { encodePreKeySignalMessage, parsesAsSignalMessage } from './messages.ts'

export interface SealOptions {
  /**
   * Which one-time prekey to use: 'random' (the app's choice, default), 'none'
   * (3-DH; the payee accepts it), or a prekey id from the bundle.
   */
  oneTimePreKey?: 'random' | 'none' | number
  /** The payer's X25519 identity private key (raw 32 bytes). Default: fresh. The payee does not check it. */
  identityPrivate?: Uint8Array
  /** Fixed ephemeral key and nonce, for test vectors only. */
  ephemeralPrivate?: Uint8Array
  nonce?: Uint8Array
  /** The sender's registration ID; the payee only stores it. Default: random uint32. */
  registrationId?: number
}

export interface Sealed {
  /** The PreKeySignalMessage bytes: the Ricochet message payload. */
  bytes: Uint8Array
  preKeyId?: number
  signedPreKeyId: number
  ephemeralPublic: Uint8Array
  identityPublic: Uint8Array
}

function randomU32 (): number {
  const b = randomBytes(4)
  return ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!
}

export function sealFirstMessage (bundle: PrekeyBundle, plaintext: Uint8Array, opts: SealOptions = {}): Sealed {
  const choice = opts.oneTimePreKey ?? 'random'
  let opk: { id: number, key: Uint8Array } | undefined
  if (choice === 'random' && bundle.oneTimePreKeys.length > 0) {
    const pick = bundle.oneTimePreKeys[randomU32() % bundle.oneTimePreKeys.length]!
    opk = { id: pick.id, key: fromBase64(pick.key) }
  } else if (typeof choice === 'number') {
    const pick = bundle.oneTimePreKeys.find(k => k.id === choice)
    if (pick === undefined) throw new RangeError(`the bundle has no one-time prekey ${choice}`)
    opk = { id: pick.id, key: fromBase64(pick.key) }
  }
  const identityPrivate = opts.identityPrivate ?? randomBytes(32)
  const identityPublic = x25519Public(identityPrivate)
  const theirIdentity = fromHex(bundle.identityKeyPublicX25519)
  const theirSignedPreKey = fromBase64(bundle.signedPreKeyPublic)
  const registrationId = opts.registrationId ?? randomU32()

  for (;;) {
    const ephemeralPrivate = opts.ephemeralPrivate ?? randomBytes(32)
    const ephemeralPublic = x25519Public(ephemeralPrivate)
    const { sk } = x3dhInitiator({
      identityPrivate,
      ephemeralPrivate,
      theirIdentity,
      theirSignedPreKey,
      ...(opk !== undefined ? { theirOneTimePreKey: opk.key } : {})
    })
    const { mk0 } = firstChain(sk)
    const nonce = opts.nonce ?? randomBytes(12)
    const aad = concat(ephemeralPublic, u32be(0))
    const sealed = chacha20poly1305(mk0, nonce, aad).encrypt(plaintext)
    const ciphertext = sealed.slice(0, sealed.length - 16)
    const authTag = sealed.slice(sealed.length - 16)
    const bytes = encodePreKeySignalMessage({
      registrationId,
      ...(opk !== undefined ? { preKeyId: opk.id } : {}),
      signedPreKeyId: bundle.signedPreKeyId,
      baseKey: ephemeralPublic,
      identityKey: identityPublic,
      message: { ephemeralPublicKey: ephemeralPublic, counter: 0, previousCounter: 0, nonce, authTag, ciphertext }
    })
    // The payee tries SignalMessage.fromBytes first; one in 2^32 messages
    // would parse as one. Draw a new ephemeral key then (never with fixed keys).
    if (parsesAsSignalMessage(bytes) && opts.ephemeralPrivate === undefined) continue
    return {
      bytes,
      ...(opk !== undefined ? { preKeyId: opk.id } : {}),
      signedPreKeyId: bundle.signedPreKeyId,
      ephemeralPublic,
      identityPublic
    }
  }
}
