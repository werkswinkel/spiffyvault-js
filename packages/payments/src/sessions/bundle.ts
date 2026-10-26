/**
 * The payee's pre-key bundle (doc/peer-sessions.md section 4, Appendix A.1):
 * the payee sends it to its own public mailbox `signal/v2/bundle`
 * (per-network suffix). Read and checked as section 5 says: the newest the
 * payee sent, its identity key the one inside the payee's peer ID, its
 * signed pre-key signed by that key.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { NoServerError, ProtocolError } from '@go-ricochet/ricochet/core'
import { concat, equalBytes, readU32be, u32be, utf8 } from '../bytes.ts'
import { PaymentError, errorText } from '../errors.ts'
import { PEER_BUNDLE_FOLDER, forNetwork } from '../networks.ts'
import type { Network } from '../networks.ts'
import { ed25519KeyOfPeerId } from '../peer.ts'
import type { RicochetLike } from '../ricochet.ts'
import { APPLICATION, ENCODED_KEY_LENGTH, decodeKey, encodeKey } from './keys.ts'

/**
 * The bundle's version byte (Appendix A.1). Version 2 signs the signed
 * pre-key with a label and its id; version 1 signed the bare key and is not
 * read.
 */
export const BUNDLE_VERSION = 2

/** What the identity key signs: `utf8("peer-sessions/1 signed pre-key") ‖ u32(id) ‖ Encode(signedPreKey)`. */
export function signedPreKeySignedBytes (id: number, signedPreKey: Uint8Array): Uint8Array {
  return concat(utf8(`${APPLICATION} signed pre-key`), u32be(id), encodeKey(signedPreKey))
}

export interface PreKeyBundle {
  /** The payee's Ed25519 identity key, 32 bytes. */
  identityKey: Uint8Array
  signedPreKeyId: number
  /** The signed pre-key, X25519, 32 bytes. */
  signedPreKey: Uint8Array
  /** Ed25519 signature by the identity key over `signedPreKeySignedBytes(signedPreKeyId, signedPreKey)`. */
  signedPreKeySignature: Uint8Array
  /** A one-time pre-key, when one is used (a published bundle has none). */
  oneTimePreKey?: { id: number, key: Uint8Array }
}

export function encodeBundle (b: PreKeyBundle): Uint8Array {
  return concat(
    new Uint8Array([BUNDLE_VERSION]),
    b.identityKey,
    u32be(b.signedPreKeyId),
    encodeKey(b.signedPreKey),
    b.signedPreKeySignature,
    b.oneTimePreKey === undefined ? new Uint8Array([0]) : concat(new Uint8Array([1]), u32be(b.oneTimePreKey.id), encodeKey(b.oneTimePreKey.key))
  )
}

/** The bundle in `bytes`. Throws when it is not one; does not check the signature (verifyBundle does). */
export function decodeBundle (bytes: Uint8Array): PreKeyBundle {
  const fixed = 1 + 32 + 4 + ENCODED_KEY_LENGTH + 64 + 1
  if (bytes.length < fixed) throw new RangeError('bundle too short')
  if (bytes[0] !== BUNDLE_VERSION) throw new RangeError('unknown bundle version')
  let o = 1
  const identityKey = bytes.slice(o, o + 32); o += 32
  const signedPreKeyId = readU32be(bytes, o); o += 4
  const signedPreKey = decodeKey(bytes.slice(o, o + ENCODED_KEY_LENGTH)); o += ENCODED_KEY_LENGTH
  const signedPreKeySignature = bytes.slice(o, o + 64); o += 64
  const flag = bytes[o]; o += 1
  let oneTimePreKey: PreKeyBundle['oneTimePreKey']
  if (flag === 1) {
    if (bytes.length !== o + 4 + ENCODED_KEY_LENGTH) throw new RangeError('bundle has the wrong length')
    oneTimePreKey = { id: readU32be(bytes, o), key: decodeKey(bytes.slice(o + 4)) }
  } else if (flag !== 0 || bytes.length !== o) {
    throw new RangeError(flag !== 0 ? 'bad bundle flag' : 'bundle has the wrong length')
  }
  return { identityKey, signedPreKeyId, signedPreKey, signedPreKeySignature, ...(oneTimePreKey !== undefined ? { oneTimePreKey } : {}) }
}

export function verifyEd25519 (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try { return ed25519.verify(signature, message, publicKey) } catch { return false }
}

/**
 * Null when the bundle may be used to start a session with `payeePeerId`;
 * otherwise why not: its identity key must be the peer ID's key, and the
 * signed pre-key must be signed by it.
 */
export function verifyBundle (b: PreKeyBundle, payeePeerId: string): string | null {
  const peerKey = ed25519KeyOfPeerId(payeePeerId)
  if (peerKey === null || !equalBytes(peerKey, b.identityKey)) return 'bundle identity key is not the payee peer ID\'s key'
  if (!verifyEd25519(b.signedPreKeySignature, signedPreKeySignedBytes(b.signedPreKeyId, b.signedPreKey), b.identityKey)) return 'signed pre-key signature does not verify'
  return null
}

const fail = (code: 'prekeys-missing' | 'prekeys-not-public' | 'prekeys-invalid' | 'server-unreachable', message: string, cause?: unknown): PaymentError =>
  new PaymentError(code, message, { path: 'offline', stage: code === 'server-unreachable' ? 'connect' : 'request', canPayAnotherWay: true, cause })

/**
 * Reads the payee's bundle (section 5, step 1 and 2): retrieve from the
 * payee's public mailbox (`fromSequence` 1, at most 10), take the message
 * with the highest sequence the payee sent, decode and verify it.
 */
export async function fetchBundle (ricochet: RicochetLike, payeePeerId: string, network: Network): Promise<PreKeyBundle> {
  const folderPath = forNetwork(PEER_BUNDLE_FOLDER, network)
  let page
  try {
    page = await ricochet.retrievePage({ targetPeerId: payeePeerId, folderPath, fromSequence: 1, maxMessages: 10 })
  } catch (e) {
    if (e instanceof ProtocolError && e.status === 404) throw fail('prekeys-missing', 'The payee has not published its payment keys (it may need to update SpiffyVault)', e)
    if (e instanceof ProtocolError && e.status === 403) throw fail('prekeys-not-public', 'The payee\'s payment keys are not public', e)
    if (e instanceof NoServerError) throw fail('server-unreachable', `Could not reach the Ricochet server: ${errorText(e)}`, e)
    throw fail('prekeys-missing', `Could not read the payee's payment keys: ${errorText(e)}`, e)
  }
  const newest = page.messages
    .filter(m => m.senderPeerId === payeePeerId && (m.folderPath === '' || m.folderPath === folderPath))
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .at(-1)
  if (newest === undefined) throw fail('prekeys-missing', 'The payee has not published its payment keys (it may need to update SpiffyVault)')
  let bundle: PreKeyBundle
  try {
    bundle = decodeBundle(newest.payload)
  } catch (e) {
    throw fail('prekeys-invalid', `The payee's payment keys are not a bundle: ${errorText(e)}`, e)
  }
  const problem = verifyBundle(bundle, payeePeerId)
  if (problem !== null) throw fail('prekeys-invalid', `The payee's payment keys do not verify: ${problem}`)
  return bundle
}
