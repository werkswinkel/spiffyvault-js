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
// #region orders-imports
import { refInNote } from '@spiffyvault/payments'
import type { LiveInvoiceRequest } from '@spiffyvault/payments'
// #endregion
// #region widget-page-imports
import { mountPayment } from '@spiffyvault/payments/widget'
// #endregion

export interface Order { id: string, totalSats: number, ref?: string, paidTxid?: string }

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
  order.ref = request.ref
  return request
}

/** What `GET /orders/:id/payment` answers. */
export function statusOf (order: Order): RequestStatus {
  // #region widget-status
  // Your payee's onPayment marks the order paid (orderPaid, below); until then the link
  // is still shown. Answer only the browser that placed the order: a status carries the txid.
  return order.paidTxid !== undefined
    ? { id: order.id, step: 'paid', path: 'live', txid: order.paidTxid }
    : { id: order.id, step: 'shown' }
  // #endregion
}

/** Open orders by their request's ref: your database. */
export type Orders = Map<string, Order>

/** The live payee's `screen`: a reason to refuse the invoice request, or undefined to invoice it. */
export function screenOrder (orders: Orders, request: LiveInvoiceRequest): string | undefined {
  // #region orders-screen
  // The payer's app sets the amount and the note. The link tells an honest app what to
  // send; nothing makes a payer follow it. So the request must name an open order, unpaid,
  // and ask its total.
  const order = orders.get(refInNote(request.note) ?? '')
  if (order === undefined) return 'Pay from the order’s pay screen.'
  if (order.paidTxid !== undefined) return `Order ${order.id} is paid.`
  if (request.amountSats !== order.totalSats) return `Order ${order.id} is for ${order.totalSats} sats.`
  return undefined
  // #endregion
}

/**
 * Called from onPayment on every path (live, PeerPay, offline), after the coin
 * is kept. True when the payment pays the order.
 */
export function orderPaid (orders: Orders, p: { txid: string, note?: string, paidSats: number }): boolean {
  // #region orders-paid
  // Check again here: PeerPay and offline payments never pass screen, and a payment can
  // come twice (after a restart). Keep the coin first, whatever this says.
  const order = orders.get(refInNote(p.note) ?? '')
  if (order === undefined) return false // no order: the coin is yours, the payer may ask for it
  if (order.paidTxid === p.txid) return true // the same payment again
  if (order.paidTxid !== undefined) return false // paid already, by another payment: refund it
  if (p.paidSats < order.totalSats) return false // too little: refund it, or ask for the rest
  order.paidTxid = p.txid // in your database, in the same transaction as the kept coin
  return true
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
