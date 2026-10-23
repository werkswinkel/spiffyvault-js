/** A mock payee behind a local go-ricochet's circuit relay, and payer nodes, for the live tests. */

import type { Libp2p } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import { createPaymentNode } from '../../src/node.ts'
import { MockPayee } from '../support/mock-payee.ts'
import type { MockPayeeOptions } from '../support/mock-payee.ts'

export interface RelayedPayee { node: Libp2p, payee: MockPayee, peerId: string, stop: () => Promise<void> }

/** A payee that listens only through the relay (a reservation), like the phone. */
export async function relayedPayee (relayUdx: string, opts: MockPayeeOptions = {}): Promise<RelayedPayee> {
  // '/p2p-circuit' asks for a reservation on any connected relay. The
  // '<relay>/p2p-circuit' form is refused: multiaddr-matcher does not know /udx.
  const { node } = await createPaymentNode({ udxOnly: true, listen: ['/p2p-circuit'] })
  await node.dial(multiaddr(relayUdx))
  const deadline = Date.now() + 20_000
  while (!node.getMultiaddrs().some(a => a.toString().includes('/p2p-circuit'))) {
    if (Date.now() > deadline) throw new Error('no relay reservation')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const payee = new MockPayee(node, opts)
  await payee.start()
  return { node, payee, peerId: node.peerId.toString(), stop: async () => { await payee.stop(); await node.stop() } }
}
