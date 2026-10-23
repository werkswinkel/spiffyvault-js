/**
 * What the SpiffyVault payee does with a collected offline payment, up to
 * (not including) SPV and broadcast: decrypt, parse, check the envelope
 * sender, re-derive each destination from its own anchor key, and find the
 * outputs that pay it (lib/services/offline_payment_service.dart:839-961,
 * libspiffy wallet_keys.dart / spv_actor.dart).
 */

import { P2PKH, PrivateKey, PublicKey, Transaction } from '@bsv/sdk'
import type { PayeeIdentity, PayeePrekeys } from './payee.ts'
import { openPreKeyMessage } from './payee.ts'
import { fromHex, fromUtf8, inspectBeefV1, parseOfflineMessage } from './internals.ts'
import type { OfflinePaymentMessage } from '../../src/index.ts'

export interface Collected {
  message: OfflinePaymentMessage
  paidSats: number
  txid: string
}

export function collectOfflinePayment (id: PayeeIdentity, keys: PayeePrekeys, anchorPriv: PrivateKey,
  envelope: { senderPeerId: string, payload: Uint8Array }): Collected {
  const message = parseOfflineMessage(JSON.parse(fromUtf8(openPreKeyMessage(id, keys, envelope.payload))))
  if (message.senderPeerId !== envelope.senderPeerId) throw new Error('inner sender is not the envelope sender')
  const beef = fromHex(message.beefHex)
  const info = inspectBeefV1(beef) // V1, subject last, no txid-only entries
  if (info.txid !== message.txid) throw new Error('txid is not the last transaction')
  const tx = Transaction.fromBEEF(Array.from(beef))
  const ours = new Set<string>()
  for (const d of message.type42Derivations) {
    if (d.anchorPublicKey !== anchorPriv.toPublicKey().toString()) throw new Error('not our anchor')
    const child = anchorPriv.deriveChild(PublicKey.fromString(d.senderPublicKey), d.invoiceNumber)
    ours.add(new P2PKH().lock(child.toPublicKey().toHash() as number[]).toHex())
  }
  const paidSats = tx.outputs.filter(o => ours.has(o.lockingScript.toHex())).reduce((s, o) => s + (o.satoshis ?? 0), 0)
  if (paidSats === 0) throw new Error('the transaction pays none of our addresses')
  return { message, paidSats, txid: info.txid }
}
