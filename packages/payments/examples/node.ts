/**
 * README example: pay a SpiffyVault link from Node.js with a BRC-100 wallet.
 * The integration tests run nodePay() against a local go-ricochet.
 */

// #region node-imports
import { RicochetClient } from '@stephanfeb/ricochet/node'
import { SPIFFYVAULT_RICOCHET, createPaymentNode, pay } from '@spiffyvault/payments/node'
import type { WalletInterface } from '@bsv/sdk'
// #endregion

export async function nodePay (link: string, wallet: WalletInterface,
  server: { peerId: string, addr: string } = { peerId: SPIFFYVAULT_RICOCHET.peerId, addr: SPIFFYVAULT_RICOCHET.udxIp }): Promise<string> {
  // #region node
  // One libp2p node: the payer's peer ID for both the live and the offline path.
  const { node } = await createPaymentNode()
  const ricochet = new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.addr] }] })
  try {
    const result = await pay({ link }, {
      wallet, // any BRC-100 WalletInterface: it builds and signs, you never see keys
      libp2p: node, // live: through the server's circuit relay
      relays: [server.addr],
      ricochet, // offline: the payee's Ricochet mailbox
      onProgress: p => console.log(`[${p.path}] ${p.step}`)
    })
    console.log(`${result.status} by ${result.path}: ${result.txid}`)
    return result.path
  } finally {
    await ricochet.close()
    await node.stop()
  }
  // #endregion
}
