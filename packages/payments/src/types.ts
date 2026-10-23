/** Shared shapes of the per-path calls and pay(). */

import type { WalletInterface } from '@bsv/sdk'
import type { PaymentError, PaymentPath } from './errors.ts'
import type { Funder } from './funding.ts'

export type PaymentStatus =
  /** Live: the payee checked the transaction by SPV and took it (it broadcasts). */
  | 'completed'
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
  /** Live: whether the payee says it broadcast the transaction (`arcStatus` "broadcasting"). */
  broadcasted?: boolean
  /** Offline: the OfflinePaymentMessage paymentId; the payee de-duplicates by it. */
  paymentId?: string
  /** Offline: the Ricochet message ID. PeerPay: the message box message ID. */
  messageId?: string
  /** PeerPay: the output that pays the payee. */
  outputIndex?: number
  /** Earlier attempts on other paths that failed safely (pay() only). */
  attempts: PaymentError[]
}

export interface PaymentProgress {
  path: PaymentPath
  step: 'anchor' | 'prekeys' | 'derive' | 'fund' | 'seal' | 'submit' | 'dial' | 'request' | 'invoice' | 'send' | 'status'
    | 'key' | 'deliver' | 'abort' | 'fallback'
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
