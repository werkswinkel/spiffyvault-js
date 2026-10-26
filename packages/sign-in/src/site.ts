/**
 * The site's side of Sign in with SpiffyVault (SpiffyVault doc/sign-in.md
 * sections 4 and 7). SignInSite makes challenges, answers the app's
 * callback, and gives the result only to the browser that asked (mode
 * `code`) or to the browser that opens the return link (mode `return`).
 * It does not make sessions: the site does that with the key it returns.
 *
 *   const site = new SignInSite({ domain, callback, name, returnBase })
 *   start:    site.start({ mode, browser })            → show link (QR) and code
 *   callback: site.answer(await req.json())            → reply with status, body
 *   poll:     site.poll(nonce, browser)                → mode code: the key, once
 *   return:   site.redeem(token)                       → mode return: the key, once
 */

import { randomBytes, toBase64Url } from './bytes.ts'
import { MAX_AGE_SECONDS, checkChallenge, challengeLink, checkSiteUrl, readChallenge } from './challenge.ts'
import type { Challenge, Mode } from './challenge.ts'
import { verifyResponse } from './keys.ts'
import type { SignInResponse } from './keys.ts'

/** What the site keeps for one challenge. */
export interface PendingSignIn {
  challenge: Challenge
  /** The code shown in the browser, mode `code`. */
  code?: string
  /** Who asked: the site's own browser id (a cookie), never the nonce. */
  browser: string
  state: 'waiting' | 'signed-in' | 'refused' | 'collected'
  /** The site key, once signed in. */
  publicKey?: string
  /** Mode return: the one-time token in the return link. */
  returnToken?: string
}

/**
 * Where SignInSite keeps pending sign-ins. MemoryStore serves one process;
 * a site with several implements this over its own shared store, with the
 * entries gone after `ttlSeconds`.
 */
export interface SignInStore {
  get (key: string): Promise<PendingSignIn | undefined> | PendingSignIn | undefined
  set (key: string, value: PendingSignIn, ttlSeconds: number): Promise<void> | void
  delete (key: string): Promise<void> | void
}

export class MemoryStore implements SignInStore {
  readonly #entries = new Map<string, { value: PendingSignIn, until: number }>()

  get (key: string): PendingSignIn | undefined {
    const e = this.#entries.get(key)
    if (e === undefined) return undefined
    if (e.until < Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return e.value
  }

  set (key: string, value: PendingSignIn, ttlSeconds: number): void {
    const now = Date.now()
    for (const [k, e] of this.#entries) if (e.until < now) this.#entries.delete(k)
    this.#entries.set(key, { value, until: now + ttlSeconds * 1000 })
  }

  delete (key: string): void {
    this.#entries.delete(key)
  }
}

export interface SignInSiteOptions {
  /** The site's domain as challenges name it; the site key is made from it, so keep it. */
  domain: string
  /** Where the app posts its response: https on exactly `domain`. */
  callback: string
  /** The site's name as the app shows it, 1 to 64 characters. */
  name: string
  /**
   * Mode return: the start of the return link, https on `domain`; the
   * token is added as `?t=`. Needed only for mode return.
   */
  returnBase?: string
  store?: SignInStore
  /** Unix seconds; for tests. */
  now?: () => number
}

/** What the browser needs to show a challenge. */
export interface Started {
  nonce: string
  /** The `spiffyvault://auth?c=` link: the QR code in mode code, the button in mode return. */
  link: string
  /** Mode code: the 6 digits to show beside the QR code. Never put it in the QR code. */
  code?: string
  /** Unix seconds after which the challenge is refused. */
  expiresAt: number
}

/** The reply to send to the app's callback request. */
export interface CallbackReply {
  status: number
  body: { ok: true, return_url?: string } | { ok: false, error: 'code' | 'expired' | 'used' | 'unknown' | 'bad-request' }
  /** The site key, when this request signed someone in. */
  publicKey?: string
}

export type PollResult =
  | { state: 'waiting' }
  | { state: 'signed-in', publicKey: string }
  | { state: 'refused' }
  | { state: 'gone' }

const sixDigits = (): string => {
  // Rejection sampling over 20 bits keeps the code uniform.
  for (;;) {
    const b = randomBytes(3)
    const n = ((b[0]! << 16) | (b[1]! << 8) | b[2]!) & 0xfffff
    if (n < 1_000_000) return String(n).padStart(6, '0')
  }
}

export class SignInSite {
  readonly domain: string
  readonly callback: string
  readonly name: string
  readonly returnBase: string | undefined
  readonly #store: SignInStore
  readonly #now: () => number
  // Entries live a little longer than a challenge, so a late answer reads 'expired', not 'unknown'.
  static readonly #ttl = MAX_AGE_SECONDS * 2

  constructor (opts: SignInSiteOptions) {
    this.domain = opts.domain
    this.callback = opts.callback
    this.name = opts.name
    this.returnBase = opts.returnBase
    this.#store = opts.store ?? new MemoryStore()
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000))
    // The same checks as the app: a site cannot make challenges the app refuses.
    readChallenge({ v: 2, domain: opts.domain, nonce: 'A'.repeat(22), ts: 0, mode: 'code', callback: opts.callback, name: opts.name })
    checkSiteUrl(opts.callback, opts.domain)
    if (opts.returnBase !== undefined) checkSiteUrl(opts.returnBase, opts.domain)
  }

  /**
   * A new challenge for the browser `browser` (the site's own id for it,
   * from a cookie). `place`: where that browser appears to be, if the site
   * can tell (for example from its IP address).
   */
  async start (opts: { mode: Mode, browser: string, place?: string }): Promise<Started> {
    if (opts.mode === 'return' && this.returnBase === undefined) throw new Error('mode return needs returnBase')
    const challenge = readChallenge({
      v: 2,
      domain: this.domain,
      nonce: toBase64Url(randomBytes(16)),
      ts: this.#now(),
      mode: opts.mode,
      callback: this.callback,
      name: this.name,
      ...(opts.place !== undefined ? { place: opts.place } : {})
    })
    const pending: PendingSignIn = {
      challenge,
      browser: opts.browser,
      state: 'waiting',
      ...(opts.mode === 'code' ? { code: sixDigits() } : {})
    }
    await this.#store.set(this.#key(challenge.nonce), pending, SignInSite.#ttl)
    return {
      nonce: challenge.nonce,
      link: challengeLink(challenge),
      ...(pending.code !== undefined ? { code: pending.code } : {}),
      expiresAt: challenge.ts + MAX_AGE_SECONDS
    }
  }

  /**
   * The app's callback (section 4). One attempt per challenge: the first
   * answer is final, right or wrong.
   */
  async answer (body: unknown): Promise<CallbackReply> {
    const r = body as Partial<SignInResponse> | null
    if (typeof r !== 'object' || r === null || r.v !== 2 || typeof r.nonce !== 'string' ||
        typeof r.public_key !== 'string' || typeof r.signature !== 'string') {
      return { status: 400, body: { ok: false, error: 'bad-request' } }
    }
    const pending = await this.#store.get(this.#key(r.nonce))
    if (pending === undefined) return { status: 404, body: { ok: false, error: 'unknown' } }
    if (pending.state !== 'waiting') return { status: 409, body: { ok: false, error: 'used' } }

    pending.state = 'refused'
    await this.#store.set(this.#key(r.nonce), pending, SignInSite.#ttl)
    try {
      checkChallenge(pending.challenge, this.#now())
    } catch {
      return { status: 410, body: { ok: false, error: 'expired' } }
    }
    if (!verifyResponse(pending.challenge, r as SignInResponse, pending.code)) {
      return { status: 400, body: { ok: false, error: 'code' } }
    }

    pending.state = 'signed-in'
    pending.publicKey = r.public_key
    if (pending.challenge.mode === 'return') {
      pending.returnToken = toBase64Url(randomBytes(24))
      await this.#store.set(this.#tokenKey(pending.returnToken), pending, SignInSite.#ttl)
    }
    await this.#store.set(this.#key(r.nonce), pending, SignInSite.#ttl)
    const returnUrl = pending.returnToken !== undefined ? this.#returnUrl(pending.returnToken) : undefined
    return { status: 200, body: { ok: true, ...(returnUrl !== undefined ? { return_url: returnUrl } : {}) }, publicKey: r.public_key }
  }

  /**
   * Mode code: what the browser `browser` gets for its challenge `nonce`.
   * Another browser, or mode return, never gets the key. The key is given
   * once; after that the challenge is `gone`.
   */
  async poll (nonce: string, browser: string): Promise<PollResult> {
    const pending = await this.#store.get(this.#key(nonce))
    if (pending === undefined || pending.browser !== browser || pending.challenge.mode !== 'code' || pending.state === 'collected') {
      return { state: 'gone' }
    }
    if (pending.state === 'waiting') {
      return pending.challenge.ts + MAX_AGE_SECONDS < this.#now() ? { state: 'gone' } : { state: 'waiting' }
    }
    if (pending.state === 'refused') return { state: 'refused' }
    pending.state = 'collected'
    await this.#store.set(this.#key(nonce), pending, SignInSite.#ttl)
    return { state: 'signed-in', publicKey: pending.publicKey! }
  }

  /** Mode return: the key for the browser that opened the return link with `token`, once. */
  async redeem (token: string): Promise<string | undefined> {
    const pending = await this.#store.get(this.#tokenKey(token))
    if (pending === undefined || pending.state !== 'signed-in') return undefined
    await this.#store.delete(this.#tokenKey(token))
    pending.state = 'collected'
    await this.#store.set(this.#key(pending.challenge.nonce), pending, SignInSite.#ttl)
    return pending.publicKey
  }

  #key (nonce: string): string { return `n:${nonce}` }
  #tokenKey (token: string): string { return `t:${token}` }

  #returnUrl (token: string): string {
    const u = new URL(this.returnBase!)
    u.searchParams.set('t', token)
    return u.toString()
  }
}
