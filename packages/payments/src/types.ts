/** Shared shapes of the per-path calls and pay(). */

import type { WalletInterface } from '@bsv/sdk'
import type { PaymentError, PaymentPath } from './errors.ts'
import type { Funder } from './funding.ts'

export type PaymentStatus =
  /** Live: the payee checked the transaction by SPV and put it on the network. */
  | 'completed'
  /**
   * Live: the payee checked it and ARC accepted it, but the network had not
   * answered within `timeouts.networkMs`. Do not pay again; watch the txid.
   */
  | 'sent'
  /** Offline: sealed and in the payee's Ricochet mailbox; the payee broadcasts when it collects. */
  | 'handed-off'
  /** PeerPay: broadcast by the payer's wallet and the token left in the payee's message box. */
  | 'delivered'

export interface PaymentResult {
  path: PaymentPath
  txid: string
  status: PaymentStatus
  amountSats: number
  /** The note sent with the payment (with `ref <r>` when the link has a request reference). */
  note?: string
  /** Live: whether the payee says it broadcast the transaction (`arcStatus` "broadcasting"); false when ARC reports it mined or seen instead. */
  broadcasted?: boolean
  /** Offline: the OfflinePaymentMessage paymentId; the payee de-duplicates by it. */
  paymentId?: string
  /** Offline: the Ricochet message ID. PeerPay: the message box message ID. */
  messageId?: string
  /**
   * Offline: when the payment is reclaimed if the payee has not broadcast it
   * by then (ms since 1970; about 3 days on). Absent with
   * `offlineReclaimSeconds: false`.
   */
  reclaimAt?: number
  /** PeerPay: the output that pays the payee. */
  outputIndex?: number
  /** Earlier attempts on other paths that failed safely (pay() only). */
  attempts: PaymentError[]
  /** pay() of a link with `d`: the domain that vouched for the payee, and the shop name its file gives. */
  payeeDomain?: { domain: string, name?: string }
}

export interface PaymentProgress {
  path: PaymentPath
  step: 'anchor' | 'prekeys' | 'derive' | 'fund' | 'seal' | 'submit' | 'dial' | 'request' | 'invoice' | 'send' | 'status' | 'network'
    | 'key' | 'deliver' | 'abort' | 'fallback'
  /** pay(): checking the link's domain (`path` is the first path pay() will try). */
    | 'domain'
  detail?: string
}

/** How a payment is funded: a BRC-100 wallet, or a lower-level Funder. */
export interface FundingContext {
  /** A BRC-100 wallet (WalletInterface from @bsv/sdk). Needed for PeerPay. */
  wallet?: WalletInterface
  /** For wallets that are not BRC-100 (live and offline only). */
  funder?: Funder
  /** BRC-100 originator domain passed to the wallet. */
  originator?: string
  onProgress?: (p: PaymentProgress) => void
}
