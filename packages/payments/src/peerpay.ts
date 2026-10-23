/**
 * PeerPay (BRC-29 over MessageBox, BRC-103 auth): the payment token the
 * app reads (lib/services/brc100/peerpay_token.dart), sent through
 * @bsv/message-box-client's PeerPayClient to a host you choose, by default
 * BSVA's https://messagebox.bsvblockchain.tech (the one SpiffyVault reads).
 *
 * The payer broadcasts (unlike live and offline). The token names its
 * output index; SpiffyVault requires output `outputIndex` to pay exactly
 * `amount` to the BRC-29 key.
 */

import { PeerPayClient } from '@bsv/message-box-client'
import { PublicKey, Transaction } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { randomBytes, toBase64, takeRunes } from './bytes.ts'
import { BRC29_PROTOCOL_ID, p2pkhScriptForKey } from './destination.ts'
import { PaymentError, errorText } from './errors.ts'
import { checkAtomicBeefForPeerPay } from './funding.ts'
import { MAX_NOTE } from './link.ts'
import { DEFAULT_MESSAGE_BOX_HOST } from './networks.ts'
import type { PaymentProgress, PaymentResult } from './types.ts'

export const PEERPAY_MESSAGE_BOX = 'payment_inbox'

export interface PeerPayToken {
  customInstructions: { derivationPrefix: string, derivationSuffix: string }
  /** Atomic BEEF (BRC-95) as byte values. */
  transaction: number[]
  amount: number
  outputIndex: number
  /** SpiffyVault's addition: the payer's note (other readers ignore it). */
  description?: string
}

/** The parts of a MessageBoxClient/PeerPayClient used to deliver a token. */
export interface MessageBoxSender {
  sendMessage: (message: { recipient: string, messageBox: string, body: string }, overrideHost?: string) => Promise<unknown>
}

export interface PeerPayParams {
  /** The payee's BRC-100 payment key: 66 hex characters, 02/03. */
  paymentKey: string
  amountSats: number
  note?: string
}

export interface PeerPayContext {
  wallet: WalletInterface
  /** The message box host. Default https://messagebox.bsvblockchain.tech. */
  host?: string
  /** A client to deliver with (default: a PeerPayClient on `wallet` and `host`). */
  client?: MessageBoxSender
  originator?: string
  onProgress?: (p: PaymentProgress) => void
}

/** The token was not delivered after the payment was broadcast: deliver it again with deliverPeerPayToken(). */
export class PeerPayUndeliveredError extends PaymentError {
  readonly token: PeerPayToken
  readonly recipient: string
  readonly host: string
  constructor (message: string, token: PeerPayToken, recipient: string, host: string, txid: string, cause?: unknown) {
    super('peerpay-undelivered', message, { path: 'peerpay', stage: 'deliver', canPayAnotherWay: false, txid, cause })
    this.name = 'PeerPayUndeliveredError'
    this.token = token
    this.recipient = recipient
    this.host = host
  }
}

const KEY = /^0[23][0-9a-f]{64}$/

function bad (code: 'bad-key' | 'own-key' | 'amount-invalid', message: string): PaymentError {
  return new PaymentError(code, message, { path: 'peerpay', stage: 'prepare', canPayAnotherWay: true })
}

/** A PeerPayClient on `wallet` that talks to `host` (default BSVA's server, not the client's old default). */
export function createPeerPayClient (wallet: WalletInterface, host: string = DEFAULT_MESSAGE_BOX_HOST, originator?: string): PeerPayClient {
  return new PeerPayClient({ walletClient: wallet, messageBoxHost: host, ...(originator !== undefined ? { originator } : {}) })
}

/** Sends a token to the payee's `payment_inbox` on `host` (no overlay lookup: the app sends to its own host). */
export async function deliverPeerPayToken (client: MessageBoxSender, recipient: string, token: PeerPayToken,
  host: string = DEFAULT_MESSAGE_BOX_HOST): Promise<string | undefined> {
  const r = await client.sendMessage({ recipient, messageBox: PEERPAY_MESSAGE_BOX, body: JSON.stringify(token) }, host)
  const id = (r as { messageId?: unknown } | undefined)?.messageId
  return typeof id === 'string' ? id : undefined
}

/**
 * Pays `amountSats` to the BRC-100 key `paymentKey` over PeerPay: derive
 * the BRC-29 key, build and broadcast with createAction (outputs kept in
 * order), check the Atomic BEEF, deliver the token.
 */
export async function payViaPeerPay (params: PeerPayParams, ctx: PeerPayContext): Promise<PaymentResult> {
  const progress = (step: PaymentProgress['step'], detail?: string): void => ctx.onProgress?.({ path: 'peerpay', step, ...(detail !== undefined ? { detail } : {}) })
  const recipient = params.paymentKey.trim().toLowerCase()
  if (!KEY.test(recipient)) throw bad('bad-key', 'That is not a BRC-100 payment key (66 hex characters starting 02 or 03)')
  try { PublicKey.fromString(recipient) } catch { throw bad('bad-key', 'That payment key is not a point on secp256k1') }
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) throw bad('amount-invalid', 'The amount must be a whole number of satoshis, at least 1')
  const host = ctx.host ?? DEFAULT_MESSAGE_BOX_HOST
  const { wallet, originator } = ctx

  const own = await wallet.getPublicKey({ identityKey: true }, originator)
  if (own.publicKey === recipient) throw bad('own-key', 'That is this wallet\'s own identity key')

  progress('key')
  const derivationPrefix = toBase64(randomBytes(32))
  const derivationSuffix = toBase64(randomBytes(32))
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL_ID, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: recipient
  }, originator)
  const lockingScript = p2pkhScriptForKey(publicKey)

  progress('fund')
  let result
  try {
    result = await wallet.createAction({
      description: 'PeerPay payment',
      labels: ['peerpay'],
      outputs: [{
        satoshis: params.amountSats,
        lockingScript,
        outputDescription: 'Payment for PeerPay transaction',
        customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix, payee: recipient })
      }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    }, originator)
  } catch (e) {
    throw new PaymentError('funding-failed', `The wallet could not build the payment: ${errorText(e)}`,
      { path: 'peerpay', stage: 'pay', canPayAnotherWay: false, cause: e })
  }
  const txid = result.txid
  const tx = result.tx
  if (txid === undefined || tx === undefined) {
    throw new PaymentError('funding-failed', 'The wallet returned no transaction', { path: 'peerpay', stage: 'pay', canPayAnotherWay: false })
  }
  const failed = result.sendWithResults?.find(r => r.status === 'failed')
  if (failed !== undefined) {
    throw new PaymentError('broadcast-failed', `The wallet could not broadcast ${txid}; nothing was delivered. Check the transaction before paying again.`,
      { path: 'peerpay', stage: 'pay', canPayAnotherWay: false, txid })
  }

  let atomic = Array.from(tx)
  let outputIndex: number
  try {
    try {
      checkAtomicBeefForPeerPay(atomic, txid)
    } catch {
      // A wallet may give txid-only ("known") entries; rebuild from the linked sources if it can.
      atomic = Array.from(Transaction.fromAtomicBEEF(atomic).toAtomicBEEF(false))
      checkAtomicBeefForPeerPay(atomic, txid)
    }
    const parsed = Transaction.fromAtomicBEEF(atomic)
    const hits = parsed.outputs.flatMap((o, i) => o.satoshis === params.amountSats && o.lockingScript.toHex() === lockingScript ? [i] : [])
    if (hits.length !== 1) throw new Error(`the transaction has ${hits.length} outputs paying the payee, not one`)
    outputIndex = hits[0]!
  } catch (e) {
    throw new PaymentError('beef-unusable', `Payment ${txid} was broadcast but cannot be proven to the payee: ${errorText(e)}`,
      { path: 'peerpay', stage: 'deliver', canPayAnotherWay: false, txid, cause: e })
  }

  const note = params.note?.trim()
  const token: PeerPayToken = {
    customInstructions: { derivationPrefix, derivationSuffix },
    transaction: atomic,
    amount: params.amountSats,
    outputIndex,
    ...(note !== undefined && note !== '' ? { description: takeRunes(note, MAX_NOTE) } : {})
  }
  progress('deliver', host)
  const client = ctx.client ?? createPeerPayClient(wallet, host, originator)
  let messageId: string | undefined
  try {
    messageId = await deliverPeerPayToken(client, recipient, token, host)
  } catch (e) {
    throw new PeerPayUndeliveredError(`Payment ${txid} was broadcast but its token could not be delivered to ${host}: ${errorText(e)}`,
      token, recipient, host, txid, e)
  }
  return {
    path: 'peerpay',
    txid,
    status: 'delivered',
    amountSats: params.amountSats,
    ...(token.description !== undefined ? { note: token.description } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    outputIndex,
    attempts: []
  }
}
