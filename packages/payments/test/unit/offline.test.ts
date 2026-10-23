import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import { PaymentError, anchorRecordJson, payOffline, prekeyBundleJson } from '../../src/index.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { MemRicochet } from '../support/mem-ricochet.ts'
import { anchorKey, fill, identityFromSeed, signAnchorRecord, signBundle } from '../support/payee.ts'
import type { PayeeIdentity, PayeePrekeys } from '../support/payee.ts'
import { collectOfflinePayment } from '../support/offline-payee.ts'
import { randomBytes } from '../support/internals.ts'

const asWallet = (w: FakeWallet): WalletInterface => w as unknown as WalletInterface

async function world (opts: { network?: 'test' | 'main', anchorPath?: string, bundle?: boolean } = {}) {
  const id: PayeeIdentity = await identityFromSeed(randomBytes(32))
  const keys: PayeePrekeys = { registrationId: 42, signedPreKeyId: 1, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map([[3, randomBytes(32)], [4, randomBytes(32)]]) }
  const anchor = anchorKey()
  const server = new MemRicochet(id.peerId)
  const networkType = opts.network ?? 'test'
  const suffix = networkType === 'main' ? '/mainnet' : ''
  server.putDoc(id.peerId, opts.anchorPath ?? `wallet/payment-anchor${suffix}`,
    anchorRecordJson(signAnchorRecord(id, { anchorPublicKey: anchor.pub, epoch: 0, networkType, timestamp: Date.now() })))
  if (opts.bundle !== false) {
    // two bundles; the last one counts
    await server.sendMessage(id.peerId, prekeyBundleJson(signBundle(id, { ...keys, signedPreKeyPrivate: randomBytes(32) }, Date.now() + 1000)), { folderPath: `signal/prekeys${suffix}`, persistent: true })
    await server.sendMessage(id.peerId, prekeyBundleJson(signBundle(id, keys, Date.now())), { folderPath: `signal/prekeys${suffix}`, persistent: true })
  }
  const payerPeerId = (await identityFromSeed(fill(9))).peerId
  return { id, keys, anchor, server, payer: server.as(payerPeerId), payerPeerId }
}

test('seals a payment the payee can collect, into wallet/offline-payments, priority 2, persistent', async () => {
  const w = await world()
  const wallet = new FakeWallet()
  const steps: string[] = []
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 2500, note: 'Coffee', network: 'testnet' },
    { wallet: asWallet(wallet), ricochet: w.payer, onProgress: p => steps.push(p.step) })
  assert.equal(r.status, 'handed-off')
  assert.deepEqual(steps, ['anchor', 'prekeys', 'derive', 'fund', 'seal', 'submit'])
  const m = w.server.mail.find(x => x.folderPath === 'wallet/offline-payments')!
  assert.equal(m.recipientPeerId, w.id.peerId)
  assert.equal(m.senderPeerId, w.payerPeerId)
  assert.equal(m.priority, 2)
  assert.equal(m.persistent, true)
  assert.equal(m.flags, 0)
  const c = collectOfflinePayment(w.id, w.keys, w.anchor.priv, m)
  assert.equal(c.txid, r.txid)
  assert.equal(c.paidSats, 2500)
  assert.equal(c.message.amountSats, 2500)
  assert.equal(c.message.description, 'Coffee')
  assert.equal(c.message.paymentId, r.paymentId)
  assert.equal(c.message.version, 2)
  assert.equal(wallet.actions.get(r.txid)!.status, 'nosend')
})

test('mainnet uses the /mainnet anchor, prekeys and payment folder', async () => {
  const w = await world({ network: 'main' })
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'mainnet' }, { wallet: asWallet(new FakeWallet({ network: 'mainnet' })), ricochet: w.payer })
  const m = w.server.mail.find(x => x.folderPath === 'wallet/offline-payments/mainnet')!
  assert.equal(collectOfflinePayment(w.id, w.keys, w.anchor.priv, m).txid, r.txid)
  assert.equal(w.server.mail.some(x => x.folderPath === 'wallet/offline-payments'), false)
})

test('a testnet payer refuses a mainnet anchor', async () => {
  const w = await world({ network: 'main', anchorPath: 'wallet/payment-anchor' })
  await assert.rejects(payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), ricochet: w.payer }),
    (e: PaymentError) => e.code === 'anchor-other-network' && e.canPayAnotherWay)
})

test('the request anchor (from ref in the note) and the wallet anchor come first, with fallback to the usual one', async () => {
  const w = await world({ anchorPath: 'wallet/payment-anchor/r/ABCD2345' })
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, note: 'Tea · ref ABCD2345', walletId: 'w1', network: 'testnet' },
    { wallet: asWallet(new FakeWallet()), ricochet: w.payer })
  assert.equal(r.status, 'handed-off')
  const w2 = await world({ anchorPath: 'wallet/payment-anchor/w/w1' })
  await payOffline({ payeePeerId: w2.id.peerId, amountSats: 10, walletId: 'w1', network: 'testnet' }, { wallet: asWallet(new FakeWallet()), ricochet: w2.payer })
  const w3 = await world()
  await payOffline({ payeePeerId: w3.id.peerId, amountSats: 10, walletId: 'nope', note: 'ref ZZZZ2345', network: 'testnet' }, { wallet: asWallet(new FakeWallet()), ricochet: w3.payer })
})

test('no anchor, no prekeys: nothing is built', async () => {
  const w = await world({ anchorPath: 'elsewhere' })
  const wallet = new FakeWallet()
  await assert.rejects(payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ricochet: w.payer }),
    (e: PaymentError) => e.code === 'anchor-missing' && e.canPayAnotherWay)
  const w2 = await world({ bundle: false })
  await assert.rejects(payOffline({ payeePeerId: w2.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ricochet: w2.payer }),
    (e: PaymentError) => e.code === 'prekeys-missing')
  assert.equal(wallet.calls.some(c => c.method === 'createAction'), false)
})

test('a refused submission aborts the wallet action', async () => {
  const w = await world()
  w.server.refuse = { status: 507, message: 'mailbox full' }
  const wallet = new FakeWallet()
  const e = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ricochet: w.payer }).catch(x => x)
  assert.ok(e instanceof PaymentError)
  assert.equal(e.code, 'mailbox-refused')
  assert.equal(e.aborted, true)
  assert.equal(e.canPayAnotherWay, true)
  assert.equal(wallet.actions.get(e.txid!)!.status, 'aborted')
})

test('a submission whose answer was lost keeps the inputs reserved', async () => {
  const w = await world()
  w.server.throwOnSend = new Error('stream reset')
  const wallet = new FakeWallet()
  const e = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ricochet: w.payer }).catch(x => x)
  assert.equal(e.code, 'delivery-unknown')
  assert.equal(e.canPayAnotherWay, false)
  assert.equal(wallet.actions.get(e.txid!)!.status, 'nosend')
})
