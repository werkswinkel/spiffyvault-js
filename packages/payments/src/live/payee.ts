/**
 * Being paid live: the payee's side of /overnode/payment/1.0.0, as the
 * SpiffyVault app answers it (payment_protocol.dart handleStream,
 * payment_session.dart, libspiffy ValidateBEEFCommand).
 *
 * Stream A: payment_request → invoice_response (one address) | payment_error.
 * Stream B: beef_payment (same sessionId) → the payment checked by SPV and
 * put on the network → payment_status.
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
import { walletNetworkType } from '../networks.ts'
import type { Network } from '../networks.ts'
import { encodeOnFrame, readOnFrame } from './frame.ts'
import { PAYMENT_PROTOCOL } from './live.ts'

/** The app's payee drops a session this long after its last change. */
export const PAYEE_SESSION_MS = 60_000
/** The app's payee cuts a note to this many characters. */
export const PAYEE_MAX_NOTE = 280
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

/** A payment checked by SPV and on the network: keep it in onPayment. */
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
  /** What the broadcaster reported, e.g. SEEN_ON_NETWORK or RECEIVED. */
  networkStatus?: string
}

export type BroadcastResult =
  | { accepted: true, status?: string }
  | { accepted: false, status?: string, error: string }

/**
 * Puts a payment on the network. `chain` is the payment's unproven
 * ancestors first and the payment last; each must be submitted in order.
 */
export type Broadcaster = (chain: Transaction[]) => Promise<BroadcastResult>

export type LivePayeeEvent =
  | { kind: 'request', request: LiveInvoiceRequest }
  | { kind: 'checking', request: LiveInvoiceRequest, txid?: string }
  | { kind: 'paid', payment: ReceivedLivePayment }
  /** Checked, but the network did not take it: nothing was received. */
  | { kind: 'not-broadcast', request: LiveInvoiceRequest, txid: string, error: string }
  /** Refused: the request or the payment did not check out. */
  | { kind: 'refused', payerPeerId: string, reason: string, request?: LiveInvoiceRequest }

export interface LivePayeeOptions {
  /** The payee's network: invoices say it, and payments must be for it. */
  network: Network
  /** The address an invoice asks to be paid to. Use a new one per invoice. */
  invoiceAddress: (request: LiveInvoiceRequest) => string | Promise<string>
  /** Called once a payment is checked and on the network, before the payer hears so. Keep the coin here. */
  onPayment: (payment: ReceivedLivePayment) => void | Promise<void>
  /** What checks merkle roots (SPV). Default: WhatsOnChain for the network. */
  chainTracker?: ChainTracker
  /** Default: arcBroadcaster(network). */
  broadcaster?: Broadcaster
  /** Return a reason to refuse a request (it is answered with payment_error), or nothing to invoice it. */
  screen?: (request: LiveInvoiceRequest) => string | undefined | Promise<string | undefined>
  onEvent?: (event: LivePayeeEvent) => void
  /** Default 60 000, as the app. */
  sessionMs?: number
  /** For each frame read. Default 30 000. */
  readMs?: number
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
  const sessions = new Map<string, Session>()
  const sessionMs = options.sessionMs ?? PAYEE_SESSION_MS
  const readMs = options.readMs ?? 30_000
  const chainTracker = options.chainTracker ?? new WhatsOnChain(options.network === 'mainnet' ? 'main' : 'test')
  const broadcaster = options.broadcaster ?? arcBroadcaster(options.network)
  const event = (e: LivePayeeEvent): void => { try { options.onEvent?.(e) } catch { /* the listener's problem */ } }

  const prune = (): void => {
    const cutoff = Date.now() - sessionMs
    for (const [id, s] of sessions) if (s.at < cutoff) sessions.delete(id)
  }

  // One frame each, written with one send(): the Dart reader takes a frame in one read.
  const reply = (stream: Stream, message: Record<string, unknown>): void => { stream.send(encodeOnFrame(message)) }

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
    prune()
    sessions.set(sessionId, { request, address, at: Date.now() })
    reply(stream, {
      type: 'invoice_response',
      sessionId,
      requestId,
      invoiceId: request.invoiceId,
      addresses: [address],
      amount: amount.toString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      network: walletNetworkType(options.network)
    })
    event({ kind: 'request', request })
  }

  const onPayment = async (stream: Stream, msg: Record<string, unknown>, payerPeerId: string): Promise<void> => {
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : ''
    const session = sessions.get(sessionId)
    // An unknown or expired session answers nothing, as the app's payee does.
    if (session === undefined || session.request.payerPeerId !== payerPeerId || msg.invoiceId !== session.request.invoiceId) return
    sessions.delete(sessionId)
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
      // On the network now: tell the payer it is paid even when keeping it fails here.
      try { await options.onPayment(payment) } catch (e) { console.error('acceptLivePayments: onPayment failed for', txid, e) }
      reply(stream, {
        type: 'payment_status', success: true, txid, broadcasted: true, arcStatus: 'broadcasting',
        ...(sent.status !== undefined ? { networkStatus: sent.status } : {}), sessionId
      })
      event({ kind: 'paid', payment })
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
  /** How long to follow a RECEIVED answer for the network's (Arcade broadcasts afterwards). Default 8000. */
  waitMs?: number
}

const IN_FLIGHT = new Set(['RECEIVED', 'QUEUED', 'STORED', 'ANNOUNCED_TO_NETWORK', 'REQUESTED_BY_NETWORK', 'SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK'])
const REFUSED = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED'])

/** Submits to ARC as the app does (`{ rawTx: <EF hex> }`), then follows an in-flight answer a few seconds. */
export function arcBroadcaster (network: Network, opts: ArcOptions = {}): Broadcaster {
  const base = (opts.url ?? (network === 'mainnet' ? DEFAULT_ARC.mainnet : DEFAULT_ARC.testnet)).replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.apiKey !== undefined ? { Authorization: `Bearer ${opts.apiKey}` } : {}) }
  const waitMs = opts.waitMs ?? 8000
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
    const txid = payment.id('hex')
    const until = Date.now() + waitMs
    while ((status === undefined || IN_FLIGHT.has(status)) && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      try {
        const r = await fetch(`${base}/tx/${txid}`, { headers, credentials: 'omit' })
        if (r.ok) status = ((await r.json()) as { txStatus?: string }).txStatus ?? status
      } catch { /* asked again */ }
    }
    if (status !== undefined && REFUSED.has(status)) return { accepted: false, status, error: 'The network refused the payment' }
    return { accepted: true, ...(status !== undefined ? { status } : {}) }
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
