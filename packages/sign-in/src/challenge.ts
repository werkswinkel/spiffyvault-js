/**
 * The OIAP-v2 challenge (SpiffyVault doc/sign-in.md sections 1 to 3): its
 * fields and limits, the checks the app makes, the link, and the text the
 * app signs. The same rules as the app, so a site cannot make a challenge
 * the app refuses.
 */

import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './bytes.ts'

export const VERSION = 2
export const MAX_LINK_BYTES = 2048
/** A challenge is good for this long either side of its `ts`. */
export const MAX_AGE_SECONDS = 300

/**
 * `code`: the browser is on another device; it shows a 6-digit code the
 * user types into the app. `return`: the browser is on the phone; the app
 * opens the site's one-time return link after approval.
 */
export type Mode = 'code' | 'return'

export interface Challenge {
  v: 2
  domain: string
  nonce: string
  /** Unix seconds. */
  ts: number
  mode: Mode
  callback: string
  name: string
  /** Where the asking browser appears to be, for example `Lagos, Nigeria`. */
  place?: string
}

/** Why a challenge, a URL or a link cannot be used. */
export class ChallengeError extends Error {
  override name = 'ChallengeError'
}

const HOST = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/
const NONCE = /^[A-Za-z0-9_-]{22,128}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

const isLabel = (s: unknown): s is string =>
  typeof s === 'string' && s.trim() !== '' && [...s].length <= 64 && !CONTROL.test(s)

/** The challenge in `json` (section 1), or a ChallengeError saying what is wrong. */
export function readChallenge (json: unknown): Challenge {
  if (typeof json !== 'object' || json === null) throw new ChallengeError('not a JSON object')
  const o = json as Record<string, unknown>
  if (o.v !== VERSION) throw new ChallengeError('not an OIAP-v2 challenge')
  if (typeof o.domain !== 'string' || !HOST.test(o.domain)) throw new ChallengeError('"domain" is not a lowercase host name')
  if (typeof o.nonce !== 'string' || !NONCE.test(o.nonce)) throw new ChallengeError('"nonce" is not 22 to 128 base64url characters')
  if (typeof o.ts !== 'number' || !Number.isInteger(o.ts)) throw new ChallengeError('"ts" is not an integer')
  if (o.mode !== 'code' && o.mode !== 'return') throw new ChallengeError('"mode" is not code or return')
  if (typeof o.callback !== 'string' || o.callback === '' || CONTROL.test(o.callback)) throw new ChallengeError('"callback" is missing')
  if (!isLabel(o.name)) throw new ChallengeError('"name" is not 1 to 64 characters')
  if (o.place !== undefined && !isLabel(o.place)) throw new ChallengeError('"place" is not 1 to 64 characters')
  return {
    v: VERSION,
    domain: o.domain,
    nonce: o.nonce,
    ts: o.ts,
    mode: o.mode,
    callback: o.callback,
    name: o.name,
    ...(o.place !== undefined ? { place: o.place as string } : {})
  }
}

/** `localhost`, `127.0.0.1` or a private IPv4 address (10/8, 172.16/12, 192.168/16). */
export function isLocalHost (host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1') return true
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false
  const [a, b] = parts.map(Number) as [number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Section 2, rules 3 and 4: `url` may be used for `domain` (a callback or
 * a return link): https on exactly the domain, which has at least two
 * labels, or, for development, http or https on exactly a local `domain`.
 * A subdomain is refused: it would get the parent's site key.
 */
export function checkSiteUrl (url: string, domain: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new ChallengeError(`not a URL: ${url}`)
  }
  if (u.username !== '' || u.password !== '' || url.includes('#') || u.hostname === '') throw new ChallengeError(`not a usable URL: ${url}`)
  const host = u.hostname
  if (isLocalHost(domain)) {
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || host !== domain) throw new ChallengeError(`"${host}" is not the local domain "${domain}"`)
    return
  }
  if (!domain.includes('.')) throw new ChallengeError(`"${domain}" is not a site's domain`)
  if (u.protocol !== 'https:') throw new ChallengeError(`${url} does not use HTTPS`)
  if (host !== domain) throw new ChallengeError(`"${host}" is not the domain "${domain}"`)
}

/** Section 2: the callback rule and `|now - ts| <= 300`. `now` in Unix seconds. */
export function checkChallenge (c: Challenge, now: number = Math.floor(Date.now() / 1000)): void {
  checkSiteUrl(c.callback, c.domain)
  if (Math.abs(now - c.ts) > MAX_AGE_SECONDS) throw new ChallengeError('challenge expired')
}

/** The JSON object of a challenge, its fields in the app's order. */
export function challengeJson (c: Challenge): Record<string, unknown> {
  return {
    v: VERSION,
    domain: c.domain,
    nonce: c.nonce,
    ts: c.ts,
    mode: c.mode,
    callback: c.callback,
    name: c.name,
    ...(c.place !== undefined ? { place: c.place } : {})
  }
}

/** The `spiffyvault://auth?c=` link of a challenge: what the QR code holds and the phone opens. */
export function challengeLink (c: Challenge): string {
  return `spiffyvault://auth?c=${toBase64Url(utf8(JSON.stringify(challengeJson(c))))}`
}

/** The challenge in a `spiffyvault://auth?c=` link (or its bare `c`). Does not run checkChallenge. */
export function parseChallengeLink (text: string): Challenge {
  let c = text
  if (text.startsWith('spiffyvault://')) {
    const u = new URL(text)
    if (u.host !== 'auth') throw new ChallengeError('not a sign-in link')
    c = u.searchParams.get('c') ?? ''
  }
  if (c === '' || c.length > MAX_LINK_BYTES) throw new ChallengeError('no challenge in the link, or too long')
  let json: unknown
  try {
    json = JSON.parse(fromUtf8(fromBase64Url(c)))
  } catch (e) {
    throw new ChallengeError(`the challenge does not decode: ${(e as Error).message}`)
  }
  return readChallenge(json)
}

/**
 * Section 3: the nine lines the site key signs. `code` is the 6 digits
 * typed in mode `code`; ignored in mode `return`.
 */
export function signedText (c: Challenge, code?: string): string {
  return [
    'OIAP-v2', c.domain, c.nonce, String(c.ts), c.mode, c.callback, c.name, c.place ?? '', c.mode === 'code' ? (code ?? '') : ''
  ].join('\n')
}
