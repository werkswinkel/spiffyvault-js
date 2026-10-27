/**
 * Signed payment links, with the app's own cases and vector
 * (test/services/payment_link_signature_test.dart).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import {
  LinkChangedError, formatPaymentLink, linkSignatureValid, linkSignedText, parsePaymentLink, pay, signPaymentLink
} from '../../src/index.ts'
import type { PaymentLink } from '../../src/index.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { fill, identityFromSeed } from '../support/payee.ts'

/** The app's PaymentLink.signedBy for seed 07 × 32 (Ed25519 is deterministic). */
const DART_VECTOR = 'https://spiffyvault.net/pay?n=testnet&p=12D3KooWRawPbxPtP1eZaJpumGnyWX2DcUyd3RQnydr3eAto4Az7' +
  '&k=02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc&a=1000&m=Coffee&w=w1&wl=Till&d=shop.example' +
  '&s=3ODFLvnO0gN3-FGUePvZHyz_gINTyNVKgw3BjEvEQytnyvGU8fKggId-8CnqEy5TSnBuUDMW-3OFP911bwHRBQ'
const KEY = '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc'

test('the app\'s signed link checks, and the library signs it byte for byte the same', async () => {
  const parsed = parsePaymentLink(DART_VECTOR)!
  assert.equal(linkSignatureValid(parsed), true)
  const shop = await identityFromSeed(fill(7))
  const link: PaymentLink = { network: 'testnet', peerId: shop.peerId, paymentKey: KEY, amountSats: 1000, memo: 'Coffee', walletId: 'w1', walletLabel: 'Till', domain: 'shop.example' }
  assert.equal(formatPaymentLink(await signPaymentLink(link, shop.libp2pKey)), DART_VECTOR)
})

test('the signed text names every field in order, empty when absent', async () => {
  const shop = await identityFromSeed(fill(7))
  assert.equal(linkSignedText({ network: 'mainnet', peerId: shop.peerId }),
    `spiffyvault-link/1\nn=mainnet\np=${shop.peerId}\nk=\na=\nm=\nw=\nwl=\nr=\nd=`)
})

test('a changed amount, note, key, wallet or domain fails; respelling the same values does not', () => {
  for (const [from, to] of [['a=1000', 'a=100000'], ['m=Coffee', 'm=Tea'], [KEY, KEY.replace('02', '03')], ['w=w1', 'w=w2'], ['d=shop.example', 'd=evil.example']] as const) {
    assert.equal(linkSignatureValid(parsePaymentLink(DART_VECTOR.replace(from, to))!), false, `${from} -> ${to}`)
  }
  assert.equal(linkSignatureValid(parsePaymentLink(`${DART_VECTOR.replace('&a=1000', '')}`)!), false)
  assert.equal(linkSignatureValid(parsePaymentLink(DART_VECTOR.replace('n=testnet', 'n=TEST').replace(KEY, KEY.toUpperCase()))!), true)
})

test('a signature without a peer ID, or not 64 bytes, makes the link broken', () => {
  const s = parsePaymentLink(DART_VECTOR)!.signature!
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&k=${KEY}&s=${s}`), null)
  assert.equal(parsePaymentLink(DART_VECTOR.replace(`s=${s}`, `s=${s.slice(1)}`)), null)
  assert.throws(() => formatPaymentLink({ network: 'testnet', paymentKey: KEY, signature: s }))
})

test('only the payee\'s own key signs its link', async () => {
  const shop = await identityFromSeed(fill(7))
  const other = await identityFromSeed(fill(9))
  await assert.rejects(signPaymentLink({ network: 'testnet', peerId: shop.peerId }, other.libp2pKey), /peer ID/)
  await assert.rejects(signPaymentLink({ network: 'testnet', paymentKey: KEY }, shop.libp2pKey), /peer ID/)
})

test('pay() refuses a changed signed link before asking anyone', async () => {
  let dialled = false
  await assert.rejects(pay({ link: DART_VECTOR.replace('a=1000', 'a=100000') }, {
    wallet: new FakeWallet() as unknown as WalletInterface,
    libp2p: { dial: async () => { dialled = true; throw new Error('no route') }, getConnections: () => [] }
  }), (e: unknown) => e instanceof LinkChangedError && e.code === 'link-changed' && !e.canPayAnotherWay)
  assert.equal(dialled, false)
})

test('a note with control characters and loose spaces is signed as a payer reads it', async () => {
  const shop = await identityFromSeed(fill(7))
  const signed = await signPaymentLink({ network: 'testnet', peerId: shop.peerId, memo: ' Cof\u0085fee\u0001  to go ', walletId: 'till', walletLabel: 'Front\u007f desk' }, shop.libp2pKey)
  assert.equal(signed.memo, 'Coffee to go')
  assert.equal(signed.walletLabel, 'Front desk')
  assert.equal(linkSignatureValid(parsePaymentLink(formatPaymentLink(signed))!), true)
})
