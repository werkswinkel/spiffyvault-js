/**
 * The offline path against a local go-ricochet, from Node over UDX: a JS
 * stand-in payee publishes its anchor, bundle and one-time pre-keys as the
 * app does, the payer pays with payOffline (claiming one of them), and the
 * payee retrieves, decrypts and checks what the server holds.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import { RicochetClient, createRicochetNode } from '@go-ricochet/ricochet/node'
import type { Libp2p } from '@libp2p/interface'
import { createPaymentNode, payOffline, fetchBundle, PaymentError } from '../../src/node.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { collectOfflinePayment } from '../support/offline-payee.ts'
import { newPayeeIdentity, publishPayee } from './payee-publish.ts'
import { startServer } from './server.ts'
import type { TestServer } from './server.ts'

let server: TestServer
const nodes: Libp2p[] = []
before(async () => { server = await startServer() })
after(async () => {
  for (const n of nodes) await n.stop()
  await server?.stop()
})

async function payeeOnServer () {
  const id = await newPayeeIdentity()
  const { node } = await createRicochetNode({ privateKey: id.libp2pKey, udxOnly: true })
  nodes.push(node)
  return await publishPayee(node, id, { peerId: server.peerId, addr: server.udx })
}

async function payerClient () {
  const { node, privateKey } = await createPaymentNode({ udxOnly: true })
  nodes.push(node)
  return { ricochet: new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.udx] }] }), identityKey: privateKey }
}

test('Node over UDX: pay offline, then the payee collects it from its mailbox', async () => {
  const payee = await payeeOnServer()
  const payer = await payerClient()
  const { ricochet } = payer
  // Reading another peer's public bundle mailbox works from JS.
  const bundle = await fetchBundle(ricochet, payee.id.peerId, 'testnet')
  assert.equal(bundle.signedPreKeyId, 1)

  const wallet = new FakeWallet({ unprovenDepth: 1 })
  const r = await payOffline({ payeePeerId: payee.id.peerId, amountSats: 4321, note: 'Integration · ref ABCD2345', network: 'testnet' },
    { wallet: wallet as unknown as WalletInterface, ...payer })
  assert.equal(r.status, 'handed-off')

  const page = await payee.client.retrievePage({ folderPath: 'wallet/offline-payments' })
  const m = page.messages.find(x => x.messageId === r.messageId)
  assert.ok(m !== undefined, 'the payment is in the payee mailbox')
  assert.equal(m.senderPeerId, ricochet.peerId)
  assert.equal(m.priority, 2)
  assert.equal(m.persistent, true)
  assert.equal(m.flags, 0)
  const c = collectOfflinePayment(payee.id, payee.keys, payee.anchor, m)
  assert.equal(c.txid, r.txid)
  assert.equal(c.paidSats, 4321)
  assert.equal(c.message.description, 'Integration · ref ABCD2345')
  // It used the first one-time pre-key, which the server handed out once.
  assert.deepEqual([...payee.keys.oneTimePreKeys.keys()], [2, 3])
  const left = []
  for (let m2; (m2 = await ricochet.claimMessage(payee.id.peerId, 'signal/v2/one-time-keys')) !== null;) left.push(m2)
  assert.equal(left.length, 2)
  // the payee's clean-up, as the app does after an import
  await payee.client.markDelivered([m.messageId])
  await payee.client.deleteMessages([m.messageId])
})

test('Node over UDX: a payee with no anchor gets nothing, and nothing is built', async () => {
  const id = await newPayeeIdentity()
  const payer = await payerClient()
  const wallet = new FakeWallet()
  await assert.rejects(payOffline({ payeePeerId: id.peerId, amountSats: 10, network: 'testnet' }, { wallet: wallet as unknown as WalletInterface, ...payer }),
    (e: PaymentError) => e.code === 'anchor-missing')
  assert.equal(wallet.calls.some(c => c.method === 'createAction'), false)
})

test('Node over UDX: mainnet folders stay apart from testnet', async () => {
  const id = await newPayeeIdentity()
  const { node } = await createRicochetNode({ privateKey: id.libp2pKey, udxOnly: true })
  nodes.push(node)
  const payee = await publishPayee(node, id, { peerId: server.peerId, addr: server.udx }, 'mainnet')
  const payer = await payerClient()
  await assert.rejects(payOffline({ payeePeerId: id.peerId, amountSats: 10, network: 'testnet' }, { wallet: new FakeWallet() as unknown as WalletInterface, ...payer }),
    (e: PaymentError) => e.code === 'anchor-missing')
  const r = await payOffline({ payeePeerId: id.peerId, amountSats: 10, network: 'mainnet' }, { wallet: new FakeWallet({ network: 'mainnet' }) as unknown as WalletInterface, ...payer })
  const page = await payee.client.retrievePage({ folderPath: 'wallet/offline-payments/mainnet' })
  assert.equal(collectOfflinePayment(payee.id, payee.keys, payee.anchor, page.messages.find(x => x.messageId === r.messageId)!).txid, r.txid)
})
