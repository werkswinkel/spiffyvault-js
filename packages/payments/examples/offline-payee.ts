/**
 * README example: being paid while the payee is away (the offline path).
 * test/unit/examples.test.ts runs it against an in-memory Ricochet server.
 */

import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import type { Broadcaster, OfflinePayee, OfflinePayeeStore, PayeeRicochet } from '@spiffyvault/payments'
import type { Ed25519PrivateKeyLike } from '@go-ricochet/ricochet/core'
// #region offline-payee-imports
import { acceptOfflinePayments } from '@spiffyvault/payments'
// #endregion

export async function startOfflinePayee (ricochet: PayeeRicochet, privateKey: Ed25519PrivateKeyLike, wallet: WalletInterface, store: OfflinePayeeStore,
  checks: { chainTracker: ChainTracker, broadcaster: Broadcaster }): Promise<OfflinePayee> {
  // #region offline-payee
  const payee = await acceptOfflinePayments({
    network: 'testnet',
    ricochet, // a RicochetClient on the node that takes live payments, so payers find one peer ID
    identityKey: privateKey, // that node's key: it signs the bundle, the one-time keys and the anchor record
    wallet, // the payments go to this BRC-100 wallet; its identity key is the anchor
    store, // keys and opened payments: offlinePayeeFileStore(path) in Node.js
    onPayment: async p => {
      // On the network now. Take it in; if this throws, the payment is offered again on the next pass.
      await wallet.internalizeAction({
        tx: p.transaction.toAtomicBEEF(),
        outputs: p.outputs.map(o => ({
          outputIndex: o.outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: { derivationPrefix: o.derivationPrefix, derivationSuffix: o.derivationSuffix, senderIdentityKey: o.senderIdentityKey }
        })),
        description: 'Offline payment'
      })
    },
    onEvent: e => { console.log(`offline payee: ${e.kind}${e.kind === 'error' ? ` (${e.error})` : ''}`) },
    ...checks // the tests use a stand-in chain and broadcaster; the defaults are WhatsOnChain and Arcade
  })
  // #endregion
  return payee
}
