/** pay(): path choice and the checks before it, with in-memory stand-ins. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { NetworkMismatchError, PaymentError, anchorRecordJson, formatPaymentLink, pay, planPayment, prekeyBundleJson } from '../../src/index.ts'
import type { MessageBoxSender, PayContext } from '../../src/index.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { MemRicochet } from '../support/mem-ricochet.ts'
import { collectOfflinePayment } from '../support/offline-payee.ts'
import { anchorKey, fill, identityFromSeed, signAnchorRecord, signBundle } from '../support/payee.ts'
import { randomBytes } from '../support/internals.ts'

const asWallet = (w: FakeWallet): WalletInterface => w as unknown as WalletInterface
const unreachable: NonNullable<PayContext['libp2p']> = { dial: async () => { throw new Error('no route to peer') }, getConnections: () => [] }

class Box implements MessageBoxSender {
  sent: string[] = []
  async sendMessage (m: { body: string }): Promise<unknown> { this.sent.push(m.body); return { messageId: 'id' } }
}

async function payee (anchorPath = 'wallet/payment-anchor') {
  const id = await identityFromSeed(randomBytes(32))
  const keys = { registrationId: 1, signedPreKeyId: 1, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map([[5, randomBytes(32)]]) }
  const anchor = anchorKey()
  const server = new MemRicochet(id.peerId)
  server.putDoc(id.peerId, anchorPath, anchorRecordJson(signAnchorRecord(id, { anchorPublicKey: anchor.pub, epoch: 0, networkType: 'test', timestamp: 1 })))
  await server.sendMessage(id.peerId, prekeyBundleJson(signBundle(id, keys, 1)), { folderPath: 'signal/prekeys' })
  const ricochet = server.as((await identityFromSeed(fill(1))).peerId)
  return { id, keys, anchor, server, ricochet, key: PrivateKey.fromRandom().toPublicKey().toString() }
}

test('peer ID first: live unreachable, so offline; the attempt is reported', async () => {
  const p = await payee()
  const link = formatPaymentLink({ network: 'testnet', peerId: p.id.peerId, paymentKey: p.key, amountSats: 1500, memo: 'Lunch' })
  const steps: string[] = []
  const r = await pay({ link }, { wallet: asWallet(new FakeWallet()), libp2p: unreachable, ricochet: p.ricochet, onProgress: s => steps.push(`${s.path}:${s.step}`) })
  assert.equal(r.path, 'offline')
  assert.equal(r.note, 'Lunch')
  assert.equal(r.attempts.length, 1)
  assert.equal(r.attempts[0]!.code, 'payee-unreachable')
  assert.ok(steps.includes('offline:fallback'))
  const m = p.server.mail.find(x => x.folderPath === 'wallet/offline-payments')!
  assert.equal(collectOfflinePayment(p.id, p.keys, p.anchor.priv, m).paidSats, 1500)
})

test('a request link: the note carries the ref and the offline anchor is the request\'s', async () => {
  const p = await payee('wallet/payment-anchor/r/ABCD2345')
  const r = await pay({ link: formatPaymentLink({ network: 'testnet', peerId: p.id.peerId, requestRef: 'ABCD2345' }), amountSats: 10, note: 'Tea' },
    { wallet: asWallet(new FakeWallet()), ricochet: p.ricochet })
  assert.equal(r.note, 'Tea · ref ABCD2345')
})

test('only a key: PeerPay, to the default host unless one is given', async () => {
  const box = new Box()
  const key = PrivateKey.fromRandom().toPublicKey().toString()
  const r = await pay({ link: `https://spiffyvault.net/pay?n=testnet&k=${key}&a=99` }, { wallet: asWallet(new FakeWallet()), peerPay: { client: box } })
  assert.equal(r.path, 'peerpay')
  assert.equal(JSON.parse(box.sent[0]!).amount, 99)
})

test('PeerPay after live and offline failed only when allowed', async () => {
  const id = await identityFromSeed(randomBytes(32))
  const empty = new MemRicochet('x').as((await identityFromSeed(fill(2))).peerId)
  const key = PrivateKey.fromRandom().toPublicKey().toString()
  const link = formatPaymentLink({ network: 'testnet', peerId: id.peerId, paymentKey: key, amountSats: 5 })
  const e = await pay({ link }, { wallet: asWallet(new FakeWallet()), libp2p: unreachable, ricochet: empty, peerPay: { client: new Box() } }).catch(x => x)
  assert.ok(e instanceof PaymentError)
  assert.equal(e.code, 'anchor-missing')
  assert.deepEqual(e.attempts.map(a => a.code), ['payee-unreachable'])
  const box = new Box()
  const r = await pay({ link }, { wallet: asWallet(new FakeWallet()), libp2p: unreachable, ricochet: empty, peerPay: { client: box, fallback: true } })
  assert.equal(r.path, 'peerpay')
  assert.deepEqual(r.attempts.map(a => a.code), ['payee-unreachable', 'anchor-missing'])
})

test('a failure that is not safe stops the fallback', async () => {
  const p = await payee()
  // funding fails on the offline path: no PeerPay even when allowed
  const e = await pay({ link: formatPaymentLink({ network: 'testnet', peerId: p.id.peerId, paymentKey: p.key, amountSats: 5 }) },
    { wallet: asWallet(new FakeWallet({ failCreate: 'Insufficient funds' })), ricochet: p.ricochet, peerPay: { client: new Box(), fallback: true } }).catch(x => x)
  assert.equal(e.code, 'funding-failed')
  assert.equal(e.path, 'offline')
})

test('network checks: a link for the other network, and payment keys outside links', async () => {
  const key = PrivateKey.fromRandom().toPublicKey().toString()
  await assert.rejects(pay({ link: `https://spiffyvault.net/pay?n=mainnet&k=${key}&a=1` }, { wallet: asWallet(new FakeWallet()) }),
    (e: unknown) => e instanceof NetworkMismatchError && e.theirs === 'mainnet' && e.ours === 'testnet')
  await assert.rejects(planPayment({ paymentKey: key, network: 'testnet', amountSats: 1 }, { wallet: asWallet(new FakeWallet()) }),
    (e: PaymentError) => e.code === 'bare-key')
  assert.equal((await planPayment({ paymentKey: key, network: 'testnet', amountSats: 1 }, { wallet: asWallet(new FakeWallet()), allowBareKey: true })).paymentKey, key)
  assert.equal((await planPayment({ paymentKey: `testnet:${key}`, network: 'testnet', amountSats: 1 }, { network: 'testnet' })).paymentKey, key)
  await assert.rejects(planPayment({ paymentKey: `testnet:${key}`, network: 'mainnet', amountSats: 1 }, { network: 'mainnet' }),
    (e: unknown) => e instanceof NetworkMismatchError)
  assert.equal((await planPayment({ paymentKey: key, network: 'mainnet', amountSats: 1 }, { network: 'mainnet' })).paymentKey, key)
  await assert.rejects(planPayment({ link: 'https://spiffyvault.net/pay?n=testnet' }, { network: 'testnet' }), (e: PaymentError) => e.code === 'bad-link')
})

test('the link amount wins; a different one is refused; none at all is refused', async () => {
  const key = PrivateKey.fromRandom().toPublicKey().toString()
  const link = `https://spiffyvault.net/pay?n=testnet&k=${key}&a=50`
  assert.equal((await planPayment({ link }, { network: 'testnet' })).amountSats, 50)
  assert.equal((await planPayment({ link, amountSats: 50 }, { network: 'testnet' })).amountSats, 50)
  await assert.rejects(planPayment({ link, amountSats: 51 }, { network: 'testnet' }), (e: PaymentError) => e.code === 'amount-invalid')
  await assert.rejects(planPayment({ link: `https://spiffyvault.net/pay?n=testnet&k=${key}` }, { network: 'testnet' }), (e: PaymentError) => e.code === 'amount-invalid')
})

test('no route: a peer ID with neither node nor Ricochet client', async () => {
  const id = await identityFromSeed(randomBytes(32))
  await assert.rejects(pay({ peerId: id.peerId, network: 'testnet', amountSats: 1 }, { wallet: asWallet(new FakeWallet()) }), (e: PaymentError) => e.code === 'no-route')
})
