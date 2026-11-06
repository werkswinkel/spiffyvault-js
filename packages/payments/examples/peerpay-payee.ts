/**
 * README example: being paid by PeerPay (BRC-29 over MessageBox).
 * test/unit/examples.test.ts runs it against an in-memory inbox.
 */

import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import type { Broadcaster, PeerPayInbox, PeerPayPayee } from '@spiffyvault/payments'
// #region peerpay-payee-imports
import { acceptPeerPayPayments } from '@spiffyvault/payments'
// #endregion

export async function startPeerPayPayee (wallet: WalletInterface,
  checks: { client: PeerPayInbox, chainTracker: ChainTracker, broadcaster: Broadcaster }): Promise<PeerPayPayee> {
  // #region peerpay-payee
  const payee = await acceptPeerPayPayments({
    network: 'testnet',
    wallet, // its identity key is the payment key payers pay; it signs in to the message box
    onPayment: async p => {
      // On the network now. Take it in; if this throws, the message stays and is offered again.
      await wallet.internalizeAction({
        tx: Array.from(p.atomicBeef),
        outputs: p.outputs.map(o => ({
          outputIndex: o.outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: { derivationPrefix: o.derivationPrefix, derivationSuffix: o.derivationSuffix, senderIdentityKey: o.senderIdentityKey }
        })),
        description: 'PeerPay payment'
      })
    },
    onEvent: e => { console.log(`PeerPay payee: ${e.kind}${e.kind === 'error' ? ` (${e.error})` : ''}`) },
    ...checks // the tests use a stand-in inbox, chain and broadcaster; the defaults are BSVA's message box, WhatsOnChain and Arcade
  })
  // #endregion
  return payee
}
