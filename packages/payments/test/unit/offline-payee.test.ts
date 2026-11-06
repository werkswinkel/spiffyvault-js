/**
 * Being paid offline (acceptOfflinePayments) against the library's own
 * payer (payOffline), on an in-memory Ricochet server: the keys a payer
 * needs, collecting, keeping before acknowledging, retries, and refusals.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { P2PKH, PrivateKey, ProtoWallet, PublicKey } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { OFFLINE_PAYEE_KEYS, acceptOfflinePayments, payOffline } from '../../src/index.ts'
import type { OfflinePayee, OfflinePayeeEvent, OfflinePayeeOptions, OfflinePayeeState, ReceivedOfflinePayment } from '../../src/index.ts'
import { parseAnchorRecord, verifyAnchorRecord } from '../../src/internal.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { MemRicochet } from '../support/mem-ricochet.ts'
import { fill, identityFromSeed } from '../support/payee.ts'
import { randomBytes } from '../support/internals.ts'

const anyRoot = { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 }
const OFFLINE = 'wallet/offline-payments'

function memStore (): { store: OfflinePayeeOptions['store'], state: () => OfflinePayeeState | null } {
  let saved: string | null = null
  return {
    store: { load: async () => saved === null ? null : JSON.parse(saved), save: async s => { saved = JSON.stringify(s) } },
    state: () => saved === null ? null : JSON.parse(saved)
  }
}

async function world () {
  const shop = await identityFromSeed(randomBytes(32))
  const server = new MemRicochet(shop.peerId)
  const root = PrivateKey.fromRandom()
  const wallet = new ProtoWallet(root)
  const payer = await identityFromSeed(fill(9))
  const { store, state } = memStore()
  const paid: ReceivedOfflinePayment[] = []
  const events: OfflinePayeeEvent[] = []
  const broadcasts: string[] = []
  let refuseBroadcast: string | undefined
  let keepFails: string | undefined
  const start = async (extra: Partial<OfflinePayeeOptions> = {}): Promise<OfflinePayee> => await acceptOfflinePayments({
    network: 'testnet',
    ricochet: server,
    identityKey: shop.libp2pKey,
    wallet,
    store,
    chainTracker: anyRoot,
    broadcaster: async chain => {
      broadcasts.push(chain[chain.length - 1]!.id('hex'))
      return refuseBroadcast === undefined ? { accepted: true, status: 'SEEN_ON_NETWORK' } : { accepted: false, error: refuseBroadcast }
    },
    onPayment: p => { if (keepFails !== undefined) throw new Error(keepFails); paid.push(p) },
    onEvent: e => events.push(e),
    collectEveryMs: 3600_000,
    ...extra
  })
  const pay = async (amountSats: number, note?: string) => await payOffline(
    { payeePeerId: shop.peerId, amountSats, network: 'testnet', ...(note !== undefined ? { note } : {}) },
    { wallet: new FakeWallet() as unknown as WalletInterface, ricochet: server.as(payer.peerId), identityKey: payer.seed })
  return {
    shop, server, root, wallet, payer, state, paid, events, broadcasts, start, pay,
    refuseBroadcast: (e: string | undefined) => { refuseBroadcast = e },
    keepFails: (e: string | undefined) => { keepFails = e }
  }
}

test('publishes what a payer needs: the bundle, 50 one-time keys, and an anchor record naming the wallet\'s identity key', async () => {
  const w = await world()
  const payee = await w.start()
  payee.stop()
  const mail = (folder: string) => w.server.mail.filter(m => m.recipientPeerId === w.shop.peerId && m.folderPath === folder)
  assert.equal(mail('signal/v2/bundle').length, 1)
  assert.equal(mail('signal/v2/one-time-keys').length, OFFLINE_PAYEE_KEYS.stockTo)
  const { content } = await w.server.getDocument(w.shop.peerId, 'wallet/payment-anchor')
  const record = parseAnchorRecord(JSON.parse(new TextDecoder().decode(content)))
  assert.equal(verifyAnchorRecord(record, w.shop.peerId, 'test', 'wallet/payment-anchor'), null)
  assert.equal(record.anchorPublicKey, w.root.toPublicKey().toString())
  const s = w.state()!
  assert.equal(s.signedPreKeys.length, 1)
  assert.equal(s.oneTimePreKeys.length, OFFLINE_PAYEE_KEYS.stockTo)
  assert.deepEqual(w.events.filter(e => e.kind === 'keys'), [{ kind: 'keys', bundle: true, oneTimeKeys: 50, anchor: true }])
})

test('a second pass publishes nothing new, and tops the one-time keys up only below 25', async () => {
  const w = await world()
  const payee = await w.start()
  await payee.refreshKeys()
  assert.equal(w.events.filter(e => e.kind === 'keys').length, 1)
  // Payers claim 30 of them.
  for (let i = 0; i < 30; i++) await w.server.as(w.payer.peerId).claimMessage(w.shop.peerId, 'signal/v2/one-time-keys')
  await payee.refreshKeys()
  payee.stop()
  assert.deepEqual(w.events.filter(e => e.kind === 'keys')[1], { kind: 'keys', bundle: false, oneTimeKeys: 30, anchor: false })
})

test('collects a payment: opened, broadcast, kept, then the message deleted; the wallet can spend every output', async () => {
  const w = await world()
  const payee = await w.start()
  const r = await w.pay(2500, 'Order 1042 · ref K7Q2M9XD')
  assert.equal(r.status, 'handed-off')
  await payee.collectNow()
  payee.stop()
  assert.equal(w.paid.length, 1)
  const p = w.paid[0]!
  assert.equal(p.txid, r.txid)
  assert.equal(p.paidSats, 2500)
  assert.equal(p.amountSats, 2500)
  assert.equal(p.note, 'Order 1042 · ref K7Q2M9XD')
  assert.equal(p.payerPeerId, w.payer.peerId)
  assert.deepEqual(w.broadcasts, [r.txid])
  // Each output's key, as Wallet Toolbox derives it for a BRC-29 payment remittance.
  for (const o of p.outputs) {
    const child = w.root.deriveChild(PublicKey.fromString(o.senderIdentityKey), `2-3241645161d8-${o.derivationPrefix} ${o.derivationSuffix}`)
    assert.equal(p.transaction.outputs[o.outputIndex]!.lockingScript.toHex(), new P2PKH().lock(child.toPublicKey().toHash() as number[]).toHex())
  }
  assert.equal(w.server.mail.some(m => m.folderPath === OFFLINE), false)
  const s = w.state()!
  assert.deepEqual(s.opened, {})
  assert.ok(s.done.includes(r.txid))
  assert.equal(s.oneTimePreKeys.length, OFFLINE_PAYEE_KEYS.stockTo - 1, 'the one-time key it used is gone')
  assert.deepEqual(w.events.filter(e => e.kind !== 'keys').map(e => e.kind), ['opened', 'paid'])
})

test('when keeping fails, the payment stays in the mailbox and is offered again from what was saved', async () => {
  const w = await world()
  const payee = await w.start()
  const r = await w.pay(700)
  w.keepFails('disk full')
  await payee.collectNow()
  assert.equal(w.paid.length, 0)
  assert.equal(w.server.mail.filter(m => m.folderPath === OFFLINE).length, 1)
  assert.ok(w.events.some(e => e.kind === 'keep-failed' && e.error === 'disk full'))
  assert.ok(Object.values(w.state()!.opened).some(o => o.message.txid === r.txid))
  w.keepFails(undefined)
  await payee.collectNow()
  payee.stop()
  assert.deepEqual(w.paid.map(p => p.txid), [r.txid])
  assert.equal(w.server.mail.some(m => m.folderPath === OFFLINE), false)
})

test('a payee that stops after opening carries on from the store when it starts again', async () => {
  const w = await world()
  const first = await w.start()
  const r = await w.pay(900)
  w.keepFails('stopped')
  await first.collectNow()
  first.stop()
  w.keepFails(undefined)
  const second = await w.start()
  await second.collectNow()
  second.stop()
  assert.deepEqual(w.paid.map(p => p.txid), [r.txid])
})

test('a payment the network will not take is tried on later passes, then given up, and deleted', async () => {
  const w = await world()
  const payee = await w.start({ maxAttempts: 2 })
  const r = await w.pay(300)
  w.refuseBroadcast('missing inputs')
  await payee.collectNow()
  assert.equal(w.server.mail.filter(m => m.folderPath === OFFLINE).length, 1)
  await payee.collectNow()
  payee.stop()
  assert.equal(w.paid.length, 0)
  assert.ok(w.events.some(e => e.kind === 'not-broadcast' && e.txid === r.txid && e.error === 'missing inputs'))
  assert.equal(w.server.mail.some(m => m.folderPath === OFFLINE), false)
})

test('a message that does not open, or a payment not for this wallet, is refused and deleted', async () => {
  const w = await world()
  const payee = await w.start()
  let elsewhere: OfflinePayee | undefined
  try {
    await w.server.as(w.payer.peerId).sendMessage(w.shop.peerId, new Uint8Array([9, 9, 9]), { folderPath: OFFLINE, persistent: true })
    await payee.collectNow()
    assert.ok(w.events.some(e => e.kind === 'refused' && /first message/.test(e.reason)))
    assert.equal(w.server.mail.some(m => m.folderPath === OFFLINE), false)

    // Another wallet's anchor: its keys pass names that wallet, so the payer pays keys this one does not hold.
    const s = w.state()!
    elsewhere = await acceptOfflinePayments({
      network: 'testnet', ricochet: w.server, identityKey: w.shop.libp2pKey, wallet: new ProtoWallet(PrivateKey.fromRandom()),
      store: { load: async () => s, save: async () => {} }, chainTracker: anyRoot, onPayment: () => { throw new Error('not ours') },
      broadcaster: async () => ({ accepted: true }), collectEveryMs: 3600_000
    })
    elsewhere.stop()
    await w.pay(400)
    await payee.collectNow()
    assert.ok(w.events.some(e => e.kind === 'refused' && e.reason === 'the payment pays nothing to this wallet'))
    assert.equal(w.paid.length, 0)
  } finally {
    payee.stop()
    elsewhere?.stop()
  }
})

test('a payment that cannot be checked is tried on later passes, then refused and deleted', async () => {
  const w = await world()
  const payee = await w.start({ maxAttempts: 2, chainTracker: { isValidRootForHeight: async () => { throw new Error('chain unreachable') }, currentHeight: async () => 1_000_000 } })
  try {
    await w.pay(250)
    await payee.collectNow()
    assert.ok(w.events.some(e => e.kind === 'error' && /chain unreachable/.test(e.error)))
    assert.equal(w.server.mail.filter(m => m.folderPath === OFFLINE).length, 1)
    await payee.collectNow()
    assert.ok(w.events.some(e => e.kind === 'refused' && /chain unreachable/.test(e.reason)))
    assert.equal(w.server.mail.some(m => m.folderPath === OFFLINE), false)
    assert.equal(w.broadcasts.length, 0)
  } finally {
    payee.stop()
  }
})
