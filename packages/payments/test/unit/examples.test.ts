/** Runs the README examples that need no network (examples/parts.ts). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { formatPaymentLink } from '../../src/index.ts'
import { anchorRecordJson } from '../../src/internal.ts'
// The examples import the built package, so errors must come from it too.
import { PaymentError } from '@spiffyvault/payments'
import { fundWithFunder } from '@spiffyvault/payments/internal'
import { handle, makeFunder, payeeLine, perPath, readLink, shopFile, signedLink } from '../../examples/parts.ts'
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
