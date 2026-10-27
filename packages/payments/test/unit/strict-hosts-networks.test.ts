/**
 * Findings 6 and 9 of the 2026-10-25 assessment, as the app has them: a
 * link's domain cannot make anyone reach a private network, and a network
 * name that is not one is refused rather than read as testnet.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import {
  PaymentError, assertNetwork, canonicalNetwork, checkPayeeDomain, isPrivateAddress, isPrivateDomainName, nodeDomainFetch,
  parseNetwork, PrivateHostError, planPayment
} from '../../src/node.ts'
import { checkInvoice } from '../../src/internal.ts'
import { FakeWallet } from '../support/fake-wallet.ts'

const PEER = '12D3KooWB8qZaSUhyN7xY9fEafpCfrpPsknzGzsLrKgHbcjrpCgT'

test('private names are refused before anything is fetched', async () => {
  for (const d of ['localhost', 'printer.local', 'vault.corp.internal', 'nas.home.arpa', 'router.lan', 'box.home', 'git.corp', 'wiki.intranet']) {
    let fetched = false
    const r = await checkPayeeDomain({ domain: d, peerId: PEER, network: 'testnet', fetch: async () => { fetched = true; return null } })
    assert.equal(fetched, false, d)
    assert.equal(r.verified, false)
    assert.equal(!r.verified && r.problem, d === 'localhost' ? 'bad-file' : 'unreachable', d) // one label is not a domain at all
  }
  assert.equal(isPrivateDomainName('shop.example'), false)
  assert.equal(isPrivateDomainName('local.shop.example'), false)
})

test("private, loopback, link-local and shared addresses are refused; public ones are not (the app's table)", () => {
  for (const a of ['10.1.2.3', '127.0.0.1', '0.0.0.0', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '::1', '::', 'fe80::1', 'fd12:3456::1', '::ffff:192.168.1.1', '::ffff:10.0.0.1', '::ffff:c0a8:101', 'fe80::1%en0', 'not an address']) {
    assert.equal(isPrivateAddress(a), true, a)
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '104.21.1.1', '2606:4700::1', '::ffff:8.8.8.8', '2001:db8:0:0:0:0:0:1']) {
    assert.equal(isPrivateAddress(a), false, a)
  }
})

test('on Node.js, a name that looks up to a private address is not connected to', async () => {
  await assert.rejects(nodeDomainFetch('https://localhost/.well-known/spiffyvault.json', AbortSignal.timeout(5000)), PrivateHostError)
})

test('network names: the documented spellings, nothing else', () => {
  for (const [text, n] of [['mainnet', 'mainnet'], ['Main', 'mainnet'], [' livenet ', 'mainnet'], ['TESTNET', 'testnet'], ['test', 'testnet'], ['regtest', 'regtest']] as const) {
    assert.equal(canonicalNetwork(text), n)
    assert.equal(parseNetwork(text), n)
  }
  for (const bad of ['mainet', 'testnett', '', 'bitcoin', 'main net']) {
    assert.equal(parseNetwork(bad), null, bad)
    assert.throws(() => canonicalNetwork(bad), TypeError, bad)
  }
  assert.equal(parseNetwork(undefined), null)
  assert.throws(() => assertNetwork('main' as never), TypeError)
  assert.equal(assertNetwork('regtest'), 'regtest')
})

test('a payer network spelled wrong is refused, not paid as testnet', async () => {
  await assert.rejects(planPayment({ peerId: PEER, network: 'testnet', amountSats: 10 }, { network: 'mainet' as never }), // a plain JavaScript caller
    (e: PaymentError) => e.code === 'no-route' && /mainet/.test(e.message))
  await assert.rejects(planPayment({ peerId: PEER, network: 'testnett', amountSats: 10 }, { network: 'testnet' }),
    (e: PaymentError) => e.code === 'no-route' && /testnett/.test(e.message))
  const odd = Object.assign(new FakeWallet(), { getNetwork: async () => ({ network: 'livenet' }) })
  await assert.rejects(planPayment({ peerId: PEER, network: 'testnet', amountSats: 10 }, { wallet: odd as unknown as WalletInterface }),
    (e: PaymentError) => e.code === 'no-route')
})

test('an invoice naming no known network is a bad invoice', () => {
  const invoice = { invoiceId: 'i', addresses: ['mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'], amount: '10', network: 'mainet' }
  assert.throws(() => checkInvoice(invoice, 10, 'testnet'), (e: PaymentError) => e.code === 'bad-invoice' && /mainet/.test(e.message))
  assert.throws(() => checkInvoice({ ...invoice, network: 'main' }, 10, 'testnet'), (e: PaymentError) => e.code === 'network-mismatch')
})
