/**
 * Browser entry: everything in core, plus createPaymentNode() for a
 * js-libp2p node that reaches the Ricochet server over WebSockets (WSS)
 * and the payee's phone through the server's circuit relay; with
 * `payee: true` it can be paid the same way (acceptLivePayments).
 */

// First: Ricochet and the phones advertise /udx addresses; without the codec
// js-libp2p's identify fails with "Protocol 768 was unknown". Browser-safe.
import '@go-ricochet/libp2p-udx/multiaddr'

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { identify, identifyPush } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webSockets } from '@libp2p/websockets'
import { createLibp2p } from 'libp2p'
import type { Libp2p, PrivateKey } from '@libp2p/interface'
import { SPIFFYVAULT_RICOCHET } from './networks.ts'

export * from './core.ts'

export interface PaymentNodeOptions {
  /** The node's identity (the payer's peer ID); a new Ed25519 key when left out. */
  privateKey?: PrivateKey
  /** Allow loopback and private addresses (browsers refuse them by default). For tests. */
  allowPrivateAddresses?: boolean
  /**
   * Be payable: keep a reservation on the relay, so payers reach this node
   * through it as they reach a phone. Pair with acceptLivePayments().
   */
  payee?: boolean
  /** The relay to be reached through, its WSS address. Default SpiffyVault's Ricochet server. */
  relay?: string
}

export interface PaymentNodeResult {
  node: Libp2p
  privateKey: PrivateKey
}

/**
 * A started js-libp2p node for the browser: WebSockets, circuit relay,
 * Noise, Yamux, identify and identify push, ping. With `payee: true` it
 * listens through the relay.
 *
 * Identify push matters to a payee: the first identify with the server runs
 * before the reservation exists, and the server's DHT, which the app asks
 * to find a payee, knows only the addresses the payee pushes afterwards.
 */
export async function createPaymentNode (options: PaymentNodeOptions = {}): Promise<PaymentNodeResult> {
  const privateKey = options.privateKey ?? await generateKeyPair('Ed25519')
  const node = await createLibp2p({
    privateKey,
    ...(options.payee === true ? { addresses: { listen: [`${options.relay ?? SPIFFYVAULT_RICOCHET.wss}/p2p-circuit`] } } : {}),
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    ...(options.allowPrivateAddresses === true ? { connectionGater: { denyDialMultiaddr: async () => false } } : {}),
    services: { identify: identify(), identifyPush: identifyPush(), ping: ping() }
  })
  return { node, privateKey }
}
