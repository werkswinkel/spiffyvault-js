/**
 * The live path through a local go-ricochet acting as circuit relay, Node
 * over UDX on both legs: payer → relay → mock payee (reservation only).
 */

import { after, afterEach, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import type { Libp2p } from '@libp2p/interface'
import { PaymentError, createPaymentNode, payLive } from '../../src/node.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { relayedPayee } from './live-peers.ts'
import type { RelayedPayee } from './live-peers.ts'
import { GO_LIBP2P_RELAY_LIMIT, startServer } from './server.ts'
import type { TestServer } from './server.ts'

let server: TestServer
let payer: Libp2p
const payees: RelayedPayee[] = []
before(async () => {
  // A relay that limits its connections, as an operator may set: the
  // payer must keep each frame within a limited connection's allowance.
  // The other suites run on go-ricochet's default, unlimited relay.
  server = await startServer({ relayLimit: GO_LIBP2P_RELAY_LIMIT })
  payer = (await createPaymentNode({ udxOnly: true })).node
})
afterEach(async () => { for (const p of payees.splice(0)) await p.stop() })
after(async () => {
  await payer?.stop()
  await server?.stop()
})

const asWallet = (w: FakeWallet): WalletInterface => w as unknown as WalletInterface
async function waitFor (ok: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function payee (opts: Parameters<typeof relayedPayee>[1] = {}): Promise<RelayedPayee> {
  const p = await relayedPayee(server.udx, opts)
  payees.push(p)
  return p
}

test('UDX↔relay↔UDX: request, invoice, BEEF, status; frames in one chunk, on a limited connection', async () => {
  const p = await payee()
  const wallet = new FakeWallet({ unprovenDepth: 1 })
  const r = await payLive({ payeePeerId: p.peerId, amountSats: 3000, note: 'Live · ref ABCD2345', walletId: 'w1', network: 'testnet' },
    { wallet: asWallet(wallet), libp2p: payer, relays: [server.udx] })
  assert.equal(r.status, 'completed')
  assert.equal(r.path, 'live')
  assert.equal(r.broadcasted, true)
  assert.deepEqual(p.payee.paid.map(x => [x.txid, x.sats]), [[r.txid, 3000]])
  const [req, beef] = p.payee.received
  assert.equal(req!.type, 'payment_request')
  assert.equal(beef!.type, 'beef_payment')
  assert.equal(req!.frame.sessionId, beef!.frame.sessionId)
  assert.match(String(req!.frame.sessionId), /^pay_\d+_[0-9a-f]{24}$/)
  assert.equal(req!.frame.amount, '3000')
  assert.equal(req!.frame.description, 'Live · ref ABCD2345')
  assert.equal(req!.frame.toWallet, 'w1')
  assert.deepEqual(req!.frame.caps, ['split'])
  assert.equal(beef!.frame.txid, r.txid)
  assert.equal(req!.chunks, 1)
  assert.equal(beef!.chunks, 1)
  assert.equal(req!.limited, true, 'the payee saw a relayed (limited) connection')
  assert.equal(req!.remotePeer, payer.peerId.toString())
  assert.equal(wallet.actions.get(r.txid)!.status, 'nosend')
  const conn = payer.getConnections().find(c => c.remotePeer.toString() === p.peerId)!
  assert.match(conn.remoteAddr.toString(), new RegExp(`^/p2p/${server.peerId}/p2p-circuit/p2p/${p.peerId}$`))
  assert.notEqual(conn.limits, undefined, 'the payer sees a limited (relayed) connection')
  const relay = payer.getConnections().find(c => c.remotePeer.toString() === server.peerId)!
  assert.match(relay.remoteAddr.toString(), /\/udx/)
})

test('an invoice in parts is paid part by part', async () => {
  const p = await payee({ split: amount => [amount - 400, 400] })
  const r = await payLive({ payeePeerId: p.peerId, amountSats: 1000, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx] })
  const tx = p.payee.paid[0]!.tx
  assert.deepEqual(tx.outputs.slice(0, 2).map(o => o.satoshis), [600, 400])
  assert.equal(r.status, 'completed')
})

test('a payment_error is "no invoice", safe to pay another way', async () => {
  const p = await payee({ error: { error: 'No wallets available', code: 'walletNone' } })
  const wallet = new FakeWallet()
  await assert.rejects(payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), libp2p: payer, relays: [server.udx] }),
    (e: PaymentError) => e.code === 'no-invoice' && e.canPayAnotherWay && /walletNone/.test(e.message))
  assert.equal(wallet.calls.some(c => c.method === 'createAction'), false)
})

test('an invoice for mainnet is refused before paying', async () => {
  const p = await payee({ network: 'main' })
  await assert.rejects(payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx] }),
    (e: PaymentError) => e.code === 'network-mismatch' && e.canPayAnotherWay)
})

test('no answer to the request: no invoice, nothing built', async () => {
  const p = await payee({ silentOnRequest: true })
  await assert.rejects(payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx], timeouts: { readMs: 3000 } }),
    (e: PaymentError) => e.code === 'no-invoice' && e.stage === 'request' && e.canPayAnotherWay)
})

test('no status after the BEEF went out: the payee may hold it; the inputs stay reserved', async () => {
  const p = await payee({ silentOnBeef: true })
  const wallet = new FakeWallet()
  const e = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), libp2p: payer, relays: [server.udx], timeouts: { readMs: 3000 } }).catch(x => x)
  assert.equal(e.code, 'not-confirmed')
  assert.equal(e.stage, 'settle')
  assert.equal(e.canPayAnotherWay, false)
  assert.equal(wallet.actions.get(e.txid)!.status, 'nosend')
})

test('a payee that could not put the payment on the network has not been paid (spiffyvault-qzj)', async () => {
  for (const status of [
    { broadcasted: false, arcStatus: 'validated_only', networkStatus: 'REJECTED', broadcastError: 'double spend' },
    { broadcasted: false, arcStatus: 'validated_only' }
  ]) {
    const p = await payee({ status })
    const wallet = new FakeWallet()
    const e = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), libp2p: payer, relays: [server.udx] }).catch(x => x)
    assert.equal(e.code, 'not-confirmed')
    assert.equal(e.stage, 'settle')
    assert.equal(e.canPayAnotherWay, false)
  }
})

test('voo: an early status, then payment_network on the network: completed, and acknowledged', async () => {
  const p = await payee({ status: { broadcasted: true, arcStatus: 'broadcasting', networkStatus: 'RECEIVED', final: false },
    networkAnswer: { onNetwork: true, networkStatus: 'SEEN_ON_NETWORK' } })
  const steps: string[] = []
  const r = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' },
    { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx], onProgress: s => steps.push(s.step) })
  assert.equal(r.status, 'completed')
  assert.ok(steps.includes('network'))
  await waitFor(() => p.payee.acks.length === 1, 'the ack')
})

test('voo: an early status, then the network refuses it: network-refused at settle', async () => {
  const p = await payee({ status: { broadcasted: true, arcStatus: 'broadcasting', networkStatus: 'RECEIVED', final: false },
    networkAnswer: { onNetwork: false, networkStatus: 'REJECTED', error: 'double spend' } })
  const e = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' },
    { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx] }).catch(x => x)
  assert.equal(e.code, 'network-refused')
  assert.equal(e.stage, 'settle')
  assert.equal(e.canPayAnotherWay, false)
})

test('voo: an early status and no network answer in time: sent', async () => {
  const p = await payee({ status: { broadcasted: true, arcStatus: 'broadcasting', networkStatus: 'RECEIVED', final: false } })
  const r = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' },
    { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx], timeouts: { networkMs: 500 } })
  assert.equal(r.status, 'sent')
})

test('a payment ARC reports mined counts as made, broadcast or not', async () => {
  const p = await payee({ status: { broadcasted: false, arcStatus: 'validated_only', networkStatus: 'MINED' } })
  const r = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx] })
  assert.equal(r.status, 'completed')
  assert.equal(r.broadcasted, false)
})

test('a refusal keeps the inputs reserved and says so', async () => {
  const p = await payee({ refuse: 'BEEF validation failed' })
  const e = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx] }).catch(x => x)
  assert.equal(e.code, 'payee-refused')
  assert.equal(e.canPayAnotherWay, false)
})

test('a payment too large for one frame is aborted before it leaves', async () => {
  const p = await payee()
  const wallet = new FakeWallet({ unprovenDepth: 3 })
  const e = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), libp2p: payer, relays: [server.udx], maxFrameBytes: 600 }).catch(x => x)
  assert.equal(e.code, 'frame-too-large')
  assert.equal(e.canPayAnotherWay, true)
  assert.equal(e.aborted, true)
  assert.equal(wallet.actions.get(e.txid)!.status, 'aborted')
  assert.equal(p.payee.received.filter(x => x.type === 'beef_payment').length, 0)
})

test('too slow to build: the session window has passed, so abort', async () => {
  const p = await payee()
  const wallet = new FakeWallet()
  const slow = Object.assign(Object.create(wallet) as FakeWallet, {
    createAction: async (a: Parameters<WalletInterface['createAction']>[0]) => { await new Promise(resolve => setTimeout(resolve, 1200)); return await wallet.createAction(a) }
  }) as unknown as WalletInterface
  const e = await payLive({ payeePeerId: p.peerId, amountSats: 10, network: 'testnet' }, { wallet: slow, libp2p: payer, relays: [server.udx], timeouts: { sessionMs: 1500, marginMs: 1000 } }).catch(x => x)
  assert.equal(e.code, 'invoice-expired')
  assert.equal(e.aborted, true)
  assert.equal(wallet.actions.get(e.txid)!.status, 'aborted')
})

test('a payee with no reservation is unreachable, safe to pay another way', async () => {
  const { node } = await createPaymentNode({ udxOnly: true })
  const absent = node.peerId.toString()
  await node.stop()
  await assert.rejects(payLive({ payeePeerId: absent, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), libp2p: payer, relays: [server.udx], timeouts: { dialMs: 10_000 } }),
    (e: PaymentError) => e.code === 'payee-unreachable' && e.stage === 'connect' && e.canPayAnotherWay)
})
