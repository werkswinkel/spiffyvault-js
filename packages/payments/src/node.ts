/**
 * Node.js and Electron (main process) entry: everything in core, plus
 * createPaymentNode() for a js-libp2p node with UDX, WebSockets and the
 * circuit relay transport (`payee: true` makes it payable through the
 * relay, with acceptLivePayments), and resolveDnsAddrs() (UDX dials IPs only).
 */

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { identify, identifyPush } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { webSockets } from '@libp2p/websockets'
// The package root registers the udx multiaddr codec and brings the transport (Node.js 22).
import { udx } from '@go-ricochet/libp2p-udx'
import { createLibp2p } from 'libp2p'
import { multiaddr } from '@multiformats/multiaddr'
import type { Libp2p, PrivateKey } from '@libp2p/interface'
import { resolveDnsAddrs } from '@go-ricochet/ricochet/node'
import { SPIFFYVAULT_RICOCHET } from './networks.ts'

export { resolveDnsAddrs }
export * from './core.ts'

export interface PaymentNodeOptions {
  /** The node's identity (the payer's peer ID); a new Ed25519 key when left out. */
  privateKey?: PrivateKey
  /** Addresses to listen on; default none (a payer need not listen). */
  listen?: string[]
  /** Leave out WebSockets and run UDX only. */
  udxOnly?: boolean
  /**
   * Be payable: keep a reservation on the relay, so payers reach this node
   * through it as they reach a phone. Pair with acceptLivePayments().
   */
  payee?: boolean
  /** The relay to be reached through. Default SpiffyVault's Ricochet server over UDX (resolved first). */
  relay?: string
}

export interface PaymentNodeResult {
  node: Libp2p
  privateKey: PrivateKey
}

/**
 * A started js-libp2p node for Node.js: UDX (+ WebSockets), circuit relay,
 * Noise, Yamux, identify and identify push, ping. With `payee: true` it
 * dials the relay and listens through it.
 *
 * Identify push matters to a payee: the first identify with the server runs
 * before the reservation exists, and the server's DHT, which the app asks
 * to find a payee, knows only the addresses the payee pushes afterwards.
 */
export async function createPaymentNode (options: PaymentNodeOptions = {}): Promise<PaymentNodeResult> {
  const privateKey = options.privateKey ?? await generateKeyPair('Ed25519')
  // '/p2p-circuit' asks for a reservation on any connected relay (the
  // '<relay>/p2p-circuit' form is refused: multiaddr-matcher does not know /udx).
  const listen = [...(options.listen ?? []), ...(options.payee === true ? ['/p2p-circuit'] : [])]
  const node = await createLibp2p({
    privateKey,
    addresses: { listen },
    transports: options.udxOnly === true ? [udx(), circuitRelayTransport()] : [udx(), webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), identifyPush: identifyPush(), ping: ping() }
  })
  if (options.payee === true) {
    const relay = options.relay ?? SPIFFYVAULT_RICOCHET.udx
    const [addr] = relay.includes('/dns4/') ? await resolveDnsAddrs([relay]) : [relay]
    if (addr === undefined) throw new Error(`The relay ${relay} did not resolve`)
    await node.dial(multiaddr(addr))
  }
  return { node, privateKey }
}
