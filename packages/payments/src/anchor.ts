/**
 * The payee's offline-payment anchor record (lib/models/payment_anchor_record.dart):
 * a signed JSON document in the Ricochet document store, owner = the payee.
 * Checked as lib/services/payment_anchor_verifier.dart does.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { concat, fromHex, fromUtf8, toHex, u32be, utf8 } from './bytes.ts'
import { NetworkMismatchError, PaymentError, errorText } from './errors.ts'
import { PAYMENT_ANCHOR_DOCUMENT, canonicalNetwork, forNetwork, walletNetworkType } from './networks.ts'
import type { Network } from './networks.ts'
import { refInNote } from './link.ts'
import { ed25519KeyOfPeerId } from './peer.ts'
import type { RicochetLike } from './ricochet.ts'

export const ANCHOR_RECORD_VERSION = 3
const SIGNATURE_TAG = 'overnode/payment-anchor-record'
const CONTEXT_TAG = 'overnode/offline-payments'

/** How long the app's records are good for (PaymentAnchorRecord.lifetime). */
export const ANCHOR_RECORD_LIFETIME_MS = 90 * 86400000

export interface AnchorRecord {
  peerId: string
  identityPublicKey: string
  anchorPublicKey: string
  anchorContextHex: string
  epoch: number
  /** 'main', 'test' or 'regtest'. */
  networkType: string
  /** The document path it is published at, network suffix included. */
  path: string
  timestamp: number
  /** Unix ms after which a payer refuses it. */
  expiresAt: number
  version: number
  signature: string
}

/**
 * `utf8(tag) ‖ 0x00 ‖ ed25519 identity key ‖ uint32be(epoch)`, hex, where the
 * tag is `overnode/offline-payments` on testnet and names the network on
 * mainnet and regtest (`…/mainnet`, `…/regtest`): AnchorContexts.offline.
 * `networkType` is any spelling of the network ('main', 'test', 'regtest').
 */
export function anchorContextHex (identityPublicKeyHex: string, epoch: number, networkType: string): string {
  const network = canonicalNetwork(networkType)
  const tag = network === 'testnet' ? CONTEXT_TAG : `${CONTEXT_TAG}/${network}`
  return toHex(concat(utf8(tag), new Uint8Array([0]), fromHex(identityPublicKeyHex), u32be(epoch)))
}

/** The text the record's Ed25519 signature covers: the tag and every field, one `name=value` per line. */
export function anchorSignedText (r: Omit<AnchorRecord, 'signature'>): string {
  return [
    SIGNATURE_TAG,
    `version=${r.version}`,
    `peerId=${r.peerId}`,
    `identityPublicKey=${r.identityPublicKey.toLowerCase()}`,
    `anchorPublicKey=${r.anchorPublicKey.toLowerCase()}`,
    `anchorContext=${r.anchorContextHex.toLowerCase()}`,
    `epoch=${r.epoch}`,
    `networkType=${r.networkType}`,
    `path=${r.path}`,
    `timestamp=${r.timestamp}`,
    `expiresAt=${r.expiresAt}`
  ].join('\n')
}

/** The bytes the record's Ed25519 signature covers: the UTF-8 of anchorSignedText. */
export function anchorSignaturePayload (r: Omit<AnchorRecord, 'signature'>): Uint8Array {
  return utf8(anchorSignedText(r))
}

/** The record in `json`, with the field types the app's reader insists on. Throws when it is not one. */
export function parseAnchorRecord (json: unknown): AnchorRecord {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new TypeError('anchor record is not a JSON object')
  const o = json as Record<string, unknown>
  const str = (k: string): string => { const v = o[k]; if (typeof v !== 'string') throw new TypeError(`anchor record ${k} is not a string`); return v }
  const int = (k: string): number => { const v = o[k]; if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new TypeError(`anchor record ${k} is not an integer`); return v }
  // Absent before version 3, which verifyAnchorRecord refuses anyway.
  const optional = <T>(k: string, read: (k: string) => T, absent: T): T => o[k] === undefined ? absent : read(k)
  return {
    peerId: str('peerId'),
    identityPublicKey: str('identityPublicKey'),
    anchorPublicKey: str('anchorPublicKey'),
    anchorContextHex: str('anchorContextHex'),
    epoch: int('epoch'),
    networkType: str('networkType'),
    path: optional('path', str, ''),
    timestamp: int('timestamp'),
    expiresAt: optional('expiresAt', int, 0),
    version: int('version'),
    signature: str('signature')
  }
}

/** The record as the app writes it (key order of PaymentAnchorRecord.toJson). */
export function anchorRecordJson (r: AnchorRecord): string {
  return JSON.stringify({
    peerId: r.peerId, identityPublicKey: r.identityPublicKey, anchorPublicKey: r.anchorPublicKey,
    anchorContextHex: r.anchorContextHex, epoch: r.epoch, networkType: r.networkType, path: r.path,
    timestamp: r.timestamp, expiresAt: r.expiresAt, version: r.version, signature: r.signature
  })
}

/**
 * Null when `record` is a valid anchor record published by `ownerPeerId`
 * for `networkType` ('main' | 'test' | 'regtest') at `path`, not expired at
 * `now` (Unix ms); otherwise why it is not. The checks of
 * PaymentAnchorVerifier.verify, in its order.
 */
export function verifyAnchorRecord (record: AnchorRecord, ownerPeerId: string, networkType: string, path: string, now: number = Date.now()): string | null {
  if (record.version !== ANCHOR_RECORD_VERSION) return `unsupported record version ${record.version}`
  if (record.peerId !== ownerPeerId) return `record names peer ${record.peerId}, fetched from ${ownerPeerId}`
  if (record.networkType !== networkType) return `record is for network ${record.networkType}, not ${networkType}`
  if (record.path !== path) return `record is for ${record.path}, read at ${path}`
  if (now >= record.expiresAt) return 'record expired'
  const peerKey = ed25519KeyOfPeerId(ownerPeerId)
  if (peerKey === null) return `peer id ${ownerPeerId} does not carry its Ed25519 key`
  const identityKey = record.identityPublicKey.toLowerCase()
  if (toHex(peerKey) !== identityKey) return `identity key does not match peer id ${ownerPeerId}`
  if (record.anchorContextHex.toLowerCase() !== anchorContextHex(identityKey, record.epoch, networkType)) {
    return 'anchor context is not the one for this identity and epoch'
  }
  const anchor = record.anchorPublicKey.toLowerCase()
  if (!/^0[23][0-9a-f]{64}$/.test(anchor)) return 'anchor key is not a compressed secp256k1 public key'
  try {
    const ok = ed25519.verify(fromHex(record.signature), anchorSignaturePayload(record), fromHex(identityKey))
    if (!ok) return 'signature does not verify'
  } catch (e) {
    return `signature is malformed: ${errorText(e)}`
  }
  return null
}

export interface AnchorLookup {
  /** The payee's wallet the link names (`w`). */
  walletId?: string
  /** The note of the payment: a `ref <r>` in it picks the request's anchor. */
  note?: string
}

/** The document paths to try, in the app's order (offline_payment_service.dart, _fetchAnchor). */
export function anchorPaths (network: Network, lookup: AnchorLookup = {}): string[] {
  const base = forNetwork(PAYMENT_ANCHOR_DOCUMENT, network)
  const out: string[] = []
  const ref = refInNote(lookup.note)
  if (ref !== null) out.push(`${base}/r/${ref}`)
  if (lookup.walletId !== undefined) out.push(`${base}/w/${lookup.walletId}`)
  out.push(base)
  return out
}

export interface FetchedAnchor {
  record: AnchorRecord
  /** The document path it came from. */
  path: string
}

/**
 * Reads the payee's anchor record, trying the request's, then the
 * wallet's, then the usual path, and verifies it for the payer's network.
 * A request's or a wallet's record that is refused (expired, an older
 * version) gives way to the next path, as the app's _fetchAnchor does.
 */
export async function fetchAnchor (ricochet: RicochetLike, payeePeerId: string, network: Network, lookup: AnchorLookup = {}): Promise<FetchedAnchor> {
  let refused: PaymentError | undefined
  for (const path of anchorPaths(network, lookup)) {
    let r
    try {
      r = await ricochet.getDocument(payeePeerId, path)
    } catch (e) {
      throw new PaymentError('server-unreachable', `Could not read the payee's payment anchor: ${errorText(e)}`,
        { path: 'offline', stage: 'connect', canPayAnotherWay: true, cause: e })
    }
    if (r.status < 200 || r.status >= 300 || r.content === undefined) continue
    let record: AnchorRecord
    try {
      record = parseAnchorRecord(JSON.parse(fromUtf8(r.content)))
    } catch (e) {
      refused = new PaymentError('anchor-invalid', `The payee's anchor record cannot be read: ${errorText(e)}`,
        { path: 'offline', stage: 'request', canPayAnotherWay: true, cause: e })
      continue
    }
    if ((canonicalNetwork(record.networkType) === 'mainnet') !== (network === 'mainnet')) {
      throw new NetworkMismatchError(canonicalNetwork(record.networkType), network, 'anchor', 'offline')
    }
    const problem = verifyAnchorRecord(record, payeePeerId, walletNetworkType(network), path)
    if (problem === null) return { record, path }
    refused = new PaymentError('anchor-invalid', `Could not derive from the payee's offline payment key: ${problem}`,
      { path: 'offline', stage: 'request', canPayAnotherWay: true })
  }
  throw refused ?? new PaymentError('anchor-missing', 'The payee has not published an offline payment key',
    { path: 'offline', stage: 'request', canPayAnotherWay: true })
}
