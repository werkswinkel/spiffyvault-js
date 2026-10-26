/**
 * fetchAnchor's path order and fallback (offline_payment_service.dart,
 * _fetchAnchor): a wallet's or a request's record that is refused gives way
 * to the next path.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PaymentError, anchorRecordJson, fetchAnchor } from '../../src/index.ts'
import { MemRicochet } from '../support/mem-ricochet.ts'
import { anchorKey, fill, identityFromSeed, signAnchorRecord } from '../support/payee.ts'

async function payee () {
  const id = await identityFromSeed(fill(4))
  const server = new MemRicochet(id.peerId)
  const put = (path: string, opts: { expiresAt?: number, signedPath?: string } = {}): string => {
    const r = signAnchorRecord(id, {
      anchorPublicKey: anchorKey().pub, epoch: 0, networkType: 'test', timestamp: Date.now(), path: opts.signedPath ?? path,
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {})
    })
    server.putDoc(id.peerId, path, anchorRecordJson(r))
    return r.anchorPublicKey
  }
  return { id, server, put, ricochet: server.as((await identityFromSeed(fill(5))).peerId) }
}

test('the wallet\'s record is used when it checks', async () => {
  const p = await payee()
  p.put('wallet/payment-anchor')
  const mine = p.put('wallet/payment-anchor/w/w1')
  const got = await fetchAnchor(p.ricochet, p.id.peerId, 'testnet', { walletId: 'w1' })
  assert.equal(got.path, 'wallet/payment-anchor/w/w1')
  assert.equal(got.record.anchorPublicKey, mine)
})

test('an expired wallet record gives way to the usual one', async () => {
  const p = await payee()
  const usual = p.put('wallet/payment-anchor')
  p.put('wallet/payment-anchor/w/w1', { expiresAt: Date.now() - 1 })
  const got = await fetchAnchor(p.ricochet, p.id.peerId, 'testnet', { walletId: 'w1' })
  assert.equal(got.path, 'wallet/payment-anchor')
  assert.equal(got.record.anchorPublicKey, usual)
})

test('a record served at another of the payee\'s paths is refused', async () => {
  const p = await payee()
  p.put('wallet/payment-anchor', { signedPath: 'wallet/payment-anchor/w/w1' })
  await assert.rejects(fetchAnchor(p.ricochet, p.id.peerId, 'testnet'),
    (e: unknown) => e instanceof PaymentError && e.code === 'anchor-invalid' && /read at/.test(e.message))
})

test('nothing published is anchor-missing', async () => {
  const p = await payee()
  await assert.rejects(fetchAnchor(p.ricochet, p.id.peerId, 'testnet'),
    (e: unknown) => e instanceof PaymentError && e.code === 'anchor-missing')
})
