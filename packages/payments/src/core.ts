/**
 * Everything that is the same on every platform. The entry points
 * (index, browser, node) re-export this.
 */

export {
  parsePaymentLink, formatPaymentLink, isPaymentLinkText, linkMismatch, noteToSend, addRefToNote, refInNote,
  parseRequestRef, parsePaymentKey, formatPaymentKey, paymentKeyMismatch, refusesBareKey,
  MAX_AMOUNT_SATS, MAX_LINK_MEMO, MAX_LINK_WALLET_LABEL, MAX_NOTE
} from './link.ts'
export type { PaymentLink, ParsedPaymentKey } from './link.ts'

export {
  canonicalNetwork, linkNetwork, walletNetworkType, forNetwork, p2pkhVersion, OFFLINE_PAYMENTS_FOLDER, PREKEYS_FOLDER,
  PAYMENT_ANCHOR_DOCUMENT, SPIFFYVAULT_RICOCHET, DEFAULT_MESSAGE_BOX_HOST
} from './networks.ts'
export type { Network, WalletNetworkType } from './networks.ts'

export { PaymentError, LinkError, NetworkMismatchError, isPaymentError } from './errors.ts'
export type { PaymentErrorCode, PaymentPath, FailureStage, PaymentErrorOptions } from './errors.ts'

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

export {
  parsePrekeyBundle, prekeyBundleJson, bundleCanonicalBytes, verifyPrekeyBundle, fetchPrekeyBundle
} from './signal/bundle.ts'
export type { PrekeyBundle, OneTimePreKey } from './signal/bundle.ts'
export { sealFirstMessage } from './signal/seal.ts'
export type { SealOptions, Sealed } from './signal/seal.ts'
export {
  encodeSignalMessage, decodeSignalMessage, encodePreKeySignalMessage, decodePreKeySignalMessage, parsesAsSignalMessage
} from './signal/messages.ts'
export type { SignalMessage, PreKeySignalMessage } from './signal/messages.ts'
export { x3dhInitiator, firstChain, hkdf32, dh as x25519SharedSecret, x25519Public } from './signal/kdf.ts'

export {
  payOffline, offlineMessageJson, parseOfflineMessage, OFFLINE_MESSAGE_VERSION, OFFLINE_PAYMENT_PRIORITY
} from './offline.ts'
export type { OfflinePaymentMessage, OfflinePayParams, OfflinePayContext } from './offline.ts'
