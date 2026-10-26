/**
 * Runs in Chromium, bundled from the browser entry. The tests call
 * window.liveFlow() / window.offlineFlow() and check what they return.
 */

import { RicochetClient } from '@go-ricochet/ricochet/core'
import type { WalletInterface } from '@bsv/sdk'
import { createPaymentNode, payLive, payOffline, isPaymentError } from '../../src/browser.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { browserPay } from '../../examples/browser.ts'

export interface FlowOutcome {
  ok: boolean
  txid?: string
  status?: string
  code?: string
  message?: string
  payerPeerId: string
  relayAddr?: string
  payeeAddr?: string
  limited?: boolean
}

function failure (e: unknown, payerPeerId: string): FlowOutcome {
  return { ok: false, payerPeerId, ...(isPaymentError(e) ? { code: e.code } : {}), message: e instanceof Error ? e.message : String(e) }
}

async function liveFlow (a: { relay: string, relayPeerId: string, payeePeerId: string, amountSats: number }): Promise<FlowOutcome> {
  const { node } = await createPaymentNode({ allowPrivateAddresses: true })
  const payerPeerId = node.peerId.toString()
  try {
    const r = await payLive({ payeePeerId: a.payeePeerId, amountSats: a.amountSats, note: 'from Chrome', network: 'testnet' },
      { wallet: new FakeWallet() as unknown as WalletInterface, libp2p: node, relays: [a.relay] })
    const relay = node.getConnections().find(c => c.remotePeer.toString() === a.relayPeerId)
    const payee = node.getConnections().find(c => c.remotePeer.toString() === a.payeePeerId)
    return {
      ok: true, txid: r.txid, status: r.status, payerPeerId,
      ...(relay !== undefined ? { relayAddr: relay.remoteAddr.toString() } : {}),
      ...(payee !== undefined ? { payeeAddr: payee.remoteAddr.toString(), limited: payee.limits !== undefined } : {})
    }
  } catch (e) {
    return failure(e, payerPeerId)
  } finally {
    await node.stop()
  }
}

async function offlineFlow (a: { serverPeerId: string, addr: string, payeePeerId: string, amountSats: number }): Promise<FlowOutcome & { messageId?: string }> {
  const { node, privateKey } = await createPaymentNode({ allowPrivateAddresses: true })
  const payerPeerId = node.peerId.toString()
  const ricochet = new RicochetClient(node, { servers: [{ peerId: a.serverPeerId, addrs: [a.addr] }] })
  try {
    const r = await payOffline({ payeePeerId: a.payeePeerId, amountSats: a.amountSats, note: 'offline from Chrome', network: 'testnet' },
      { wallet: new FakeWallet() as unknown as WalletInterface, ricochet, identityKey: privateKey })
    return { ok: true, txid: r.txid, status: r.status, payerPeerId, ...(r.messageId !== undefined ? { messageId: r.messageId } : {}), relayAddr: node.getConnections()[0]?.remoteAddr.toString() ?? '' }
  } catch (e) {
    return failure(e, payerPeerId)
  } finally {
    await ricochet.close()
    await node.stop()
  }
}

/** The README browser example, with a stand-in wallet. */
async function exampleFlow (a: { link: string, peerId: string, wss: string }): Promise<{ path: string, txid: string }> {
  return await browserPay(a.link, new FakeWallet() as unknown as WalletInterface, { peerId: a.peerId, wss: a.wss }, { allowPrivateAddresses: true })
}

declare global {
  interface Window {
    liveFlow: typeof liveFlow
    offlineFlow: typeof offlineFlow
    exampleFlow: typeof exampleFlow
  }
}

window.liveFlow = liveFlow
window.offlineFlow = offlineFlow
window.exampleFlow = exampleFlow
document.title = 'ready'
