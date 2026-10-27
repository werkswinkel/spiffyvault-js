/**
 * Everything that is the same on every platform. The entry points
 * (index, browser, node) re-export this.
 *
 * This is the public API: what a payer, a payee or a shop needs. The parts
 * it is built from (sessions, frames, anchors, BEEF handling, bytes) are in
 * ./internal.ts (`@spiffyvault/payments/internal`), which may change in any
 * release.
 */

export {
  parsePaymentLink, formatPaymentLink, isPaymentLinkText, linkMismatch, noteToSend, addRefToNote, refInNote,
  parseRequestRef, parsePaymentKey, formatPaymentKey, paymentKeyMismatch, refusesBareKey, linkSignedText, linkSignatureValid, signPaymentLink,
  MAX_AMOUNT_SATS, MAX_LINK_MEMO, MAX_LINK_WALLET_LABEL, MAX_NOTE
} from './link.ts'
export type { PaymentLink, ParsedPaymentKey } from './link.ts'

export { canonicalNetwork, parseNetwork, assertNetwork, linkNetwork, SPIFFYVAULT_RICOCHET, DEFAULT_MESSAGE_BOX_HOST } from './networks.ts'
export type { Network, WalletNetworkType } from './networks.ts'

export { PaymentError, LinkError, NetworkMismatchError, DomainError, LinkChangedError, isPaymentError } from './errors.ts'
export type { PaymentErrorCode, PaymentPath, FailureStage, PaymentErrorOptions } from './errors.ts'

export {
  normalizeDomain, domainFileUrl, domainSignedText, domainEntry, domainFileText, checkPayeeDomain, verifyDomainFile,
  isPrivateDomainName, isPrivateAddress, DomainFileTooLarge, PRIVATE_DOMAIN_SUFFIXES, DOMAIN_FILE_VERSION, DOMAIN_FILE_PATH, MAX_DOMAIN_FILE_BYTES, DOMAIN_TIMEOUT_MS, MAX_DOMAIN_NAME
} from './domain.ts'
export type {
  DomainFileEntry, PeerKeySigner, DomainEntryParams, DomainProblem, DomainCheck, DomainFetch, DomainCheckParams
} from './domain.ts'

export type { PaymentResult, PaymentStatus, PaymentProgress, FundingContext } from './types.ts'
export type { Funder, FundInfo, FundedPayment, PaymentOutput } from './funding.ts'

// Receiving PeerPay with your own message box client (README, "Receiving PeerPay").
export { BRC29_PROTOCOL_ID } from './destination.ts'
export { payViaPeerPay, deliverPeerPayToken, PeerPayUndeliveredError, PEERPAY_MESSAGE_BOX } from './peerpay.ts'
export type { PeerPayParams, PeerPayContext, PeerPayToken, MessageBoxSender } from './peerpay.ts'

export { isPeerId } from './peer.ts'
export type { RicochetLike } from './ricochet.ts'

export { payOffline, OFFLINE_RECLAIM_SECONDS } from './offline.ts'
export type { OfflinePayParams, OfflinePayContext } from './offline.ts'

export { payLive } from './live/live.ts'
export type { LivePayParams, LivePayContext, LiveTimeouts } from './live/live.ts'
export {
  acceptLivePayments, arcBroadcaster, isReachable, waitUntilReachable, DEFAULT_ARC, PAYEE_SESSION_MS, PAYEE_MAX_NOTE, PAYEE_LIMITS, PAYEE_NETWORK_WAIT_MS
} from './live/payee.ts'
export type {
  LivePayee, LivePayeeOptions, LivePayeeEvent, PayeeLimits, LiveInvoiceRequest, ReceivedLivePayment, Broadcaster, BroadcastResult, NetworkOutcome, ArcOptions
} from './live/payee.ts'

export { pay, planPayment } from './pay.ts'
export type { PayRequest, PayContext, PayPlan } from './pay.ts'
