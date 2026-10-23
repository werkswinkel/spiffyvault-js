/**
 * A JS stand-in for the payee's side of /overnode/payment/1.0.0, after the
 * app (payment_protocol.dart handleStream, payment_session.dart):
 *
 * - each stream: read one frame, find or make the session by sessionId,
 *   answer, half-close;
 * - payment_request (idle) → invoice_response (+ outputs when the payer
 *   says caps:["split"] and parts are configured) or payment_error;
 * - beef_payment (invoiceSent) → check BEEF V1, subject last, outputs to
 *   the invoice addresses ≥ amount → payment_status; an unknown session
 *   makes a fresh idle session and answers nothing;
 * - a session is dropped 60 s after its last change.
 *
 * It also records how many chunks each frame came in: the Dart reader
 * needs the whole frame in one yamux data frame.
 */

import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { Connection, Libp2p, Stream } from '@libp2p/interface'
import { PAYMENT_PROTOCOL, encodeOnFrame, openFrameReader, inspectBeefV1, fromBase64 } from './internals.ts'

export interface MockPayeeOptions {
  network?: 'test' | 'main'
  /** Sats per part when the payer pays parts; the parts must add up to the amount asked. */
  split?: (amount: number) => number[] | undefined
  /** Answer payment_request with payment_error. */
  error?: { error: string, code: string }
  /** Read the request and close without answering. */
  silentOnRequest?: boolean
  /** Read the beef_payment and close without answering. */
  silentOnBeef?: boolean
  /** Answer beef_payment with success:false. */
  refuse?: string
  /** The payment_status fields after success:true (default: broadcast). */
  status?: Record<string, unknown>
  /** With status final:false: the payment_network fields sent after it on the same stream. */
  networkAnswer?: Record<string, unknown>
  sessionMs?: number
}

interface Session { state: 'idle' | 'invoiceSent' | 'done', amount: number, addresses: string[], invoiceId: string, timer?: ReturnType<typeof setTimeout> }

export interface Received {
  type: string
  frame: Record<string, unknown>
  chunks: number
  remotePeer: string
  limited: boolean
}

export class MockPayee {
  readonly received: Received[] = []
  readonly sessions = new Map<string, Session>()
  readonly paid: Array<{ txid: string, sats: number, tx: Transaction }> = []
  /** The payer's acknowledgements of payment_network. */
  readonly acks: Array<Record<string, unknown>> = []
  private readonly opts: MockPayeeOptions
  private readonly node: Pick<Libp2p, 'handle' | 'unhandle'>

  constructor (node: Pick<Libp2p, 'handle' | 'unhandle'>, opts: MockPayeeOptions = {}) {
    this.node = node
    this.opts = opts
  }

  async start (): Promise<void> {
    await this.node.handle(PAYMENT_PROTOCOL, (stream, connection) => { void this.onStream(stream, connection) }, { runOnLimitedConnection: true })
  }

  async stop (): Promise<void> {
    for (const s of this.sessions.values()) clearTimeout(s.timer)
    await this.node.unhandle(PAYMENT_PROTOCOL)
  }

  private touch (id: string, s: Session): void {
    clearTimeout(s.timer)
    s.timer = setTimeout(() => this.sessions.delete(id), this.opts.sessionMs ?? 60_000)
    this.sessions.set(id, s)
  }

  private async onStream (stream: Stream, connection: Connection): Promise<void> {
    const reader = openFrameReader(stream)
    try {
      const { payload, chunks } = await reader.next(AbortSignal.timeout(30_000))
      this.received.push({ type: String(payload.type), frame: payload, chunks, remotePeer: connection.remotePeer.toString(), limited: connection.limits !== undefined })
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : `pay_${Date.now()}`
      const session = this.sessions.get(sessionId) ?? { state: 'idle', amount: 0, addresses: [], invoiceId: '' }
      this.touch(sessionId, session)
      const reply = this.handle(session, payload)
      if (reply !== undefined) stream.send(encodeOnFrame({ ...reply, sessionId }))
      if (reply?.final === false && this.opts.networkAnswer !== undefined) {
        // The network's answer, then the payer's ack (spiffyvault-voo).
        await new Promise(resolve => setTimeout(resolve, 50))
        stream.send(encodeOnFrame({ type: 'payment_network', sessionId, txid: reply.txid, ...this.opts.networkAnswer }))
        this.acks.push((await reader.next(AbortSignal.timeout(10_000))).payload)
      }
      await stream.close()
    } catch {
      stream.abort(new Error('payee error'))
    } finally {
      reader.close()
    }
  }

  private handle (s: Session, m: Record<string, unknown>): Record<string, unknown> | undefined {
    const net = this.opts.network ?? 'test'
    if (s.state === 'idle' && m.type === 'payment_request') {
      if (this.opts.silentOnRequest === true) return undefined
      if (this.opts.error !== undefined) { s.state = 'done'; return { type: 'payment_error', requestId: m.requestId, ...this.opts.error } }
      const amount = Number(BigInt(String(m.amount)))
      const caps = Array.isArray(m.caps) ? m.caps : []
      const parts = caps.includes('split') ? this.opts.split?.(amount) : undefined
      const addresses = (parts ?? [amount]).map(() => PrivateKey.fromRandom().toPublicKey().toAddress(net === 'main' ? 'mainnet' : 'testnet'))
      Object.assign(s, { state: 'invoiceSent', amount, addresses, invoiceId: `inv-${Math.random().toString(36).slice(2)}` })
      return {
        type: 'invoice_response',
        requestId: m.requestId,
        invoiceId: s.invoiceId,
        addresses,
        amount: String(amount),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        network: net,
        ...(parts !== undefined ? { outputs: addresses.map((address, i) => ({ address, sats: parts[i]! })) } : {})
      }
    }
    if (s.state === 'invoiceSent' && m.type === 'beef_payment') {
      s.state = 'done'
      if (this.opts.silentOnBeef === true) return undefined
      if (this.opts.refuse !== undefined) return { type: 'payment_status', success: false, error: this.opts.refuse }
      try {
        const beef = fromBase64(String(m.beef))
        const info = inspectBeefV1(beef)
        const tx = Transaction.fromBEEF(Array.from(beef))
        const scripts = new Set(s.addresses.map(a => new P2PKH().lock(a).toHex()))
        const sats = tx.outputs.filter(o => scripts.has(o.lockingScript.toHex())).reduce((t, o) => t + (o.satoshis ?? 0), 0)
        if (sats < s.amount) return { type: 'payment_status', success: false, error: `pays ${sats} of ${s.amount}` }
        this.paid.push({ txid: info.txid, sats, tx })
        return { type: 'payment_status', success: true, txid: m.txid, ...(this.opts.status ?? { broadcasted: true, arcStatus: 'broadcasting' }) }
      } catch (e) {
        return { type: 'payment_status', success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    return undefined // e.g. beef_payment for an unknown session: a fresh idle session writes nothing
  }
}
