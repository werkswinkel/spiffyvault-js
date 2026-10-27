import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CreateActionArgs, WalletInterface } from '@bsv/sdk'
import { OFFLINE_RECLAIM_SECONDS, PaymentError, payOffline } from '../../src/index.ts'
import type { Funder } from '../../src/index.ts'
import { anchorRecordJson } from '../../src/internal.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { MemRicochet } from '../support/mem-ricochet.ts'
import { anchorKey, fill, identityFromSeed, publishSessionKeys, signAnchorRecord } from '../support/payee.ts'
import type { PayeeIdentity, PayeeSessionKeys } from '../support/payee.ts'
import { collectOfflinePayment } from '../support/offline-payee.ts'
import { randomBytes } from '../support/internals.ts'

const asWallet = (w: FakeWallet): WalletInterface => w as unknown as WalletInterface

async function world (opts: { network?: 'test' | 'main', anchorPath?: string, bundle?: boolean } = {}) {
  const id: PayeeIdentity = await identityFromSeed(randomBytes(32))
  const keys: PayeeSessionKeys = { signedPreKeyId: 2, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map([[3, randomBytes(32)], [4, randomBytes(32)]]) }
  const anchor = anchorKey()
  const server = new MemRicochet(id.peerId)
  const networkType = opts.network ?? 'test'
  const suffix = networkType === 'main' ? '/mainnet' : ''
  const anchorPath = opts.anchorPath ?? `wallet/payment-anchor${suffix}`
  server.putDoc(id.peerId, anchorPath,
    anchorRecordJson(signAnchorRecord(id, { anchorPublicKey: anchor.pub, epoch: 0, networkType, timestamp: Date.now(), path: anchorPath })))
  const network = networkType === 'main' ? 'mainnet' : 'testnet'
  if (opts.bundle !== false) {
    // two bundles; the last one counts
    await publishSessionKeys(server.as(id.peerId), id, { signedPreKeyId: 1, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map() }, network)
    await publishSessionKeys(server.as(id.peerId), id, keys, network)
  }
  const payer = await identityFromSeed(fill(9))
  const payerPeerId = payer.peerId
  return { id, keys, anchor, server, payer: server.as(payerPeerId), payerPeerId, pc: { ricochet: server.as(payerPeerId), identityKey: payer.seed } }
}

test('seals a payment the payee can collect, into wallet/offline-payments, priority 2, persistent', async () => {
  const w = await world()
  const wallet = new FakeWallet()
  const steps: string[] = []
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 2500, note: 'Coffee', network: 'testnet' },
    { wallet: asWallet(wallet), ...w.pc, onProgress: p => steps.push(p.step) })
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

test('mainnet uses the /mainnet anchor, payment keys and payment folder', async () => {
  const w = await world({ network: 'main' })
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'mainnet' }, { wallet: asWallet(new FakeWallet({ network: 'mainnet' })), ...w.pc })
  const m = w.server.mail.find(x => x.folderPath === 'wallet/offline-payments/mainnet')!
  assert.equal(collectOfflinePayment(w.id, w.keys, w.anchor.priv, m).txid, r.txid)
  assert.equal(w.server.mail.some(x => x.folderPath === 'wallet/offline-payments'), false)
})

test('a testnet payer refuses a mainnet anchor', async () => {
  const w = await world({ network: 'main', anchorPath: 'wallet/payment-anchor' })
  await assert.rejects(payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), ...w.pc }),
    (e: PaymentError) => e.code === 'anchor-other-network' && e.canPayAnotherWay)
})

test('the request anchor (from ref in the note) and the wallet anchor come first, with fallback to the usual one', async () => {
  const w = await world({ anchorPath: 'wallet/payment-anchor/r/ABCD2345' })
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, note: 'Tea · ref ABCD2345', walletId: 'w1', network: 'testnet' },
    { wallet: asWallet(new FakeWallet()), ...w.pc })
  assert.equal(r.status, 'handed-off')
  const w2 = await world({ anchorPath: 'wallet/payment-anchor/w/w1' })
  await payOffline({ payeePeerId: w2.id.peerId, amountSats: 10, walletId: 'w1', network: 'testnet' }, { wallet: asWallet(new FakeWallet()), ...w2.pc })
  const w3 = await world()
  await payOffline({ payeePeerId: w3.id.peerId, amountSats: 10, walletId: 'nope', note: 'ref ZZZZ2345', network: 'testnet' }, { wallet: asWallet(new FakeWallet()), ...w3.pc })
})

test('no anchor, no prekeys: nothing is built', async () => {
  const w = await world({ anchorPath: 'elsewhere' })
  const wallet = new FakeWallet()
  await assert.rejects(payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc }),
    (e: PaymentError) => e.code === 'anchor-missing' && e.canPayAnotherWay)
  const w2 = await world({ bundle: false })
  await assert.rejects(payOffline({ payeePeerId: w2.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w2.pc }),
    (e: PaymentError) => e.code === 'prekeys-missing')
  assert.equal(wallet.calls.some(c => c.method === 'createAction'), false)
})

test('a refused submission aborts the wallet action', async () => {
  const w = await world()
  w.server.refuse = { status: 507, message: 'mailbox full' }
  const wallet = new FakeWallet()
  const e = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc }).catch(x => x)
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
  const e = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc }).catch(x => x)
  assert.equal(e.code, 'delivery-unknown')
  assert.equal(e.canPayAnotherWay, false)
  assert.equal(wallet.actions.get(e.txid!)!.status, 'nosend')
})

test('each payment claims its own one-time pre-key; with none left it is sealed without one and still opens', async () => {
  const w = await world()
  const steps: string[] = []
  const pay = async (): Promise<void> => {
    await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' },
      { wallet: asWallet(new FakeWallet()), ...w.pc, onProgress: p => { if (p.detail !== undefined) steps.push(p.detail) } })
  }
  await pay(); await pay(); await pay()
  const payments = w.server.mail.filter(x => x.folderPath === 'wallet/offline-payments')
  assert.equal(payments.length, 3)
  assert.equal(w.server.mail.some(x => x.folderPath === 'signal/v2/one-time-keys'), false)
  for (const m of payments) assert.equal(collectOfflinePayment(w.id, w.keys, w.anchor.priv, m).paidSats, 10)
  assert.equal(w.keys.oneTimePreKeys.size, 0) // the payee used both
  assert.ok(steps.some(d => /no one-time pre-key \(none-left\)/.test(d)))
})

test('a failed claim does not stop the payment', async () => {
  const w = await world()
  w.server.claimFails = new Error('400 unknown operation')
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(new FakeWallet()), ...w.pc })
  const m = w.server.mail.find(x => x.folderPath === 'wallet/offline-payments')!
  assert.equal(collectOfflinePayment(w.id, w.keys, w.anchor.priv, m).txid, r.txid)
  assert.equal(w.keys.oneTimePreKeys.size, 2)
})

test('the payment is sealed from the payer\'s own key; another key is refused before anything is built', async () => {
  const w = await world()
  const wallet = new FakeWallet()
  const other = await identityFromSeed(fill(10))
  await assert.rejects(payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ricochet: w.payer, identityKey: other.seed }),
    (e: PaymentError) => e.code === 'no-route' && /not the key of the Ricochet client's peer ID/.test(e.message))
  // The libp2p form (seed ‖ public) works as well as the seed.
  const payer = await identityFromSeed(fill(9))
  await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ricochet: w.payer, identityKey: payer.libp2pKey })
  assert.equal(wallet.calls.filter(c => c.method === 'createAction').length, 1)
})

test('the wallet is asked to reclaim an uncollected payment after 3 days (BRC-177), as the app does', async () => {
  const w = await world()
  const wallet = new FakeWallet()
  const before = Date.now()
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc })
  const args = wallet.calls.find(c => c.method === 'createAction')!.args as CreateActionArgs
  assert.equal(OFFLINE_RECLAIM_SECONDS, 259_200)
  assert.deepEqual(args.labels, ['p nosend expiry seconds 259200'])
  assert.equal(args.options?.noSend, true)
  assert.ok(r.reclaimAt! >= before + 259_200_000 && r.reclaimAt! <= Date.now() + 259_200_000)
})

test('offlineReclaimSeconds sets the deadline, or false leaves the payment without one', async () => {
  const w = await world()
  const wallet = new FakeWallet({ coins: [100_000, 100_000] })
  await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc, offlineReclaimSeconds: 3600 })
  const off = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc, offlineReclaimSeconds: false })
  const labels = wallet.calls.filter(c => c.method === 'createAction').map(c => (c.args as CreateActionArgs).labels)
  assert.deepEqual(labels, [['p nosend expiry seconds 3600'], undefined])
  assert.equal(off.reclaimAt, undefined)
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc, offlineReclaimSeconds: bad }), TypeError)
  }
})

test('a wallet without BRC-177 refuses the payment, and nothing reaches the mailbox', async () => {
  const w = await world()
  const wallet = new FakeWallet({ noBrc177: true })
  const e = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc }).catch(x => x)
  assert.ok(e instanceof PaymentError)
  assert.equal(e.code, 'funding-failed')
  assert.match(e.message, /BRC-177/)
  assert.equal(w.server.mail.filter(m => m.folderPath === 'wallet/offline-payments').length, 0)
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc, offlineReclaimSeconds: false })
  assert.equal(r.status, 'handed-off')
})

test('a funder is told when to reclaim the payment', async () => {
  const w = await world()
  const wallet = new FakeWallet()
  const seen: Array<number | undefined> = []
  const funder: Funder = async (outputs, info) => {
    seen.push(info.reclaimAt)
    const made = await wallet.createAction({ description: 'test', outputs: outputs.map(o => ({ ...o, outputDescription: 'test' })), options: { noSend: true } })
    return made.tx!
  }
  const before = Date.now()
  const r = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { funder, ...w.pc })
  assert.ok(seen[0]! >= before + 259_200_000)
  assert.equal(r.reclaimAt, seen[0])
})

test('a wallet that answers aborted: false is not reported as aborted', async () => {
  const w = await world()
  w.server.refuse = { status: 507, message: 'mailbox full' }
  const wallet = new FakeWallet({ refuseAbort: true })
  const e = await payOffline({ payeePeerId: w.id.peerId, amountSats: 10, network: 'testnet' }, { wallet: asWallet(wallet), ...w.pc }).catch(x => x)
  assert.equal(e.code, 'mailbox-refused')
  assert.equal(e.aborted, false)
  assert.equal(wallet.actions.get(e.txid!)!.status, 'nosend')
})
