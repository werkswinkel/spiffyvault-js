/**
 * README example: pay from a web page. The Chrome test runs browserPay().
 */

// #region browser-imports
import { RicochetClient } from '@go-ricochet/ricochet/browser'
import { SPIFFYVAULT_RICOCHET, createPaymentNode, pay } from '@spiffyvault/payments/browser'
import type { WalletInterface } from '@bsv/sdk'
// #endregion

export async function browserPay (link: string, wallet: WalletInterface,
  server: { peerId: string, wss: string } = { peerId: SPIFFYVAULT_RICOCHET.peerId, wss: SPIFFYVAULT_RICOCHET.wss },
  nodeOptions: { allowPrivateAddresses?: boolean } = {}): Promise<{ path: string, txid: string }> {
  // #region browser
  // WebSockets only: the page reaches the Ricochet server over WSS, and the
  // payee's phone (UDX) through the server's circuit relay.
  const { node, privateKey } = await createPaymentNode(nodeOptions) // tests allow loopback addresses here
  const ricochet = new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.wss] }] })
  try {
    const { path, txid } = await pay({ link }, { wallet, libp2p: node, relays: [server.wss], ricochet, identityKey: privateKey })
    return { path, txid }
  } finally {
    await ricochet.close()
    await node.stop()
  }
  // #endregion
}
