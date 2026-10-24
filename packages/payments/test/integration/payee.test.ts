/**
 * Being paid live, the way the app finds and pays a payee: the payer asks
 * the Ricochet server's DHT for the payee's peer ID (FIND_PEER, as
 * p2p_coordinator_actor.dart does before every live payment), dials the
 * relay address it gets back, and pays. A payee node from
 * createPaymentNode({ payee: true }) is found; one without identify push is
 * not, because its only identify with the server ran before its
 * reservation existed.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { kadDHT } from '@libp2p/kad-dht'
import type { KadDHT } from '@libp2p/kad-dht'
import { peerIdFromString } from '@libp2p/peer-id'
import { ping } from '@libp2p/ping'
import type { Libp2p, PeerInfo } from '@libp2p/interface'
import { udx } from '@stephanfeb/libp2p-udx'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import { acceptLivePayments, createPaymentNode, payLive, waitUntilReachable } from '../../src/node.ts'
import { createPaymentNode as createBrowserNode } from '../../src/browser.ts'
import type { ReceivedLivePayment } from '../../src/node.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { startServer } from './server.ts'
import type { TestServer } from './server.ts'

let server: TestServer
let looker: Libp2p<{ dht: KadDHT, identify: unknown, ping: unknown }>
before(async () => {
  server = await startServer()
  // The app's node: UDX to the server, a DHT client.
  looker = await createLibp2p({
    transports: [udx(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping(), dht: kadDHT({ clientMode: true, protocol: '/ipfs/kad/1.0.0', peerInfoMapper: p => p }) }
  })
  await looker.dial(multiaddr(server.udx))
})
after(async () => {
  await looker?.stop()
  await server?.stop()
})

/**
 * FIND_PEER through the server's DHT, as the app does; null when it does
 * not know the peer within `ms` (the payee's identify push takes a moment
 * after its reservation).
 */
async function lookUp (peerId: string, ms = 5000): Promise<PeerInfo | null> {
  const until = Date.now() + ms
  for (;;) {
    try {
      for await (const ev of looker.services.dht.findPeer(peerIdFromString(peerId), { signal: AbortSignal.timeout(5000) })) {
        if (ev.name === 'FINAL_PEER') return ev.peer
      }
    } catch (e) {
      if (process.env.DEBUG_LOOKUP !== undefined) console.log('lookup:', (e as Error).message)
    }
    if (Date.now() > until) return null
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

const anyRoot = { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 }

async function payTo (payee: Libp2p): Promise<{ payments: ReceivedLivePayment[], result: Awaited<ReturnType<typeof payLive>> }> {
  const payments: ReceivedLivePayment[] = []
  const handle = await acceptLivePayments(payee, {
    network: 'testnet',
    chainTracker: anyRoot,
    invoiceAddress: () => PrivateKey.fromRandom().toPublicKey().toAddress('testnet'),
    broadcaster: async () => ({ accepted: true, status: 'SEEN_ON_NETWORK' }),
    onPayment: p => { payments.push(p) }
  })
  try {
    const found = await lookUp(payee.peerId.toString())
    assert.ok(found !== null, 'the server\'s DHT knows the payee')
    // A relay address through the server; which transport the payee used to
    // reach it does not matter, the payer's circuit goes over its own
    // connection to the relay (as the app's swarm does, and dialPayee).
    const circuit = found.multiaddrs.map(String).find(a => a.includes(`/p2p/${server.peerId}/p2p-circuit`))
    assert.ok(circuit !== undefined, `a relay address through the server among ${found.multiaddrs.map(String).join(', ')}`)
    await looker.dial(multiaddr(`/p2p/${server.peerId}/p2p-circuit/p2p/${payee.peerId.toString()}`), { runOnLimitedConnection: true } as never)
    const result = await payLive({ payeePeerId: payee.peerId.toString(), amountSats: 2500, note: 'found by lookup', network: 'testnet' },
      { wallet: new FakeWallet() as unknown as WalletInterface, libp2p: looker as unknown as Libp2p, relays: [] })
    return { payments, result }
  } finally {
    await handle.stop()
  }
}

test('a Node payee (UDX) is found through the server\'s DHT and paid', async () => {
  const { node } = await createPaymentNode({ udxOnly: true, payee: true, relay: server.udx })
  try {
    await waitUntilReachable(node)
    const { payments, result } = await payTo(node)
    assert.equal(result.status, 'completed')
    assert.equal(payments.length, 1)
    assert.equal(payments[0]!.note, 'found by lookup')
  } finally {
    await node.stop()
  }
})

test('a browser payee (WebSockets only) is found through the server\'s DHT and paid', async () => {
  const { node } = await createBrowserNode({ payee: true, relay: server.ws, allowPrivateAddresses: true })
  try {
    await waitUntilReachable(node)
    const { payments, result } = await payTo(node)
    assert.equal(result.status, 'completed')
    assert.equal(payments[0]!.paidSats, 2500)
  } finally {
    await node.stop()
  }
})

test('without identify push the server never learns the relay address: the app cannot find the payee', async () => {
  const node = await createLibp2p({
    addresses: { listen: ['/p2p-circuit'] },
    transports: [udx(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping() }
  })
  try {
    await node.dial(multiaddr(server.udx))
    await waitUntilReachable(node)
    await new Promise(resolve => setTimeout(resolve, 1000))
    assert.equal(await lookUp(node.peerId.toString()), null)
  } finally {
    await node.stop()
  }
})
