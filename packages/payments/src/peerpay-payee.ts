/**
 * Being paid by PeerPay: the payee's side of BRC-29 over MessageBox, as
 * the SpiffyVault app reads its inbox (lib/services/brc100/peerpay_service.dart).
 *
 * The payer's wallet has broadcast the payment and left a token in the
 * payee's `payment_inbox`. For each token the payee checks the output it
 * names (P2PKH to the BRC-29 key under the wallet's identity key, exactly
 * the amount), checks the transaction by SPV, makes sure the network has
 * it, and hands it to onPayment. Only then is the message acknowledged,
 * which deletes it from the server.
 *
 * The wallet needs no internalizeAction here: a ProtoWallet made from the
 * identity key signs in to the server (BRC-103) and opens the messages.
 */

import { MessageBoxClient } from '@bsv/message-box-client'
import { Transaction, WhatsOnChain } from '@bsv/sdk'
import type { ChainTracker, WalletInterface } from '@bsv/sdk'

import { BRC29_PROTOCOL_ID, p2pkhScriptForKey } from './destination.ts'
import { errorText } from './errors.ts'
import { checkAtomicBeefForPeerPay } from './funding.ts'
import { arcBroadcaster, unprovenChain, waitForNetwork } from './live/payee.ts'
import type { Broadcaster } from './live/payee.ts'
import { DEFAULT_MESSAGE_BOX_HOST, assertNetwork } from './networks.ts'
import type { Network } from './networks.ts'
import type { ReceivedOutput } from './offline-payee.ts'
import { PEERPAY_MESSAGE_BOX } from './peerpay.ts'

/** What the payee needs of the wallet: its keys, and what the server's sign-in and opening messages use. A ProtoWallet will do. */
export type PeerPayPayeeWallet = Pick<WalletInterface, 'getPublicKey' | 'encrypt' | 'decrypt' | 'createHmac' | 'verifyHmac' | 'createSignature' | 'verifySignature'>

/** A message as `listMessagesLite` gives it: the body opened, and parsed when it is JSON. */
export interface PeerPayInboxMessage { messageId: string, sender: string, body: unknown }

/** The calls the payee makes on a MessageBoxClient. */
export interface PeerPayInbox {
  listMessagesLite: (args: { messageBox: string, host: string }) => Promise<PeerPayInboxMessage[]>
  acknowledgeMessage: (args: { messageIds: string[], host: string }) => Promise<unknown>
}

/** A payment checked by SPV and seen on the network: keep it in onPayment. */
export interface ReceivedPeerPayment {
  /** The message it came in. */
  messageId: string
  /** The payer's identity key: the counterparty of the output's key. */
  senderIdentityKey: string
  /** The payer's description (SpiffyVault's addition), with "ref <r>" for a payment-request link. */
  note?: string
  txid: string
  /** The payment as Atomic BEEF (BRC-95), as the token carried it: internalizeAction's `tx`. */
  atomicBeef: Uint8Array
  transaction: Transaction
  /** The output the token names, as a BRC-29 payment remittance. */
  outputs: ReceivedOutput[]
  paidSats: number
  /** What the token says it pays (the same as paidSats: a token whose output pays another amount is refused). */
  amountSats: number
  networkStatus?: string
}

export type PeerPayPayeeEvent =
  /** Checked, and taken by the broadcaster, not yet seen on the network. */
  | { kind: 'on-the-way', payment: ReceivedPeerPayment }
  /** On the network, and onPayment has run. */
  | { kind: 'paid', payment: ReceivedPeerPayment }
  /** onPayment threw. Tried again on the next pass. */
  | { kind: 'keep-failed', payment: ReceivedPeerPayment, error: string }
  /** Taken by the broadcaster, not seen on the network yet. Tried again on the next pass. */
  | { kind: 'unsettled', payment: ReceivedPeerPayment }
  /** The network refused it, or would not take it within giveUpMs: nothing was received. Deleted. */
  | { kind: 'not-broadcast', messageId: string, senderIdentityKey: string, txid: string, error: string }
  /** Not a payment token, not for this wallet, or does not check out: deleted. */
  | { kind: 'refused', messageId: string, senderIdentityKey: string, reason: string }
  /** A pass, or one message, failed for a reason that may pass (the server or the chain could not be reached, say). Tried again. */
  | { kind: 'error', error: string, messageId?: string }

export interface PeerPayPayeeOptions {
  network: Network
  /** The BRC-100 wallet the payments go to. Its identity key is the PeerPay payment key payers pay. */
  wallet: PeerPayPayeeWallet
  /** The message box host. Default https://messagebox.bsvblockchain.tech, the one the app sends to. */
  host?: string
  /** A client to read the inbox with (default: a MessageBoxClient on `wallet` and `host`). */
  client?: PeerPayInbox
  /** Called once a payment is checked and seen on the network, before its message is acknowledged. Throw to have it offered again. */
  onPayment: (payment: ReceivedPeerPayment) => void | Promise<void>
  onEvent?: (event: PeerPayPayeeEvent) => void
  /** Default: WhatsOnChain for the network. */
  chainTracker?: ChainTracker
  /** Default: Arcade for the network. */
  broadcaster?: Broadcaster
  /** Milliseconds between inbox checks. Default 10 000. */
  checkEveryMs?: number
  /** How long to wait for the network to show a payment. Default 60 000. */
  networkWaitMs?: number
  /** A message that cannot be checked or broadcast for this long is given up and deleted. Default one hour. */
  giveUpMs?: number
  now?: () => number
}

export interface PeerPayPayee {
  /** Unix ms of the last inbox check that reached the server; undefined before the first. */
  readonly checkedAt: number | undefined
  /** Checks the inbox now. */
  collectNow: () => Promise<void>
  stop: () => void
}

const DONE_KEPT = 1000
/** BRC-29 prefix and suffix as the app reads them. */
const DERIVATION = /^\S{1,399}$/

class Refusal extends Error {}
/** A reason that a later pass may not have. */
class NotYet extends Error {}

interface Token { derivationPrefix: string, derivationSuffix: string, transaction: number[], amount: number, outputIndex: number, description?: string }

function readToken (body: unknown): Token {
  let t = body
  if (typeof body === 'string') {
    try { t = JSON.parse(body) } catch {
      // listMessagesLite puts this in place of a message the wallet could not open; the wallet may be back later.
      if (body.startsWith('[Error:')) throw new NotYet('the message could not be opened')
      throw new Refusal('it is not a payment token')
    }
  }
  if (t === null || typeof t !== 'object' || Array.isArray(t)) throw new Refusal('it is not a payment token')
  const o = t as Record<string, unknown>
  const ci = o.customInstructions as Record<string, unknown> | undefined
  const derivationPrefix = ci?.derivationPrefix
  const derivationSuffix = ci?.derivationSuffix
  if (typeof derivationPrefix !== 'string' || typeof derivationSuffix !== 'string' || !DERIVATION.test(derivationPrefix) || !DERIVATION.test(derivationSuffix)) {
    throw new Refusal('it is not a payment token: no usable derivation prefix and suffix')
  }
  if (!Array.isArray(o.transaction) || !o.transaction.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Refusal('it is not a payment token: no transaction')
  if (!Number.isSafeInteger(o.amount) || (o.amount as number) <= 0) throw new Refusal('it is not a payment token: no amount')
  const outputIndex = o.outputIndex ?? 0
  if (!Number.isSafeInteger(outputIndex) || (outputIndex as number) < 0) throw new Refusal('it is not a payment token: bad output index')
  return {
    derivationPrefix,
    derivationSuffix,
    transaction: o.transaction as number[],
    amount: o.amount as number,
    outputIndex: outputIndex as number,
    ...(typeof o.description === 'string' ? { description: o.description } : {})
  }
}

/** Starts being paid by PeerPay: an inbox check now, then on its timer. */
export async function acceptPeerPayPayments (opts: PeerPayPayeeOptions): Promise<PeerPayPayee> {
  const network = assertNetwork(opts.network)
  const now = opts.now ?? Date.now
  const host = opts.host ?? DEFAULT_MESSAGE_BOX_HOST
  const chainTracker = opts.chainTracker ?? new WhatsOnChain(network === 'mainnet' ? 'main' : 'test')
  const broadcaster = opts.broadcaster ?? arcBroadcaster(network)
  const networkWaitMs = opts.networkWaitMs ?? 60_000
  const giveUpMs = opts.giveUpMs ?? 3600_000
  const client: PeerPayInbox = opts.client ??
    new MessageBoxClient({ walletClient: opts.wallet as WalletInterface, host, enableLogging: false }) as unknown as PeerPayInbox
  const event = (e: PeerPayPayeeEvent): void => { try { opts.onEvent?.(e) } catch { /* the caller's own handler */ } }

  /** Message ids and txids finished lately, newest last: a second copy is acknowledged without being offered again. */
  let done: string[] = []
  /** When each message first failed for a passing reason. */
  const failingSince = new Map<string, number>()

  const acknowledge = async (messageId: string): Promise<void> => {
    failingSince.delete(messageId)
    try { await client.acknowledgeMessage({ messageIds: [messageId], host }) } catch { /* the next pass finds it done, and acknowledges it then */ }
  }
  const markDone = (...ids: string[]): void => { done = [...done.filter(d => !ids.includes(d)), ...ids].slice(-DONE_KEPT) }

  /** Checks one token and hands it over. Throws Refusal or NotYet. */
  const take = async (m: PeerPayInboxMessage): Promise<void> => {
    const t = readToken(m.body)
    let tx: Transaction
    try { tx = Transaction.fromAtomicBEEF(t.transaction) } catch (e) { throw new Refusal(`its transaction cannot be read: ${errorText(e)}`) }
    const txid = tx.id('hex')
    if (done.includes(txid)) { markDone(m.messageId); await acknowledge(m.messageId); return }
    try { checkAtomicBeefForPeerPay(t.transaction, txid) } catch (e) { throw new Refusal(`its transaction cannot be checked: ${errorText(e)}`) }
    const output = tx.outputs[t.outputIndex]
    if (output === undefined) throw new Refusal(`the transaction has no output ${t.outputIndex}`)
    const { publicKey } = await opts.wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL_ID, keyID: `${t.derivationPrefix} ${t.derivationSuffix}`, counterparty: m.sender, forSelf: true
    })
    if (output.lockingScript.toHex() !== p2pkhScriptForKey(publicKey)) throw new Refusal('the payment pays nothing to this wallet')
    if (output.satoshis !== t.amount) throw new Refusal(`output ${t.outputIndex} pays ${String(output.satoshis)} satoshis, not the ${t.amount} the token says`)
    let valid: boolean
    try { valid = await tx.verify(chainTracker) } catch (e) { throw new NotYet(`the payment could not be checked: ${errorText(e)}`) }
    if (!valid) throw new Refusal('the payment does not check out')

    let payment: ReceivedPeerPayment = {
      messageId: m.messageId,
      senderIdentityKey: m.sender,
      ...(t.description !== undefined ? { note: t.description } : {}),
      txid,
      atomicBeef: Uint8Array.from(t.transaction),
      transaction: tx,
      outputs: [{ outputIndex: t.outputIndex, derivationPrefix: t.derivationPrefix, derivationSuffix: t.derivationSuffix, senderIdentityKey: m.sender }],
      paidSats: output.satoshis,
      amountSats: t.amount
    }
    // The payer broadcast it; sending it again is how the payee learns the network has it.
    const sent = await broadcaster(unprovenChain(tx))
    if (!sent.accepted) throw new NotYet(`the network did not take it: ${sent.error}`, { cause: { txid } })
    if (sent.status !== undefined) payment = { ...payment, networkStatus: sent.status }
    if (sent.settled !== undefined) {
      event({ kind: 'on-the-way', payment })
      const outcome = await waitForNetwork(sent.settled, networkWaitMs)
      if (outcome.status !== undefined) payment = { ...payment, networkStatus: outcome.status }
      if (outcome.kind === 'unknown') { event({ kind: 'unsettled', payment }); return }
      if (outcome.kind === 'refused') {
        event({ kind: 'not-broadcast', messageId: m.messageId, senderIdentityKey: m.sender, txid, error: outcome.error })
        markDone(m.messageId)
        await acknowledge(m.messageId)
        return
      }
    }
    try {
      await opts.onPayment(payment)
    } catch (e) {
      // Kept on the server, and offered again, for as long as it takes.
      event({ kind: 'keep-failed', payment, error: errorText(e) })
      return
    }
    markDone(m.messageId, txid)
    await acknowledge(m.messageId)
    event({ kind: 'paid', payment })
  }

  let checkedAt: number | undefined
  const collectPass = async (): Promise<void> => {
    const messages = await client.listMessagesLite({ messageBox: PEERPAY_MESSAGE_BOX, host })
    checkedAt = now()
    for (const m of messages) {
      if (done.includes(m.messageId)) { await acknowledge(m.messageId); continue }
      try {
        await take(m)
      } catch (e) {
        if (e instanceof Refusal) {
          event({ kind: 'refused', messageId: m.messageId, senderIdentityKey: m.sender, reason: e.message })
          markDone(m.messageId)
          await acknowledge(m.messageId)
          continue
        }
        const since = failingSince.get(m.messageId) ?? now()
        failingSince.set(m.messageId, since)
        if (now() - since < giveUpMs) {
          event({ kind: 'error', messageId: m.messageId, error: errorText(e) })
          continue
        }
        // Never checked out or never reached the network: given up.
        const txid = ((e as { cause?: { txid?: unknown } }).cause?.txid)
        if (typeof txid === 'string') {
          event({ kind: 'not-broadcast', messageId: m.messageId, senderIdentityKey: m.sender, txid, error: errorText(e) })
        } else {
          event({ kind: 'refused', messageId: m.messageId, senderIdentityKey: m.sender, reason: errorText(e) })
        }
        markDone(m.messageId)
        await acknowledge(m.messageId)
      }
    }
  }

  let stopped = false
  let collecting: Promise<void> | undefined
  const collectNow = async (): Promise<void> => {
    collecting ??= collectPass()
      .catch(e => { event({ kind: 'error', error: errorText(e) }) })
      .finally(() => { collecting = undefined })
    await collecting
  }
  void collectNow()
  const timer = setInterval(() => { if (!stopped) void collectNow() }, opts.checkEveryMs ?? 10_000)
  return {
    get checkedAt () { return checkedAt },
    collectNow,
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
