/**
 * The app's Signal-style message layouts (lib/signal/session_cipher.dart).
 * These are custom byte layouts, not libsignal's protobufs.
 *
 * SignalMessage:        ratchetKey(32) ‖ counter(u32) ‖ previousCounter(u32) ‖ nonce(12) ‖ tag(16) ‖ len(u32) ‖ ciphertext
 * PreKeySignalMessage:  registrationId(u32) ‖ flag(1) ‖ [preKeyId(u32)] ‖ signedPreKeyId(u32) ‖ baseKey(32) ‖ identityKey(32) ‖ len(u32) ‖ SignalMessage
 */

import { concat, readU32be, u32be } from '../bytes.ts'

export interface SignalMessage {
  ephemeralPublicKey: Uint8Array
  counter: number
  previousCounter: number
  nonce: Uint8Array
  authTag: Uint8Array
  ciphertext: Uint8Array
}

export interface PreKeySignalMessage {
  registrationId: number
  /** Present when a one-time prekey was used. */
  preKeyId?: number
  signedPreKeyId: number
  /** The sender's ephemeral X25519 key (EKa). */
  baseKey: Uint8Array
  /** The sender's X25519 identity key (IKa), not Ed25519. */
  identityKey: Uint8Array
  message: SignalMessage
}

function need (cond: boolean, what: string): void { if (!cond) throw new RangeError(what) }

export function encodeSignalMessage (m: SignalMessage): Uint8Array {
  need(m.ephemeralPublicKey.length === 32, 'Ephemeral public key must be 32 bytes.')
  need(m.nonce.length === 12, 'Nonce must be 12 bytes.')
  need(m.authTag.length === 16, 'AuthTag must be 16 bytes.')
  return concat(m.ephemeralPublicKey, u32be(m.counter), u32be(m.previousCounter), m.nonce, m.authTag,
    u32be(m.ciphertext.length), m.ciphertext)
}

/** Parses as SignalMessage.fromBytes does, including its "no bytes left over" rule. */
export function decodeSignalMessage (bytes: Uint8Array): SignalMessage {
  need(bytes.length >= 72, 'SignalMessage too short')
  const len = readU32be(bytes, 68)
  need(72 + len === bytes.length, 'Error deserializing SignalMessage: Unexpected remaining bytes.')
  return {
    ephemeralPublicKey: bytes.slice(0, 32),
    counter: readU32be(bytes, 32),
    previousCounter: readU32be(bytes, 36),
    nonce: bytes.slice(40, 52),
    authTag: bytes.slice(52, 68),
    ciphertext: bytes.slice(72, 72 + len)
  }
}

export function encodePreKeySignalMessage (m: PreKeySignalMessage): Uint8Array {
  need(m.baseKey.length === 32, 'Base key must be 32 bytes.')
  need(m.identityKey.length === 32, 'Identity key must be 32 bytes.')
  const inner = encodeSignalMessage(m.message)
  return concat(
    u32be(m.registrationId),
    new Uint8Array([m.preKeyId !== undefined ? 1 : 0]),
    m.preKeyId !== undefined ? u32be(m.preKeyId) : new Uint8Array(0),
    u32be(m.signedPreKeyId),
    m.baseKey,
    m.identityKey,
    u32be(inner.length),
    inner
  )
}

export function decodePreKeySignalMessage (bytes: Uint8Array): PreKeySignalMessage {
  let o = 0
  const registrationId = readU32be(bytes, o); o += 4
  need(o < bytes.length, 'PreKeySignalMessage too short')
  const hasPreKey = bytes[o] === 1; o += 1
  let preKeyId: number | undefined
  if (hasPreKey) { preKeyId = readU32be(bytes, o); o += 4 }
  const signedPreKeyId = readU32be(bytes, o); o += 4
  need(o + 68 <= bytes.length, 'PreKeySignalMessage too short')
  const baseKey = bytes.slice(o, o + 32); o += 32
  const identityKey = bytes.slice(o, o + 32); o += 32
  const len = readU32be(bytes, o); o += 4
  need(o + len === bytes.length, 'Error deserializing PreKeySignalMessage: Unexpected remaining bytes.')
  const message = decodeSignalMessage(bytes.slice(o, o + len))
  return { registrationId, ...(preKeyId !== undefined ? { preKeyId } : {}), signedPreKeyId, baseKey, identityKey, message }
}

/**
 * Whether the payee's parser would misread `bytes` as a SignalMessage: it
 * tries SignalMessage.fromBytes first (signal_messaging_service.dart). A
 * PreKeySignalMessage for which this is true must not be sent.
 */
export function parsesAsSignalMessage (bytes: Uint8Array): boolean {
  if (bytes.length < 72) return false
  return 72 + readU32be(bytes, 68) === bytes.length
}
