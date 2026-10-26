/**
 * Everything that is the same on every platform. The entry points
 * (index, browser, node) re-export this.
 */

export {
  parsePaymentLink, formatPaymentLink, isPaymentLinkText, linkMismatch, noteToSend, addRefToNote, refInNote,
  parseRequestRef, parsePaymentKey, formatPaymentKey, paymentKeyMismatch, refusesBareKey, linkSignedText, linkSignatureValid, signPaymentLink,
  MAX_AMOUNT_SATS, MAX_LINK_MEMO, MAX_LINK_WALLET_LABEL, MAX_NOTE
} from './link.ts'
export type { PaymentLink, ParsedPaymentKey } from './link.ts'

export {
  canonicalNetwork, linkNetwork, walletNetworkType, forNetwork, p2pkhVersion, OFFLINE_PAYMENTS_FOLDER, PEER_BUNDLE_FOLDER, PEER_ONE_TIME_KEYS_FOLDER,
  PAYMENT_ANCHOR_DOCUMENT, SPIFFYVAULT_RICOCHET, DEFAULT_MESSAGE_BOX_HOST
} from './networks.ts'
export type { Network, WalletNetworkType } from './networks.ts'

export { PaymentError, LinkError, NetworkMismatchError, DomainError, LinkChangedError, isPaymentError } from './errors.ts'
export type { PaymentErrorCode, PaymentPath, FailureStage, PaymentErrorOptions } from './errors.ts'

export {
  normalizeDomain, domainFileUrl, domainSignedText, domainEntry, domainFileText, checkPayeeDomain, verifyDomainFile,
  DOMAIN_FILE_VERSION, DOMAIN_FILE_PATH, MAX_DOMAIN_FILE_BYTES, DOMAIN_TIMEOUT_MS, MAX_DOMAIN_NAME
} from './domain.ts'
export type {
  DomainFileEntry, PeerKeySigner, DomainEntryParams, DomainProblem, DomainCheck, DomainFetch, DomainCheckParams
} from './domain.ts'

export type { PaymentResult, PaymentStatus, PaymentProgress, FundingContext } from './types.ts'

export {
  toBeefV1, inspectBeefV1, checkAtomicBeefForPeerPay, beefKind, fundWithWallet, fundWithFunder, walletNetwork,
  BEEF_V1_MAGIC, BEEF_V2_MAGIC, ATOMIC_BEEF_MAGIC
} from './funding.ts'
export type { Funder, FundInfo, FundedPayment, PaymentOutput, BeefKind } from './funding.ts'

export {
  BRC29_PROTOCOL_ID, brc29InvoiceNumber, p2pkhScriptForAddress, p2pkhScriptForKey, addressForKey, deriveOfflineDestination
} from './destination.ts'
export type { Type42Derivation, OfflineDestination, DestinationOptions } from './destination.ts'

export {
  payViaPeerPay, createPeerPayClient, deliverPeerPayToken, PeerPayUndeliveredError, PEERPAY_MESSAGE_BOX
} from './peerpay.ts'
export type { PeerPayParams, PeerPayContext, PeerPayToken, MessageBoxSender } from './peerpay.ts'

export { ed25519KeyOfPeerId, isPeerId } from './peer.ts'
export type { RicochetLike } from './ricochet.ts'
export { toHex, fromHex, toBase64, fromBase64, utf8, fromUtf8 } from './bytes.ts'

export {
  anchorContextHex, anchorSignaturePayload, parseAnchorRecord, anchorRecordJson, verifyAnchorRecord, anchorPaths, fetchAnchor,
  ANCHOR_RECORD_VERSION
} from './anchor.ts'
export type { AnchorRecord, AnchorLookup, FetchedAnchor } from './anchor.ts'

export { encodeBundle, decodeBundle, verifyBundle, fetchBundle } from './sessions/bundle.ts'
export type { PreKeyBundle } from './sessions/bundle.ts'
export {
  encodeOneTimeKeyItem, decodeOneTimeKeyItem, verifyOneTimeKeyItem, oneTimeKeySignedBytes, withOneTimeKey, ONE_TIME_KEY_LABEL
} from './sessions/one-time-key.ts'
export type { OneTimeKeyItem, NoOneTimeKey } from './sessions/one-time-key.ts'
export { sealFirstMessage } from './sessions/seal.ts'
export type { SealOptions, Sealed } from './sessions/seal.ts'
export { APPLICATION as PEER_SESSIONS_APPLICATION, edPublicToX25519 } from './sessions/keys.ts'

export {
  payOffline, offlineMessageJson, parseOfflineMessage, OFFLINE_MESSAGE_VERSION, OFFLINE_PAYMENT_PRIORITY
} from './offline.ts'
export type { OfflinePaymentMessage, OfflinePayParams, OfflinePayContext } from './offline.ts'

export {
  payLive, dialPayee, circuitAddress, newSessionId, checkInvoice, invoiceOutputs, PAYMENT_PROTOCOL, SPLIT_CAPABILITY, DEFAULT_MAX_FRAME_BYTES
} from './live/live.ts'
export type { LivePayParams, LivePayContext, LiveTimeouts } from './live/live.ts'
export {
  acceptLivePayments, arcBroadcaster, isReachable, waitUntilReachable, unprovenChain, DEFAULT_ARC, PAYEE_SESSION_MS, PAYEE_MAX_NOTE, PAYEE_LIMITS
} from './live/payee.ts'
export type {
  LivePayee, LivePayeeOptions, LivePayeeEvent, PayeeLimits, LiveInvoiceRequest, ReceivedLivePayment, Broadcaster, BroadcastResult, ArcOptions
} from './live/payee.ts'
export { encodeOnFrame, decodeOnFrame, readOnFrame, openFrameReader, frameLength, FrameError, FRAME_HEADER, PAYMENT_PROTOCOL_ID, DEFAULT_MAX_INBOUND_FRAME_BYTES } from './live/frame.ts'
export type { FrameReadOptions } from './live/frame.ts'
export type { FrameReader } from './live/frame.ts'
export type { ReadFrameResult } from './live/frame.ts'

export { pay, planPayment } from './pay.ts'
export type { PayRequest, PayContext, PayPlan } from './pay.ts'
