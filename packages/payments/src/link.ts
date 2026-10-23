/**
 * SpiffyVault payment links and payment keys, read by the app's rules:
 * lib/services/payment_link.dart, lib/services/payment_requests.dart and
 * lib/services/brc100/payment_key_text.dart.
 *
 *     https://spiffyvault.net/pay?n=testnet&p=12D3KooW…&k=02…&a=10000&m=Coffee
 */

import { peerIdFromString } from '@libp2p/peer-id'
import { runeLength, takeRunes } from './bytes.ts'
import { NetworkMismatchError } from './errors.ts'
import { canonicalNetwork, linkNetwork } from './networks.ts'
import type { Network } from './networks.ts'

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

/** Dart's Uri.splitQueryString: '&'-separated, '+' is a space, the last of a repeated key wins. */
function splitQuery (query: string): Map<string, string> | null {
  const map = new Map<string, string>()
  try {
    for (const element of query.split('&')) {
      const i = element.indexOf('=')
      const dec = (s: string): string => decodeURIComponent(s.replace(/\+/g, ' '))
      if (i === -1) {
        if (element !== '') map.set(dec(element), '')
      } else if (i !== 0) {
        map.set(dec(element.slice(0, i)), dec(element.slice(i + 1)))
      }
    }
  } catch {
    return null // a malformed %-escape; Dart throws here
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

/** True when `text` has the shape of a payment link, valid or not. */
export function isPaymentLinkText (text: string): boolean {
  const u = splitUri(text.trim())
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
  const m = text?.replace(/\s+/g, ' ').trim()
  if (m === undefined || m === '') return undefined
  return runeLength(m) > max ? takeRunes(m, max) : m
}

function validPeerId (value: string): boolean {
  try { peerIdFromString(value); return true } catch { return false }
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
 * wallet ID or request reference, or neither a peer ID nor a key.
 */
export function parsePaymentLink (text: string): PaymentLink | null {
  const u = splitUri(text.trim())
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
  return link
}

/** The link as text, as the app writes it for its QR code. */
export function formatPaymentLink (link: PaymentLink): string {
  const q = new URLSearchParams()
  q.set('n', link.network)
  if (link.peerId !== undefined) q.set('p', link.peerId)
  if (link.paymentKey !== undefined) q.set('k', link.paymentKey)
  if (link.amountSats !== undefined) q.set('a', String(link.amountSats))
  if (link.memo !== undefined) q.set('m', link.memo)
  if (link.walletId !== undefined) q.set('w', link.walletId)
  if (link.walletId !== undefined && link.walletLabel !== undefined) q.set('wl', link.walletLabel)
  if (link.requestRef !== undefined) q.set('r', link.requestRef)
  return `https://${PAY_LINK_HOST}${PAY_LINK_PATH}?${q.toString().replace(/\+/g, '%20')}`
}

/** Why `link` must not be paid from a wallet on `ourNetwork`, or null. */
export function linkMismatch (link: Pick<PaymentLink, 'network'>, ourNetwork: string): NetworkMismatchError | null {
  const ours = canonicalNetwork(ourNetwork)
  return ours === link.network ? null : new NetworkMismatchError(link.network, ours, 'code')
}
