/** Peer ID helpers. */

import { peerIdFromString } from '@libp2p/peer-id'

/**
 * The raw 32-byte Ed25519 public key inside a libp2p peer ID, or null when
 * the text is not a peer ID or its key is not Ed25519 (or not embedded).
 */
export function ed25519KeyOfPeerId (peerId: string): Uint8Array | null {
  try {
    const id = peerIdFromString(peerId)
    if (id.type !== 'Ed25519') return null
    return id.publicKey.raw
  } catch {
    return null
  }
}

export function isPeerId (text: string): boolean {
  try { peerIdFromString(text); return true } catch { return false }
}
