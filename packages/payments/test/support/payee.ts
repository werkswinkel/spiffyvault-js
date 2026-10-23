/**
 * A JavaScript stand-in for the SpiffyVault payee's side of the offline
 * path, for tests: identity from a phrase (the app's PBKDF2 rule), a signed
 * anchor record and prekey bundle, and the decryption the app's
 * SessionCipher does for a PreKeySignalMessage.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey as Libp2pPrivateKey } from '@libp2p/interface'
import { PrivateKey } from '@bsv/sdk'
import {
  anchorContextHex, anchorSignaturePayload, bundleCanonicalBytes, concat, decodePreKeySignalMessage, equalBytes, firstChain,
  fromBase64, hkdf32, parsesAsSignalMessage, toBase64, toHex, u32be, utf8, x25519Public, x25519SharedSecret
} from './internals.ts'
import type { AnchorRecord, PrekeyBundle } from '../../src/index.ts'

export const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

export interface PayeeIdentity {
  seed: Uint8Array
  edPublic: Uint8Array
  xPublic: Uint8Array
  peerId: string
  libp2pKey: Libp2pPrivateKey
}

/** The app's identity: PBKDF2-HMAC-SHA256(NFKD(phrase), "mnemonic", 10000, 32) → Ed25519 and X25519. */
export async function identityFromPhrase (phrase: string): Promise<PayeeIdentity> {
  const seed = pbkdf2(sha256, utf8(phrase.normalize('NFKD')), utf8('mnemonic'), { c: 10000, dkLen: 32 })
  return await identityFromSeed(seed)
}

export async function identityFromSeed (seed: Uint8Array): Promise<PayeeIdentity> {
  const libp2pKey = await generateKeyPairFromSeed('Ed25519', seed)
  return {
    seed,
    edPublic: ed25519.getPublicKey(seed),
    xPublic: x25519Public(seed),
    peerId: peerIdFromPrivateKey(libp2pKey).toString(),
    libp2pKey
  }
}

export function signAnchorRecord (id: PayeeIdentity, r: { anchorPublicKey: string, epoch: number, networkType: string, timestamp: number }): AnchorRecord {
  const unsigned = {
    peerId: id.peerId,
    identityPublicKey: toHex(id.edPublic),
    anchorPublicKey: r.anchorPublicKey,
    anchorContextHex: anchorContextHex(toHex(id.edPublic), r.epoch),
    epoch: r.epoch,
    networkType: r.networkType,
    timestamp: r.timestamp,
    version: 2
  }
  return { ...unsigned, signature: toHex(ed25519.sign(anchorSignaturePayload(unsigned), id.seed)) }
}

export interface PayeePrekeys {
  registrationId: number
  signedPreKeyId: number
  signedPreKeyPrivate: Uint8Array
  oneTimePreKeys: Map<number, Uint8Array>
}

export function signBundle (id: PayeeIdentity, keys: PayeePrekeys, publishedAt: number): PrekeyBundle {
  const spkPub = x25519Public(keys.signedPreKeyPrivate)
  const unsigned: PrekeyBundle = {
    registrationId: keys.registrationId,
    identityKeyPublicEd25519: toHex(id.edPublic),
    identityKeyPublicX25519: toHex(id.xPublic),
    signedPreKeyPublic: toBase64(spkPub),
    signedPreKeyId: keys.signedPreKeyId,
    signedPreKeySignature: toBase64(ed25519.sign(spkPub, id.seed)),
    oneTimePreKeys: [...keys.oneTimePreKeys].map(([kid, priv]) => ({ id: kid, key: toBase64(x25519Public(priv)) })),
    publishedAt,
    peerId: id.peerId,
    bundleSignature: ''
  }
  return { ...unsigned, bundleSignature: toBase64(ed25519.sign(bundleCanonicalBytes(unsigned), id.seed)) }
}

/** A payee's anchor key pair (a stand-in for its wallet's anchor). */
export function anchorKey (): { priv: PrivateKey, pub: string } {
  const priv = PrivateKey.fromRandom()
  return { priv, pub: priv.toPublicKey().toString() }
}

/**
 * Decrypts a first message as the app's payee does
 * (SessionCipher._decryptPreKeySignalMessage): refuses a payload that
 * parses as a SignalMessage, an embedded counter other than 0, an
 * ephemeral key other than the base key, an unknown signed or one-time prekey.
 */
export function openPreKeyMessage (id: PayeeIdentity, keys: PayeePrekeys, bytes: Uint8Array): Uint8Array {
  if (parsesAsSignalMessage(bytes)) throw new Error('parses as a SignalMessage')
  const m = decodePreKeySignalMessage(bytes)
  if (m.signedPreKeyId !== keys.signedPreKeyId) throw new Error(`Signed pre-key ${m.signedPreKeyId} not found.`)
  let opk: Uint8Array | undefined
  if (m.preKeyId !== undefined) {
    opk = keys.oneTimePreKeys.get(m.preKeyId)
    if (opk === undefined) throw new Error(`One-time pre-key ${m.preKeyId} not found.`)
  }
  const dh1 = x25519SharedSecret(keys.signedPreKeyPrivate, m.identityKey)
  const dh2 = x25519SharedSecret(id.seed, m.baseKey)
  const dh3 = x25519SharedSecret(keys.signedPreKeyPrivate, m.baseKey)
  const ikm = opk !== undefined ? concat(dh1, dh2, dh3, x25519SharedSecret(opk, m.baseKey)) : concat(dh1, dh2, dh3)
  const sk = hkdf32(ikm, 'X3DH_SK_Derivation')
  const { mk0 } = firstChain(sk)
  if (m.message.counter !== 0) throw new Error('Embedded message counter must be 0')
  if (!equalBytes(m.message.ephemeralPublicKey, m.baseKey)) throw new Error('Embedded ephemeral key does not match the base key')
  const aad = concat(m.message.ephemeralPublicKey, u32be(m.message.counter))
  return chacha20poly1305(mk0, m.message.nonce, aad).decrypt(concat(m.message.ciphertext, m.message.authTag))
}

export const fill = (b: number): Uint8Array => new Uint8Array(32).fill(b)
export { fromBase64 }
