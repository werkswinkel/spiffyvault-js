/**
 * Runs the README Node example (examples/node.ts) against a local
 * go-ricochet: a payee reachable live through the relay, and one that is
 * only published (offline), and the README payee example (examples/payee.ts)
 * paid by it. The examples import the built package by name.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import { createRicochetNode } from '@go-ricochet/ricochet/node'
import type { Libp2p } from '@libp2p/interface'
import { formatPaymentLink } from '../../src/node.ts'
import { nodePay } from '../../examples/node.ts'
import { till } from '../../examples/payee.ts'
import { PrivateKey } from '@bsv/sdk'
import type { ReceivedLivePayment } from '../../src/node.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { relayedPayee } from './live-peers.ts'
import type { RelayedPayee } from './live-peers.ts'
import { newPayeeIdentity, publishPayee } from './payee-publish.ts'
import { startServer } from './server.ts'
import type { TestServer } from './server.ts'

let server: TestServer
const stops: Array<() => Promise<void>> = []
before(async () => { server = await startServer() })
after(async () => {
  for (const s of stops) await s()
  await server?.stop()
})

test('README Node example: live when the phone is reachable', async () => {
  const p: RelayedPayee = await relayedPayee(server.udx)
  stops.push(p.stop)
  const link = formatPaymentLink({ network: 'testnet', peerId: p.peerId, amountSats: 2000 })
  assert.equal(await nodePay(link, new FakeWallet() as unknown as WalletInterface, { peerId: server.peerId, addr: server.udx }), 'live')
  assert.equal(p.payee.paid.length, 1)
})

test('README Node example: offline when it is not', async () => {
  const id = await newPayeeIdentity()
  const { node }: { node: Libp2p } = await createRicochetNode({ privateKey: id.libp2pKey, udxOnly: true })
  stops.push(async () => { await node.stop() })
  const payee = await publishPayee(node, id, { peerId: server.peerId, addr: server.udx })
  const link = formatPaymentLink({ network: 'testnet', peerId: id.peerId, amountSats: 2000 })
  assert.equal(await nodePay(link, new FakeWallet() as unknown as WalletInterface, { peerId: server.peerId, addr: server.udx }), 'offline')
  assert.equal((await payee.client.retrievePage({ folderPath: 'wallet/offline-payments' })).messages.length, 1)
})

test('README payee example: the Node example pays it live', async () => {
  const kept: ReceivedLivePayment[] = []
  const t = await till(() => PrivateKey.fromRandom().toPublicKey().toAddress('testnet'), p => { kept.push(p) }, server.udx, {
    chainTracker: { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 },
    broadcaster: async () => ({ accepted: true, status: 'SEEN_ON_NETWORK' })
  })
  stops.push(t.stop)
  assert.equal(await nodePay(t.link, new FakeWallet() as unknown as WalletInterface, { peerId: server.peerId, addr: server.udx }), 'live')
  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.paidSats, 2500)
})
