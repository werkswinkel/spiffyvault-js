/**
 * Browser entry: everything in core, plus createPaymentNode() for a
 * js-libp2p node that reaches the Ricochet server over WebSockets (WSS)
 * and the payee's phone through the server's circuit relay.
 */

// First: Ricochet and the phones advertise /udx addresses; without the codec
// js-libp2p's identify fails with "Protocol 768 was unknown". Browser-safe.
import '@stephanfeb/libp2p-udx/multiaddr'

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webSockets } from '@libp2p/websockets'
import { createLibp2p } from 'libp2p'
import type { Libp2p, PrivateKey } from '@libp2p/interface'

export * from './core.ts'

export interface PaymentNodeOptions {
  /** The node's identity (the payer's peer ID); a new Ed25519 key when left out. */
  privateKey?: PrivateKey
  /** Allow loopback and private addresses (browsers refuse them by default). For tests. */
  allowPrivateAddresses?: boolean
}

export interface PaymentNodeResult {
  node: Libp2p
  privateKey: PrivateKey
}

/** A started js-libp2p node for the browser: WebSockets, circuit relay (dial only), Noise, Yamux, identify, ping. */
export async function createPaymentNode (options: PaymentNodeOptions = {}): Promise<PaymentNodeResult> {
  const privateKey = options.privateKey ?? await generateKeyPair('Ed25519')
  const node = await createLibp2p({
    privateKey,
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    ...(options.allowPrivateAddresses === true ? { connectionGater: { denyDialMultiaddr: async () => false } } : {}),
    services: { identify: identify(), ping: ping() }
  })
  return { node, privateKey }
}
