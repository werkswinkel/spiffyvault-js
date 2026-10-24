/**
 * A link's domain vouching for its payee, with the cases of the app's own
 * test (test/payee_domain_test.dart) and files the app wrote.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import {
  DomainError, MAX_DOMAIN_FILE_BYTES, anchorRecordJson, prekeyBundleJson, checkPayeeDomain, domainEntry, domainFileText, formatPaymentLink, normalizeDomain, parsePaymentLink,
  pay, utf8, verifyDomainFile
} from '../../src/index.ts'
import type { DomainFetch, PayContext } from '../../src/index.ts'
import { DART_SEED7_FILE, SHOP_DOMAIN, SHOP_FILE, SHOP_KEY, SHOP_PEER } from '../fixtures/domain-files.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { randomBytes } from '../support/internals.ts'
import { MemRicochet } from '../support/mem-ricochet.ts'
import { collectOfflinePayment } from '../support/offline-payee.ts'
import { anchorKey, fill, identityFromSeed, signAnchorRecord, signBundle } from '../support/payee.ts'

const KEY = '02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc'
const OTHER_KEY = '03a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc'
const serve = (body: string | Uint8Array | null): DomainFetch => async () => typeof body === 'string' ? utf8(body) : body

async function shopFile (opts: { domain?: string, networks?: string[], key?: string | null } = {}) {
  const shop = await identityFromSeed(fill(7))
  const entry = await domainEntry({
    domain: opts.domain ?? 'shop.example',
    peerId: shop.peerId,
    ...(opts.key === null ? {} : { paymentKey: opts.key ?? KEY }),
    networks: opts.networks ?? ['testnet'],
    name: 'Corner  Shop'
  }, shop.libp2pKey)
  return { shop, text: domainFileText([entry]) }
}

test('the domain is a lower-case host name and nothing else', () => {
  assert.equal(normalizeDomain(' Shop.Example. '), 'shop.example')
  assert.equal(normalizeDomain('xn--bcher-kva.example'), 'xn--bcher-kva.example')
  for (const bad of ['shop', 'https://shop.example', 'shop.example:443', 'shop.example/pay', '1.2.3.4', 'shop..example', '-shop.example', 'bücher.example', '', 'shop.123']) {
    assert.equal(normalizeDomain(bad), null, bad)
  }
})

test('rides in the link as d, after the other fields as the app writes it; a bad one makes the link broken', () => {
  const text = formatPaymentLink({ network: 'testnet', peerId: SHOP_PEER, requestRef: 'ABCD2345', domain: 'shop.example' })
  assert.match(text, /&r=ABCD2345&d=shop\.example$/)
  assert.equal(parsePaymentLink(text)!.domain, 'shop.example')
  assert.equal(parsePaymentLink(text.replace('d=shop.example', 'd=Shop.Example.'))!.domain, 'shop.example')
  assert.equal(parsePaymentLink(text.replace('shop.example', 'shop.example:8080')), null)
  assert.throws(() => formatPaymentLink({ network: 'testnet', peerId: SHOP_PEER, domain: 'https://shop.example' }))
})

test('the shop the app linked verifies, with its name; changed links do not', () => {
  const ok = verifyDomainFile(SHOP_FILE, { domain: SHOP_DOMAIN, peerId: SHOP_PEER, paymentKey: SHOP_KEY, network: 'testnet' })
  assert.deepEqual(ok, { verified: true, domain: SHOP_DOMAIN, name: 'Fina Tey' })
  assert.equal(verifyDomainFile(SHOP_FILE, { domain: SHOP_DOMAIN, paymentKey: SHOP_KEY.toUpperCase(), network: 'test' }).verified, true)
  const problem = (p: Partial<{ peerId: string, paymentKey: string, network: string, domain: string }>) => {
    const r = verifyDomainFile(SHOP_FILE, { domain: SHOP_DOMAIN, peerId: SHOP_PEER, paymentKey: SHOP_KEY, network: 'testnet', ...p })
    return r.verified ? 'verified' : r.problem
  }
  assert.equal(problem({ peerId: '12D3KooWPdspKFQn35Eg62Fg6mG7abr2B5MarJvkFfVqeT8NxqcF' }), 'not-listed')
  assert.equal(problem({ paymentKey: OTHER_KEY }), 'key-mismatch')
  assert.equal(problem({ network: 'mainnet' }), 'other-network')
  assert.equal(problem({ domain: 'evil.example' }), 'bad-signature')
})

test('signs entries the app accepts: byte for byte the app\'s own for the same identity', async () => {
  const shop = await identityFromSeed(fill(7))
  const entry = await domainEntry({ domain: 'Shop.Example', peerId: shop.peerId, paymentKey: KEY.toUpperCase(), networks: ['main', 'testnet'], name: '  Corner   Shop ' }, shop.libp2pKey)
  assert.equal(domainFileText([entry]), DART_SEED7_FILE)
})

test('the check passes for a payee the domain lists, by peer ID or by key alone', async () => {
  const { shop, text } = await shopFile()
  assert.deepEqual(await checkPayeeDomain({ domain: 'shop.example', peerId: shop.peerId, paymentKey: KEY, network: 'testnet', fetch: serve(text) }),
    { verified: true, domain: 'shop.example', name: 'Corner Shop' })
  assert.equal((await checkPayeeDomain({ domain: 'shop.example', paymentKey: KEY, network: 'testnet', fetch: serve(text) })).verified, true)
  assert.equal((await checkPayeeDomain({ domain: 'shop.example', peerId: shop.peerId, network: 'testnet', fetch: serve(text) })).verified, true)
})

test('refuses an entry signed for another domain, edited after signing, or signed by another peer', async () => {
  const { shop, text: copied } = await shopFile({ domain: 'other.example' })
  const v = (text: string, network = 'testnet') => verifyDomainFile(text, { domain: 'shop.example', peerId: shop.peerId, network })
  assert.deepEqual(v(copied), { verified: false, domain: 'shop.example', problem: 'bad-signature' })

  const edited = JSON.parse((await shopFile()).text)
  edited.payees[0].networks = ['testnet', 'mainnet']
  assert.equal((v(JSON.stringify(edited), 'mainnet') as { problem: string }).problem, 'bad-signature')

  const other = await identityFromSeed(fill(9))
  await assert.rejects(domainEntry({ domain: 'shop.example', peerId: shop.peerId, networks: ['testnet'] }, other.libp2pKey), /peer ID/)
  const forged = JSON.parse(copied)
  forged.payees[0].sig = (await domainEntry({ domain: 'shop.example', peerId: other.peerId, networks: ['testnet'] }, other.libp2pKey)).sig
  assert.equal((v(JSON.stringify(forged)) as { problem: string }).problem, 'bad-signature')
})

test('tells no file, a bad file, a large file and no answer apart', async () => {
  const problem = async (fetch: DomainFetch) => {
    const r = await checkPayeeDomain({ domain: 'shop.example', peerId: SHOP_PEER, network: 'testnet', fetch })
    return r.verified ? 'verified' : r.problem
  }
  assert.equal(await problem(serve(null)), 'no-file')
  assert.equal(await problem(serve('<html>')), 'bad-file')
  assert.equal(await problem(serve('{"version":2,"payees":[]}')), 'bad-file')
  assert.equal(await problem(serve(new Uint8Array(MAX_DOMAIN_FILE_BYTES + 1).fill(32))), 'bad-file')
  assert.equal(await problem(async () => { throw new TypeError('fetch failed') }), 'unreachable')
  assert.equal(await problem(async () => { throw new DOMException('The operation timed out.', 'TimeoutError') }), 'unreachable')
})

test('reads the file at the domain\'s well-known address', async () => {
  let asked = ''
  await checkPayeeDomain({ domain: 'Shop.Example', peerId: SHOP_PEER, network: 'testnet', fetch: async url => { asked = url; return null } })
  assert.equal(asked, 'https://shop.example/.well-known/spiffyvault.json')
})

test('pay() refuses a link whose domain does not vouch for the payee, before asking anyone', async () => {
  const { text } = await shopFile()
  const stranger = await identityFromSeed(fill(3))
  let dialled = false
  const ctx: PayContext = {
    wallet: new FakeWallet() as unknown as WalletInterface,
    libp2p: { dial: async () => { dialled = true; throw new Error('no route') }, getConnections: () => [] },
    domainFetch: serve(text)
  }
  const link = formatPaymentLink({ network: 'testnet', peerId: stranger.peerId, amountSats: 1000, domain: 'shop.example' })
  await assert.rejects(pay({ link }, ctx), (e: unknown) => {
    assert.ok(e instanceof DomainError)
    assert.equal(e.code, 'domain-refused')
    assert.equal(e.problem, 'not-listed')
    assert.equal(e.domain, 'shop.example')
    assert.equal(e.stage, 'prepare')
    assert.equal(e.canPayAnotherWay, false)
    return true
  })
  assert.equal(dialled, false)
})

test('pay() pays a link its domain vouches for, and says which domain and name', async () => {
  const id = await identityFromSeed(randomBytes(32))
  const keys = { registrationId: 1, signedPreKeyId: 1, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map([[5, randomBytes(32)]]) }
  const anchor = anchorKey()
  const server = new MemRicochet(id.peerId)
  server.putDoc(id.peerId, 'wallet/payment-anchor', anchorRecordJson(signAnchorRecord(id, { anchorPublicKey: anchor.pub, epoch: 0, networkType: 'test', timestamp: 1 })))
  await server.sendMessage(id.peerId, prekeyBundleJson(signBundle(id, keys, 1)), { folderPath: 'signal/prekeys' })
  const file = domainFileText([await domainEntry({ domain: 'shop.example', peerId: id.peerId, networks: ['testnet'], name: 'Corner Shop' }, id.libp2pKey)])

  const steps: string[] = []
  const link = formatPaymentLink({ network: 'testnet', peerId: id.peerId, amountSats: 1200, domain: 'shop.example' })
  const r = await pay({ link }, {
    wallet: new FakeWallet() as unknown as WalletInterface,
    ricochet: server.as((await identityFromSeed(fill(1))).peerId),
    domainFetch: serve(file),
    onProgress: s => steps.push(s.step)
  })
  assert.equal(r.path, 'offline')
  assert.deepEqual(r.payeeDomain, { domain: 'shop.example', name: 'Corner Shop' })
  assert.equal(steps[0], 'domain')
  const m = server.mail.find(x => x.folderPath === 'wallet/offline-payments')!
  assert.equal(collectOfflinePayment(id, keys, anchor.priv, m).paidSats, 1200)
})
