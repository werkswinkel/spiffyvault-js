/**
 * A shop's domain vouching for its payee, by the app's rules
 * (lib/services/payee_domain.dart).
 *
 * A payment link may name a domain (`d`). The payer then reads
 * `https://<d>/.well-known/spiffyvault.json` and pays only when that file
 * lists the link's payee, for the payer's network, signed by the payee's
 * own peer key:
 *
 *     {
 *       "version": 1,
 *       "payees": [
 *         { "peerId": "12D3KooW…", "paymentKey": "02…", "networks": ["mainnet"],
 *           "name": "Shop Name", "sig": "<hex Ed25519 signature>" }
 *       ]
 *     }
 *
 * HTTPS shows the file is the domain's; the signature shows the payee
 * agreed to be listed there. `sig` signs the UTF-8 text of signedText().
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { INVISIBLE_FORMAT, fromHex, runeLength, takeRunes, toHex, utf8 } from './bytes.ts'
import { canonicalNetwork, parseNetwork } from './networks.ts'
import type { Network } from './networks.ts'
import { ed25519KeyOfPeerId } from './peer.ts'

export const DOMAIN_FILE_VERSION = 1
export const DOMAIN_FILE_PATH = '/.well-known/spiffyvault.json'
/** Largest file read; a longer one is refused. */
export const MAX_DOMAIN_FILE_BYTES = 16 * 1024
/** How long the payer waits for the domain, in milliseconds. */
export const DOMAIN_TIMEOUT_MS = 5000
/** Longest shop name taken from the file. */
export const MAX_DOMAIN_NAME = 60

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4 = /^\d+(\.\d+){3}$/
const ENTRY_KEY = /^0[23][0-9a-f]{64}$/

/**
 * `text` as a link's domain: a host name in lower case, ASCII (an
 * international name in punycode), with at least two labels; null when it
 * is not one (a scheme, port, path, IP address or bad label).
 */
export function normalizeDomain (text: string | null | undefined): string | null {
  let d = text?.trim().toLowerCase()
  if (d === undefined || d === '') return null
  if (d.endsWith('.')) d = d.slice(0, -1)
  if (d.length > 253 || IPV4.test(d)) return null
  const labels = d.split('.')
  if (labels.length < 2 || !labels.every(l => LABEL.test(l))) return null
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null
  return d
}

/** The file's address for `domain`. */
export function domainFileUrl (domain: string): string {
  return `https://${domain}${DOMAIN_FILE_PATH}`
}

/** What a payee signs to be listed at `domain`. */
export function domainSignedText (domain: string, peerId: string, paymentKey: string | undefined, networks: readonly string[]): string {
  return `spiffyvault-domain/${DOMAIN_FILE_VERSION} ${domain} ${peerId} ${paymentKey ?? '-'} ${networks.join(',')}`
}

export interface DomainFileEntry {
  peerId: string
  paymentKey?: string
  networks: string[]
  name?: string
  sig: string
}

/** Anything that signs with the payee's peer key, such as a libp2p Ed25519 private key. */
export interface PeerKeySigner {
  sign: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

export interface DomainEntryParams {
  domain: string
  peerId: string
  paymentKey?: string
  networks: readonly string[]
  name?: string
}

/**
 * The payee's entry for `domain`'s file, signed by `signer`, the private
 * key of `peerId`. Throws when the domain is not one, or the signature
 * does not check against the peer ID's key.
 */
export async function domainEntry (params: DomainEntryParams, signer: PeerKeySigner): Promise<DomainFileEntry> {
  const domain = normalizeDomain(params.domain)
  if (domain === null) throw new TypeError(`not a domain: ${params.domain}`)
  const networks = params.networks.map(n => {
    const net = parseNetwork(n)
    if (net === null) throw new TypeError(`not a network: ${n}`)
    return net
  })
  const paymentKey = params.paymentKey?.toLowerCase()
  const text = domainSignedText(domain, params.peerId, paymentKey, networks)
  const sig = toHex(await signer.sign(utf8(text)))
  if (!verifySig(params.peerId, text, sig)) throw new Error('The signature does not match the peer ID: sign with its own key')
  const name = cleanName(params.name)
  return {
    peerId: params.peerId,
    ...(paymentKey !== undefined ? { paymentKey } : {}),
    networks,
    ...(name !== undefined ? { name } : {}),
    sig
  }
}

/** The whole file, with `entries`, as the shop puts it on its site (the app's layout). */
export function domainFileText (entries: readonly DomainFileEntry[]): string {
  return JSON.stringify({ version: DOMAIN_FILE_VERSION, payees: entries }, null, 2)
}

/** Why a domain does not vouch for a link's payee. */
export type DomainProblem =
  /** No answer: offline, a timeout, a TLS error, or (in a browser) no CORS. */
  | 'unreachable'
  /** The domain answered without the file (404, a redirect, any non-200). */
  | 'no-file'
  /** The file is not a version 1 payee file, or is too large. */
  | 'bad-file'
  /** The file does not list the link's payee. */
  | 'not-listed'
  /** The file lists the peer ID with another payment key than the link's. */
  | 'key-mismatch'
  /** The payee is listed, but not for the payer's network. */
  | 'other-network'
  /** The payee's entry is not signed by its peer key. */
  | 'bad-signature'

export type DomainCheck =
  | { verified: true, domain: string, name?: string }
  | { verified: false, domain: string, problem: DomainProblem }

/** Reads the file's bytes; null when the domain answers without one. Throws when there is no answer. */
export type DomainFetch = (url: string, signal: AbortSignal) => Promise<Uint8Array | null>

export interface DomainCheckParams {
  domain: string
  /** The link's peer ID and/or payment key; at least one. */
  peerId?: string
  paymentKey?: string
  /** The payer's network. */
  network: string
  /**
   * Default: fetch() over HTTPS, no redirects, 5 s in all, at most 16 KiB;
   * from the Node.js entry, one that also connects only to a public address
   * (nodeDomainFetch). A domain at or under PRIVATE_DOMAIN_SUFFIXES is
   * refused as 'unreachable' before any fetch.
   */
  fetch?: DomainFetch
  signal?: AbortSignal
}

/** A domain file longer than MAX_DOMAIN_FILE_BYTES: thrown by a DomainFetch, read as 'bad-file'. */
export class DomainFileTooLarge extends Error {}

/**
 * Names that are never on the public internet, as the app keeps them:
 * a link's domain at or under one is refused before anything is fetched,
 * so that a link cannot make a payer or a shop's server reach its own
 * network (assessment finding 6).
 */
export const PRIVATE_DOMAIN_SUFFIXES: readonly string[] = ['localhost', 'local', 'internal', 'home.arpa', 'lan', 'home', 'corp', 'intranet']

/** Whether `domain` (normalized) is, or is under, one of PRIVATE_DOMAIN_SUFFIXES. */
export function isPrivateDomainName (domain: string): boolean {
  return PRIVATE_DOMAIN_SUFFIXES.some(s => domain === s || domain.endsWith(`.${s}`))
}

/**
 * Whether the IP address `address` (text) is not on the public internet:
 * unspecified, loopback, private, shared (CGNAT), link-local or unique-local,
 * or an IPv4 one of those written as IPv6. Text that is not an address
 * counts as private. The app's PayeeDomain.isPrivateAddress.
 */
export function isPrivateAddress (address: string): boolean {
  const v4 = (a: string): number[] | null => {
    const parts = a.split('.')
    if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
    return parts.map(Number)
  }
  const privateV4 = (b: number[]): boolean =>
    b[0] === 0 || b[0] === 10 || b[0] === 127 ||
    (b[0] === 100 && (b[1]! & 0xc0) === 64) ||
    (b[0] === 169 && b[1] === 254) ||
    (b[0] === 172 && (b[1]! & 0xf0) === 16) ||
    (b[0] === 192 && b[1] === 168)
  const plain = v4(address)
  if (plain !== null) return privateV4(plain)
  const bytes = v6Bytes(address)
  if (bytes === null) return true
  const mapped = bytes.slice(0, 10).every(x => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (mapped) return privateV4(bytes.slice(12))
  const zeroHead = bytes.slice(0, 15).every(x => x === 0)
  return (zeroHead && (bytes[15] === 0 || bytes[15] === 1)) || (bytes[0]! & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80)
}

/** An IPv6 address's 16 bytes, its zone dropped; null when it is not one. */
function v6Bytes (text: string): number[] | null {
  let a = text.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase()
  const tail: number[] = []
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a)
  if (dotted !== null) {
    const parts = dotted[2]!.split('.').map(Number)
    if (parts.some(p => p > 255)) return null
    tail.push(parts[0]! << 8 | parts[1]!, parts[2]! << 8 | parts[3]!)
    a = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1)
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const group = (s: string): number[] | null => {
    if (s === '') return []
    const g = s.split(':')
    if (!g.every(x => /^[0-9a-f]{1,4}$/.test(x))) return null
    return g.map(x => parseInt(x, 16))
  }
  const head = group(halves[0]!)
  const rest = halves.length === 2 ? group(halves[1]!) : []
  if (head === null || rest === null) return null
  const known = head.length + rest.length + tail.length
  if (halves.length === 1 ? known !== 8 : known > 7) return null
  const words = [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail]
  return words.flatMap(w => [w >> 8, w & 0xff])
}

let defaultDomainFetch: DomainFetch = (url, signal) => fetchDomainFile(url, signal)

/** The fetch checkPayeeDomain uses when given none: the Node.js entry sets one that refuses private addresses. */
export function setDefaultDomainFetch (fetch: DomainFetch): void { defaultDomainFetch = fetch }

/**
 * Checks that `domain` lists the payee for `network`, as the app does
 * before it pays a link with `d`. In a browser the site must send
 * `Access-Control-Allow-Origin` for the file, or the check is `unreachable`.
 */
export async function checkPayeeDomain (params: DomainCheckParams): Promise<DomainCheck> {
  const domain = normalizeDomain(params.domain)
  if (domain === null) return { verified: false, domain: params.domain, problem: 'bad-file' }
  if (isPrivateDomainName(domain)) return { verified: false, domain, problem: 'unreachable' }
  canonicalNetwork(params.network)
  const timeout = AbortSignal.timeout(DOMAIN_TIMEOUT_MS)
  const signal = params.signal !== undefined ? AbortSignal.any([params.signal, timeout]) : timeout
  let body: Uint8Array | null
  try {
    body = await (params.fetch ?? defaultDomainFetch)(domainFileUrl(domain), signal)
  } catch (e) {
    if (e instanceof DomainFileTooLarge) return { verified: false, domain, problem: 'bad-file' }
    return { verified: false, domain, problem: 'unreachable' }
  }
  if (body === null) return { verified: false, domain, problem: 'no-file' }
  return verifyDomainFile(body, { ...params, domain })
}

/** checkPayeeDomain() on a file already read. */
export function verifyDomainFile (body: Uint8Array | string, params: Omit<DomainCheckParams, 'fetch' | 'signal'>): DomainCheck {
  const domain = params.domain
  const fail = (problem: DomainProblem): DomainCheck => ({ verified: false, domain, problem })
  const bytes = typeof body === 'string' ? utf8(body) : body
  if (bytes.length > MAX_DOMAIN_FILE_BYTES) return fail('bad-file')
  let payees: unknown[]
  try {
    const file: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!isRecord(file) || file.version !== DOMAIN_FILE_VERSION || !Array.isArray(file.payees)) return fail('bad-file')
    payees = file.payees
  } catch {
    return fail('bad-file')
  }

  const key = params.paymentKey?.toLowerCase()
  const net = canonicalNetwork(params.network)
  // The entries naming this payee: by peer ID when the link has one,
  // otherwise by payment key.
  const mine = payees.filter((e): e is Record<string, unknown> =>
    isRecord(e) && (params.peerId !== undefined ? e.peerId === params.peerId : lower(e.paymentKey) === key))
  if (mine.length === 0) return fail('not-listed')

  let problem: DomainProblem = 'key-mismatch'
  for (const e of mine) {
    const entryPeer = e.peerId
    const entryKey = lower(e.paymentKey)
    if (typeof entryPeer !== 'string') continue
    // The key goes into the signed text between the peer ID and the
    // networks: one that is not a key is refused before it gets there.
    if (e.paymentKey != null && (entryKey === undefined || !ENTRY_KEY.test(entryKey))) {
      problem = 'bad-file'
      continue
    }
    if (key !== undefined && entryKey !== key) continue
    const nets = e.networks
    if (!Array.isArray(nets) || !nets.every(n => typeof n === 'string')) {
      problem = 'bad-file'
      continue
    }
    const read = (nets as string[]).map(parseNetwork)
    if (read.includes(null)) {
      problem = 'bad-file'
      continue
    }
    const canonical = read as Network[]
    if (!canonical.includes(net)) {
      problem = 'other-network'
      continue
    }
    const text = domainSignedText(domain, entryPeer, entryKey, canonical)
    if (!verifySig(entryPeer, text, e.sig)) {
      problem = 'bad-signature'
      continue
    }
    const name = cleanName(typeof e.name === 'string' ? e.name : undefined)
    return { verified: true, domain, ...(name !== undefined ? { name } : {}) }
  }
  return fail(problem)
}

function verifySig (peerId: string, text: string, sig: unknown): boolean {
  if (typeof sig !== 'string') return false
  const key = ed25519KeyOfPeerId(peerId)
  if (key === null) return false
  try {
    return ed25519.verify(fromHex(sig), utf8(text), key)
  } catch {
    return false
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const lower = (v: unknown): string | undefined => typeof v === 'string' ? v.toLowerCase() : undefined

const INVISIBLE = new RegExp(INVISIBLE_FORMAT, 'g')

/** The name as it is shown: without invisible format characters, whitespace collapsed. */
function cleanName (name: string | undefined): string | undefined {
  const n = name?.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  if (n === undefined || n === '') return undefined
  return runeLength(n) > MAX_DOMAIN_NAME ? takeRunes(n, MAX_DOMAIN_NAME) : n
}

/** The file's bytes, or null when the domain answers without one (any status but 200, a redirect included). */
async function fetchDomainFile (url: string, signal: AbortSignal): Promise<Uint8Array | null> {
  const response = await fetch(url, { redirect: 'manual', signal, headers: { accept: 'application/json' }, credentials: 'omit' })
  if (response.status !== 200) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > MAX_DOMAIN_FILE_BYTES) {
      await reader.cancel()
      throw new DomainFileTooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}
