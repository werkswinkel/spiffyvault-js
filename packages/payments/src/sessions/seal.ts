/**
 * Seals one message as the first of a new session (doc/peer-sessions.md
 * section 5): X3DH as Alice, `RatchetInitAlice`, one `RatchetEncrypt`, sent
 * as a pre-key message (Appendix A.2), byte for byte as package:double_ratchet's
 * processBundle and encrypt write it. A payer starts a new session for every
 * offline payment, so this is all the JS payer needs: it never reads a reply.
 */

import { cbc } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, randomBytes, u32be } from '../bytes.ts'
import type { PreKeyBundle } from './bundle.ts'
import { PROTOCOL_VERSION, dh, edPublicToX25519, encodeKey, identityOfSeed, kdfCk, kdfRk, kdfX3dh, messageKeys, x25519Public } from './keys.ts'

export const MESSAGE_TYPE = 1
export const PRE_KEY_MESSAGE_TYPE = 2

export interface SealOptions {
  /** Fixed ephemeral (base) and ratchet keys, for test vectors only. Default: fresh. */
  ephemeralPrivate?: Uint8Array
  ratchetPrivate?: Uint8Array
}

export interface Sealed {
  /** The pre-key message: the Ricochet message payload. */
  bytes: Uint8Array
  signedPreKeyId: number
  oneTimePreKeyId?: number
  /** The base key, `EK_A`. */
  ephemeralPublic: Uint8Array
}

/** The parts of the first message, for tests: the KDF outputs of Appendix A.5. */
export interface FirstMessageKeys {
  sk: Uint8Array
  rootKey: Uint8Array
  chainKey: Uint8Array
  messageKey: Uint8Array
}

/**
 * The first message to `bundle`'s owner, from the identity of the Ed25519
 * private key `identitySeed` (the payer's libp2p key: the payee checks that
 * it is the key of the peer ID that sent the message). `bundle` must have
 * passed verifyBundle.
 */
export function sealFirstMessage (bundle: PreKeyBundle, identitySeed: Uint8Array, plaintext: Uint8Array, opts: SealOptions = {}): Sealed {
  const { keys: _, ...sealed } = sealWithKeys(bundle, identitySeed, plaintext, opts)
  return sealed
}

/** sealFirstMessage, with the KDF outputs for the test vectors. Not exported from the package. */
export function sealWithKeys (bundle: PreKeyBundle, identitySeed: Uint8Array, plaintext: Uint8Array, opts: SealOptions = {}):
Sealed & { keys: FirstMessageKeys } {
  const ours = identityOfSeed(identitySeed)
  const ephemeralPrivate = opts.ephemeralPrivate ?? randomBytes(32)
  const ephemeralPublic = x25519Public(ephemeralPrivate)
  const opk = bundle.oneTimePreKey
  const sk = kdfX3dh([
    dh(ours.x25519Private, bundle.signedPreKey),
    dh(ephemeralPrivate, edPublicToX25519(bundle.identityKey)),
    dh(ephemeralPrivate, bundle.signedPreKey),
    ...(opk !== undefined ? [dh(ephemeralPrivate, opk.key)] : [])
  ])

  // RatchetInitAlice: a fresh ratchet key, the signed pre-key as Bob's.
  const ratchetPrivate = opts.ratchetPrivate ?? randomBytes(32)
  const { rootKey, chainKey } = kdfRk(sk, dh(ratchetPrivate, bundle.signedPreKey))

  // RatchetEncrypt of message 0; AD is the two Ed25519 identity keys, ours first.
  const { messageKey } = kdfCk(chainKey)
  const { aesKey, hmacKey, iv } = messageKeys(messageKey)
  const header = concat(new Uint8Array([PROTOCOL_VERSION, MESSAGE_TYPE]), encodeKey(x25519Public(ratchetPrivate)), u32be(0), u32be(0))
  const ciphertext = cbc(aesKey, iv).encrypt(plaintext)
  const mac = hmac(sha256, hmacKey, concat(ours.ed25519, bundle.identityKey, header, ciphertext))

  const bytes = concat(
    new Uint8Array([PROTOCOL_VERSION, PRE_KEY_MESSAGE_TYPE]),
    ours.ed25519,
    encodeKey(ephemeralPublic),
    u32be(bundle.signedPreKeyId),
    opk !== undefined ? concat(new Uint8Array([1]), u32be(opk.id)) : new Uint8Array([0]),
    header,
    ciphertext,
    mac
  )
  return {
    bytes,
    signedPreKeyId: bundle.signedPreKeyId,
    ...(opk !== undefined ? { oneTimePreKeyId: opk.id } : {}),
    ephemeralPublic,
    keys: { sk, rootKey, chainKey, messageKey }
  }
}
