/**
 * README examples: links, per-path calls, a lower-level funder, errors.
 * test/unit/examples.test.ts runs them.
 */

import type { WalletInterface } from '@bsv/sdk'
import type { MessageBoxSender, RicochetLike } from '@spiffyvault/payments'
// #region link-imports
import { linkMismatch, noteToSend, parsePaymentLink } from '@spiffyvault/payments'
// #endregion
// #region perpath-imports
import { payOffline, payViaPeerPay } from '@spiffyvault/payments'
// #endregion
// #region funder-imports
import type { Funder } from '@spiffyvault/payments'
// #endregion
// #region domain-imports
import { checkPayeeDomain, domainEntry, domainFileText } from '@spiffyvault/payments'
import type { DomainFetch, PaymentLink, PeerKeySigner } from '@spiffyvault/payments'
// #endregion
// #region signed-imports
import { formatPaymentLink, linkSignatureValid, signPaymentLink } from '@spiffyvault/payments'
// #endregion
// #region errors-imports
import { PaymentError } from '@spiffyvault/payments'
// #endregion

export function readLink (text: string): { network: string, peerId?: string, note?: string, wrongNetwork: boolean } | null {
  // #region link
  const link = parsePaymentLink(text) // null when it is not a valid SpiffyVault link
  if (link === null) return null
  const wrongNetwork = linkMismatch(link, 'mainnet') !== null // a testnet link from a mainnet wallet
  const note = noteToSend(link, link.memo) // adds "ref <r>" for a payment-request link
  // #endregion
  return { network: link.network, ...(link.peerId !== undefined ? { peerId: link.peerId } : {}), ...(note !== undefined ? { note } : {}), wrongNetwork }
}

/** The line to show above a payment, or null when the link must not be paid. */
export async function payeeLine (link: PaymentLink, fetch?: DomainFetch): Promise<string | null> {
  if (link.domain === undefined) return 'Not verified: check who you are paying'
  // #region domain
  const check = await checkPayeeDomain({
    domain: link.domain,
    network: link.network,
    ...(link.peerId !== undefined ? { peerId: link.peerId } : {}),
    ...(link.paymentKey !== undefined ? { paymentKey: link.paymentKey } : {}),
    ...(fetch !== undefined ? { fetch } : {})
  })
  if (!check.verified) return null // refuse: check.problem says why ('not-listed', 'unreachable', …)
  return `${check.name ?? check.domain} · verified for ${check.domain}`
  // #endregion
}

/** A shop's server writes its file with the payee's libp2p Ed25519 key. */
export async function shopFile (peerKey: PeerKeySigner, peerId: string, paymentKey: string): Promise<string> {
  // #region domain-entry
  const entry = await domainEntry({ domain: 'shop.example', peerId, paymentKey, networks: ['mainnet'], name: 'Corner Shop' }, peerKey)
  const file = domainFileText([entry]) // serve at https://shop.example/.well-known/spiffyvault.json
  // #endregion
  return file
}

/** A server signs the link it hands out with the payee's libp2p Ed25519 key. */
export async function signedLink (peerKey: PeerKeySigner, peerId: string): Promise<{ text: string, valid: boolean }> {
  // #region signed
  const link = await signPaymentLink({ network: 'mainnet', peerId, amountSats: 2500, memo: 'Order 1042' }, peerKey)
  const text = formatPaymentLink(link) // …&s=<signature>: changing any field now fails the check
  const valid = linkSignatureValid(link) // a payer's check; pay() makes it too
  // #endregion
  return { text, valid }
}

export async function perPath (wallet: WalletInterface, ricochet: RicochetLike, payeePeerId: string, paymentKey: string, client?: MessageBoxSender): Promise<string[]> {
  // #region perpath
  const offline = await payOffline({ payeePeerId, amountSats: 1000, note: 'Coffee', network: 'testnet' }, { wallet, ricochet })
  const peerpay = await payViaPeerPay({ paymentKey, amountSats: 1000, note: 'Coffee' }, {
    wallet,
    host: 'https://messagebox.bsvblockchain.tech', // the default; set your own here
    ...(client !== undefined ? { client } : {}) // the tests deliver to a stand-in
  })
  // #endregion
  return [offline.status, peerpay.status]
}

export function makeFunder (build: (outputs: Array<{ lockingScript: string, satoshis: number }>) => Promise<Uint8Array>, release: () => Promise<void>): Funder {
  // #region funder
  // For a wallet that is not BRC-100: build, sign, do NOT broadcast, return BEEF.
  const funder: Funder = async (outputs, info) => {
    // outputs: [{ lockingScript (hex), satoshis, address? }]; info.broadcast is false
    // for live and offline (the payee broadcasts). PeerPay needs a BRC-100 wallet.
    const beef = await build(outputs) // BEEF V1 preferred; V2 and Atomic BEEF are converted
    return { beef, abort: release } // abort(): the payment was given up before it left
  }
  // #endregion
  return funder
}

export async function handle (attempt: () => Promise<unknown>): Promise<string> {
  // #region errors
  try {
    await attempt()
    return 'paid'
  } catch (e) {
    if (!(e instanceof PaymentError)) throw e
    if (e.canPayAnotherWay) return `nothing left; safe to try again or another way (${e.code})`
    // The payee may hold the transaction: never pay again; watch e.txid.
    return `do not pay again: ${e.code} ${e.txid ?? ''}`
  }
  // #endregion
}
