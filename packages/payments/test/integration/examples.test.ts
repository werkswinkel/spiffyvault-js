/**
 * Runs the README Node example (examples/node.ts) against a local
 * go-ricochet: a payee reachable live through the relay, and one that is
 * only published (offline). The example imports the built package by name.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { WalletInterface } from '@bsv/sdk'
import { createRicochetNode } from '@stephanfeb/ricochet/node'
import type { Libp2p } from '@libp2p/interface'
import { formatPaymentLink } from '../../src/node.ts'
import { nodePay } from '../../examples/node.ts'
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
