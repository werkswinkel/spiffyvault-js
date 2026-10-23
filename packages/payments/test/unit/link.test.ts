/**
 * Payment links and keys, with the cases of the app's own tests
 * (test/services/payment_link_test.dart, payment_requests_test.dart).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_NOTE, addRefToNote, formatPaymentKey, formatPaymentLink, isPaymentLinkText, linkMismatch, noteToSend,
  parsePaymentKey, parsePaymentLink, paymentKeyMismatch, refInNote, refusesBareKey
} from '../../src/index.ts'

const KEY = '02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const PEER = '12D3KooWJfrcqqdoAcKUjAB6dGkC9KHCsTG5WKHZH8hk1wLs67it'

test('formats as an https link and parses back, on every network', () => {
  for (const network of ['mainnet', 'testnet', 'regtest'] as const) {
    const text = formatPaymentLink({ network, peerId: PEER, paymentKey: KEY, amountSats: 1, memo: 'Ünïcode ☕ note & more' })
    assert.match(text, /^https:\/\/spiffyvault\.net\/pay\?n=/)
    const back = parsePaymentLink(text)!
    assert.deepEqual(back, { network, peerId: PEER, paymentKey: KEY, amountSats: 1, memo: 'Ünïcode ☕ note & more' })
    assert.equal(linkMismatch(back, network), null)
  }
})

test('amount and note are optional; peer or key alone is enough', () => {
  assert.deepEqual(parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}`), { network: 'testnet', peerId: PEER })
  assert.deepEqual(parsePaymentLink(`https://spiffyvault.net/pay?n=mainnet&k=${KEY}`), { network: 'mainnet', paymentKey: KEY })
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=TEST&p=${PEER}`)!.network, 'testnet')
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=main&p=${PEER}`)!.network, 'mainnet')
})

test('reads the app scheme, www, a trailing slash, an upper-case host and key', () => {
  assert.notEqual(parsePaymentLink(`spiffyvault://pay?n=testnet&p=${PEER}`), null)
  assert.notEqual(parsePaymentLink(`https://www.spiffyvault.net/pay/?n=testnet&p=${PEER}`), null)
  assert.notEqual(parsePaymentLink(`HTTPS://SpiffyVault.net/pay?n=testnet&p=${PEER}`), null)
  assert.equal(parsePaymentLink(`  https://spiffyvault.net/pay?n=testnet&k=${KEY.toUpperCase()}  `)!.paymentKey, KEY)
})

test('refuses links that are not complete or not valid', () => {
  const bad = [
    `https://spiffyvault.net/pay?p=${PEER}`,
    `https://spiffyvault.net/pay?n=signet&p=${PEER}`,
    'https://spiffyvault.net/pay?n=testnet',
    'https://spiffyvault.net/pay?n=testnet&p=notapeer',
    `https://spiffyvault.net/pay?n=testnet&k=04${KEY.slice(2)}`,
    `https://spiffyvault.net/pay?n=testnet&k=testnet:${KEY}`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=0`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=1.5`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=-3`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=2100000000000001`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=99999999999999999999`,
    `https://example.com/pay?n=testnet&p=${PEER}`,
    `https://spiffyvault.net/privacy?n=testnet&p=${PEER}`,
    'spiffyvault://auth?c=abc',
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&w=../x`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&r=ABC`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&r=ABCDEFGI`,
    `https://spiffyvault.net/pay?n=testnet&p=${PEER}&m=%E0%A4`,
    KEY,
    'not a link'
  ]
  for (const text of bad) assert.equal(parsePaymentLink(text), null, text)
})

test('amounts as Dart int.tryParse reads them: a sign and 0x hex', () => {
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=%2B10`)!.amountSats, 10)
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=0x10`)!.amountSats, 16)
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}&a=2100000000000000`)!.amountSats, 2_100_000_000_000_000)
})

test('the last of a repeated key wins, + is a space, an empty value is none', () => {
  const l = parsePaymentLink(`https://spiffyvault.net/pay?n=mainnet&n=testnet&p=${PEER}&m=Coffee+and+cake&a=`)!
  assert.equal(l.network, 'testnet')
  assert.equal(l.memo, 'Coffee and cake')
  assert.equal(l.amountSats, undefined)
})

test('tells a broken payment link from a code that is not ours', () => {
  assert.equal(isPaymentLinkText('https://spiffyvault.net/pay?n=x'), true)
  assert.equal(isPaymentLinkText('spiffyvault://pay'), true)
  assert.equal(isPaymentLinkText('spiffyvault://auth?c=1'), false)
  assert.equal(isPaymentLinkText('bitcoin:mxyz'), false)
})

test('a link for the other network is refused, both ways', () => {
  const t = parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}`)!
  const m = linkMismatch(t, 'main')!
  assert.equal(m.code, 'network-mismatch')
  assert.equal(m.theirs, 'testnet')
  assert.equal(m.ours, 'mainnet')
  assert.equal(m.canPayAnotherWay, false)
  assert.equal(linkMismatch({ network: 'mainnet' }, 'test')!.theirs, 'mainnet')
  assert.equal(linkMismatch(t, 'testnet'), null)
  assert.equal(linkMismatch({ network: 'regtest' }, 'test')!.theirs, 'regtest')
})

test('a long note is cut to 100 runes and spaces are made plain', () => {
  const l = parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}&m=${encodeURIComponent(`  a\n\tb  ${'☕'.repeat(200)}`)}`)!
  assert.ok(l.memo!.startsWith('a b '))
  assert.equal(Array.from(l.memo!).length, 100)
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}&m=%20%20`)!.memo, undefined)
})

test('a wallet and its name travel together; a name without a wallet is dropped', () => {
  const l = parsePaymentLink(formatPaymentLink({ network: 'testnet', peerId: PEER, walletId: 'wallet_17-ab', walletLabel: ' Agent ' }))!
  assert.equal(l.walletId, 'wallet_17-ab')
  assert.equal(l.walletLabel, 'Agent')
  assert.equal(parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}&wl=ignored`)!.walletLabel, undefined)
})

test('a request reference parses upper-case, and the note carries it', () => {
  const l = parsePaymentLink(`https://spiffyvault.net/pay?n=testnet&p=${PEER}&r=abcd2345`)!
  assert.equal(l.requestRef, 'ABCD2345')
  assert.equal(noteToSend(l, ' Coffee '), 'Coffee · ref ABCD2345')
  assert.equal(noteToSend(l, ''), 'ref ABCD2345')
  assert.equal(noteToSend(l, undefined), 'ref ABCD2345')
  assert.equal(noteToSend({}, '  '), undefined)
  assert.equal(noteToSend({}, ' Tea '), 'Tea')
})

test('refs in notes: any case, word edges only, added once, cut to what the payee keeps', () => {
  assert.equal(refInNote('Coffee · ref abcd2345'), 'ABCD2345')
  assert.equal(refInNote('preref ABCD2345'), null)
  assert.equal(refInNote('ref ABCD23456'), null)
  assert.equal(refInNote(null), null)
  assert.equal(addRefToNote('Tea · ref ABCD2345', 'ABCD2345'), 'Tea · ref ABCD2345')
  const long = addRefToNote('x'.repeat(400), 'ABCD2345')
  assert.ok(Array.from(long).length <= MAX_NOTE)
  assert.equal(long, `${'x'.repeat(265)} · ref ABCD2345`)
  assert.equal(refInNote(long), 'ABCD2345')
  assert.equal(addRefToNote(`${'y'.repeat(264)}  z`, 'ABCD2345'), `${'y'.repeat(264)} · ref ABCD2345`)
})

test('payment keys outside links: testnet:/regtest: labels, bare keys, mismatch', () => {
  assert.deepEqual(parsePaymentKey(`testnet:${KEY}`), { key: KEY, network: 'test' })
  assert.deepEqual(parsePaymentKey(`  Regtest : ${KEY.toUpperCase()}`), { key: KEY, network: 'regtest' })
  assert.deepEqual(parsePaymentKey(`mainnet:${KEY}`), { key: KEY, network: 'main' })
  assert.deepEqual(parsePaymentKey(`pay me at ${KEY} please`), { key: KEY })
  assert.equal(parsePaymentKey('04' + KEY.slice(2)), null)
  assert.equal(formatPaymentKey(KEY, 'main'), KEY)
  assert.equal(formatPaymentKey(KEY, 'test'), `testnet:${KEY}`)
  assert.equal(formatPaymentKey(KEY, 'regtest'), `regtest:${KEY}`)
  assert.equal(paymentKeyMismatch(parsePaymentKey(`testnet:${KEY}`)!, 'mainnet')!.theirs, 'testnet')
  assert.equal(paymentKeyMismatch(parsePaymentKey(`testnet:${KEY}`)!, 'testnet'), null)
  assert.equal(paymentKeyMismatch(parsePaymentKey(KEY)!, 'mainnet'), null)
  assert.equal(refusesBareKey(parsePaymentKey(KEY)!, 'testnet'), true)
  assert.equal(refusesBareKey(parsePaymentKey(KEY)!, 'mainnet'), false)
  assert.equal(refusesBareKey(parsePaymentKey(KEY)!, 'regtest'), false)
  assert.equal(refusesBareKey(parsePaymentKey(`testnet:${KEY}`)!, 'testnet'), false)
})
