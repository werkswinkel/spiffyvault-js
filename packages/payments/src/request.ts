/**
 * Payment requests: what a shop's server hands the payment widget
 * (`@spiffyvault/payments/widget`), and what it reports back while the
 * request is being paid.
 *
 * The payee (a till) makes a request with createPaymentRequest: a reference
 * of its own, a live link signed with its peer key, and a PeerPay link to its
 * payment key. The shop's server passes the request to its page as JSON and
 * answers the widget's status questions with a RequestStatus.
 */

import { formatPaymentLink, signPaymentLink } from './link.ts'
import type { PaymentLink } from './link.ts'
import type { PeerKeySigner } from './domain.ts'
import type { Network } from './networks.ts'
import type { PaymentPath } from './errors.ts'

const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** How long a request's links are good for, unless the payee says otherwise. */
export const DEFAULT_REQUEST_TTL_MS = 10 * 60_000

/** A payment the payee is ready to take, as the widget shows it. */
export interface PaymentRequest {
  /** The shop's id for it (an order number, say); the widget passes it back to `status`. */
  id: string
  /** The reference the payer's note carries ("ref K7Q2M9XD"); it matches a payment to this request. */
  ref: string
  network: Network
  amountSats: number
  memo?: string
  /** Unix milliseconds. After this the links are refused and the widget offers a new one. */
  expiresAt: number
  links: {
    /** Signed link with the payee's peer ID: the app pays live, or by PeerPay when the payee is away. */
    live?: string
    /** Key-only link: any BRC-100 wallet pays it by PeerPay. */
    peerpay?: string
  }
  /** False when the payee cannot take live payments right now; a phone still pays by PeerPay. */
  payeeOnline?: boolean
}

/**
 * Where a request has got to. A live payment goes shown → phone-connected →
 * checking → on-the-way → paid; a PeerPay or mailbox payment shows up later
 * in the list, at on-the-way or in-mailbox.
 */
export type RequestStep =
  | 'shown'
  | 'phone-connected'
  | 'checking'
  | 'on-the-way'
  | 'in-mailbox'
  | 'paid'
  | 'expired'
  | 'refused'

export interface RequestStatus {
  id: string
  step: RequestStep
  /** How it was paid, once the payee knows. */
  path?: PaymentPath
  txid?: string
  /** Step refused: why, in words for the payer. The request is still open; they can try again. */
  reason?: string
  payeeOnline?: boolean
}

/** The payee a request is for: what goes into its links, and its peer key to sign them. */
export interface RequestPayee {
  network: Network
  /** libp2p peer ID: the live link. Needs `signer`. */
  peerId?: string
  /** BRC-100 payment key: the PeerPay link, and the live link's fallback. */
  paymentKey?: string
  /** Signs the live link with the peer key, so a changed amount or payee is refused. */
  signer?: PeerKeySigner
  /** The domain whose /.well-known/spiffyvault.json lists this payee. */
  domain?: string
}

export interface CreateRequestParams {
  id: string
  amountSats: number
  memo?: string
  /** A reference of your own; one is made when left out. */
  ref?: string
  ttlMs?: number
  now?: number
}

/** A new request reference: 8 characters of Crockford base32, as the app makes them. */
export function newRequestRef (): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, b => REF_ALPHABET[b & 31]).join('')
}

/** Makes the links for a payment of `amountSats` to `payee`. */
export async function createPaymentRequest (payee: RequestPayee, params: CreateRequestParams): Promise<PaymentRequest> {
  if (payee.peerId === undefined && payee.paymentKey === undefined) throw new TypeError('A payee needs a peer ID or a payment key')
  if (payee.peerId !== undefined && payee.signer === undefined) throw new TypeError('A live link must be signed: pass the payee\'s signer')
  const ref = params.ref ?? newRequestRef()
  const base: PaymentLink = {
    network: payee.network,
    amountSats: params.amountSats,
    requestRef: ref,
    ...(params.memo !== undefined ? { memo: params.memo } : {})
  }
  const links: PaymentRequest['links'] = {}
  if (payee.peerId !== undefined && payee.signer !== undefined) {
    links.live = formatPaymentLink(await signPaymentLink({
      ...base,
      peerId: payee.peerId,
      ...(payee.paymentKey !== undefined ? { paymentKey: payee.paymentKey } : {}),
      ...(payee.domain !== undefined ? { domain: payee.domain } : {})
    }, payee.signer))
  }
  if (payee.paymentKey !== undefined) links.peerpay = formatPaymentLink({ ...base, paymentKey: payee.paymentKey })
  return {
    id: params.id,
    ref,
    network: payee.network,
    amountSats: params.amountSats,
    ...(params.memo !== undefined ? { memo: params.memo } : {}),
    expiresAt: (params.now ?? Date.now()) + (params.ttlMs ?? DEFAULT_REQUEST_TTL_MS),
    links
  }
}
