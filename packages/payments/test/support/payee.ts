/**
 * A JavaScript stand-in for the SpiffyVault payee's side of the offline
 * path, for tests: identity from a phrase (the app's PBKDF2 rule), a signed
 * anchor record, the bundle and one-time pre-keys of doc/peer-sessions.md,
 * and the decryption package:double_ratchet does for a first message.
 */

import { cbc } from '@noble/ciphers/aes.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey as Libp2pPrivateKey } from '@libp2p/interface'
import { PrivateKey } from '@bsv/sdk'
import {
  ANCHOR_RECORD_LIFETIME_MS, ANCHOR_RECORD_VERSION, PEER_BUNDLE_FOLDER, PEER_ONE_TIME_KEYS_FOLDER, anchorContextHex, anchorSignaturePayload, concat, encodeBundle, encodeOneTimeKeyItem,
  equalBytes, forNetwork, oneTimeKeySignedBytes, readU32be, signedPreKeySignedBytes, toHex, utf8
} from './internals.ts'
import type { Network, RicochetLike } from '../../src/index.ts'
import type { AnchorRecord, PreKeyBundle } from '../../src/internal.ts'
import { decodeKey, dh, edPublicToX25519, encodeKey, identityOfSeed, kdfCk, kdfRk, kdfX3dh, messageKeys, x25519Public } from '../../src/sessions/keys.ts'
import { ed25519KeyOfPeerId } from '../../src/peer.ts'

export const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

export interface PayeeIdentity {
  seed: Uint8Array
  edPublic: Uint8Array
  /** The X25519 form of edPublic (RFC 7748 map). */
  xPublic: Uint8Array
  peerId: string
  libp2pKey: Libp2pPrivateKey
}

/** The app's identity: PBKDF2-HMAC-SHA256(NFKD(phrase), "mnemonic", 10000, 32) → Ed25519, and its X25519 form. */
export async function identityFromPhrase (phrase: string): Promise<PayeeIdentity> {
  const seed = pbkdf2(sha256, utf8(phrase.normalize('NFKD')), utf8('mnemonic'), { c: 10000, dkLen: 32 })
  return await identityFromSeed(seed)
}

export async function identityFromSeed (seed: Uint8Array): Promise<PayeeIdentity> {
  const libp2pKey = await generateKeyPairFromSeed('Ed25519', seed)
  return {
    seed,
    edPublic: ed25519.getPublicKey(seed),
    xPublic: edPublicToX25519(ed25519.getPublicKey(seed)),
    peerId: peerIdFromPrivateKey(libp2pKey).toString(),
    libp2pKey
  }
}

export function signAnchorRecord (id: PayeeIdentity, r: { anchorPublicKey: string, epoch: number, networkType: string, timestamp: number, path: string, expiresAt?: number }): AnchorRecord {
  const unsigned = {
    peerId: id.peerId,
    identityPublicKey: toHex(id.edPublic),
    anchorPublicKey: r.anchorPublicKey,
    anchorContextHex: anchorContextHex(toHex(id.edPublic), r.epoch, r.networkType),
    epoch: r.epoch,
    networkType: r.networkType,
    path: r.path,
    timestamp: r.timestamp,
    expiresAt: r.expiresAt ?? Date.now() + ANCHOR_RECORD_LIFETIME_MS,
    version: ANCHOR_RECORD_VERSION
  }
  return { ...unsigned, signature: toHex(ed25519.sign(anchorSignaturePayload(unsigned), id.seed)) }
}

/** The payee's session keys: its signed pre-key and the one-time pre-keys it put in its claim mailbox. */
export interface PayeeSessionKeys {
  signedPreKeyId: number
  signedPreKeyPrivate: Uint8Array
  oneTimePreKeys: Map<number, Uint8Array>
}

/** The bundle the app publishes (PreKeyBundle.of: no one-time pre-key), signed by the identity. */
export function signBundle (id: PayeeIdentity, keys: PayeeSessionKeys): PreKeyBundle {
  const signedPreKey = x25519Public(keys.signedPreKeyPrivate)
  return {
    identityKey: id.edPublic,
    signedPreKeyId: keys.signedPreKeyId,
    signedPreKey,
    signedPreKeySignature: ed25519.sign(signedPreKeySignedBytes(keys.signedPreKeyId, signedPreKey), id.seed)
  }
}

/** The claim-mailbox items of the one-time pre-keys, as the app signs them. */
export function oneTimeKeyItems (id: PayeeIdentity, keys: PayeeSessionKeys): Uint8Array[] {
  return [...keys.oneTimePreKeys].map(([kid, priv]) => {
    const key = x25519Public(priv)
    return encodeOneTimeKeyItem({ id: kid, key, signature: ed25519.sign(oneTimeKeySignedBytes(kid, key), id.seed) })
  })
}

/** A Ricochet client of the payee itself, as far as publishing goes. */
export interface PayeeMailboxes {
  sendMessage: RicochetLike['sendMessage']
  createMailbox?: (folderPath: string, type: 'claim' | 'public', opts?: { retentionDays?: number, retentionCount?: number }) => Promise<void>
}

/** Publishes the payee's bundle and fills its claim mailbox, as the app's OwnerKeys does. */
export async function publishSessionKeys (client: PayeeMailboxes, id: PayeeIdentity, keys: PayeeSessionKeys, network: Network = 'testnet'): Promise<void> {
  const bundleFolder = forNetwork(PEER_BUNDLE_FOLDER, network)
  const oneTimeFolder = forNetwork(PEER_ONE_TIME_KEYS_FOLDER, network)
  await client.createMailbox?.(bundleFolder, 'public', { retentionDays: 30, retentionCount: 5 })
  const sent = await client.sendMessage(id.peerId, encodeBundle(signBundle(id, keys)), { folderPath: bundleFolder, priority: 1, persistent: true })
  if (!sent.success) throw new Error(`bundle refused: ${sent.errorMessage}`)
  await client.createMailbox?.(oneTimeFolder, 'claim', { retentionDays: 30 })
  for (const item of oneTimeKeyItems(id, keys)) {
    const r = await client.sendMessage(id.peerId, item, { folderPath: oneTimeFolder, persistent: true })
    if (!r.success) throw new Error(`one-time pre-key refused: ${r.errorMessage}`)
  }
}

/** A payee's anchor key pair (a stand-in for its wallet's anchor). */
export function anchorKey (): { priv: PrivateKey, pub: string } {
  const priv = PrivateKey.fromRandom()
  return { priv, pub: priv.toPublicKey().toString() }
}

/**
 * Opens a first message as the app's payee does (SessionCipher.decrypt of a
 * pre-key message, doc/peer-sessions.md section 6): the sender's identity
 * key must be the key of `senderPeerId` (the envelope sender), the signed
 * and one-time pre-keys must be ours; X3DH as Bob, RatchetInitBob, one DH
 * ratchet step, the MAC over AD ‖ header ‖ ciphertext, then AES-256-CBC.
 * A used one-time pre-key is deleted from `keys`, so a replay with it fails.
 */
export function openPreKeyMessage (id: PayeeIdentity, keys: PayeeSessionKeys, bytes: Uint8Array, senderPeerId?: string): Uint8Array {
  if (bytes[0] !== 1 || bytes[1] !== 2) throw new Error('not a pre-key message')
  let o = 2
  const aliceEd = bytes.slice(o, o + 32); o += 32
  const baseKey = decodeKey(bytes.slice(o, o + 33)); o += 33
  const signedPreKeyId = readU32be(bytes, o); o += 4
  let oneTimePreKeyId: number | undefined
  if (bytes[o] === 1) { oneTimePreKeyId = readU32be(bytes, o + 1); o += 5 } else if (bytes[o] === 0) { o += 1 } else throw new Error('bad flag')
  const message = bytes.slice(o)
  if (senderPeerId !== undefined) {
    const peerKey = ed25519KeyOfPeerId(senderPeerId)
    if (peerKey === null || !equalBytes(peerKey, aliceEd)) throw new Error('UntrustedIdentity: the sender key is not the sender peer ID\'s')
  }
  if (signedPreKeyId !== keys.signedPreKeyId) throw new Error(`InvalidKeyId: no signed pre-key ${signedPreKeyId}`)
  let opk: Uint8Array | undefined
  if (oneTimePreKeyId !== undefined) {
    opk = keys.oneTimePreKeys.get(oneTimePreKeyId)
    if (opk === undefined) throw new Error(`InvalidKeyId: no one-time pre-key ${oneTimePreKeyId}`)
  }
  const ours = identityOfSeed(id.seed)
  const sk = kdfX3dh([
    dh(keys.signedPreKeyPrivate, edPublicToX25519(aliceEd)),
    dh(ours.x25519Private, baseKey),
    dh(keys.signedPreKeyPrivate, baseKey),
    ...(opk !== undefined ? [dh(opk, baseKey)] : [])
  ])
  if (message[0] !== 1 || message[1] !== 1) throw new Error('not a ratchet message')
  const header = message.slice(0, 43)
  const theirRatchet = decodeKey(header.slice(2, 35))
  if (readU32be(header, 39) !== 0) throw new Error('a first message is message 0 here')
  const { chainKey } = kdfRk(sk, dh(keys.signedPreKeyPrivate, theirRatchet))
  const { aesKey, hmacKey, iv } = messageKeys(kdfCk(chainKey).messageKey)
  const ciphertext = message.slice(43, message.length - 32)
  const mac = hmac(sha256, hmacKey, concat(aliceEd, id.edPublic, header, ciphertext))
  if (!equalBytes(mac, message.slice(message.length - 32))) throw new Error('InvalidMessage: bad MAC')
  if (oneTimePreKeyId !== undefined) keys.oneTimePreKeys.delete(oneTimePreKeyId)
  return cbc(aesKey, iv).decrypt(ciphertext)
}

export const fill = (b: number): Uint8Array => new Uint8Array(32).fill(b)
