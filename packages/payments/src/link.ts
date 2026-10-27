/**
 * SpiffyVault payment links and payment keys, read by the app's rules:
 * lib/services/payment_link.dart, lib/services/payment_requests.dart and
 * lib/services/brc100/payment_key_text.dart.
 *
 *     https://spiffyvault.net/pay?n=testnet&p=12D3KooW…&k=02…&a=10000&m=Coffee&d=shop.example
 */

import { peerIdFromString } from '@libp2p/peer-id'
import { ed25519 } from '@noble/curves/ed25519.js'
import { INVISIBLE_FORMAT, runeLength, takeRunes, utf8 } from './bytes.ts'
import { normalizeDomain } from './domain.ts'
import { NetworkMismatchError } from './errors.ts'
import { canonicalNetwork, linkNetwork } from './networks.ts'
import type { Network } from './networks.ts'
import { ed25519KeyOfPeerId } from './peer.ts'
import type { PeerKeySigner } from './domain.ts'

export const PAY_LINK_HOST = 'spiffyvault.net'
export const PAY_LINK_PATH = '/pay'
export const PAY_LINK_APP_SCHEME = 'spiffyvault'
/** Longest note a link carries; a longer one is cut. */
export const MAX_LINK_MEMO = 100
/** Longest wallet name a link carries. */
export const MAX_LINK_WALLET_LABEL = 40
/** 21 million BSV in satoshis. */
export const MAX_AMOUNT_SATS = 2_100_000_000_000_000
/** The longest note the payee keeps (PaymentSession cuts to this). */
export const MAX_NOTE = 280

const WALLET_ID = /^[A-Za-z0-9_-]{1,64}$/
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const REF = new RegExp(`^[${REF_ALPHABET}]{8}$`)
const REF_IN_NOTE = new RegExp(`\\bref ([${REF_ALPHABET}]{8})\\b`, 'i')
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/
const KEY_TEXT = /(?:\b(mainnet|testnet|regtest)\s*:\s*)?\b(0[23][0-9a-fA-F]{64})\b/i

export interface PaymentLink {
  network: Network
  /** The payee's libp2p peer ID: live, then offline. */
  peerId?: string
  /** The payee's BRC-100 payment key (66 lowercase hex): PeerPay. */
  paymentKey?: string
  amountSats?: number
  memo?: string
  /** The payee's wallet to pay into (`w`), and its name (`wl`). */
  walletId?: string
  walletLabel?: string
  /** The payment request this link pays (`r`). */
  requestRef?: string
  /**
   * The shop's domain that vouches for the payee (`d`): pay only when
   * checkPayeeDomain() verifies it, as the app does. pay() checks it.
   */
  domain?: string
  /**
   * The payee's signature over every other field (`s`): Ed25519 by the key
   * in `peerId`, base64url without padding, over linkSignedText(). Check it
   * with linkSignatureValid(); pay() refuses a link whose signature fails,
   * and falls back to PeerPay only for a signed link.
   */
  signature?: string
}

// ---------------------------------------------------------------------------
// Payment request references
// ---------------------------------------------------------------------------

/** `text` as a request reference (trimmed, upper-cased), or null. */
export function parseRequestRef (text: string | null | undefined): string | null {
  const t = text?.trim().toUpperCase()
  return t !== undefined && REF.test(t) ? t : null
}

/** The request reference in a payment note, upper-cased, or null. */
export function refInNote (note: string | null | undefined): string | null {
  const m = note == null ? null : REF_IN_NOTE.exec(note)
  return m === null ? null : m[1]!.toUpperCase()
}

/**
 * `note` with "ref <ref>" at its end, cut so the whole stays within what
 * the payee keeps; a note that has the reference already stays as it is.
 */
export function addRefToNote (note: string | null | undefined, ref: string): string {
  const tag = `ref ${ref}`
  const n = note?.trim() ?? ''
  if (n === '') return tag
  if (refInNote(n) === ref) return n
  const room = MAX_NOTE - tag.length - 3
  const cut = runeLength(n) > room ? takeRunes(n, room).trimEnd() : n
  return `${cut} · ${tag}`
}

/** The note to send with a payment of `link`: with the request's reference when it has one. */
export function noteToSend (link: Pick<PaymentLink, 'requestRef'>, note: string | null | undefined): string | undefined {
  const ref = link.requestRef
  if (ref === undefined) return note == null || note.trim() === '' ? undefined : note.trim()
  return addRefToNote(note, ref)
}

// ---------------------------------------------------------------------------
// Payment keys
// ---------------------------------------------------------------------------

export interface ParsedPaymentKey {
  /** 66 lowercase hex characters. */
  key: string
  /** 'main', 'test' or 'regtest' when the text named it; undefined for a bare key. */
  network?: 'main' | 'test' | 'regtest'
}

/** The first payment key in `text`, with the network it names (`testnet:02…`), if any. */
export function parsePaymentKey (text: string): ParsedPaymentKey | null {
  const m = KEY_TEXT.exec(text.trim())
  if (m === null) return null
  const label = m[1]?.toLowerCase()
  const out: ParsedPaymentKey = { key: m[2]!.toLowerCase() }
  if (label === 'mainnet') out.network = 'main'
  else if (label === 'testnet') out.network = 'test'
  else if (label === 'regtest') out.network = 'regtest'
  return out
}

/** `key` as shared from a wallet on `network`: bare on mainnet, else `testnet:`/`regtest:` in front. */
export function formatPaymentKey (key: string, network: string): string {
  const n = canonicalNetwork(network)
  return n === 'mainnet' ? key : `${n}:${key}`
}

/** A labelled key for another network than `ourNetwork`, as an error; null when it may be paid. */
export function paymentKeyMismatch (parsed: ParsedPaymentKey, ourNetwork: string): NetworkMismatchError | null {
  if (parsed.network === undefined) return null
  const theirs = canonicalNetwork(parsed.network)
  const ours = canonicalNetwork(ourNetwork)
  return theirs === ours ? null : new NetworkMismatchError(theirs, ours, 'payment key')
}

/**
 * Whether a bare key is refused from a testnet wallet (unless the payer
 * insists): bare keys are mainnet BRC-100 keys, and PeerPay broadcasts
 * before it delivers. Never for a labelled key, or on mainnet or regtest.
 */
export function refusesBareKey (parsed: ParsedPaymentKey, ourNetwork: string): boolean {
  return parsed.network === undefined && canonicalNetwork(ourNetwork) === 'testnet'
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Dropped from every value before it is trimmed: the C0 and C1 control
 * characters that are not whitespace to `\s` (Dart's trim() strips NEL,
 * U+0085, and JavaScript's does not, so the app drops them too), and
 * {@link INVISIBLE_FORMAT}.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = new RegExp(String.raw`[\x00-\x08\x0E-\x1F\x7F-\x9F]|` + INVISIBLE_FORMAT, 'g')

/**
 * Dart's Uri.splitQueryString: '&'-separated, '+' is a space, the last of a
 * repeated key wins; every value without its control characters.
 */
function splitQuery (query: string): Map<string, string> | null {
  const map = new Map<string, string>()
  try {
    for (const element of query.split('&')) {
      const i = element.indexOf('=')
      const dec = (s: string): string => decodeURIComponent(s.replace(/\+/g, ' '))
      if (i === -1) {
        if (element !== '') map.set(dec(element), '')
      } else if (i !== 0) {
        map.set(dec(element.slice(0, i)), dec(element.slice(i + 1)).replace(CONTROLS, ''))
      }
    }
  } catch {
    return null // a malformed %-escape, or one that is not UTF-8: the app refuses both
  }
  return map
}

interface Parts { scheme: string, host: string, path: string, query: string }

function splitUri (text: string): Parts | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/.exec(text)
  if (m === null) return null
  const authority = m[2]!
  const host = authority.replace(/^[^@]*@/, '').replace(/:\d*$/, '')
  return { scheme: m[1]!.toLowerCase(), host: host.toLowerCase(), path: m[3]!, query: m[4] ?? '' }
}

const trimSlash = (p: string): string => p.endsWith('/') ? p.slice(0, -1) : p

/** Dart's String.trim(): JavaScript's whitespace, and NEL (U+0085). */
const dartTrim = (t: string): string => t.replace(/^[\s\x85]+|[\s\x85]+$/g, '')

/** True when `text` has the shape of a payment link, valid or not. */
export function isPaymentLinkText (text: string): boolean {
  const u = splitUri(dartTrim(text))
  return u !== null && isLinkShape(u)
}

function isLinkShape (u: Parts): boolean {
  if (u.scheme === 'https' || u.scheme === 'http') {
    return (u.host === PAY_LINK_HOST || u.host === `www.${PAY_LINK_HOST}`) && trimSlash(u.path) === PAY_LINK_PATH
  }
  if (u.scheme === PAY_LINK_APP_SCHEME) return u.host === 'pay' && trimSlash(u.path) === ''
  return false
}

function blank (v: string | undefined): string | undefined {
  const t = v?.trim()
  return t === undefined || t === '' ? undefined : t
}

function clean (text: string | undefined, max: number): string | undefined {
  const m = text?.replace(CONTROLS, '').replace(/\s+/g, ' ').trim()
  if (m === undefined || m === '') return undefined
  return runeLength(m) > max ? takeRunes(m, max) : m
}

/**
 * An Ed25519 peer ID in base58 (`12D3KooW…`), the one form a link's
 * signature can be checked against; a CID or another key type is not.
 */
function validPeerId (value: string): boolean {
  try { return ed25519KeyOfPeerId(value) !== null && peerIdFromString(value).toString() === value } catch { return false }
}

/** Dart's int.tryParse without a radix: optional sign, decimal or 0x hex. */
function dartInt (text: string): number | null {
  const m = /^([+-]?)(?:(\d+)|0[xX]([0-9a-fA-F]+))$/.exec(text)
  if (m === null) return null
  const v = m[2] !== undefined ? BigInt(m[2]) : BigInt('0x' + m[3]!)
  const signed = m[1] === '-' ? -v : v
  if (signed > 9223372036854775807n || signed < -9223372036854775808n) return null
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) return Number.NaN
  return Number(signed)
}

/**
 * The payment link in `text`, or null when it is not one or a part of it
 * is not valid: an unknown network, a bad peer ID or key, an amount that is
 * not a whole positive number of satoshis within 21 million BSV, a bad
 * wallet ID, request reference, domain or signature (not 64 bytes, or
 * without a peer ID), or neither a peer ID nor a key. It does not check the
 * signature: linkSignatureValid() does.
 */
export function parsePaymentLink (text: string): PaymentLink | null {
  const u = splitUri(dartTrim(text))
  if (u === null || !isLinkShape(u)) return null
  const q = splitQuery(u.query)
  if (q === null) return null

  const network = linkNetwork(q.get('n'))
  if (network === null) return null

  const peerId = blank(q.get('p'))
  if (peerId !== undefined && !validPeerId(peerId)) return null

  const rawKey = blank(q.get('k'))
  let key: string | undefined
  if (rawKey !== undefined) {
    const parsed = parsePaymentKey(rawKey)
    if (parsed === null || parsed.key !== rawKey.toLowerCase()) return null
    key = parsed.key
  }
  if (peerId === undefined && key === undefined) return null

  const rawAmount = blank(q.get('a'))
  let amount: number | undefined
  if (rawAmount !== undefined) {
    const a = dartInt(rawAmount)
    if (a === null || Number.isNaN(a) || a <= 0 || a > MAX_AMOUNT_SATS) return null
    amount = a
  }

  const walletId = blank(q.get('w'))
  if (walletId !== undefined && !WALLET_ID.test(walletId)) return null

  const rawRef = blank(q.get('r'))
  const requestRef = parseRequestRef(rawRef)
  if (rawRef !== undefined && requestRef === null) return null

  const rawDomain = blank(q.get('d'))
  const domain = normalizeDomain(rawDomain)
  if (rawDomain !== undefined && domain === null) return null

  // A signature needs the peer ID whose key made it.
  const signature = blank(q.get('s'))
  if (signature !== undefined && (peerId === undefined || !SIGNATURE.test(signature))) return null

  const link: PaymentLink = { network }
  if (peerId !== undefined) link.peerId = peerId
  if (key !== undefined) link.paymentKey = key
  if (amount !== undefined) link.amountSats = amount
  const memo = clean(q.get('m'), MAX_LINK_MEMO)
  if (memo !== undefined) link.memo = memo
  if (walletId !== undefined) {
    link.walletId = walletId
    const label = clean(q.get('wl'), MAX_LINK_WALLET_LABEL)
    if (label !== undefined) link.walletLabel = label
  }
  if (requestRef !== null) link.requestRef = requestRef
  if (domain !== null) link.domain = domain
  if (signature !== undefined) link.signature = signature
  return link
}

/** The link as text, as the app writes it for its QR code. Throws on a domain that is not one. */
export function formatPaymentLink (link: PaymentLink): string {
  if (link.domain !== undefined && normalizeDomain(link.domain) !== link.domain) throw new TypeError(`not a domain: ${link.domain}`)
  if (link.signature !== undefined && (link.peerId === undefined || !SIGNATURE.test(link.signature))) throw new TypeError('not a link signature')
  const q = new URLSearchParams()
  q.set('n', link.network)
  if (link.peerId !== undefined) q.set('p', link.peerId)
  if (link.paymentKey !== undefined) q.set('k', link.paymentKey)
  if (link.amountSats !== undefined) q.set('a', String(link.amountSats))
  if (link.memo !== undefined) q.set('m', link.memo)
  if (link.walletId !== undefined) q.set('w', link.walletId)
  if (link.walletId !== undefined && link.walletLabel !== undefined) q.set('wl', link.walletLabel)
  if (link.requestRef !== undefined) q.set('r', link.requestRef)
  if (link.domain !== undefined) q.set('d', link.domain)
  if (link.signature !== undefined) q.set('s', link.signature)
  return `https://${PAY_LINK_HOST}${PAY_LINK_PATH}?${q.toString().replace(/\+/g, '%20')}`
}

/** Why `link` must not be paid from a wallet on `ourNetwork`, or null. */
export function linkMismatch (link: Pick<PaymentLink, 'network'>, ourNetwork: string): NetworkMismatchError | null {
  const ours = canonicalNetwork(ourNetwork)
  return ours === link.network ? null : new NetworkMismatchError(link.network, ours, 'code')
}

// ---------------------------------------------------------------------------
// Signed links (the app's PaymentLink.signedText)
// ---------------------------------------------------------------------------

/**
 * What the payee signs (`s`): every field but `s`, each on its own line in
 * this order, empty when absent, with the parsed values (as parsePaymentLink
 * returns them: the key in lower case, note and wallet name cleaned).
 */
export function linkSignedText (link: PaymentLink): string {
  const label = link.walletId === undefined ? undefined : link.walletLabel
  return [
    'spiffyvault-link/1',
    `n=${link.network}`,
    `p=${link.peerId ?? ''}`,
    `k=${link.paymentKey ?? ''}`,
    `a=${link.amountSats ?? ''}`,
    `m=${link.memo ?? ''}`,
    `w=${link.walletId ?? ''}`,
    `wl=${label ?? ''}`,
    `r=${link.requestRef ?? ''}`,
    `d=${link.domain ?? ''}`
  ].join('\n')
}

const b64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromB64url = (text: string): Uint8Array => {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - text.length % 4) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

/** Whether the link's `s` is its payee's signature: false without one, or when it does not check. */
export function linkSignatureValid (link: PaymentLink): boolean {
  if (link.signature === undefined || link.peerId === undefined || !SIGNATURE.test(link.signature)) return false
  const key = ed25519KeyOfPeerId(link.peerId)
  if (key === null) return false
  try {
    return ed25519.verify(fromB64url(link.signature), utf8(linkSignedText(link)), key)
  } catch {
    return false
  }
}

/**
 * The link signed by `signer`, the private key of its peer ID (a libp2p
 * Ed25519 key), as the app signs the links it makes: its note and wallet
 * name cleaned as a payer reads them. Throws when the link has no peer ID,
 * is not valid, or the signature does not check against it.
 */
export async function signPaymentLink (link: PaymentLink, signer: PeerKeySigner): Promise<PaymentLink> {
  if (link.peerId === undefined) throw new TypeError('Only a link with a peer ID can be signed')
  const { signature: _old, ...rest } = link
  if (rest.walletId === undefined) delete rest.walletLabel
  // Signed as a payer reads it: the note and wallet name cleaned, as the app signs.
  const unsigned = parsePaymentLink(formatPaymentLink(rest))
  if (unsigned === null) throw new TypeError('not a valid payment link')
  const signed: PaymentLink = { ...unsigned, signature: b64url(await signer.sign(utf8(linkSignedText(unsigned)))) }
  if (!linkSignatureValid(signed)) throw new Error('The signature does not match the peer ID: sign with its own key')
  return signed
}
