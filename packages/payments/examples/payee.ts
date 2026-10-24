/**
 * README example: be paid live, as a phone is, from Node.js or a browser.
 * The integration tests run till() against a local go-ricochet and pay it
 * with the Node example.
 */

// #region payee-imports
import { acceptLivePayments, createPaymentNode, formatPaymentLink, waitUntilReachable } from '@spiffyvault/payments/node'
import type { LivePayeeOptions, ReceivedLivePayment } from '@spiffyvault/payments/node'
// #endregion

export async function till (addressFor: (invoiceId: string) => string, keep: (p: ReceivedLivePayment) => void,
  relay?: string, checks: Pick<LivePayeeOptions, 'chainTracker' | 'broadcaster'> = {}): Promise<{ link: string, stop: () => Promise<void> }> {
  // #region payee
  // A reservation on the relay, and identify push, so the app finds this peer ID.
  const { node } = await createPaymentNode({ payee: true, ...(relay !== undefined ? { relay } : {}) })
  await waitUntilReachable(node)
  const payee = await acceptLivePayments(node, {
    network: 'testnet',
    invoiceAddress: r => addressFor(r.invoiceId), // a new address per invoice, one you can spend
    onPayment: p => { keep(p) }, // checked by SPV and on the network: keep p.beefV1 and p.vouts
    onEvent: e => { console.log(`payee: ${e.kind}`) },
    ...checks // the tests use a stand-in chain and broadcaster; the defaults are WhatsOnChain and ARC
  })
  // The app pays this link live; signPaymentLink() adds a signature.
  const link = formatPaymentLink({ network: 'testnet', peerId: node.peerId.toString(), amountSats: 2500 })
  // #endregion
  return { link, stop: async () => { await payee.stop(); await node.stop() } }
}
