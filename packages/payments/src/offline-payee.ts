/**
 * Being paid offline: the payee's side of the offline path, as the
 * SpiffyVault app does it (lib/peer_sessions/owner_keys.dart,
 * lib/services/offline_payment_service.dart).
 *
 * Keys. The payee publishes what a payer needs to pay it while it is away:
 * its pre-key bundle (a signed pre-key, rotated weekly), a claim mailbox of
 * signed one-time pre-keys (kept between 25 and 50), and its anchor record,
 * signed with its peer key and naming the wallet's identity key as the
 * anchor. A payer pays BRC-29 keys under that anchor, so the wallet takes
 * the coins in as it takes a PeerPay payment.
 *
 * Collecting. Each sealed payment in `wallet/offline-payments` is opened
 * once (opening uses up its one-time pre-key), and what it says is saved in
 * the store at once. Then it is checked (the sender, the outputs that pay
 * this wallet, SPV), broadcast (the payee broadcasts on this path), and
 * handed to onPayment once the network has it. Only then is the message
 * deleted. A step that failed for a passing reason is tried again on the
 * next pass, from what was saved.
 */

import { Transaction, WhatsOnChain } from '@bsv/sdk'
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { cbc } from '@noble/ciphers/aes.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Ed25519PrivateKeyLike, RicochetClient } from '@go-ricochet/ricochet/core'
import { ANCHOR_RECORD_LIFETIME_MS, ANCHOR_RECORD_VERSION, anchorContextHex, anchorRecordJson, anchorSignaturePayload, parseAnchorRecord, verifyAnchorRecord } from './anchor.ts'
import type { AnchorRecord } from './anchor.ts'
import { concat, equalBytes, fromHex, fromUtf8, randomBytes, readU32be, toHex } from './bytes.ts'
import { BRC29_PROTOCOL_ID, p2pkhScriptForKey } from './destination.ts'
import { errorText } from './errors.ts'
import { beefKind } from './funding.ts'
import { arcBroadcaster, unprovenChain, waitForNetwork } from './live/payee.ts'
import type { Broadcaster } from './live/payee.ts'
import { OFFLINE_PAYMENTS_FOLDER, PAYMENT_ANCHOR_DOCUMENT, PEER_BUNDLE_FOLDER, PEER_ONE_TIME_KEYS_FOLDER, assertNetwork, forNetwork, walletNetworkType } from './networks.ts'
import type { Network } from './networks.ts'
import { parseOfflineMessage } from './offline.ts'
import type { OfflinePaymentMessage } from './offline.ts'
import { ed25519KeyOfPeerId } from './peer.ts'
import { encodeBundle, signedPreKeySignedBytes } from './sessions/bundle.ts'
import { decodeKey, dh, edPublicToX25519, identityOfSeed, kdfCk, kdfRk, kdfX3dh, messageKeys, x25519Public } from './sessions/keys.ts'
import { encodeOneTimeKeyItem, oneTimeKeySignedBytes } from './sessions/one-time-key.ts'

/** The app's numbers (OwnerKeys). */
export const OFFLINE_PAYEE_KEYS = {
  /** A new signed pre-key this often. */
  rotateSignedMs: 7 * 86400_000,
  /** Older signed pre-keys and unused one-time pre-keys are kept this long: a payer may still use them. */
  keepMs: 30 * 86400_000,
  /** The claim mailbox is filled to stockTo once it holds fewer than stockBelow. */
  stockTo: 50,
  stockBelow: 25,
  /** No more one-time pre-keys are made while this many are held. */
  heldAtMost: 400,
  /** The anchor record is published again once it has less than this left. */
  renewAnchorMs: 30 * 86400_000
} as const

/** What the payee keeps between runs. Secret: it holds private keys. Plain JSON. */
export interface OfflinePayeeState {
  version: 1
  /** Hex X25519 private keys; the last is the one in the published bundle. */
  signedPreKeys: Array<{ id: number, privateKey: string, createdAt: number }>
  oneTimePreKeys: Array<{ id: number, privateKey: string, createdAt: number }>
  nextKeyId: number
  /** Opened and saved, not finished yet, by Ricochet message id. */
  opened: Record<string, { message: OfflinePaymentMessage, openedAt: number, attempts: number }>
  /** Message ids, payment ids and txids finished lately, newest last: a second copy is dropped. */
  done: string[]
}

export interface OfflinePayeeStore {
  load: () => Promise<OfflinePayeeState | null>
  save: (state: OfflinePayeeState) => Promise<void>
}

/** The calls the payee makes on its own Ricochet client. */
export type PayeeRicochet = Pick<RicochetClient, 'peerId' | 'retrievePage' | 'deleteMessages' | 'sendMessage' | 'createMailbox' | 'getMailboxInfo' | 'getDocument' | 'putDocument'>

/** One output paying this wallet, as a BRC-29 payment remittance (internalizeAction's paymentRemittance). */
export interface OfflineOutput {
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /** The payer's single-use key for this output: the counterparty. */
  senderIdentityKey: string
}

/** A payment checked by SPV and seen on the network: keep it in onPayment. */
export interface ReceivedOfflinePayment {
  /** The Ricochet message it came in. */
  messageId: string
  paymentId: string
  payerPeerId: string
  /** The payer's description, with "ref <r>" for a payment-request link. */
  note?: string
  txid: string
  /** The payment as BEEF V1, ancestors included. */
  beefV1: Uint8Array
  transaction: Transaction
  outputs: OfflineOutput[]
  paidSats: number
  /** What the payer said it pays. */
  amountSats: number
  networkStatus?: string
}

export type OfflinePayeeEvent =
  /** The keys pass published something. */
  | { kind: 'keys', bundle: boolean, oneTimeKeys: number, anchor: boolean }
  /** Opened and saved: from here it is not lost if the payee stops. */
  | { kind: 'opened', messageId: string, payerPeerId: string, paymentId: string, txid: string, amountSats: number, note?: string }
  /** Checked, and taken by the broadcaster, not yet seen on the network. */
  | { kind: 'on-the-way', payment: ReceivedOfflinePayment }
  /** On the network, and onPayment has run. */
  | { kind: 'paid', payment: ReceivedOfflinePayment }
  /** onPayment threw. Tried again on the next pass. */
  | { kind: 'keep-failed', payment: ReceivedOfflinePayment, error: string }
  /** Taken by the broadcaster, not seen on the network yet. Tried again on the next pass. */
  | { kind: 'unsettled', payment: ReceivedOfflinePayment }
  /** The network did not take it after several passes, or refused it: nothing was received. The payer reclaims it. */
  | { kind: 'not-broadcast', messageId: string, payerPeerId: string, txid: string, error: string }
  /** Unreadable, not for this wallet, or does not check out: deleted. The payer reclaims it. */
  | { kind: 'refused', messageId: string, payerPeerId: string, reason: string }
  /** A pass failed (the server could not be reached, say). The next one tries again. */
  | { kind: 'error', during: 'keys' | 'collect', error: string }

export interface OfflinePayeeOptions {
  network: Network
  /** A RicochetClient of this payee's own libp2p node, connected to its server (SpiffyVault's by default). */
  ricochet: PayeeRicochet
  /** The node's Ed25519 private key (createPaymentNode returns it): the payee's identity, which signs its keys. */
  identityKey: Ed25519PrivateKeyLike
  /** The BRC-100 wallet the payments go to. Its identity key is the anchor; it derives each output's key. */
  wallet: Pick<WalletInterface, 'getPublicKey'>
  store: OfflinePayeeStore
  /** Called once a payment is checked and seen on the network, before its message is deleted. Throw to have it offered again. */
  onPayment: (payment: ReceivedOfflinePayment) => void | Promise<void>
  onEvent?: (event: OfflinePayeeEvent) => void
  /** Default: WhatsOnChain for the network. */
  chainTracker?: ChainTracker
  /** Default: Arcade for the network. */
  broadcaster?: Broadcaster
  /** Milliseconds between mailbox checks. Default 30 000. */
  collectEveryMs?: number
  /** Milliseconds between keys passes. Default one hour. */
  keysEveryMs?: number
  /** How long to wait for the network to show a broadcast payment. Default 60 000. */
  networkWaitMs?: number
  /** Passes a payment that cannot be checked or broadcast is tried before it is given up. Default 5. */
  maxAttempts?: number
  now?: () => number
}

export interface OfflinePayee {
  /** Checks the mailbox now. */
  collectNow: () => Promise<void>
  /** Runs a keys pass now. */
  refreshKeys: () => Promise<void>
  stop: () => void
}

const DONE_KEPT = 1000

class Refusal extends Error {}
/** A reason that a later pass may not have. */
class NotYet extends Error {}

/** Starts being paid offline: a keys pass and a mailbox check now, then on their timers. */
export async function acceptOfflinePayments (opts: OfflinePayeeOptions): Promise<OfflinePayee> {
  const network = assertNetwork(opts.network)
  const now = opts.now ?? Date.now
  const chainTracker = opts.chainTracker ?? new WhatsOnChain(network === 'mainnet' ? 'main' : 'test')
  const broadcaster = opts.broadcaster ?? arcBroadcaster(network)
  const networkWaitMs = opts.networkWaitMs ?? 60_000
  const maxAttempts = opts.maxAttempts ?? 5
  const peerId = opts.ricochet.peerId.toString()
  const seed = identitySeed(opts.identityKey, peerId)
  const edPublic = ed25519.getPublicKey(seed)
  const event = (e: OfflinePayeeEvent): void => { try { opts.onEvent?.(e) } catch { /* the caller's own handler */ } }
  const anchorKey = (await opts.wallet.getPublicKey({ identityKey: true })).publicKey

  let state: OfflinePayeeState = await opts.store.load() ?? { version: 1, signedPreKeys: [], oneTimePreKeys: [], nextKeyId: 1 + Math.floor(Math.random() * 1_000_000), opened: {}, done: [] }
  const save = async (): Promise<void> => { await opts.store.save(state) }
  const newKeyId = (): number => { const id = state.nextKeyId; state.nextKeyId = (id % 0x7fffffff) + 1; return id }

  const folders = {
    bundle: forNetwork(PEER_BUNDLE_FOLDER, network),
    oneTime: forNetwork(PEER_ONE_TIME_KEYS_FOLDER, network),
    offline: forNetwork(OFFLINE_PAYMENTS_FOLDER, network),
    anchor: forNetwork(PAYMENT_ANCHOR_DOCUMENT, network)
  }

  // Keys ---------------------------------------------------------------

  const publishBundle = async (): Promise<void> => {
    const spk = state.signedPreKeys[state.signedPreKeys.length - 1]!
    const signedPreKey = x25519Public(fromHex(spk.privateKey))
    const bundle = encodeBundle({
      identityKey: edPublic,
      signedPreKeyId: spk.id,
      signedPreKey,
      signedPreKeySignature: ed25519.sign(signedPreKeySignedBytes(spk.id, signedPreKey), seed)
    })
    await mailbox(folders.bundle, 'public', { retentionDays: 30, retentionCount: 5 })
    const sent = await opts.ricochet.sendMessage(peerId, bundle, { folderPath: folders.bundle, priority: 1, persistent: true })
    if (!sent.success) throw new Error(`the server refused the bundle: ${sent.errorMessage ?? 'no reason given'}`)
  }

  /** Makes a mailbox; one that exists already is fine (a later send says if it is not). */
  const mailbox = async (folder: string, type: 'public' | 'claim', options: { retentionDays: number, retentionCount?: number }): Promise<void> => {
    try { await opts.ricochet.createMailbox(folder, type, options) } catch { /* exists already */ }
  }

  const count = async (folder: string): Promise<number | null> => {
    try { return (await opts.ricochet.getMailboxInfo(folder)).messageCount } catch { return null }
  }

  const stockOneTimeKeys = async (): Promise<number> => {
    await mailbox(folders.oneTime, 'claim', { retentionDays: 30 })
    const held = (await count(folders.oneTime)) ?? 0
    if (held >= OFFLINE_PAYEE_KEYS.stockBelow) return 0
    const add = Math.min(OFFLINE_PAYEE_KEYS.stockTo - held, OFFLINE_PAYEE_KEYS.heldAtMost - state.oneTimePreKeys.length)
    let sent = 0
    for (let i = 0; i < add; i++) {
      const privateKey = randomBytes(32)
      const id = newKeyId()
      // Kept before it is offered: a key a payer may use is never lost.
      state.oneTimePreKeys.push({ id, privateKey: toHex(privateKey), createdAt: now() })
      await save()
      const key = x25519Public(privateKey)
      const item = encodeOneTimeKeyItem({ id, key, signature: ed25519.sign(oneTimeKeySignedBytes(id, key), seed) })
      const r = await opts.ricochet.sendMessage(peerId, item, { folderPath: folders.oneTime, persistent: true })
      if (!r.success) break
      sent++
    }
    return sent
  }

  const publishAnchor = async (): Promise<boolean> => {
    const networkType = walletNetworkType(network)
    let current: AnchorRecord | null = null
    try {
      const doc = await opts.ricochet.getDocument(peerId, folders.anchor)
      if (doc.content === undefined) throw new Error('no anchor record')
      const record = parseAnchorRecord(JSON.parse(fromUtf8(doc.content)))
      if (verifyAnchorRecord(record, peerId, networkType, folders.anchor, now()) === null) current = record
    } catch { /* none yet, or unreadable: publish one */ }
    if (current !== null && current.anchorPublicKey.toLowerCase() === anchorKey.toLowerCase() &&
      current.expiresAt - now() > OFFLINE_PAYEE_KEYS.renewAnchorMs) return false
    const unsigned = {
      peerId,
      identityPublicKey: toHex(edPublic),
      anchorPublicKey: anchorKey,
      anchorContextHex: anchorContextHex(toHex(edPublic), 0, networkType),
      epoch: 0,
      networkType,
      path: folders.anchor,
      timestamp: now(),
      expiresAt: now() + ANCHOR_RECORD_LIFETIME_MS,
      version: ANCHOR_RECORD_VERSION
    }
    const record: AnchorRecord = { ...unsigned, signature: toHex(ed25519.sign(anchorSignaturePayload(unsigned), seed)) }
    await opts.ricochet.putDocument(peerId, folders.anchor, anchorRecordJson(record), { contentType: 'application/json', visibility: 'public' })
    return true
  }

  const keysPass = async (): Promise<void> => {
    const t = now()
    const newest = state.signedPreKeys[state.signedPreKeys.length - 1]
    const rotate = newest === undefined || t - newest.createdAt >= OFFLINE_PAYEE_KEYS.rotateSignedMs
    if (rotate) {
      state.signedPreKeys.push({ id: newKeyId(), privateKey: toHex(randomBytes(32)), createdAt: t })
      await save()
    }
    // Old keys go once no payer can still be using them.
    const keepFrom = t - OFFLINE_PAYEE_KEYS.keepMs
    const latest = state.signedPreKeys[state.signedPreKeys.length - 1]!
    state.signedPreKeys = state.signedPreKeys.filter(k => k === latest || k.createdAt >= keepFrom)
    state.oneTimePreKeys = state.oneTimePreKeys.filter(k => k.createdAt >= keepFrom)
    await save()
    const bundle = rotate || ((await count(folders.bundle)) ?? 0) === 0
    if (bundle) await publishBundle()
    const oneTimeKeys = await stockOneTimeKeys()
    const anchor = await publishAnchor()
    if (bundle || oneTimeKeys > 0 || anchor) event({ kind: 'keys', bundle, oneTimeKeys, anchor })
  }

  // Collecting ---------------------------------------------------------

  /** Opens a first message (doc/peer-sessions.md section 6), using up its one-time pre-key. */
  const open = (bytes: Uint8Array, senderPeerId: string): Uint8Array => {
    if (bytes[0] !== 1 || bytes[1] !== 2) throw new Refusal('it is not a session\'s first message')
    let o = 2
    const theirEd = bytes.slice(o, o + 32); o += 32
    const baseKey = decodeKey(bytes.slice(o, o + 33)); o += 33
    const signedPreKeyId = readU32be(bytes, o); o += 4
    let oneTimePreKeyId: number | undefined
    if (bytes[o] === 1) { oneTimePreKeyId = readU32be(bytes, o + 1); o += 5 } else if (bytes[o] === 0) { o += 1 } else throw new Refusal('it is malformed')
    const message = bytes.slice(o)
    const senderKey = ed25519KeyOfPeerId(senderPeerId)
    if (senderKey === null || !equalBytes(senderKey, theirEd)) throw new Refusal('it is sealed by a key other than its sender\'s')
    const spk = state.signedPreKeys.find(k => k.id === signedPreKeyId)
    if (spk === undefined) throw new Refusal(`it names signed pre-key ${signedPreKeyId}, which this payee does not hold`)
    const opk = oneTimePreKeyId === undefined ? undefined : state.oneTimePreKeys.find(k => k.id === oneTimePreKeyId)
    if (oneTimePreKeyId !== undefined && opk === undefined) throw new Refusal(`it names one-time pre-key ${oneTimePreKeyId}, which this payee does not hold (used already?)`)
    const spkPrivate = fromHex(spk.privateKey)
    const sk = kdfX3dh([
      dh(spkPrivate, edPublicToX25519(theirEd)),
      dh(identityOfSeed(seed).x25519Private, baseKey),
      dh(spkPrivate, baseKey),
      ...(opk !== undefined ? [dh(fromHex(opk.privateKey), baseKey)] : [])
    ])
    if (message.length < 43 + 32 || message[0] !== 1 || message[1] !== 1) throw new Refusal('it is malformed')
    const header = message.slice(0, 43)
    if (readU32be(header, 39) !== 0) throw new Refusal('it is not the first message of its session')
    const { chainKey } = kdfRk(sk, dh(spkPrivate, decodeKey(header.slice(2, 35))))
    const { aesKey, hmacKey, iv } = messageKeys(kdfCk(chainKey).messageKey)
    const ciphertext = message.slice(43, message.length - 32)
    const mac = hmac(sha256, hmacKey, concat(theirEd, edPublic, header, ciphertext))
    if (!equalBytes(mac, message.slice(message.length - 32))) throw new Refusal('it does not open with this payee\'s keys')
    if (opk !== undefined) state.oneTimePreKeys = state.oneTimePreKeys.filter(k => k !== opk)
    try { return cbc(aesKey, iv).decrypt(ciphertext) } catch { throw new Refusal('it does not open with this payee\'s keys') }
  }

  /** The outputs of `tx` that pay this wallet, from the message's derivations. */
  const ourOutputs = async (tx: Transaction, m: OfflinePaymentMessage): Promise<OfflineOutput[]> => {
    const byScript = new Map<string, Omit<OfflineOutput, 'outputIndex'>>()
    for (const d of m.type42Derivations) {
      if (d.anchorPublicKey.toLowerCase() !== anchorKey.toLowerCase()) continue
      const match = /^2-3241645161d8-(\S+) (\S+)$/.exec(d.invoiceNumber)
      if (match === null) continue // not a BRC-29 key: this wallet could not spend it
      const [, derivationPrefix, derivationSuffix] = match as unknown as [string, string, string]
      const { publicKey } = await opts.wallet.getPublicKey({ protocolID: BRC29_PROTOCOL_ID, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: d.senderPublicKey, forSelf: true })
      byScript.set(p2pkhScriptForKey(publicKey), { derivationPrefix, derivationSuffix, senderIdentityKey: d.senderPublicKey })
    }
    const outputs: OfflineOutput[] = []
    tx.outputs.forEach((o, outputIndex) => {
      const r = byScript.get(o.lockingScript.toHex())
      if (r !== undefined) outputs.push({ outputIndex, ...r })
    })
    return outputs
  }

  const finish = async (messageId: string, ids: string[]): Promise<void> => {
    delete state.opened[messageId]
    state.done = [...state.done.filter(d => !ids.includes(d)), ...ids].slice(-DONE_KEPT)
    await save()
    try { await opts.ricochet.deleteMessages([messageId]) } catch { /* the next pass finds it done, and deletes it then */ }
  }

  const drop = async (messageId: string): Promise<void> => {
    delete state.opened[messageId]
    state.done = [...state.done, messageId].slice(-DONE_KEPT)
    await save()
    try { await opts.ricochet.deleteMessages([messageId]) } catch { /* tried again next pass */ }
  }

  /** Checks, broadcasts and hands over one saved payment. */
  const settle = async (messageId: string): Promise<void> => {
    const entry = state.opened[messageId]!
    const m = entry.message
    entry.attempts++
    await save()
    const beef = fromHex(m.beefHex)
    if (beefKind(beef) !== 'v1') throw new Refusal('the payment is not BEEF V1')
    let tx: Transaction
    try { tx = Transaction.fromBEEF(Array.from(beef)) } catch (e) { throw new Refusal(`the payment cannot be read: ${errorText(e)}`) }
    const txid = tx.id('hex')
    if (txid !== m.txid) throw new Refusal('the payment is not the transaction the message names')
    const outputs = await ourOutputs(tx, m)
    if (outputs.length === 0) throw new Refusal('the payment pays nothing to this wallet')
    let valid: boolean
    try { valid = await tx.verify(chainTracker) } catch (e) { throw new NotYet(`the payment could not be checked: ${errorText(e)}`) }
    if (!valid) throw new Refusal('the payment does not check out')
    const payment: ReceivedOfflinePayment = {
      messageId,
      paymentId: m.paymentId,
      payerPeerId: m.senderPeerId,
      ...(m.description !== undefined ? { note: m.description } : {}),
      txid,
      beefV1: beef,
      transaction: tx,
      outputs,
      paidSats: outputs.reduce((s, o) => s + (tx.outputs[o.outputIndex]!.satoshis ?? 0), 0),
      amountSats: m.amountSats
    }
    const sent = await broadcaster(unprovenChain(tx))
    if (!sent.accepted) {
      if (entry.attempts >= maxAttempts) {
        event({ kind: 'not-broadcast', messageId, payerPeerId: m.senderPeerId, txid, error: sent.error })
        await drop(messageId)
        return
      }
      throw new NotYet(`the network did not take it: ${sent.error}`)
    }
    let settled = sent.status !== undefined ? { ...payment, networkStatus: sent.status } : payment
    if (sent.settled !== undefined) {
      event({ kind: 'on-the-way', payment: settled })
      const outcome = await waitForNetwork(sent.settled, networkWaitMs)
      if (outcome.status !== undefined) settled = { ...settled, networkStatus: outcome.status }
      if (outcome.kind === 'unknown') { event({ kind: 'unsettled', payment: settled }); return }
      if (outcome.kind === 'refused') {
        event({ kind: 'not-broadcast', messageId, payerPeerId: m.senderPeerId, txid, error: outcome.error })
        await drop(messageId)
        return
      }
    }
    try {
      await opts.onPayment(settled)
    } catch (e) {
      event({ kind: 'keep-failed', payment: settled, error: errorText(e) })
      return
    }
    await finish(messageId, [messageId, m.paymentId, txid])
    event({ kind: 'paid', payment: settled })
  }

  const collectPass = async (): Promise<void> => {
    let fromSequence: number | undefined
    for (;;) {
      const page = await opts.ricochet.retrievePage({ folderPath: folders.offline, maxMessages: 50, ...(fromSequence !== undefined ? { fromSequence } : {}) })
      for (const msg of page.messages) {
        const id = msg.messageId
        if (state.done.includes(id)) {
          // Finished, but its delete did not reach the server.
          try { await opts.ricochet.deleteMessages([id]) } catch { /* next pass */ }
          continue
        }
        if (state.opened[id] === undefined) {
          let message: OfflinePaymentMessage
          try {
            const plain = open(msg.payload, msg.senderPeerId)
            message = parseOfflineMessage(JSON.parse(fromUtf8(plain)))
          } catch (e) {
            // Its key, if it had one, is used up whatever went wrong after the MAC.
            await save()
            const reason = e instanceof Refusal ? e.message : `it could not be read: ${errorText(e)}`
            event({ kind: 'refused', messageId: id, payerPeerId: msg.senderPeerId, reason })
            await drop(id)
            continue
          }
          if (message.senderPeerId !== msg.senderPeerId) {
            await save()
            event({ kind: 'refused', messageId: id, payerPeerId: msg.senderPeerId, reason: `it claims to be from ${message.senderPeerId}` })
            await drop(id)
            continue
          }
          if (state.done.includes(message.paymentId) || state.done.includes(message.txid)) {
            await save()
            await drop(id) // a second copy of a payment already received
            continue
          }
          state.opened[id] = { message, openedAt: now(), attempts: 0 }
          await save()
          event({ kind: 'opened', messageId: id, payerPeerId: message.senderPeerId, paymentId: message.paymentId, txid: message.txid, amountSats: message.amountSats, ...(message.description !== undefined ? { note: message.description } : {}) })
        }
        try {
          await settle(id)
        } catch (e) {
          if (e instanceof Refusal) {
            event({ kind: 'refused', messageId: id, payerPeerId: msg.senderPeerId, reason: e.message })
            await drop(id)
          } else if ((state.opened[id]?.attempts ?? 0) >= maxAttempts) {
            // Never checked out over several passes: given up, and the payer reclaims it.
            event({ kind: 'refused', messageId: id, payerPeerId: msg.senderPeerId, reason: errorText(e) })
            await drop(id)
          } else {
            event({ kind: 'error', during: 'collect', error: `${state.opened[id]?.message.txid ?? id}: ${errorText(e)}` })
          }
        }
      }
      if (!page.hasMore || page.messages.length === 0) break
      fromSequence = page.messages[page.messages.length - 1]!.sequenceNumber + 1
    }
  }

  // Timers -------------------------------------------------------------

  let stopped = false
  let collecting: Promise<void> | undefined
  let keying: Promise<void> | undefined
  const collectNow = async (): Promise<void> => {
    collecting ??= collectPass()
      .catch(e => { event({ kind: 'error', during: 'collect', error: errorText(e) }) })
      .finally(() => { collecting = undefined })
    await collecting
  }
  const refreshKeys = async (): Promise<void> => {
    keying ??= keysPass()
      .catch(e => { event({ kind: 'error', during: 'keys', error: errorText(e) }) })
      .finally(() => { keying = undefined })
    await keying
  }
  await refreshKeys()
  void collectNow()
  const collectTimer = setInterval(() => { if (!stopped) void collectNow() }, opts.collectEveryMs ?? 30_000)
  const keysTimer = setInterval(() => { if (!stopped) void refreshKeys() }, opts.keysEveryMs ?? 3600_000)
  return {
    collectNow,
    refreshKeys,
    stop: () => {
      stopped = true
      clearInterval(collectTimer)
      clearInterval(keysTimer)
    }
  }
}

/** The 32-byte seed of `key`, checked to be the key of `peerId`. */
function identitySeed (key: Ed25519PrivateKeyLike, peerId: string): Uint8Array {
  const raw = key instanceof Uint8Array ? key : key.raw
  if (raw.length !== 32 && raw.length !== 64) throw new TypeError('identityKey is not an Ed25519 private key')
  const seed = raw.slice(0, 32)
  const peerKey = ed25519KeyOfPeerId(peerId)
  if (peerKey === null || !equalBytes(peerKey, identityOfSeed(seed).ed25519)) throw new TypeError(`identityKey is not the key of ${peerId}`)
  return seed
}
