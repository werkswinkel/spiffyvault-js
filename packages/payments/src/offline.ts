/**
 * The offline path: pay a payee who is not online by leaving a sealed
 * payment in their Ricochet mailbox (lib/services/offline_payment_service.dart).
 *
 * 1. Read and verify the payee's anchor record (request, wallet, usual path).
 * 2. Read and verify the payee's pre-key bundle, and claim one of its
 *    one-time pre-keys (SpiffyVault doc/peer-sessions.md section 5).
 * 3. Derive a single-use BRC-42 destination under the anchor key.
 * 4. Build the transaction, not broadcast (the payee broadcasts), as BEEF V1.
 * 5. Seal the OfflinePaymentMessage as the first message of a new session
 *    (a pre-key message), from the payer's identity key.
 * 6. Submit it to `wallet/offline-payments` (per network), priority 2, persistent,
 *    with no RCE2 encryption and no compression.
 *
 * A failure before the mailbox took the message aborts the wallet action.
 */

import { NoServerError } from '@go-ricochet/ricochet/core'
import type { Ed25519PrivateKeyLike } from '@go-ricochet/ricochet/core'
import { fetchAnchor } from './anchor.ts'
import { equalBytes, toHex, utf8, uuidV4 } from './bytes.ts'
import { deriveOfflineDestination } from './destination.ts'
import type { Type42Derivation } from './destination.ts'
import { PaymentError, errorText } from './errors.ts'
import { fundWithFunder, fundWithWallet } from './funding.ts'
import type { FundedPayment, PaymentOutput } from './funding.ts'
import { OFFLINE_PAYMENTS_FOLDER, forNetwork } from './networks.ts'
import type { Network } from './networks.ts'
import { ed25519KeyOfPeerId } from './peer.ts'
import type { RicochetLike } from './ricochet.ts'
import { fetchBundle } from './sessions/bundle.ts'
import { identityOfSeed } from './sessions/keys.ts'
import { withOneTimeKey } from './sessions/one-time-key.ts'
import { sealFirstMessage } from './sessions/seal.ts'
import type { SealOptions } from './sessions/seal.ts'
import type { FundingContext, PaymentProgress, PaymentResult } from './types.ts'

export const OFFLINE_MESSAGE_VERSION = 2
/** The app's priority for offline payments (offline_payment_service.dart). */
export const OFFLINE_PAYMENT_PRIORITY = 2

/** lib/models/offline_payment_message.dart. */
export interface OfflinePaymentMessage {
  paymentId: string
  senderPeerId: string
  beefHex: string
  txid: string
  type42Derivations: Type42Derivation[]
  amountSats: number
  description?: string
  timestamp: number
  version: number
}

/** The message's JSON as the Dart writer orders it (the reader does not care). */
export function offlineMessageJson (m: OfflinePaymentMessage): string {
  return JSON.stringify({
    paymentId: m.paymentId,
    senderPeerId: m.senderPeerId,
    beefHex: m.beefHex,
    txid: m.txid,
    type42Derivations: m.type42Derivations.map(d => ({
      anchorPublicKey: d.anchorPublicKey, anchorContext: d.anchorContext, senderPublicKey: d.senderPublicKey, invoiceNumber: d.invoiceNumber
    })),
    amountSats: m.amountSats,
    ...(m.description !== undefined ? { description: m.description } : {}),
    timestamp: m.timestamp,
    version: m.version
  })
}

/** Parses a message as OfflinePaymentMessage.fromJson does (version 2 only). */
export function parseOfflineMessage (json: unknown): OfflinePaymentMessage {
  const o = json as Record<string, unknown>
  const version = typeof o.version === 'number' ? o.version : 1
  if (version !== OFFLINE_MESSAGE_VERSION) throw new TypeError(`unsupported offline payment version ${version}`)
  const s = (k: string): string => { if (typeof o[k] !== 'string') throw new TypeError(`${k} is not a string`); return o[k] }
  const n = (k: string): number => { if (typeof o[k] !== 'number' || !Number.isSafeInteger(o[k])) throw new TypeError(`${k} is not an integer`); return o[k] }
  if (!Array.isArray(o.type42Derivations)) throw new TypeError('type42Derivations is not a list')
  const derivations = o.type42Derivations.map((d: unknown) => {
    const r = d as Record<string, unknown>
    for (const v of Object.values(r)) if (typeof v !== 'string') throw new TypeError('a derivation value is not a string')
    return r as unknown as Type42Derivation
  })
  if (o.description !== undefined && o.description !== null && typeof o.description !== 'string') throw new TypeError('description is not a string')
  return {
    paymentId: s('paymentId'),
    senderPeerId: s('senderPeerId'),
    beefHex: s('beefHex'),
    txid: s('txid'),
    type42Derivations: derivations,
    amountSats: n('amountSats'),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    timestamp: n('timestamp'),
    version
  }
}

export interface OfflinePayParams {
  payeePeerId: string
  amountSats: number
  /** The note to send (already with `ref <r>` for a request link). */
  note?: string
  /** The payee's wallet the link names (`w`), for its own anchor. */
  walletId?: string
  /** The payer's network; the anchor must be for it. */
  network: Network
}

export interface OfflinePayContext extends FundingContext {
  /** A RicochetClient connected to the payee's server (SpiffyVault's by default). Its peer ID is the payer. */
  ricochet: RicochetLike
  /**
   * The Ed25519 private key of `ricochet`'s libp2p node (createPaymentNode
   * returns it as `privateKey`): the payment is sealed from this identity,
   * and the payee opens it only when it is the key of the sending peer ID.
   */
  identityKey: Ed25519PrivateKeyLike
  /** Sealing options (fixed keys for tests). */
  seal?: SealOptions
}

/** The 32-byte seed of `key`, checked to be the key of `peerId`. */
export function payerSeed (key: Ed25519PrivateKeyLike, peerId: string): Uint8Array {
  const raw = key instanceof Uint8Array ? key : key.raw
  if (!(key instanceof Uint8Array) && key.type !== 'Ed25519') throw new PaymentError('no-route', `The payer's identity key is ${key.type}, not Ed25519`, { path: 'offline', stage: 'prepare', canPayAnotherWay: true })
  if (raw.length !== 32 && raw.length !== 64) throw new PaymentError('no-route', 'The payer\'s identity key is not an Ed25519 private key', { path: 'offline', stage: 'prepare', canPayAnotherWay: true })
  const seed = raw.slice(0, 32)
  const peerKey = ed25519KeyOfPeerId(peerId)
  if (peerKey === null || !equalBytes(peerKey, identityOfSeed(seed).ed25519)) {
    throw new PaymentError('no-route', 'The identity key is not the key of the Ricochet client\'s peer ID: pass the private key of the same libp2p node', { path: 'offline', stage: 'prepare', canPayAnotherWay: true })
  }
  return seed
}

function invalid (message: string): PaymentError {
  return new PaymentError('amount-invalid', message, { path: 'offline', stage: 'prepare', canPayAnotherWay: true })
}

/** Pays `amountSats` into the payee's Ricochet mailbox. */
export async function payOffline (params: OfflinePayParams, ctx: OfflinePayContext): Promise<PaymentResult> {
  const progress = (step: PaymentProgress['step'], detail?: string): void => ctx.onProgress?.({ path: 'offline', step, ...(detail !== undefined ? { detail } : {}) })
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) throw invalid('The amount must be a whole number of satoshis, at least 1')
  if (ctx.wallet === undefined && ctx.funder === undefined) throw new PaymentError('no-route', 'Offline payments need a wallet or a funder', { path: 'offline', stage: 'prepare', canPayAnotherWay: true })
  const { ricochet } = ctx
  const senderPeerId = ricochet.peerId
  const seed = payerSeed(ctx.identityKey, senderPeerId)
  const note = params.note?.trim() === '' ? undefined : params.note

  progress('anchor')
  const { record } = await fetchAnchor(ricochet, params.payeePeerId, params.network, {
    ...(params.walletId !== undefined ? { walletId: params.walletId } : {}),
    ...(note !== undefined ? { note } : {})
  })
  progress('prekeys')
  const claimed = await withOneTimeKey(ricochet, params.payeePeerId, params.network, await fetchBundle(ricochet, params.payeePeerId, params.network))
  const bundle = claimed.bundle
  if (claimed.missing !== undefined) progress('prekeys', `no one-time pre-key (${claimed.missing}); sealing without one`)

  progress('derive')
  let destination
  try {
    destination = deriveOfflineDestination(record.anchorPublicKey.toLowerCase(), record.anchorContextHex.toLowerCase(), params.network)
  } catch (e) {
    throw new PaymentError('anchor-invalid', `Could not derive a payment address: ${errorText(e)}`, { path: 'offline', stage: 'request', canPayAnotherWay: true, cause: e })
  }
  const outputs: PaymentOutput[] = [{ lockingScript: destination.lockingScript, satoshis: params.amountSats, address: destination.address }]

  progress('fund', destination.address)
  const info = { path: 'offline' as const, broadcast: false, ...(note !== undefined ? { note } : {}), counterparty: params.payeePeerId }
  const funded: FundedPayment = ctx.wallet !== undefined
    ? await fundWithWallet(ctx.wallet, outputs, info, ctx.originator !== undefined ? { originator: ctx.originator } : {})
    : await fundWithFunder(ctx.funder!, outputs, info)

  const giveUp = async (code: 'mailbox-refused' | 'server-unreachable' | 'prekeys-invalid', message: string, cause?: unknown): Promise<never> => {
    progress('abort', funded.txid)
    const aborted = await funded.abort()
    throw new PaymentError(code, message, { path: 'offline', stage: code === 'server-unreachable' ? 'connect' : 'deliver', canPayAnotherWay: true, txid: funded.txid, aborted, cause })
  }

  progress('seal')
  const paymentId = uuidV4()
  const message: OfflinePaymentMessage = {
    paymentId,
    senderPeerId,
    beefHex: toHex(funded.beefV1),
    txid: funded.txid,
    type42Derivations: [destination.derivation],
    amountSats: params.amountSats,
    ...(note !== undefined ? { description: note } : {}),
    timestamp: Date.now(),
    version: OFFLINE_MESSAGE_VERSION
  }
  let sealed
  try {
    sealed = sealFirstMessage(bundle, seed, utf8(offlineMessageJson(message)), ctx.seal)
  } catch (e) {
    return await giveUp('prekeys-invalid', `Could not seal the payment for the payee: ${errorText(e)}`, e)
  }

  progress('submit')
  const folderPath = forNetwork(OFFLINE_PAYMENTS_FOLDER, params.network)
  let sent
  try {
    sent = await ricochet.sendMessage(params.payeePeerId, sealed.bytes, { folderPath, priority: OFFLINE_PAYMENT_PRIORITY, persistent: true })
  } catch (e) {
    // Not dialled at all: nothing reached the server.
    if (e instanceof NoServerError) return await giveUp('server-unreachable', `Could not reach the Ricochet server: ${errorText(e)}`, e)
    // Sent, but the answer was lost: the payee may get it. Keep the inputs reserved.
    throw new PaymentError('delivery-unknown', `The payment may or may not be in the payee's mailbox: ${errorText(e)}. Keep its inputs reserved and watch ${funded.txid}.`,
      { path: 'offline', stage: 'deliver', canPayAnotherWay: false, txid: funded.txid, cause: e })
  }
  if (!sent.success) {
    return await giveUp('mailbox-refused', `The payee's mailbox refused the payment (${sent.status}): ${sent.errorMessage}`, sent.error)
  }
  return {
    path: 'offline',
    txid: funded.txid,
    status: 'handed-off',
    amountSats: params.amountSats,
    ...(note !== undefined ? { note } : {}),
    paymentId,
    messageId: sent.messageId,
    attempts: []
  }
}
