/**
 * @spiffyvault/payments/internal: the parts the public API is built from,
 * for tests, tools and wallets that need one step on its own. Unstable:
 * any of it may change or go in any release, a patch release too. Import
 * the public API from @spiffyvault/payments.
 */

import '@go-ricochet/libp2p-udx/multiaddr'

export { setDefaultDomainFetch } from './domain.ts'
export { walletNetworkType, forNetwork, p2pkhVersion, OFFLINE_PAYMENTS_FOLDER, PEER_BUNDLE_FOLDER, PEER_ONE_TIME_KEYS_FOLDER, PAYMENT_ANCHOR_DOCUMENT } from './networks.ts'

export {
  toBeefV1, inspectBeefV1, checkAtomicBeefForPeerPay, beefKind, fundWithWallet, fundWithFunder, walletNetwork,
  BEEF_V1_MAGIC, BEEF_V2_MAGIC, ATOMIC_BEEF_MAGIC
} from './funding.ts'
export type { BeefKind } from './funding.ts'

export { brc29InvoiceNumber, p2pkhScriptForAddress, p2pkhScriptForKey, addressForKey, deriveOfflineDestination } from './destination.ts'
export type { Type42Derivation, OfflineDestination, DestinationOptions } from './destination.ts'

export { createPeerPayClient } from './peerpay.ts'
export { ed25519KeyOfPeerId } from './peer.ts'
export { toHex, fromHex, toBase64, fromBase64, utf8, fromUtf8 } from './bytes.ts'

export {
  anchorContextHex, anchorSignaturePayload, anchorSignedText, parseAnchorRecord, anchorRecordJson, verifyAnchorRecord, anchorPaths,
  fetchAnchor, ANCHOR_RECORD_VERSION, ANCHOR_RECORD_LIFETIME_MS
} from './anchor.ts'
export type { AnchorRecord, AnchorLookup, FetchedAnchor } from './anchor.ts'

export { encodeBundle, decodeBundle, verifyBundle, fetchBundle, signedPreKeySignedBytes, BUNDLE_VERSION } from './sessions/bundle.ts'
export type { PreKeyBundle } from './sessions/bundle.ts'
export {
  encodeOneTimeKeyItem, decodeOneTimeKeyItem, verifyOneTimeKeyItem, oneTimeKeySignedBytes, withOneTimeKey, ONE_TIME_KEY_LABEL
} from './sessions/one-time-key.ts'
export type { OneTimeKeyItem, NoOneTimeKey } from './sessions/one-time-key.ts'
export { sealFirstMessage } from './sessions/seal.ts'
export type { SealOptions, Sealed } from './sessions/seal.ts'
export { APPLICATION as PEER_SESSIONS_APPLICATION, edPublicToX25519 } from './sessions/keys.ts'

export { offlineMessageJson, parseOfflineMessage, OFFLINE_MESSAGE_VERSION, OFFLINE_PAYMENT_PRIORITY } from './offline.ts'
export type { OfflinePaymentMessage } from './offline.ts'

export { dialPayee, circuitAddress, newSessionId, checkInvoice, invoiceOutputs, PAYMENT_PROTOCOL, SPLIT_CAPABILITY, DEFAULT_MAX_FRAME_BYTES } from './live/live.ts'
export { unprovenChain } from './live/payee.ts'
export { encodeOnFrame, decodeOnFrame, readOnFrame, openFrameReader, frameLength, FrameError, FRAME_HEADER, PAYMENT_PROTOCOL_ID, DEFAULT_MAX_INBOUND_FRAME_BYTES } from './live/frame.ts'
export type { FrameReadOptions, FrameReader, ReadFrameResult } from './live/frame.ts'
