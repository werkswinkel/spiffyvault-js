/**
 * The SpiffyVault payee's check of a PeerPay token
 * (lib/services/brc100/peerpay_token.dart, peerpay_service.dart): derive our
 * BRC-29 key for (sender, prefix, suffix); the Atomic BEEF has no txid-only
 * entries; output `outputIndex` (default 0) is P2PKH to that key with
 * exactly `amount` satoshis.
 */

import { Beef, P2PKH, PublicKey, Transaction } from '@bsv/sdk'
import type { ProtoWallet } from '@bsv/sdk'

export async function payeeAcceptsToken (payee: ProtoWallet, senderIdentityKey: string, token: unknown): Promise<{ txid: string, amount: number }> {
  const t = token as { customInstructions: { derivationPrefix: string, derivationSuffix: string }, transaction: number[], amount: number, outputIndex?: number }
  const { derivationPrefix: p, derivationSuffix: s } = t.customInstructions
  if (p.length < 1 || p.length > 399 || /\s/.test(p) || s.length < 1 || s.length > 399 || /\s/.test(s)) throw new Error('bad prefix or suffix')
  if (!Number.isInteger(t.amount) || t.amount <= 0) throw new Error('bad amount')
  const { publicKey } = await payee.getPublicKey({ protocolID: [2, '3241645161d8'], keyID: `${p} ${s}`, counterparty: senderIdentityKey, forSelf: true })
  const beef = Beef.fromBinary(t.transaction)
  if (beef.txs.some(x => x.isTxidOnly)) throw new Error('txid-only entry')
  const tx = Transaction.fromAtomicBEEF(t.transaction)
  const out = tx.outputs[t.outputIndex ?? 0]
  const want = new P2PKH().lock(PublicKey.fromString(publicKey).toHash() as number[]).toHex()
  if (out === undefined || out.lockingScript.toHex() !== want || out.satoshis !== t.amount) throw new Error('output does not pay the payee')
  return { txid: tx.id('hex'), amount: t.amount }
}
