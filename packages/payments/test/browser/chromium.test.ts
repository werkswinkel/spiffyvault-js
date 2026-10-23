/**
 * From headless Chrome against a local go-ricochet:
 *
 * - live: the page (WebSockets only) pays a mock payee that is reachable
 *   only through the relay's circuit, the payee on UDX in Node, as a phone
 *   is: browser --ws/wss--> relay --udx--> payee;
 * - offline: the page seals a payment into a JS payee's mailbox, which the
 *   payee then collects and decrypts in Node.
 *
 * Run `node test/browser/build.ts` first (npm run test:browser does).
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { RicochetClient, createRicochetNode } from '@stephanfeb/ricochet/node'
import type { Libp2p } from '@libp2p/interface'
import { startServer } from '../integration/server.ts'
import type { TestServer } from '../integration/server.ts'
import { relayedPayee } from '../integration/live-peers.ts'
import type { RelayedPayee } from '../integration/live-peers.ts'
import { newPayeeIdentity, publishPayee } from '../integration/payee-publish.ts'
import { collectOfflinePayment } from '../support/offline-payee.ts'
import { openPage } from './harness.ts'
import type { BrowserSession } from './harness.ts'

let server: TestServer
let session: BrowserSession
const payees: RelayedPayee[] = []
const nodes: Libp2p[] = []

before(async () => {
  server = await startServer()
  session = await openPage(server.certSpki !== undefined ? { trustSpki: server.certSpki } : {})
})

after(async () => {
  for (const p of payees) await p.stop()
  for (const n of nodes) await n.stop()
  await session?.close()
  await server?.stop()
})

async function live (relay: string, t: { diagnostic: (s: string) => void }): Promise<void> {
  const p = await relayedPayee(server.udx)
  payees.push(p)
  const r = await session.page.evaluate(async (a) => await window.liveFlow(a), { relay, relayPeerId: server.peerId, payeePeerId: p.peerId, amountSats: 777 })
  if (!r.ok) t.diagnostic(session.logs.join('\n'))
  assert.equal(r.ok, true, r.message)
  assert.equal(r.status, 'completed')
  assert.deepEqual(p.payee.paid.map(x => [x.txid, x.sats]), [[r.txid, 777]])
  assert.equal(p.payee.received.every(x => x.chunks === 1), true, 'each frame in one chunk')
  assert.equal(p.payee.received[0]!.remotePeer, r.payerPeerId)
  assert.equal(p.payee.received[0]!.limited, true)
  assert.equal(r.limited, true)
  assert.match(r.payeeAddr!, /\/p2p-circuit\//)
  t.diagnostic(`browser: ${session.browser}; relay leg ${r.relayAddr}; payee ${r.payeeAddr}`)
}

test('Chrome over WebSocket → relay → UDX payee: a live payment', async (t) => {
  await live(server.ws, t)
})

test('Chrome over TLS WebSocket (WSS) → relay → UDX payee: a live payment', async (t) => {
  if (server.wss === undefined) { t.skip('no certificate (openssl missing)'); return }
  await live(server.wss, t)
})

test('Chrome over WSS: an offline payment the payee collects', async (t) => {
  const id = await newPayeeIdentity()
  const { node } = await createRicochetNode({ privateKey: id.libp2pKey, udxOnly: true })
  nodes.push(node)
  const payee = await publishPayee(node, id, { peerId: server.peerId, addr: server.udx })
  const addr = server.wss ?? server.ws
  const r = await session.page.evaluate(async (a) => await window.offlineFlow(a), { serverPeerId: server.peerId, addr, payeePeerId: id.peerId, amountSats: 888 })
  if (!r.ok) t.diagnostic(session.logs.join('\n'))
  assert.equal(r.ok, true, r.message)
  assert.equal(r.status, 'handed-off')
  const page = await payee.client.retrievePage({ folderPath: 'wallet/offline-payments' })
  const m = page.messages.find(x => x.messageId === r.messageId)!
  assert.equal(m.senderPeerId, r.payerPeerId)
  const c = collectOfflinePayment(payee.id, payee.keys, payee.anchor, m)
  assert.equal(c.txid, r.txid)
  assert.equal(c.paidSats, 888)
  void RicochetClient
})
