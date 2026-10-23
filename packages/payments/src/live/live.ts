/**
 * The live path: /overnode/payment/1.0.0 to the payee's phone
 * (lib/services/p2p_isolate/protocol/payment_protocol.dart, payment_session.dart).
 *
 * Stream A: payment_request → invoice_response | payment_error.
 * Build the transaction (not broadcast) within the payee's 60 s window.
 * Stream B: beef_payment (same sessionId) → payment_status.
 *
 * The phone listens on UDX only and keeps a reservation on the Ricochet
 * server's circuit relay, so the payer dials
 * `<relay>/p2p-circuit/p2p/<payee>`: from the relay's WSS address in a
 * browser, its UDX address in Node. The relayed connection is "limited"
 * (go-libp2p defaults: 120 s, 128 KiB), so streams are opened with
 * runOnLimitedConnection and each frame is kept under a size limit and
 * written with one send().
 */

import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { Connection, Libp2p, Stream } from '@libp2p/interface'
import { randomBytes, toBase64, toHex } from '../bytes.ts'
import { p2pkhScriptForAddress } from '../destination.ts'
import { NetworkMismatchError, PaymentError, errorText } from '../errors.ts'
import { fundWithFunder, fundWithWallet } from '../funding.ts'
import type { FundedPayment, PaymentOutput } from '../funding.ts'
import { SPIFFYVAULT_RICOCHET, canonicalNetwork, walletNetworkType } from '../networks.ts'
import type { Network } from '../networks.ts'
import type { FundingContext, PaymentProgress, PaymentResult } from '../types.ts'
import { encodeOnFrame, readOnFrame } from './frame.ts'

export const PAYMENT_PROTOCOL = '/overnode/payment/1.0.0'
/** What a payer that pays invoices in parts says in `caps` (invoice_parts.dart). */
export const SPLIT_CAPABILITY = 'split'
/** Keep each frame within one yamux data frame and well under the relay's 128 KiB per circuit. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024

export interface LivePayParams {
  payeePeerId: string
  amountSats: number
  /** The note (already with `ref <r>` for a request link); sent as `description`. */
  note?: string
  /** The payee's wallet the link names (`w`), sent as `toWallet`. */
  walletId?: string
  network: Network
}

export interface LiveTimeouts {
  /** To reach the payee, relay included. Default 30 000 (the app's relay dial). */
  dialMs?: number
  /** For each reply frame. Default 30 000 (payment_protocol.dart). */
  readMs?: number
  /** The payee drops the session this long after the invoice. Default 60 000. */
  sessionMs?: number
  /** Give up building when less than this is left of the session. Default 10 000. */
  marginMs?: number
}

export interface LivePayContext extends FundingContext {
  /** A started js-libp2p node with Noise, Yamux and the circuit relay transport (createPaymentNode). */
  libp2p: Pick<Libp2p, 'dial' | 'getConnections'>
  /**
   * Relay addresses ending in /p2p/<relay>, tried in order. Default: the
   * SpiffyVault Ricochet server's WSS address, then its UDX IP address.
   */
  relays?: string[]
  /** Send `caps: ["split"]` (this payer pays invoice parts). Default true. */
  split?: boolean
  maxFrameBytes?: number
  timeouts?: LiveTimeouts
  /** Fixed session/request IDs, for tests. Default: random. */
  sessionId?: string
  requestId?: string
  signal?: AbortSignal
}

const DEFAULT_RELAYS = [SPIFFYVAULT_RICOCHET.wss, SPIFFYVAULT_RICOCHET.udxIp]

/** `<relay>/p2p-circuit/p2p/<payee>`. */
export function circuitAddress (relay: string, payeePeerId: string): string {
  return `${relay.replace(/\/$/, '')}/p2p-circuit/p2p/${payeePeerId}`
}

/** A random session ID, so two payers can never collide in the payee's session map. */
export function newSessionId (): string { return `pay_${Date.now()}_${toHex(randomBytes(12))}` }

function err (code: ConstructorParameters<typeof PaymentError>[0], message: string, stage: PaymentError['stage'], canPayAnotherWay: boolean,
  extra: { txid?: string, aborted?: boolean, cause?: unknown } = {}): PaymentError {
  return new PaymentError(code, message, { path: 'live', stage, canPayAnotherWay, ...extra })
}

/**
 * Reaches the payee: an open connection, else through each relay in turn.
 *
 * The relay is dialled first on its own address, then the payee as
 * `/p2p/<relay>/p2p-circuit/p2p/<payee>` over that connection. Dialling
 * `<relay udx address>/p2p-circuit/p2p/<payee>` in one go fails in
 * js-libp2p: the circuit transport's dial filter (@multiformats/multiaddr-matcher)
 * does not know /udx and drops the address. The WSS form would pass, but
 * one way for both keeps it simple.
 */
export async function dialPayee (libp2p: LivePayContext['libp2p'], payeePeerId: string, relays: string[], signal?: AbortSignal): Promise<Connection> {
  const peer = peerIdFromString(payeePeerId)
  const open = libp2p.getConnections(peer).find(c => c.status === 'open')
  if (open !== undefined) return open
  const opts = signal !== undefined ? { signal } : {}
  const errors: string[] = []
  for (const relay of relays) {
    try {
      const relayAddr = multiaddr(relay)
      const relayId = relayAddr.getComponents().filter(c => c.name === 'p2p').at(-1)?.value
      if (relayId === undefined) throw new Error('the relay address has no /p2p/<peer id>')
      await libp2p.dial(relayAddr, opts)
      return await libp2p.dial(multiaddr(`/p2p/${relayId}/p2p-circuit/p2p/${payeePeerId}`), opts)
    } catch (e) {
      errors.push(`${relay}: ${errorText(e)}`)
      if (signal?.aborted === true) break
    }
  }
  throw new Error(errors.join('; ') || 'no relay to dial through')
}

async function exchange (conn: Connection, frame: Uint8Array, readMs: number, signal?: AbortSignal): Promise<{ stream: Stream, reply: Promise<Record<string, unknown>> }> {
  const stream = await conn.newStream(PAYMENT_PROTOCOL, { runOnLimitedConnection: true, ...(signal !== undefined ? { signal } : {}) })
  const timeout = AbortSignal.timeout(readMs)
  const reply = readOnFrame(stream, signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout).then(r => r.payload)
  reply.catch(() => {})
  // One send(): header and payload in one yamux data frame.
  if (!stream.send(frame)) await stream.onDrain(signal !== undefined ? { signal } : {})
  return { stream, reply }
}

async function closeQuietly (stream: Stream): Promise<void> {
  try { await stream.close({ signal: AbortSignal.timeout(2000) }) } catch { stream.abort(new Error('closed')) }
}

interface Invoice { invoiceId: string, addresses: string[], outputs?: Array<{ address: string, sats: number }> }

/** The payer's checks of an invoice (payment_session.dart:224-254, invoice_parts.dart:35-55). */
export function checkInvoice (msg: Record<string, unknown>, amountSats: number, network: Network): Invoice {
  const bad = (m: string): PaymentError => err('bad-invoice', `The payee sent an invoice that cannot be paid: ${m}`, 'request', true)
  const invoiceId = typeof msg.invoiceId === 'string' ? msg.invoiceId : ''
  const addresses = Array.isArray(msg.addresses) ? msg.addresses : []
  if (addresses.length === 0 || invoiceId === '') throw bad('no payment address')
  if (!addresses.every((a): a is string => typeof a === 'string')) throw bad('an address is not text')
  let amount: bigint | undefined
  try { amount = BigInt(String(msg.amount)) } catch { amount = undefined }
  if (amount !== BigInt(amountSats)) throw bad(`it is for ${String(msg.amount)} sats, not the ${amountSats} sats of this payment`)
  if (msg.network !== undefined && msg.network !== null && msg.network !== walletNetworkType(network)) {
    throw new NetworkMismatchError(canonicalNetwork(String(msg.network)), network, 'invoice', 'live')
  }
  for (const a of addresses) {
    try { p2pkhScriptForAddress(a, network) } catch (e) { throw bad(errorText(e)) }
  }
  if (msg.outputs === undefined || msg.outputs === null) return { invoiceId, addresses }
  const raw = msg.outputs
  if (!Array.isArray(raw) || raw.length === 0) throw bad('the invoice has no parts')
  const seen = new Set<string>()
  let total = 0n
  const outputs = raw.map((e: unknown) => {
    const r = e !== null && typeof e === 'object' ? e as Record<string, unknown> : {}
    if (typeof r.address !== 'string' || typeof r.sats !== 'number' || !Number.isSafeInteger(r.sats)) throw bad('a part has no address or amount')
    if (r.sats <= 0) throw bad(`a part of ${r.sats} sats`)
    if (!addresses.includes(r.address)) throw bad('a part pays an address the invoice does not name')
    if (seen.has(r.address)) throw bad('two parts pay the same address')
    seen.add(r.address)
    total += BigInt(r.sats)
    return { address: r.address, sats: r.sats }
  })
  if (outputs.length !== addresses.length) throw bad(`${outputs.length} parts for ${addresses.length} addresses`)
  if (total !== BigInt(amountSats)) throw bad(`the parts add up to ${total} sats, not ${amountSats}`)
  return { invoiceId, addresses, outputs }
}

/** The outputs to pay: each part; else the whole to one address; else equal shares, the remainder to the last. */
export function invoiceOutputs (inv: Invoice, amountSats: number, network: Network): PaymentOutput[] {
  if (inv.outputs !== undefined) return inv.outputs.map(o => ({ address: o.address, satoshis: o.sats, lockingScript: p2pkhScriptForAddress(o.address, network) }))
  const n = inv.addresses.length
  const share = Math.floor(amountSats / n)
  return inv.addresses.map((a, i) => ({
    address: a,
    satoshis: i === n - 1 ? amountSats - share * (n - 1) : share,
    lockingScript: p2pkhScriptForAddress(a, network)
  }))
}

/** Pays the payee over a libp2p stream; the payee checks it by SPV and broadcasts it. */
export async function payLive (params: LivePayParams, ctx: LivePayContext): Promise<PaymentResult> {
  const progress = (step: PaymentProgress['step'], detail?: string): void => ctx.onProgress?.({ path: 'live', step, ...(detail !== undefined ? { detail } : {}) })
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw err('amount-invalid', 'The amount must be a whole number of satoshis, at least 1', 'prepare', true)
  }
  if (ctx.wallet === undefined && ctx.funder === undefined) throw err('no-route', 'Live payments need a wallet or a funder', 'prepare', true)
  const t = { dialMs: 30_000, readMs: 30_000, sessionMs: 60_000, marginMs: 10_000, ...ctx.timeouts }
  const maxFrame = ctx.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const sessionId = ctx.sessionId ?? newSessionId()
  const requestId = ctx.requestId ?? `req_${Date.now()}_${toHex(randomBytes(4))}`
  const note = params.note?.trim() ?? ''

  progress('dial')
  let conn: Connection
  try {
    const dialSignal = ctx.signal !== undefined ? AbortSignal.any([ctx.signal, AbortSignal.timeout(t.dialMs)]) : AbortSignal.timeout(t.dialMs)
    conn = await dialPayee(ctx.libp2p, params.payeePeerId, ctx.relays ?? DEFAULT_RELAYS, dialSignal)
  } catch (e) {
    throw err('payee-unreachable', `The payee could not be reached: ${errorText(e)}`, 'connect', true, { cause: e })
  }

  // Stream A: the request and the invoice.
  progress('request', sessionId)
  const request: Record<string, unknown> = {
    type: 'payment_request',
    sessionId,
    requestId,
    amount: String(params.amountSats),
    description: note,
    ...(params.walletId !== undefined ? { toWallet: params.walletId } : {}),
    ...(ctx.split !== false ? { caps: [SPLIT_CAPABILITY] } : {})
  }
  let invoiceMsg: Record<string, unknown>
  let a: Stream | undefined
  try {
    const x = await exchange(conn, encodeOnFrame(request), t.readMs, ctx.signal)
    a = x.stream
    invoiceMsg = await x.reply
  } catch (e) {
    const opened = a !== undefined
    throw err(opened ? 'no-invoice' : 'payee-unreachable', opened ? `The payee sent no invoice: ${errorText(e)}` : `The payee could not be reached: ${errorText(e)}`,
      opened ? 'request' : 'connect', true, { cause: e })
  } finally {
    if (a !== undefined) await closeQuietly(a)
  }
  const invoiceAt = Date.now()
  if (invoiceMsg.type === 'payment_error') {
    throw err('no-invoice', `The payee could not make an invoice (${String(invoiceMsg.code ?? 'no code')}): ${String(invoiceMsg.error ?? '')}`, 'request', true)
  }
  if (invoiceMsg.type !== 'invoice_response') throw err('no-invoice', `The payee answered ${String(invoiceMsg.type)}, not an invoice`, 'request', true)
  const invoice = checkInvoice(invoiceMsg, params.amountSats, params.network)
  progress('invoice', invoice.invoiceId)

  // Build it, not broadcast.
  const outputs = invoiceOutputs(invoice, params.amountSats, params.network)
  progress('fund')
  const info = { path: 'live' as const, broadcast: false, ...(note !== '' ? { note } : {}), counterparty: params.payeePeerId }
  const funded: FundedPayment = ctx.wallet !== undefined
    ? await fundWithWallet(ctx.wallet, outputs, info, ctx.originator !== undefined ? { originator: ctx.originator } : {})
    : await fundWithFunder(ctx.funder!, outputs, info)
  const giveUp = async (code: 'invoice-expired' | 'frame-too-large' | 'payee-unreachable', message: string, stage: PaymentError['stage'], cause?: unknown): Promise<never> => {
    progress('abort', funded.txid)
    const aborted = await funded.abort()
    throw err(code, message, stage, true, { txid: funded.txid, aborted, cause })
  }
  if (Date.now() - invoiceAt > t.sessionMs - t.marginMs) {
    return await giveUp('invoice-expired', 'Building the payment took too long; the payee has dropped the invoice', 'pay')
  }
  const frame = encodeOnFrame({
    type: 'beef_payment', sessionId, requestId, invoiceId: invoice.invoiceId, beef: toBase64(funded.beefV1), txid: funded.txid
  })
  const cap = conn.limits?.bytes
  const limit = cap !== undefined && cap > 0n ? Math.min(maxFrame, Number(cap) - 16 * 1024) : maxFrame
  if (frame.length > limit) {
    return await giveUp('frame-too-large', `The payment is ${frame.length} bytes, more than the ${limit} a live payment may carry; pay it offline`, 'pay')
  }

  // Stream B: the transaction and the payee's verdict. Once sent, never abort.
  progress('send', funded.txid)
  let b: Stream
  try {
    b = await conn.newStream(PAYMENT_PROTOCOL, { runOnLimitedConnection: true, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) })
  } catch (e) {
    return await giveUp('payee-unreachable', `The payee could not be reached again to hand over the payment: ${errorText(e)}`, 'connect', e)
  }
  let status: Record<string, unknown>
  try {
    const timeout = AbortSignal.timeout(t.readMs)
    const reply = readOnFrame(b, ctx.signal !== undefined ? AbortSignal.any([ctx.signal, timeout]) : timeout)
    reply.catch(() => {})
    if (!b.send(frame)) await b.onDrain()
    progress('status')
    status = (await reply).payload
  } catch (e) {
    throw err('not-confirmed', `Payment ${funded.txid} was handed to the payee, but no answer came: the payee may hold it. Do not pay again; watch the txid.`,
      'settle', false, { txid: funded.txid, cause: e })
  } finally {
    await closeQuietly(b)
  }
  if (status.type !== 'payment_status') {
    throw err('not-confirmed', `Payment ${funded.txid} was handed over and the payee answered ${String(status.type)}; watch the txid.`, 'settle', false, { txid: funded.txid })
  }
  if (status.success !== true) {
    throw err('payee-refused', `The payee refused payment ${funded.txid}: ${String(status.error ?? '')}. Its inputs stay reserved; release them once the txid is not on the network.`,
      'settle', false, { txid: funded.txid })
  }
  if (!reachedNetwork(status)) {
    // The payee holds a valid payment but could not put it on the network
    // (ARC refused it, or could not be asked): not a payment made.
    const why = String(status.broadcastError ?? status.networkStatus ?? status.arcStatus ?? 'no broadcast')
    throw err('not-confirmed', `The payee checked payment ${funded.txid} but could not put it on the network (${why}). Do not pay again; watch the txid.`,
      'settle', false, { txid: funded.txid })
  }
  return {
    path: 'live',
    txid: funded.txid,
    status: 'completed',
    amountSats: params.amountSats,
    ...(note !== '' ? { note } : {}),
    broadcasted: status.broadcasted === true,
    attempts: []
  }
}

/**
 * Whether a successful payment_status says the payment reached the network:
 * the payee submitted it (`broadcasted`, or `arcStatus` "broadcasting"), or
 * ARC reports it on the network or mined. "validated_only" alone is a
 * payment the payee could not put on the network.
 */
export function reachedNetwork (status: Record<string, unknown>): boolean {
  if (status.broadcasted === true || status.arcStatus === 'broadcasting') return true
  return ['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'MINED'].includes(String(status.networkStatus))
}
