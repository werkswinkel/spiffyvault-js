/**
 * Payment destinations: P2PKH scripts for invoice addresses (live), BRC-42
 * children of the payee's anchor key (offline), BRC-29 keys (PeerPay).
 */

import { P2PKH, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import { randomBytes, toBase64 } from './bytes.ts'
import { p2pkhVersion } from './networks.ts'
import type { Network } from './networks.ts'

/** BRC-29's protocol: security level 2, "3241645161d8". */
export const BRC29_PROTOCOL_ID: [2, string] = [2, '3241645161d8']

/** The BRC-42 invoice number of a BRC-29 payment: `2-3241645161d8-<prefix> <suffix>`. */
export function brc29InvoiceNumber (prefix: string, suffix: string): string {
  return `2-3241645161d8-${prefix} ${suffix}`
}

/** The P2PKH locking script (hex) of a base58 address, checked against the payer's network. */
export function p2pkhScriptForAddress (address: string, network: Network): string {
  let decoded
  try {
    decoded = Utils.fromBase58Check(address)
  } catch {
    throw new TypeError(`not a base58check address: ${address}`)
  }
  const prefix = Array.isArray(decoded.prefix) ? decoded.prefix : Utils.toArray(decoded.prefix, 'hex')
  const data = Array.isArray(decoded.data) ? decoded.data : Utils.toArray(decoded.data, 'hex')
  if (prefix.length !== 1 || data.length !== 20) throw new TypeError(`not a P2PKH address: ${address}`)
  if (prefix[0] !== p2pkhVersion(network)) {
    throw new RangeError(`address ${address} is not a ${network} address`)
  }
  return new P2PKH().lock(data).toHex()
}

/** The P2PKH locking script (hex) paying a compressed public key. */
export function p2pkhScriptForKey (publicKeyHex: string): string {
  return new P2PKH().lock(PublicKey.fromString(publicKeyHex).toHash() as number[]).toHex()
}

/** The P2PKH address of a public key on `network`. */
export function addressForKey (publicKeyHex: string, network: Network): string {
  return PublicKey.fromString(publicKeyHex).toAddress([p2pkhVersion(network)])
}

/** `Type42Derivation.toMap()` of libspiffy: what the payee needs to find its output. All strings. */
export interface Type42Derivation {
  anchorPublicKey: string
  anchorContext: string
  senderPublicKey: string
  invoiceNumber: string
}

export interface OfflineDestination {
  /** P2PKH locking script, hex. */
  lockingScript: string
  address: string
  /** The child key C, compressed hex. */
  childPublicKey: string
  derivation: Type42Derivation
}

export interface DestinationOptions {
  /** The single-use sender key b (hex). Default: a fresh random key. It never signs. */
  senderPrivateKey?: string
  /** Default: base64 of 16 random bytes, as the Dart payer does. */
  prefix?: string
  suffix?: string
}

/**
 * A single-use BRC-42 destination under the payee's anchor key A:
 * C = A + HMAC-SHA256(compressed(b·A), invoiceNumber)·G, paid by P2PKH.
 */
export function deriveOfflineDestination (anchorPublicKey: string, anchorContextHex: string, network: Network,
  opts: DestinationOptions = {}): OfflineDestination {
  const sender = opts.senderPrivateKey !== undefined ? PrivateKey.fromHex(opts.senderPrivateKey) : PrivateKey.fromRandom()
  const prefix = opts.prefix ?? toBase64(randomBytes(16))
  const suffix = opts.suffix ?? toBase64(randomBytes(16))
  const invoiceNumber = brc29InvoiceNumber(prefix, suffix)
  const child = PublicKey.fromString(anchorPublicKey).deriveChild(sender, invoiceNumber)
  const childHex = child.toString()
  return {
    lockingScript: p2pkhScriptForKey(childHex),
    address: addressForKey(childHex, network),
    childPublicKey: childHex,
    derivation: {
      anchorPublicKey,
      anchorContext: anchorContextHex,
      senderPublicKey: sender.toPublicKey().toString(),
      invoiceNumber
    }
  }
}
