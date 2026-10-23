/**
 * Node.js and Electron (main process) entry: everything in core, plus
 * createPaymentNode() for a js-libp2p node with UDX, WebSockets and the
 * circuit relay transport, and resolveDnsAddrs() (UDX dials IPs only).
 */

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webSockets } from '@libp2p/websockets'
// The package root registers the udx multiaddr codec and brings the transport (Node.js 22).
import { udx } from '@stephanfeb/libp2p-udx'
import { createLibp2p } from 'libp2p'
import type { Libp2p, PrivateKey } from '@libp2p/interface'

export { resolveDnsAddrs } from '@stephanfeb/ricochet/node'
export * from './core.ts'

export interface PaymentNodeOptions {
  /** The node's identity (the payer's peer ID); a new Ed25519 key when left out. */
  privateKey?: PrivateKey
  /** Addresses to listen on; default none (a payer need not listen). */
  listen?: string[]
  /** Leave out WebSockets and run UDX only. */
  udxOnly?: boolean
}

export interface PaymentNodeResult {
  node: Libp2p
  privateKey: PrivateKey
}

/** A started js-libp2p node for Node.js: UDX (+ WebSockets), circuit relay (dial only), Noise, Yamux, identify, ping. */
export async function createPaymentNode (options: PaymentNodeOptions = {}): Promise<PaymentNodeResult> {
  const privateKey = options.privateKey ?? await generateKeyPair('Ed25519')
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: options.listen ?? [] },
    transports: options.udxOnly === true ? [udx(), circuitRelayTransport()] : [udx(), webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping() }
  })
  return { node, privateKey }
}
