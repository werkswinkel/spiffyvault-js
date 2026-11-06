/**
 * acceptOfflinePayments against a local go-ricochet, from Node over UDX:
 * the payee publishes its keys and anchor (twice: the second pass finds
 * the mailboxes there), a payer pays with payOffline, and the payee
 * collects, broadcasts (a stand-in) and deletes the message.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { RicochetClient } from '@go-ricochet/ricochet/node'
import type { Libp2p } from '@libp2p/interface'
import { acceptOfflinePayments, createPaymentNode, payOffline } from '../../src/node.ts'
import type { OfflinePayeeEvent, OfflinePayeeState, ReceivedOfflinePayment } from '../../src/node.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { startServer } from './server.ts'
import type { TestServer } from './server.ts'

let server: TestServer
const nodes: Libp2p[] = []
before(async () => { server = await startServer() })
after(async () => {
  for (const n of nodes) await n.stop()
  await server?.stop()
})

async function client () {
  const { node, privateKey } = await createPaymentNode({ udxOnly: true })
  nodes.push(node)
  return { ricochet: new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.udx] }] }), identityKey: privateKey }
}

test('Node over UDX: a payee publishes its keys, is paid offline, and collects the payment', async () => {
  const shop = await client()
  let saved: OfflinePayeeState | null = null
  const paid: ReceivedOfflinePayment[] = []
  const events: OfflinePayeeEvent[] = []
  const payee = await acceptOfflinePayments({
    network: 'testnet',
    ricochet: shop.ricochet,
    identityKey: shop.identityKey,
    wallet: new ProtoWallet(PrivateKey.fromRandom()),
    store: { load: async () => saved, save: async s => { saved = structuredClone(s) } },
    chainTracker: { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 },
    broadcaster: async () => ({ accepted: true, status: 'SEEN_ON_NETWORK' }),
    onPayment: p => { paid.push(p) },
    onEvent: e => events.push(e),
    collectEveryMs: 3600_000
  })
  try {
    await payee.refreshKeys()
    assert.deepEqual(events.filter(e => e.kind === 'error'), [], 'no pass failed')
    assert.deepEqual(events.filter(e => e.kind === 'keys'), [{ kind: 'keys', bundle: true, oneTimeKeys: 50, anchor: true }])
    assert.equal((await shop.ricochet.getMailboxInfo('signal/v2/one-time-keys')).messageCount, 50)

    const payer = await client()
    const r = await payOffline({ payeePeerId: shop.ricochet.peerId.toString(), amountSats: 4321, note: 'Order 7 · ref ABCD2345', network: 'testnet' },
      { wallet: new FakeWallet({ unprovenDepth: 1 }) as unknown as WalletInterface, ...payer })
    assert.equal(r.status, 'handed-off')

    await payee.collectNow()
    assert.deepEqual(events.filter(e => e.kind === 'error' || e.kind === 'refused'), [])
    assert.deepEqual(paid.map(p => [p.txid, p.paidSats, p.note]), [[r.txid, 4321, 'Order 7 · ref ABCD2345']])
    const left = await shop.ricochet.retrievePage({ folderPath: 'wallet/offline-payments' })
    assert.equal(left.messages.length, 0, 'the message is deleted once kept')
    assert.equal((await shop.ricochet.getMailboxInfo('signal/v2/one-time-keys')).messageCount, 49, 'the payer claimed one')
  } finally {
    payee.stop()
  }
})
