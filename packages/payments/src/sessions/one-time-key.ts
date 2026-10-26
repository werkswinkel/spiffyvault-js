/**
 * One one-time pre-key as the payee puts it in its claim mailbox
 * `signal/v2/one-time-keys` (doc/peer-sessions.md section 4, Appendix A.4),
 * and the claim of section 5 step 3.
 *
 * The payee signs each item with its identity key, so the server cannot hand
 * out a key of its own: an item is taken only when the signature verifies
 * with the bundle's identity key.
 */

import { concat, readU32be, u32be, utf8 } from '../bytes.ts'
import { PEER_ONE_TIME_KEYS_FOLDER, forNetwork } from '../networks.ts'
import type { Network } from '../networks.ts'
import type { RicochetLike } from '../ricochet.ts'
import type { PreKeyBundle } from './bundle.ts'
import { verifyEd25519 } from './bundle.ts'
import { ENCODED_KEY_LENGTH, PROTOCOL_VERSION, decodeKey, encodeKey } from './keys.ts'

/** Before the id and key in what an item's signature covers. */
export const ONE_TIME_KEY_LABEL = 'peer-sessions/1 one-time pre-key'
const ITEM_LENGTH = 1 + 4 + ENCODED_KEY_LENGTH + 64

export interface OneTimeKeyItem {
  id: number
  /** X25519, 32 bytes. */
  key: Uint8Array
  signature: Uint8Array
}

/** `utf8(label) ‖ u32(id) ‖ Encode(key)`: what the signature covers. */
export function oneTimeKeySignedBytes (id: number, key: Uint8Array): Uint8Array {
  return concat(utf8(ONE_TIME_KEY_LABEL), u32be(id), encodeKey(key))
}

export function encodeOneTimeKeyItem (item: OneTimeKeyItem): Uint8Array {
  return concat(new Uint8Array([PROTOCOL_VERSION]), u32be(item.id), encodeKey(item.key), item.signature)
}

/** Null when `bytes` are not an item of this version. Does not check the signature. */
export function decodeOneTimeKeyItem (bytes: Uint8Array): OneTimeKeyItem | null {
  if (bytes.length !== ITEM_LENGTH || bytes[0] !== PROTOCOL_VERSION) return null
  try {
    return { id: readU32be(bytes, 1), key: decodeKey(bytes.slice(5, 5 + ENCODED_KEY_LENGTH)), signature: bytes.slice(5 + ENCODED_KEY_LENGTH) }
  } catch {
    return null
  }
}

export function verifyOneTimeKeyItem (item: OneTimeKeyItem, identityKey: Uint8Array): boolean {
  return verifyEd25519(item.signature, oneTimeKeySignedBytes(item.id, item.key), identityKey)
}

/** Why a session starts without a one-time pre-key, for the progress report. */
export type NoOneTimeKey = 'none-left' | 'bad-item' | 'claim-failed'

/**
 * `bundle` with one one-time pre-key claimed from the payee, or the bundle
 * as read with the reason when none was claimed (section 5, steps 3 and 4):
 * the mailbox is empty or out of claims for the hour, the item is bad, or
 * the claim failed (an older server, no claim mailbox).
 */
export async function withOneTimeKey (ricochet: RicochetLike, payeePeerId: string, network: Network, bundle: PreKeyBundle):
Promise<{ bundle: PreKeyBundle, missing?: NoOneTimeKey, cause?: unknown }> {
  let claimed
  try {
    claimed = await ricochet.claimMessage(payeePeerId, forNetwork(PEER_ONE_TIME_KEYS_FOLDER, network))
  } catch (e) {
    return { bundle, missing: 'claim-failed', cause: e }
  }
  if (claimed === null) return { bundle, missing: 'none-left' }
  const item = decodeOneTimeKeyItem(claimed.payload)
  if (item === null || !verifyOneTimeKeyItem(item, bundle.identityKey)) return { bundle, missing: 'bad-item' }
  return { bundle: { ...bundle, oneTimePreKey: { id: item.id, key: item.key } } }
}
