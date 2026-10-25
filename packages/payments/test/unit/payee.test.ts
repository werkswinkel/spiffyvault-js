/**
 * acceptLivePayments() against the SDK's own payer (payLive), on two
 * loopback UDX nodes: the payer dials the payee first, and payLive uses
 * that connection. The relay and the DHT lookup are the integration
 * test's (test/integration/payee.test.ts).
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import type { Transaction, WalletInterface } from '@bsv/sdk'
import type { Libp2p } from '@libp2p/interface'
import {
  PaymentError, acceptLivePayments, arcBroadcaster, createPaymentNode, payLive, unprovenChain
} from '../../src/node.ts'
import type { Broadcaster, LivePayeeEvent, LivePayeeOptions, ReceivedLivePayment } from '../../src/node.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { encodeOnFrame, readOnFrame } from '../../src/live/frame.ts'
import { PAYMENT_PROTOCOL } from '../../src/live/live.ts'

let payer: Libp2p
let payee: Libp2p
let other: Libp2p
before(async () => {
  payee = (await createPaymentNode({ udxOnly: true, listen: ['/ip4/127.0.0.1/udp/0/udx'] })).node
  payer = (await createPaymentNode({ udxOnly: true })).node
  other = (await createPaymentNode({ udxOnly: true })).node
  await payer.dial(payee.getMultiaddrs()[0]!)
  await other.dial(payee.getMultiaddrs()[0]!)
})
after(async () => { await payer.stop(); await other.stop(); await payee.stop() })

/** One frame from [from] to the payee on a new stream, and its answer: undefined when none comes. */
async function ask (from: Libp2p, message: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const stream = await from.dialProtocol(payee.peerId, PAYMENT_PROTOCOL, { runOnLimitedConnection: true })
  stream.send(encodeOnFrame(message))
  try {
    return (await readOnFrame(stream, AbortSignal.timeout(2000))).payload
  } catch {
    return undefined
  } finally {
    await stream.close().catch(() => {})
  }
}

const anyRoot = { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 }
const asWallet = (w: FakeWallet): WalletInterface => w as unknown as WalletInterface

interface Run { payments: ReceivedLivePayment[], events: LivePayeeEvent[], chains: Transaction[][], keys: Map<string, PrivateKey> }

/** Serves acceptLivePayments for one test, a fresh key per invoice. */
async function serving (opts: Partial<LivePayeeOptions> & { broadcast?: Broadcaster }, body: (run: Run) => Promise<void>): Promise<void> {
  const run: Run = { payments: [], events: [], chains: [], keys: new Map() }
  const handle = await acceptLivePayments(payee, {
    network: 'testnet',
    chainTracker: anyRoot,
    invoiceAddress: r => {
      const key = PrivateKey.fromRandom()
      run.keys.set(r.invoiceId, key)
      return key.toPublicKey().toAddress('testnet')
    },
    broadcaster: async chain => { run.chains.push(chain); return await (opts.broadcast?.(chain) ?? { accepted: true, status: 'SEEN_ON_NETWORK' }) },
    onPayment: p => { run.payments.push(p) },
    onEvent: e => { run.events.push(e) },
    ...opts
  })
  try { await body(run) } finally { await handle.stop() }
}

const pay = async (wallet: FakeWallet, amountSats = 10_000, note = 'Lunch'): Promise<Awaited<ReturnType<typeof payLive>>> =>
  await payLive({ payeePeerId: payee.peerId.toString(), amountSats, note, network: 'testnet' }, { wallet: asWallet(wallet), libp2p: payer, relays: [] })

test('a live payment: invoice, payment checked and broadcast, kept, payer told it is done', async () => {
  await serving({}, async run => {
    const r = await pay(new FakeWallet())
    assert.equal(r.status, 'completed')
    assert.equal(r.broadcasted, true)
    assert.equal(run.payments.length, 1)
    const p = run.payments[0]!
    assert.equal(p.txid, r.txid)
    assert.equal(p.amountSats, 10_000)
    assert.equal(p.paidSats, 10_000)
    assert.equal(p.note, 'Lunch')
    assert.equal(p.payerPeerId, payer.peerId.toString())
    assert.equal(p.networkStatus, 'SEEN_ON_NETWORK')
    // The coin spends with the invoice's key.
    const out = p.transaction.outputs[p.vouts[0]!]!
    assert.equal(out.lockingScript.toHex(), new P2PKH().lock(run.keys.get(p.invoiceId)!.toPublicKey().toAddress('testnet')).toHex())
    assert.deepEqual(run.events.map(e => e.kind), ['request', 'checking', 'paid'])
    assert.equal(run.chains[0]!.at(-1)!.id('hex'), r.txid)
  })
})

test("another peer's request with the same session ID leaves the payer's session alone", async () => {
  await serving({}, async () => {
    const request = { type: 'payment_request', sessionId: 'shared', requestId: 'r1', amount: '1000' }
    const invoice = await ask(payer, request)
    assert.equal(invoice?.type, 'invoice_response')
    assert.equal((await ask(other, request))?.type, 'invoice_response')
    // The payer's session still answers its payment: here refused, as the
    // BEEF is not real. Replaced by the other peer's, it answered nothing.
    const status = await ask(payer, { type: 'beef_payment', sessionId: 'shared', invoiceId: invoice?.invoiceId, beef: 'AAAA' })
    assert.equal(status?.type, 'payment_status')
    assert.equal(status?.success, false)
    assert.match(String(status?.error), /BEEF/)
  })
})

test('unproven parents are broadcast first, the payment last', async () => {
  await serving({}, async run => {
    const r = await pay(new FakeWallet({ unprovenDepth: 2 }))
    const chain = run.chains[0]!
    assert.equal(chain.length, 3)
    assert.equal(chain.at(-1)!.id('hex'), r.txid)
    assert.deepEqual(unprovenChain(chain.at(-1)!).map(t => t.id('hex')), chain.map(t => t.id('hex')))
  })
})

test('the network refuses it: nothing kept, the payer must not pay again', async () => {
  await serving({ broadcast: async () => ({ accepted: false, status: 'DOUBLE_SPEND_ATTEMPTED', error: 'double spend' }) }, async run => {
    await assert.rejects(pay(new FakeWallet()), (e: PaymentError) => e.code === 'not-confirmed' && !e.canPayAnotherWay && /double spend/.test(e.message))
    assert.equal(run.payments.length, 0)
    assert.equal(run.events.at(-1)!.kind, 'not-broadcast')
  })
})

test('a payment that does not check out by SPV is refused', async () => {
  await serving({ chainTracker: { isValidRootForHeight: async () => false, currentHeight: async () => 1 } }, async run => {
    await assert.rejects(pay(new FakeWallet()), (e: PaymentError) => e.code === 'payee-refused')
    assert.equal(run.payments.length, 0)
    assert.equal(run.chains.length, 0) // never broadcast
    assert.equal(run.events.at(-1)!.kind, 'refused')
  })
})

test('screen refuses a request: payment_error, nothing moved', async () => {
  await serving({ screen: r => r.amountSats > 5000 ? 'Too much for this till' : undefined }, async run => {
    await assert.rejects(pay(new FakeWallet(), 6000), (e: PaymentError) => e.code === 'no-invoice' && e.canPayAnotherWay && /Too much/.test(e.message))
    assert.equal(run.payments.length, 0)
    const ok = await pay(new FakeWallet(), 4000)
    assert.equal(ok.status, 'completed')
  })
})

test('a mainnet payee: a testnet payer refuses its invoice', async () => {
  await serving({ network: 'mainnet', invoiceAddress: () => PrivateKey.fromRandom().toPublicKey().toAddress('mainnet') }, async () => {
    await assert.rejects(pay(new FakeWallet()), (e: PaymentError) => e.code === 'network-mismatch')
  })
})

test('arcBroadcaster: EF to <base>/tx, follows RECEIVED, reports a refusal', async () => {
  const wallet = new FakeWallet({ unprovenDepth: 1 })
  const { tx } = await wallet.createAction({ description: 't', outputs: [{ lockingScript: '76a914' + '00'.repeat(20) + '88ac', satoshis: 10, outputDescription: 'x' }], options: { noSend: true } } as never)
  const { Transaction: T } = await import('@bsv/sdk')
  const payment = T.fromAtomicBEEF(tx!)
  const calls: string[] = []
  const real = globalThis.fetch
  let refuse = false
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}${init?.body !== undefined ? ` ${String(JSON.parse(String(init.body)).rawTx).slice(8, 20)}` : ''}`)
    if (init?.method === 'POST') return new Response(JSON.stringify({ txStatus: 'RECEIVED' }), { status: 200 })
    return new Response(JSON.stringify({ txStatus: refuse ? 'REJECTED' : 'SEEN_ON_NETWORK' }), { status: 200 })
  }) as typeof fetch
  try {
    const b = arcBroadcaster('testnet', { url: 'https://arc.test/', waitMs: 3000 })
    assert.deepEqual(await b(unprovenChain(payment)), { accepted: true, status: 'SEEN_ON_NETWORK' })
    assert.equal(calls.filter(c => c === 'POST https://arc.test/tx 0000000000ef').length, 2) // EF (BRC-30 marker): parent, then payment
    assert.ok(calls.at(-1)!.startsWith(`GET https://arc.test/tx/${payment.id('hex')}`))
    refuse = true
    const r = await b([payment])
    assert.equal(r.accepted, false)
  } finally {
    globalThis.fetch = real
  }
})
