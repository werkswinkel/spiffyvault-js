/**
 * Payment requests (createPaymentRequest) and the widget's pure parts: the
 * progress, the clock, the trust line and when a request has lapsed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPaymentRequest, linkSignatureValid, parsePaymentLink, refInNote, noteToSend } from '../../src/index.ts'
import type { PaymentRequest } from '../../src/index.ts'
import { englishPaymentLabels, lapsed, progressIndex, timeLeft, trustLine } from '../../src/widget.ts'
import { fill, identityFromSeed } from '../support/payee.ts'

const KEY = '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc'

test('a request has a signed live link and a key-only PeerPay link for the same amount and reference', async () => {
  const shop = await identityFromSeed(fill(7))
  const r = await createPaymentRequest(
    { network: 'testnet', peerId: shop.peerId, paymentKey: KEY, signer: shop.libp2pKey, domain: 'shop.example' },
    { id: '1042', amountSats: 37_000, memo: 'Order 1042', now: 1_000_000 }
  )
  assert.match(r.ref, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  assert.equal(r.expiresAt, 1_000_000 + 10 * 60_000)
  assert.equal(r.id, '1042')

  const live = parsePaymentLink(r.links.live!)!
  assert.equal(linkSignatureValid(live), true)
  assert.deepEqual([live.peerId, live.paymentKey, live.amountSats, live.memo, live.requestRef, live.domain],
    [shop.peerId, KEY, 37_000, 'Order 1042', r.ref, 'shop.example'])

  const peerpay = parsePaymentLink(r.links.peerpay!)!
  assert.deepEqual([peerpay.peerId, peerpay.paymentKey, peerpay.amountSats, peerpay.requestRef, peerpay.signature],
    [undefined, KEY, 37_000, r.ref, undefined])
  // What a payer sends carries the reference, so the payee can match it.
  assert.equal(refInNote(noteToSend(peerpay, 'Order 1042')), r.ref)
})

test('a request keeps a reference it is given, and a key-only payee gets only the PeerPay link', async () => {
  const r = await createPaymentRequest({ network: 'mainnet', paymentKey: KEY }, { id: 'a', amountSats: 500, ref: 'K7Q2M9XD', ttlMs: 1000, now: 0 })
  assert.equal(r.ref, 'K7Q2M9XD')
  assert.equal(r.expiresAt, 1000)
  assert.equal(r.links.live, undefined)
  assert.equal(parsePaymentLink(r.links.peerpay!)!.network, 'mainnet')
})

test('a live link is never left unsigned, and a payee needs a peer ID or a key', async () => {
  const shop = await identityFromSeed(fill(7))
  await assert.rejects(createPaymentRequest({ network: 'testnet', peerId: shop.peerId }, { id: 'a', amountSats: 1 }), /signed/)
  await assert.rejects(createPaymentRequest({ network: 'testnet' }, { id: 'a', amountSats: 1 }), /peer ID or a payment key/)
})

test('the progress list follows the step; mailbox and PeerPay sit where the live payment goes to the network', () => {
  assert.deepEqual(['shown', 'refused', 'expired', 'phone-connected', 'checking', 'on-the-way', 'in-mailbox', 'paid'].map(s => progressIndex(s as never)),
    [0, 0, 0, 1, 2, 3, 3, 5])
})

test('the clock counts down in m:ss and stops at the expiry', () => {
  assert.equal(timeLeft(10 * 60_000, 0), '10:00')
  assert.equal(timeLeft(61_001, 0), '1:02')
  assert.equal(timeLeft(1, 0), '0:01')
  assert.equal(timeLeft(5, 5), null)
})

test('a request lapses on the clock only while nothing is under way', () => {
  const r = { expiresAt: 100 } as PaymentRequest
  assert.equal(lapsed(r, 'shown', 101), true)
  assert.equal(lapsed(r, 'refused', 101), true)
  assert.equal(lapsed(r, 'shown', 100), false)
  assert.equal(lapsed(r, 'checking', 10_000), false)
  assert.equal(lapsed(r, 'in-mailbox', 10_000), false)
  assert.equal(lapsed(r, 'expired', 0), true)
})

test('the trust line says what the link proves', async () => {
  const shop = await identityFromSeed(fill(7))
  const signed = await createPaymentRequest({ network: 'testnet', peerId: shop.peerId, paymentKey: KEY, signer: shop.libp2pKey, domain: 'shop.example' }, { id: 'a', amountSats: 1 })
  const noDomain = await createPaymentRequest({ network: 'testnet', peerId: shop.peerId, signer: shop.libp2pKey }, { id: 'a', amountSats: 1 })
  const keyOnly = await createPaymentRequest({ network: 'testnet', paymentKey: KEY }, { id: 'a', amountSats: 1 })
  assert.equal(trustLine(signed, englishPaymentLabels), 'Payee listed by shop.example · link signed')
  assert.equal(trustLine(noDomain, englishPaymentLabels), 'Link signed by the payee')
  assert.equal(trustLine(keyOnly, englishPaymentLabels), 'Paying the payee\'s key by PeerPay')
})
