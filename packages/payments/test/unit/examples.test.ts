/** Runs the README examples that need no network (examples/parts.ts). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { formatPaymentLink } from '../../src/index.ts'
import { anchorRecordJson } from '../../src/internal.ts'
// The examples import the built package, so errors must come from it too.
import { PaymentError } from '@spiffyvault/payments'
import { fundWithFunder } from '@spiffyvault/payments/internal'
import { handle, makeFunder, payeeLine, perPath, readLink, shopFile, signedLink } from '../../examples/parts.ts'
import { orderPaid, paymentFor, screenOrder, statusOf } from '../../examples/widget.ts'
import { startOfflinePayee } from '../../examples/offline-payee.ts'
import { startPeerPayPayee } from '../../examples/peerpay-payee.ts'
import { payOffline, payViaPeerPay } from '../../src/index.ts'
import type { OfflinePayeeState } from '../../src/index.ts'
import type { Order, Orders } from '../../examples/widget.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { MemRicochet } from '../support/mem-ricochet.ts'
import { anchorKey, fill, identityFromSeed, publishSessionKeys, signAnchorRecord } from '../support/payee.ts'
import { randomBytes } from '../support/internals.ts'

test('README: reading a link', async () => {
  const id = await identityFromSeed(fill(3))
  const r = readLink(formatPaymentLink({ network: 'testnet', peerId: id.peerId, requestRef: 'ABCD2345', memo: 'Tea' }))
  assert.deepEqual(r, { network: 'testnet', peerId: id.peerId, note: 'Tea · ref ABCD2345', wrongNetwork: true })
  assert.equal(readLink('https://example.com'), null)
})

test('README: per-path calls', async () => {
  const id = await identityFromSeed(randomBytes(32))
  const server = new MemRicochet(id.peerId)
  server.putDoc(id.peerId, 'wallet/payment-anchor', anchorRecordJson(signAnchorRecord(id, { anchorPublicKey: anchorKey().pub, epoch: 0, networkType: 'test', timestamp: 1, path: 'wallet/payment-anchor' })))
  await publishSessionKeys(server.as(id.peerId), id, { signedPreKeyId: 1, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map() })
  const sent: string[] = []
  const payer = await identityFromSeed(fill(4))
  const out = await perPath(new FakeWallet({ coins: [10_000, 10_000] }) as unknown as WalletInterface, server.as(payer.peerId), payer.seed, id.peerId,
    PrivateKey.fromRandom().toPublicKey().toString(), { sendMessage: async m => { sent.push(m.body); return {} } })
  assert.deepEqual(out, ['handed-off', 'delivered'])
  assert.equal(sent.length, 1)
})

test('README: a funder and error handling', async () => {
  let released = 0
  const funder = makeFunder(async () => new Uint8Array([9, 9, 9]), async () => { released++ })
  const r = await handle(async () => await fundWithFunder(funder, [{ lockingScript: '76a914' + '00'.repeat(20) + '88ac', satoshis: 1 }], { path: 'live', broadcast: false }))
  assert.match(r, /safe to try again or another way \(beef-unusable\)/)
  assert.equal(released, 1)
  assert.match(await handle(async () => { throw new PaymentError('not-confirmed', 'x', { stage: 'settle', canPayAnotherWay: false, txid: 'ab' }) }), /do not pay again: not-confirmed ab/)
})

test('the domain example: a shop file the check accepts, and a changed link it refuses', async () => {
  const { identityFromSeed, fill } = await import('../support/payee.ts')
  const shop = await identityFromSeed(fill(7))
  const key = '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc'
  const file = new TextEncoder().encode(await shopFile(shop.libp2pKey, shop.peerId, key))
  const serve = async (): Promise<Uint8Array> => file
  assert.equal(await payeeLine({ network: 'mainnet', peerId: shop.peerId, paymentKey: key, domain: 'shop.example' }, serve), 'Corner Shop · verified for shop.example')
  const stranger = (await identityFromSeed(fill(8))).peerId
  assert.equal(await payeeLine({ network: 'mainnet', peerId: stranger, domain: 'shop.example' }, serve), null)
})

test('the signed link example', async () => {
  const { identityFromSeed, fill } = await import('../support/payee.ts')
  const shop = await identityFromSeed(fill(7))
  const { text, valid } = await signedLink(shop.libp2pKey, shop.peerId)
  assert.equal(valid, true)
  assert.match(text, /&s=[A-Za-z0-9_-]{86}$/)
})

test('README: a payment request for an order, and its status', async () => {
  const id = await identityFromSeed(fill(9))
  const key = PrivateKey.fromRandom().toPublicKey().toString()
  const order: Order = { id: '1042', totalSats: 37_000 }
  const request = await paymentFor(order, { peerId: id.peerId, paymentKey: key, privateKey: id.libp2pKey })
  assert.equal(request.id, '1042')
  assert.equal(request.amountSats, 37_000)
  assert.ok(request.links.live !== undefined && request.links.peerpay !== undefined)
  assert.deepEqual(statusOf(order), { id: '1042', step: 'shown' })
  assert.deepEqual(statusOf({ ...order, paidTxid: 'ab' }), { id: '1042', step: 'paid', path: 'live', txid: 'ab' })
})

test('README: matching requests and payments to orders', () => {
  const order: Order = { id: '1042', totalSats: 37_000, ref: 'K7Q2M9XD' }
  const orders: Orders = new Map([['K7Q2M9XD', order]])
  const ask = (amountSats: number, note?: string) => ({ invoiceId: 'i', amountSats, payerPeerId: 'p', ...(note !== undefined ? { note } : {}) })
  assert.equal(screenOrder(orders, ask(37_000, 'Order 1042 ref K7Q2M9XD')), undefined)
  assert.ok(screenOrder(orders, ask(1, 'ref K7Q2M9XD')) !== undefined, 'a request for less than the order is refused')
  assert.ok(screenOrder(orders, ask(37_000)) !== undefined, 'a request without a ref is refused')
  assert.ok(screenOrder(orders, ask(37_000, 'ref AAAAAAAA')) !== undefined, 'an unknown ref is refused')

  assert.equal(orderPaid(orders, { txid: 'aa', note: 'ref K7Q2M9XD', paidSats: 1 }), false, 'too little')
  assert.equal(order.paidTxid, undefined)
  assert.equal(orderPaid(orders, { txid: 'bb', note: 'ref K7Q2M9XD', paidSats: 37_000 }), true)
  assert.equal(orderPaid(orders, { txid: 'bb', note: 'ref K7Q2M9XD', paidSats: 37_000 }), true, 'the same payment twice')
  assert.equal(orderPaid(orders, { txid: 'cc', note: 'ref K7Q2M9XD', paidSats: 37_000 }), false, 'a second payment')
  assert.equal(order.paidTxid, 'bb')
  assert.ok(screenOrder(orders, ask(37_000, 'ref K7Q2M9XD')) !== undefined, 'a paid order is refused')
})

test('README: being paid offline, the payment taken into the wallet as a BRC-29 payment', async () => {
  const shop = await identityFromSeed(randomBytes(32))
  const server = new MemRicochet(shop.peerId)
  const root = PrivateKey.fromRandom()
  const taken: unknown[] = []
  const wallet = Object.assign(new ProtoWallet(root), { internalizeAction: async (args: unknown) => { taken.push(args); return { accepted: true } } }) as unknown as WalletInterface
  let saved: OfflinePayeeState | null = null
  const payee = await startOfflinePayee(server, shop.libp2pKey, wallet, { load: async () => saved, save: async s => { saved = s } },
    { chainTracker: { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 }, broadcaster: async () => ({ accepted: true }) })
  const payer = await identityFromSeed(fill(9))
  const r = await payOffline({ payeePeerId: shop.peerId, amountSats: 1200, network: 'testnet' },
    { wallet: new FakeWallet() as unknown as WalletInterface, ricochet: server.as(payer.peerId), identityKey: payer.seed })
  await payee.collectNow()
  payee.stop()
  assert.equal(taken.length, 1)
  const args = taken[0] as { outputs: Array<{ protocol: string }>, tx: number[] }
  assert.equal(args.outputs[0]!.protocol, 'wallet payment')
  assert.equal(Transaction.fromAtomicBEEF(args.tx).id('hex'), r.txid)
})

test('README: being paid by PeerPay, the payment taken into the wallet as a BRC-29 payment', async () => {
  const root = PrivateKey.fromRandom()
  const taken: unknown[] = []
  const wallet = Object.assign(new ProtoWallet(root), { internalizeAction: async (args: unknown) => { taken.push(args); return { accepted: true } } }) as unknown as WalletInterface
  const payer = new FakeWallet()
  const messages: Array<{ messageId: string, sender: string, body: unknown }> = []
  const client = {
    listMessagesLite: async () => messages.slice(),
    acknowledgeMessage: async ({ messageIds }: { messageIds: string[] }) => { messages.splice(0, messages.length, ...messages.filter(m => !messageIds.includes(m.messageId))) }
  }
  const sender = (await payer.getPublicKey({ identityKey: true })).publicKey
  const r = await payViaPeerPay({ paymentKey: root.toPublicKey().toString(), amountSats: 1500 }, {
    wallet: payer as unknown as WalletInterface,
    client: { sendMessage: async m => { messages.push({ messageId: 'm1', sender, body: JSON.parse(m.body) }); return {} } }
  })
  const payee = await startPeerPayPayee(wallet, {
    client, chainTracker: { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 }, broadcaster: async () => ({ accepted: true })
  })
  await payee.collectNow()
  payee.stop()
  assert.equal(taken.length, 1)
  const args = taken[0] as { outputs: Array<{ protocol: string, paymentRemittance: { senderIdentityKey: string } }>, tx: number[] }
  assert.equal(args.outputs[0]!.protocol, 'wallet payment')
  assert.equal(args.outputs[0]!.paymentRemittance.senderIdentityKey, sender)
  assert.equal(Transaction.fromAtomicBEEF(args.tx).id('hex'), r.txid)
  assert.equal(messages.length, 0)
})
