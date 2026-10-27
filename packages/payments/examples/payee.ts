/**
 * README example: be paid live, as a phone is, from Node.js or a browser.
 * The integration tests run till() against a local go-ricochet and pay it
 * with the Node example.
 */

// #region payee-imports
import { acceptLivePayments, createPaymentNode, formatPaymentLink, signPaymentLink, waitUntilReachable } from '@spiffyvault/payments/node'
import type { LivePayeeOptions, ReceivedLivePayment } from '@spiffyvault/payments/node'
// #endregion

export async function till (addressFor: (invoiceId: string) => string, keep: (p: ReceivedLivePayment) => void,
  relay?: string, checks: Pick<LivePayeeOptions, 'chainTracker' | 'broadcaster'> = {}): Promise<{ link: string, stop: () => Promise<void> }> {
  // #region payee
  // A reservation on the relay, and identify push, so the app finds this peer ID.
  const { node, privateKey } = await createPaymentNode({ payee: true, ...(relay !== undefined ? { relay } : {}) })
  await waitUntilReachable(node)
  const payee = await acceptLivePayments(node, {
    network: 'testnet',
    invoiceAddress: r => addressFor(r.invoiceId), // a new address per invoice, one you can spend
    onPayment: p => { keep(p) }, // checked by SPV and seen on the network: keep p.beefV1 and p.vouts, once per txid
    onEvent: e => { console.log(`payee: ${e.kind}`) }, // 'keep-failed' and 'unsettled' carry a payment to keep or watch
    ...checks // the tests use a stand-in chain and broadcaster; the defaults are WhatsOnChain and ARC
  })
  // The app pays this link live, and refuses it if anyone changes it.
  const link = formatPaymentLink(await signPaymentLink({ network: 'testnet', peerId: node.peerId.toString(), amountSats: 2500 }, privateKey))
  // #endregion
  return { link, stop: async () => { await payee.stop(); await node.stop() } }
}
