/**
 * Being paid live: the payee's side of /overnode/payment/1.0.0, as the
 * SpiffyVault app answers it (payment_protocol.dart handleStream,
 * payment_session.dart, libspiffy ValidateBEEFCommand).
 *
 * Stream A: payment_request → invoice_response (one address) | payment_error.
 * Stream B: beef_payment (same sessionId) → the payment checked by SPV and
 * put on the network → payment_status; when the network had not shown it
 * yet, payment_status with final: false, then payment_network → ack.
 *
 * To be reached, the node must hold a reservation on the Ricochet server's
 * circuit relay and tell the server its relay addresses (identify push):
 * the app finds a payee by asking the server's DHT for the peer ID, and the
 * server answers from what the payee told it. createPaymentNode({ payee: true })
 * sets both up.
 */

import { Transaction, WhatsOnChain } from '@bsv/sdk'
import type { ChainTracker } from '@bsv/sdk'
import type { Connection, Libp2p, Stream } from '@libp2p/interface'
import { fromBase64, randomBytes, toHex } from '../bytes.ts'
import { p2pkhScriptForAddress } from '../destination.ts'
import { errorText } from '../errors.ts'
import { beefKind } from '../funding.ts'
import { MAX_AMOUNT_SATS } from '../link.ts'
import { assertNetwork, walletNetworkType } from '../networks.ts'
import type { Network } from '../networks.ts'
import { encodeOnFrame, readOnFrame } from './frame.ts'
import { PAYMENT_PROTOCOL } from './live.ts'

/** The app's payee drops a session this long after its last change. */
export const PAYEE_SESSION_MS = 60_000
/**
 * How long the payee waits for the network's answer to a payment ARC took
 * but had not yet shown on the network, as the app's payee does.
 */
export const PAYEE_NETWORK_WAIT_MS = 240_000
/** The app's payee cuts a note to this many characters. */
export const PAYEE_MAX_NOTE = 280
/**
 * How many payment requests are taken, as the app's payee takes them:
 * unpaid invoices held at once, by one payer and by all, and requests a
 * minute. Each request may cost an address from `invoiceAddress`.
 */
export const PAYEE_LIMITS: Readonly<PayeeLimits> = {
  openPerPayer: 3,
  open: 64,
  perPayerPerMinute: 10,
  perMinute: 300
}

export interface PayeeLimits {
  /** Unpaid invoices one payer may hold at once. */
  openPerPayer: number
  /** Unpaid invoices all payers together may hold at once. */
  open: number
  /** Requests one payer may make a minute. */
  perPayerPerMinute: number
  /** Requests all payers together may make a minute. */
  perMinute: number
}
/** Default ARC endpoints, the ones the app broadcasts to (POST <base>/tx). */
export const DEFAULT_ARC = {
  mainnet: 'https://arc.gorillapool.io/v1',
  testnet: 'https://arcade-v2-testnet-us-1.bsvblockchain.tech'
} as const

/** A payer's request, before the invoice. */
export interface LiveInvoiceRequest {
  invoiceId: string
  amountSats: number
  /** Who asks: the payer's libp2p peer ID. */
  payerPeerId: string
  note?: string
  /** The link's `w`, when the payer sent it. */
  toWallet?: string
}

/** A payment checked by SPV and seen on the network: keep it in onPayment. */
export interface ReceivedLivePayment {
  invoiceId: string
  /** The invoice's address and what it asked. */
  address: string
  amountSats: number
  payerPeerId: string
  note?: string
  txid: string
  /** The outputs paying the invoice's address, and their sum (at least amountSats). */
  vouts: number[]
  paidSats: number
  /** BEEF V1 as the payer sent it: the payment last, with its ancestors and proofs. */
  beefV1: Uint8Array
  transaction: Transaction
  /** What the broadcaster reported, e.g. SEEN_ON_NETWORK. */
  networkStatus?: string
}

/** What the network did with a payment the broadcaster took before the network showed it. */
export type NetworkOutcome =
  | { kind: 'on-network', status?: string }
  | { kind: 'refused', status?: string, error: string }
  /** Still on its way when the broadcaster stopped following it. */
  | { kind: 'unknown', status?: string }

/**
 * `settled` is there when the broadcaster took the payment but the network
 * has not shown it yet (ARC's RECEIVED, for one): it resolves to what the
 * network did. Without it, `accepted` means the network has the payment.
 */
export type BroadcastResult =
  | { accepted: true, status?: string, settled?: Promise<NetworkOutcome> }
  | { accepted: false, status?: string, error: string }

/**
 * Puts a payment on the network. `chain` is the payment's unproven
 * ancestors first and the payment last; each must be submitted in order.
 */
export type Broadcaster = (chain: Transaction[]) => Promise<BroadcastResult>

export type LivePayeeEvent =
  | { kind: 'request', request: LiveInvoiceRequest }
  | { kind: 'checking', request: LiveInvoiceRequest, txid?: string }
  /**
   * Checked, and taken by the broadcaster, but not yet seen on the network:
   * not received until 'paid'. The payer has been told it is on its way.
   */
  | { kind: 'on-the-way', payment: ReceivedLivePayment }
  /** Seen on the network, and onPayment has run: received. */
  | { kind: 'paid', payment: ReceivedLivePayment }
  /**
   * onPayment threw for a payment that is on the network. The payer was
   * told it is paid; the coin is at the invoice's address with no record of
   * yours. Keep `payment` some other way.
   */
  | { kind: 'keep-failed', payment: ReceivedLivePayment, error: string }
  /** Checked, but the network did not take it, or refused it later: nothing was received. */
  | { kind: 'not-broadcast', request: LiveInvoiceRequest, txid: string, error: string }
  /**
   * Taken by the broadcaster, and still not seen on the network when the
   * payee stopped waiting. The payer heard only that it is on its way, and
   * onPayment has not run. Watch `payment.txid`: keep it if it lands.
   */
  | { kind: 'unsettled', payment: ReceivedLivePayment }
  /** Refused: the request or the payment did not check out. */
  | { kind: 'refused', payerPeerId: string, reason: string, request?: LiveInvoiceRequest }

export interface LivePayeeOptions {
  /** The payee's network: invoices say it, and payments must be for it. */
  network: Network
  /** The address an invoice asks to be paid to. Use a new one per invoice. */
  invoiceAddress: (request: LiveInvoiceRequest) => string | Promise<string>
  /**
   * Called once a payment is checked and seen on the network, before the
   * payer hears it is paid. Keep the coin here, durably, and make it safe to
   * call twice for one txid. A throw is reported as a 'keep-failed' event;
   * the payer is still told it is paid.
   */
  onPayment: (payment: ReceivedLivePayment) => void | Promise<void>
  /** What checks merkle roots (SPV). Default: WhatsOnChain for the network. */
  chainTracker?: ChainTracker
  /** Default: arcBroadcaster(network). */
  broadcaster?: Broadcaster
  /** Return a reason to refuse a request (it is answered with payment_error), or nothing to invoice it. */
  screen?: (request: LiveInvoiceRequest) => string | undefined | Promise<string | undefined>
  onEvent?: (event: LivePayeeEvent) => void
  /** How long an invoice waits for its payment; its expiresAt. Default 60 000, as the app. */
  sessionMs?: number
  /** Default PAYEE_LIMITS. A request past one is answered with payment_error. */
  limits?: Partial<PayeeLimits>
  /** For each frame read. Default 30 000. */
  readMs?: number
  /** How long to wait for a `settled` broadcast. Default PAYEE_NETWORK_WAIT_MS. */
  networkWaitMs?: number
}

export interface LivePayee {
  /** Stops answering payment streams. */
  stop: () => Promise<void>
}

interface Session {
  request: LiveInvoiceRequest
  address: string
  at: number
}

class Refusal extends Error {}

/**
 * Answers /overnode/payment/1.0.0 on `libp2p`, over relayed (limited)
 * connections too: the app pays this node's peer ID as it pays a phone.
 */
export async function acceptLivePayments (libp2p: Libp2p, options: LivePayeeOptions): Promise<LivePayee> {
  // By payer and session ID: by the ID alone, another peer that sent a
  // request with a payer's session ID replaced that payer's session, and the
  // payer's payment was then refused.
  assertNetwork(options.network)
  const sessions = new Map<string, Session>()
  const sessionKey = (payerPeerId: string, sessionId: string): string => `${payerPeerId} ${sessionId}`
  const sessionMs = options.sessionMs ?? PAYEE_SESSION_MS
  const readMs = options.readMs ?? 30_000
  const networkWaitMs = options.networkWaitMs ?? PAYEE_NETWORK_WAIT_MS
  const chainTracker = options.chainTracker ?? new WhatsOnChain(options.network === 'mainnet' ? 'main' : 'test')
  const broadcaster = options.broadcaster ?? arcBroadcaster(options.network)
  const limits = { ...PAYEE_LIMITS, ...options.limits }
  const event = (e: LivePayeeEvent): void => { try { options.onEvent?.(e) } catch { /* the listener's problem */ } }

  const prune = (): void => {
    const cutoff = Date.now() - sessionMs
    for (const [id, s] of sessions) if (s.at < cutoff) sessions.delete(id)
  }

  // Requests taken in the last minute, and those between the check below
  // and their invoice, so that requests arriving together all count.
  const recent: Array<{ payer: string, at: number }> = []
  const pending = new Map<string, number>()
  const noRoom = (payer: string): string | undefined => {
    prune()
    const minuteAgo = Date.now() - 60_000
    while (recent.length > 0 && recent[0]!.at < minuteAgo) recent.shift()
    let open = 0
    let mine = 0
    for (const s of sessions.values()) { open++; if (s.request.payerPeerId === payer) mine++ }
    for (const [p, n] of pending) { open += n; if (p === payer) mine += n }
    if (open >= limits.open || recent.length >= limits.perMinute) return 'Too many payment requests at once'
    if (mine >= limits.openPerPayer) return 'Too many payment requests from you at once'
    if (recent.filter(r => r.payer === payer).length >= limits.perPayerPerMinute) return 'Too many payment requests from you; try again in a minute'
    return undefined
  }

  // One frame each, written with one send(): the Dart reader takes a frame in one read.
  const reply = (stream: Stream, message: Record<string, unknown>): void => { stream.send(encodeOnFrame(message)) }

  const keep = async (payment: ReceivedLivePayment): Promise<void> => {
    try {
      await options.onPayment(payment)
    } catch (e) {
      if (options.onEvent === undefined) console.error('acceptLivePayments: onPayment failed for', payment.txid, e)
      event({ kind: 'keep-failed', payment, error: errorText(e) })
    }
  }

  // The network's answer to a payment answered early, on the payer's stream;
  // the payer acknowledges it. A payer gone by then reads the txid itself.
  const tellNetwork = async (stream: Stream, message: Record<string, unknown>): Promise<void> => {
    try {
      reply(stream, message)
      await readOnFrame(stream, AbortSignal.timeout(10_000))
    } catch { /* the payer left */ }
  }

  const onRequest = async (stream: Stream, msg: Record<string, unknown>, payerPeerId: string): Promise<void> => {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : ''
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
    const refuse = (error: string, code: string): void => {
      reply(stream, { type: 'payment_error', requestId, error, code, sessionId })
      event({ kind: 'refused', payerPeerId, reason: error })
    }
    let amount: bigint | undefined
    try { amount = BigInt(String(msg.amount)) } catch { amount = undefined }
    if (sessionId === '') { refuse('The request has no session', 'invalidRequest'); return }
    if (amount === undefined || amount <= 0n || amount > BigInt(MAX_AMOUNT_SATS)) { refuse('The amount is not a whole number of satoshis', 'invalidAmount'); return }
    const full = noRoom(payerPeerId)
    if (full !== undefined) { refuse(full, 'busy'); return }
    recent.push({ payer: payerPeerId, at: Date.now() })
    pending.set(payerPeerId, (pending.get(payerPeerId) ?? 0) + 1)
    try {
      await invoice(stream, msg, payerPeerId, sessionId, requestId, amount, refuse)
    } finally {
      const n = (pending.get(payerPeerId) ?? 1) - 1
      if (n > 0) pending.set(payerPeerId, n)
      else pending.delete(payerPeerId)
    }
  }

  const invoice = async (stream: Stream, msg: Record<string, unknown>, payerPeerId: string, sessionId: string,
    requestId: string, amount: bigint, refuse: (error: string, code: string) => void): Promise<void> => {
    const raw = typeof msg.description === 'string' ? msg.description.trim() : ''
    const note = raw === '' ? undefined : [...raw].slice(0, PAYEE_MAX_NOTE).join('')
    const request: LiveInvoiceRequest = {
      invoiceId: `inv_${Date.now()}_${toHex(randomBytes(8))}`,
      amountSats: Number(amount),
      payerPeerId,
      ...(note !== undefined ? { note } : {}),
      ...(typeof msg.toWallet === 'string' ? { toWallet: msg.toWallet } : {})
    }
    const why = await options.screen?.(request)
    if (why !== undefined) { refuse(why, 'refused'); return }
    let address: string
    try {
      address = await options.invoiceAddress(request)
      p2pkhScriptForAddress(address, options.network)
    } catch (e) {
      refuse(`No address to be paid to: ${errorText(e)}`, 'walletNone')
      return
    }
    const at = Date.now()
    sessions.set(sessionKey(payerPeerId, sessionId), { request, address, at })
    reply(stream, {
      type: 'invoice_response',
      sessionId,
      requestId,
      invoiceId: request.invoiceId,
      addresses: [address],
      amount: amount.toString(),
      // When the session is dropped: it said an hour, and was gone in a minute.
      expiresAt: new Date(at + sessionMs).toISOString(),
      network: walletNetworkType(options.network)
    })
    event({ kind: 'request', request })
  }

  const onPayment = async (stream: Stream, msg: Record<string, unknown>, payerPeerId: string): Promise<void> => {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : ''
    const key = sessionKey(payerPeerId, sessionId)
    const refuse = (error: string, request?: LiveInvoiceRequest): void => {
      reply(stream, { type: 'payment_status', success: false, error, sessionId })
      event({ kind: 'refused', payerPeerId, reason: error, ...(request !== undefined ? { request } : {}) })
    }
    let session = sessions.get(key)
    // Expired even when no request has come since to prune it.
    if (session !== undefined && Date.now() - session.at >= sessionMs) { sessions.delete(key); session = undefined }
    if (session === undefined) { refuse('No payment request for this session'); return }
    if (msg.invoiceId !== session.request.invoiceId) { refuse('The payment is for another invoice', session.request); return }
    sessions.delete(key)
    const { request, address } = session
    event({ kind: 'checking', request, ...(typeof msg.txid === 'string' ? { txid: msg.txid } : {}) })
    try {
      const { tx, bytes, vouts, paid } = await check(msg.beef, address, request.amountSats, options.network, chainTracker)
      const txid = tx.id('hex')
      const sent = await broadcaster(unprovenChain(tx))
      if (!sent.accepted) {
        reply(stream, {
          type: 'payment_status', success: true, txid, broadcasted: false, arcStatus: 'validated_only',
          ...(sent.status !== undefined ? { networkStatus: sent.status } : {}), broadcastError: sent.error, sessionId
        })
        event({ kind: 'not-broadcast', request, txid, error: sent.error })
        return
      }
      const payment: ReceivedLivePayment = {
        invoiceId: request.invoiceId,
        address,
        amountSats: request.amountSats,
        payerPeerId,
        ...(request.note !== undefined ? { note: request.note } : {}),
        txid,
        vouts,
        paidSats: paid,
        beefV1: bytes,
        transaction: tx,
        ...(sent.status !== undefined ? { networkStatus: sent.status } : {})
      }
      const status = {
        type: 'payment_status', success: true, txid, broadcasted: true, arcStatus: 'broadcasting',
        ...(sent.status !== undefined ? { networkStatus: sent.status } : {}), sessionId
      }
      if (sent.settled === undefined) {
        // On the network now: the payer is told it is paid even when keeping it fails here.
        await keep(payment)
        reply(stream, status)
        event({ kind: 'paid', payment })
        return
      }
      // Taken, and on its way to the network: the payer hears so now and the
      // outcome on this stream when it comes, as from the app's payee. Not
      // received until then: a payment the network refuses pays nothing.
      reply(stream, { ...status, final: false })
      event({ kind: 'on-the-way', payment })
      const outcome = await waitFor(sent.settled, networkWaitMs)
      const settled = outcome.status !== undefined ? { ...payment, networkStatus: outcome.status } : payment
      if (outcome.kind === 'unknown') { event({ kind: 'unsettled', payment: settled }); return }
      if (outcome.kind === 'on-network') await keep(settled)
      event(outcome.kind === 'on-network' ? { kind: 'paid', payment: settled } : { kind: 'not-broadcast', request, txid, error: outcome.error })
      await tellNetwork(stream, {
        type: 'payment_network', sessionId, txid, onNetwork: outcome.kind === 'on-network',
        ...(outcome.status !== undefined ? { networkStatus: outcome.status } : {}),
        ...(outcome.kind === 'refused' ? { error: outcome.error } : {})
      })
    } catch (e) {
      const reason = e instanceof Refusal ? e.message : `The payment could not be checked: ${errorText(e)}`
      reply(stream, { type: 'payment_status', success: false, error: reason, sessionId })
      event({ kind: 'refused', payerPeerId, reason, request })
    }
  }

  const handler = (stream: Stream, connection: Connection): void => {
    const payer = connection.remotePeer.toString()
    void (async () => {
      try {
        const { payload } = await readOnFrame(stream, AbortSignal.timeout(readMs))
        if (payload.type === 'payment_request') await onRequest(stream, payload, payer)
        else if (payload.type === 'beef_payment') await onPayment(stream, payload, payer)
        await stream.close({ signal: AbortSignal.timeout(2000) })
      } catch {
        stream.abort(new Error('payment stream failed'))
      }
    })()
  }

  await libp2p.handle(PAYMENT_PROTOCOL, handler, { runOnLimitedConnection: true })
  return {
    stop: async () => {
      sessions.clear()
      await libp2p.unhandle(PAYMENT_PROTOCOL)
    }
  }
}

/** [settled], or 'unknown' when it takes longer than [ms] or fails. */
async function waitFor (settled: Promise<NetworkOutcome>, ms: number): Promise<NetworkOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<NetworkOutcome>(resolve => { timer = setTimeout(() => { resolve({ kind: 'unknown' }) }, ms) })
  try {
    return await Promise.race([settled.catch((): NetworkOutcome => ({ kind: 'unknown' })), late])
  } finally {
    clearTimeout(timer)
  }
}

/** The payee's checks (libspiffy ValidateBEEFCommand, invoice case): BEEF V1, pays the invoice, SPV. */
async function check (beef: unknown, address: string, amountSats: number, network: Network, chainTracker: ChainTracker):
Promise<{ tx: Transaction, bytes: Uint8Array, vouts: number[], paid: number }> {
  if (typeof beef !== 'string') throw new Refusal('The payment has no BEEF')
  let bytes: Uint8Array
  try { bytes = fromBase64(beef) } catch { throw new Refusal('The payment is not base64') }
  if (beefKind(bytes) !== 'v1') throw new Refusal('The payment is not BEEF V1')
  let tx: Transaction
  try { tx = Transaction.fromBEEF(Array.from(bytes)) } catch (e) { throw new Refusal(`The payment cannot be read: ${errorText(e)}`) }
  const script = p2pkhScriptForAddress(address, network)
  const vouts: number[] = []
  let paid = 0
  tx.outputs.forEach((o, i) => {
    if (o.lockingScript.toHex() === script) { vouts.push(i); paid += o.satoshis ?? 0 }
  })
  if (paid < amountSats) throw new Refusal(`The payment pays ${paid} sats to the invoice, not ${amountSats}`)
  let valid: boolean
  try { valid = await tx.verify(chainTracker) } catch (e) { throw new Refusal(`The payment does not check out: ${errorText(e)}`) }
  if (!valid) throw new Refusal('The payment does not check out')
  return { tx, bytes, vouts, paid }
}

/** The payment's ancestors without a merkle proof, parents first, then the payment. */
export function unprovenChain (tx: Transaction): Transaction[] {
  const chain: Transaction[] = []
  const seen = new Set<string>()
  const walk = (t: Transaction): void => {
    const id = t.id('hex')
    if (seen.has(id)) return
    seen.add(id)
    if (t.merklePath !== undefined && t !== tx) return
    for (const i of t.inputs) if (i.sourceTransaction !== undefined) walk(i.sourceTransaction)
    chain.push(t)
  }
  walk(tx)
  return chain
}

export interface ArcOptions {
  /** ARC base URL; POST <url>/tx. Default DEFAULT_ARC for the network. */
  url?: string
  apiKey?: string
  /**
   * How long `settled` follows an answer that is not yet on the network
   * (RECEIVED, for one: Arcade broadcasts afterwards). Default 30 000, as
   * the app's wallet.
   */
  followMs?: number
}

const ON_NETWORK = new Set(['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'MINED'])
const REFUSED = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED'])

/**
 * Submits to ARC as the app does (`{ rawTx: <EF hex> }`). An answer already
 * on the network is final; any other comes with `settled`, which asks ARC
 * every second until the network has the payment or refuses it.
 */
export function arcBroadcaster (network: Network, opts: ArcOptions = {}): Broadcaster {
  const base = (opts.url ?? (network === 'mainnet' ? DEFAULT_ARC.mainnet : DEFAULT_ARC.testnet)).replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.apiKey !== undefined ? { Authorization: `Bearer ${opts.apiKey}` } : {}) }
  const followMs = opts.followMs ?? 30_000
  const follow = async (txid: string, status: string | undefined): Promise<NetworkOutcome> => {
    const until = Date.now() + followMs
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      try {
        const r = await fetch(`${base}/tx/${txid}`, { headers, credentials: 'omit' })
        if (r.ok) status = ((await r.json()) as { txStatus?: string }).txStatus ?? status
      } catch { /* asked again */ }
      if (status !== undefined && ON_NETWORK.has(status)) return { kind: 'on-network', status }
      if (status !== undefined && REFUSED.has(status)) return { kind: 'refused', status, error: 'The network refused the payment' }
    }
    return { kind: 'unknown', ...(status !== undefined ? { status } : {}) }
  }
  return async (chain) => {
    const payment = chain[chain.length - 1]
    if (payment === undefined) return { accepted: false, error: 'Nothing to broadcast' }
    let status: string | undefined
    try {
      for (const t of chain) {
        const r = await fetch(`${base}/tx`, { method: 'POST', headers, body: JSON.stringify({ rawTx: t.toHexEF() }), credentials: 'omit' })
        const body = await r.json().catch(() => ({})) as { txStatus?: string, extraInfo?: string, detail?: string, title?: string }
        const refused = !r.ok || (body.txStatus !== undefined && REFUSED.has(body.txStatus))
        // A parent ARC already has may be refused as known; only the payment's answer counts.
        if (t === payment) {
          if (refused) {
            return { accepted: false, ...(body.txStatus !== undefined ? { status: body.txStatus } : {}), error: body.extraInfo ?? body.detail ?? body.title ?? body.txStatus ?? `HTTP ${r.status}` }
          }
          status = body.txStatus
        }
      }
    } catch (e) {
      return { accepted: false, error: `ARC could not be reached: ${errorText(e)}` }
    }
    if (status !== undefined && ON_NETWORK.has(status)) return { accepted: true, status }
    return { accepted: true, ...(status !== undefined ? { status } : {}), settled: follow(payment.id('hex'), status) }
  }
}

/** True while the node holds a relay reservation, so payers can reach it. */
export function isReachable (libp2p: Libp2p): boolean {
  return libp2p.getMultiaddrs().some(a => a.toString().includes('/p2p-circuit'))
}

/** Waits for a relay reservation. Throws on timeout or abort. */
export async function waitUntilReachable (libp2p: Libp2p, opts: { timeoutMs?: number, signal?: AbortSignal } = {}): Promise<void> {
  const until = Date.now() + (opts.timeoutMs ?? 20_000)
  while (!isReachable(libp2p)) {
    if (opts.signal?.aborted === true) throw new Error('aborted')
    if (Date.now() > until) throw new Error('No relay reservation: payers cannot reach this node')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
