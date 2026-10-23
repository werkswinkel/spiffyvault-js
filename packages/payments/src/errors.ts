/**
 * Typed errors. Every failure of a payment is a PaymentError with a `code`
 * a program can switch on, the `path` it happened on, the `stage` it
 * reached, and `canPayAnotherWay`: true only when nothing that could pay
 * the payee has left this side (so trying another path cannot pay twice).
 */

export type PaymentPath = 'live' | 'offline' | 'peerpay'

/**
 * How far a payment got before it failed, after the app's scale
 * (PaymentFailureStage, lib/services/p2p_isolate/protocol/payment_session.dart):
 *
 * - `prepare`: checks before anything was asked of anyone (link, key, amount).
 * - `connect`: the payee, its anchor, prekeys or message box could not be reached.
 * - `request`: no usable invoice (live) or no usable anchor/prekeys (offline).
 * - `pay`: the wallet could not build the transaction, or it was built and
 *   then abandoned (aborted) before it left.
 * - `deliver`: handing the transaction over failed in a way that may or may
 *   not have reached the payee.
 * - `settle`: the transaction was handed over and no good answer came back.
 */
export type FailureStage = 'prepare' | 'connect' | 'request' | 'pay' | 'deliver' | 'settle'

export type PaymentErrorCode =
  | 'bad-link' | 'bad-key' | 'bare-key' | 'own-key' | 'network-mismatch' | 'amount-invalid' | 'no-route'
  | 'payee-unreachable' | 'server-unreachable' | 'no-invoice' | 'bad-invoice' | 'invoice-expired' | 'frame-too-large'
  | 'anchor-missing' | 'anchor-invalid' | 'anchor-other-network'
  | 'prekeys-missing' | 'prekeys-not-public' | 'prekeys-invalid'
  | 'funding-failed' | 'beef-unusable' | 'broadcast-failed'
  | 'mailbox-refused' | 'delivery-unknown' | 'not-confirmed' | 'payee-refused' | 'network-refused'
  | 'peerpay-undelivered' | 'aborted'

export interface PaymentErrorOptions {
  path?: PaymentPath
  stage: FailureStage
  /** True when nothing that pays the payee has left; another path is safe. */
  canPayAnotherWay: boolean
  /** The payment's txid, once one was built. */
  txid?: string
  /** The wallet action was aborted (inputs released). */
  aborted?: boolean
  /** Earlier attempts on other paths, when pay() fell back. */
  attempts?: PaymentError[]
  cause?: unknown
}

export class PaymentError extends Error {
  readonly code: PaymentErrorCode
  readonly path?: PaymentPath
  readonly stage: FailureStage
  readonly canPayAnotherWay: boolean
  readonly txid?: string
  readonly aborted: boolean
  readonly attempts: PaymentError[]

  constructor (code: PaymentErrorCode, message: string, opts: PaymentErrorOptions) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'PaymentError'
    this.code = code
    if (opts.path !== undefined) this.path = opts.path
    this.stage = opts.stage
    this.canPayAnotherWay = opts.canPayAnotherWay
    if (opts.txid !== undefined) this.txid = opts.txid
    this.aborted = opts.aborted === true
    this.attempts = opts.attempts ?? []
  }

  /** The same error, re-labelled (used when pay() collects attempts). */
  withAttempts (attempts: PaymentError[]): PaymentError {
    const e = new PaymentError(this.code, this.message, {
      ...(this.path !== undefined ? { path: this.path } : {}),
      stage: this.stage,
      canPayAnotherWay: this.canPayAnotherWay,
      ...(this.txid !== undefined ? { txid: this.txid } : {}),
      aborted: this.aborted,
      attempts,
      cause: this.cause
    })
    return e
  }
}

/** The text is not a SpiffyVault payment link, or a part of it is not valid. */
export class LinkError extends PaymentError {
  constructor (message: string) {
    super('bad-link', message, { stage: 'prepare', canPayAnotherWay: true })
    this.name = 'LinkError'
  }
}

/** The link or key is for another network than the payer's wallet. */
export class NetworkMismatchError extends PaymentError {
  /** 'mainnet', 'testnet' or 'regtest'. */
  readonly theirs: string
  readonly ours: string
  constructor (theirs: string, ours: string, what: 'code' | 'payment key' | 'anchor' | 'invoice', path?: PaymentPath) {
    super(what === 'anchor' ? 'anchor-other-network' : 'network-mismatch',
      `This ${what} is for ${theirs}; this wallet is on ${ours}. Paying it would send coins the other wallet never sees.`,
      { stage: what === 'invoice' || what === 'anchor' ? 'request' : 'prepare', canPayAnotherWay: what !== 'code' && what !== 'payment key', ...(path !== undefined ? { path } : {}) })
    this.name = 'NetworkMismatchError'
    this.theirs = theirs
    this.ours = ours
  }
}

export function isPaymentError (e: unknown): e is PaymentError { return e instanceof PaymentError }

export function errorText (e: unknown): string { return e instanceof Error ? e.message : String(e) }
