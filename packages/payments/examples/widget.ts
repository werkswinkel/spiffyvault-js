/**
 * README examples: taking payments on a web page with the widget. The
 * server part makes a request for an order; the page part mounts the
 * widget. test/unit/examples.test.ts runs the server part and
 * test/browser/widget.test.ts runs the page part.
 */

import type { PeerKeySigner } from '@spiffyvault/payments'
// #region widget-server-imports
import { createPaymentRequest } from '@spiffyvault/payments'
import type { PaymentRequest, RequestStatus } from '@spiffyvault/payments'
// #endregion
// #region widget-page-imports
import { mountPayment } from '@spiffyvault/payments/widget'
// #endregion

export interface Order { id: string, totalSats: number, paidTxid?: string }

/** The payee: the peer ID and key of a node running acceptLivePayments. */
export interface Payee { peerId: string, paymentKey: string, privateKey: PeerKeySigner }

/** What `POST /orders/:id/payment` answers. */
export async function paymentFor (order: Order, payee: Payee): Promise<PaymentRequest> {
  // #region widget-server
  // The payee's links for this order: live, signed with its peer key, and PeerPay.
  const request = await createPaymentRequest(
    { network: 'testnet', peerId: payee.peerId, paymentKey: payee.paymentKey, signer: payee.privateKey, domain: 'shop.example' },
    { id: order.id, amountSats: order.totalSats, memo: `Order ${order.id}` }
  )
  // Keep request.ref with the order: the payer's note carries it ("ref K7Q2M9XD"),
  // so refInNote() matches a payment that arrives late, or by PeerPay, to the order.
  // #endregion
  return request
}

/** What `GET /orders/:id/payment` answers. */
export function statusOf (order: Order): RequestStatus {
  // #region widget-status
  // Your payee's onPayment marks the order paid; until then the link is still shown.
  return order.paidTxid !== undefined
    ? { id: order.id, step: 'paid', path: 'live', txid: order.paidTxid }
    : { id: order.id, step: 'shown' }
  // #endregion
}

export function checkout (orderId: string): () => void {
  // #region widget-page
  const json = async (res: Response): Promise<any> => {
    if (!res.ok) throw new Error(`shop answered ${res.status}`)
    return await res.json()
  }
  const stop = mountPayment(document.getElementById('pay')!, {
    // A new request, or a fresh one when the payer asks again after it expired.
    request: async () => await json(await fetch(`/orders/${orderId}/payment`, { method: 'POST' })),
    status: async id => await json(await fetch(`/orders/${id}/payment`)),
    onPaid: () => { location.assign(`/orders/${orderId}/thanks`) },
    accent: '#0b6e4f'
  })
  // #endregion
  return stop
}
