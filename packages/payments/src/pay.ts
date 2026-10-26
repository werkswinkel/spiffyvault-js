/**
 * pay(): one call that pays a SpiffyVault link, peer or key the way the
 * app's pay-link screen does (lib/screens/pay/pay_link_screen.dart,
 * lib/services/payment_service.dart):
 *
 * - with a peer ID: live first; offline only if live failed before any
 *   transaction was handed over (the payee could not be reached, or sent
 *   no usable invoice); PeerPay after that only when you allow it (the app
 *   offers it to the user, it never falls back to it on its own) and the
 *   link has a key;
 * - with only a payment key: PeerPay.
 *
 * A failure that may have handed a transaction over stops there: the
 * payee is never paid twice.
 *
 * A link that names a domain (`d`) is paid only when the domain's file
 * vouches for the payee (checkPayeeDomain); otherwise DomainError, before
 * anything is asked of the payee.
 *
 * A signed link (`s`) is paid only when the signature checks; otherwise
 * LinkChangedError. An unsigned link with a peer ID never falls back to
 * PeerPay: only the payee's signature ties its key to the peer ID.
 */

import type { Ed25519PrivateKeyLike } from '@go-ricochet/ricochet/core'
import { checkPayeeDomain } from './domain.ts'
import type { DomainFetch } from './domain.ts'
import { DomainError, LinkChangedError, LinkError, PaymentError, isPaymentError } from './errors.ts'
import type { PaymentPath } from './errors.ts'
import { walletNetwork } from './funding.ts'
import {
  linkMismatch, linkSignatureValid, noteToSend, parsePaymentKey, parsePaymentLink, parseRequestRef, paymentKeyMismatch, refusesBareKey
} from './link.ts'
import type { PaymentLink } from './link.ts'
import { payLive } from './live/live.ts'
import type { LivePayContext } from './live/live.ts'
import { canonicalNetwork } from './networks.ts'
import type { Network } from './networks.ts'
import { payOffline } from './offline.ts'
import { payViaPeerPay } from './peerpay.ts'
import type { MessageBoxSender } from './peerpay.ts'
import { isPeerId } from './peer.ts'
import type { RicochetLike } from './ricochet.ts'
import type { SealOptions } from './sessions/seal.ts'
import type { FundingContext, PaymentResult } from './types.ts'

export interface PayRequest {
  /** A payment link (https://spiffyvault.net/pay?… or spiffyvault://pay?…), as text or parsed. */
  link?: string | PaymentLink
  /** Without a link: the payee's peer ID … */
  peerId?: string
  /** … and/or payment key: 66 hex, or `testnet:`/`regtest:` + key as SpiffyVault shares it off mainnet. */
  paymentKey?: string
  /** Without a link: the payee's network. */
  network?: string
  /** Satoshis. A link's `a` wins; a different amount here is refused. */
  amountSats?: number
  /** The payer's note; default the link's `m`. */
  note?: string
  /** Without a link: a payment request reference (the link's `r`). */
  ref?: string
  /** Without a link: the payee's wallet (the link's `w`). */
  walletId?: string
}

export interface PayContext extends FundingContext {
  /** The payer's network. Default: the wallet's (getNetwork); required with only a funder, and for regtest. */
  network?: Network
  /** A RicochetClient for the offline path (SpiffyVault's server). Without it, no offline path. */
  ricochet?: RicochetLike
  /**
   * The Ed25519 private key of the Ricochet client's libp2p node
   * (createPaymentNode returns it): offline payments are sealed from it.
   * Required with `ricochet`.
   */
  identityKey?: Ed25519PrivateKeyLike
  /** A libp2p node with the circuit relay transport for the live path. Without it, no live path. */
  libp2p?: LivePayContext['libp2p']
  /** Relay addresses for the live path (default: SpiffyVault's server, WSS then UDX). */
  relays?: string[]
  /** Live path settings. */
  live?: Pick<LivePayContext, 'split' | 'maxFrameBytes' | 'timeouts'>
  /** Offline path: sealing options (fixed keys for tests). */
  seal?: SealOptions
  /**
   * PeerPay: the message box host (default https://messagebox.bsvblockchain.tech),
   * an optional client, and whether pay() may fall back to it after live
   * and offline failed safely (default false, as in the app).
   */
  peerPay?: { host?: string, client?: MessageBoxSender, fallback?: boolean }
  /** Pay a bare (unlabelled) payment key from a testnet wallet (the app's "Advanced"). */
  allowBareKey?: boolean
  /** How a link's domain file is read (default fetch(): HTTPS, no redirects, 5 s, 16 KiB). */
  domainFetch?: DomainFetch
  signal?: AbortSignal
}

export interface PayPlan {
  network: Network
  peerId?: string
  paymentKey?: string
  amountSats: number
  note?: string
  walletId?: string
  requestRef?: string
  /** The link's domain, which pay() checks before paying. */
  domain?: string
  /** True for a link signed by its payee; undefined without a link. */
  signed?: boolean
}

function prepare (code: 'bad-key' | 'bare-key' | 'amount-invalid' | 'no-route', message: string): PaymentError {
  return new PaymentError(code, message, { stage: 'prepare', canPayAnotherWay: code !== 'bare-key' })
}

/** The checks pay() makes before anything is asked of anyone; returns what it will pay. */
export async function planPayment (req: PayRequest, ctx: Pick<PayContext, 'network' | 'wallet' | 'allowBareKey'>): Promise<PayPlan> {
  let link: PaymentLink | undefined
  if (req.link !== undefined) {
    link = typeof req.link === 'string' ? parsePaymentLink(req.link) ?? undefined : req.link
    if (link === undefined) throw new LinkError('That is not a valid SpiffyVault payment link')
    if (link.signature !== undefined && !linkSignatureValid(link)) throw new LinkChangedError()
  }
  const ours = ctx.network ?? (ctx.wallet !== undefined ? await walletNetwork(ctx.wallet) : undefined)
  if (ours === undefined) throw prepare('no-route', 'The payer network is not known: pass `network` or a BRC-100 wallet')

  let network: Network
  let peerId = link?.peerId
  let paymentKey = link?.paymentKey
  if (link !== undefined) {
    const m = linkMismatch(link, ours)
    if (m !== null) throw m
    network = link.network
  } else {
    if (req.network === undefined) throw prepare('no-route', 'Without a link, give the payee\'s network')
    network = canonicalNetwork(req.network)
    if (network !== canonicalNetwork(ours)) throw linkMismatch({ network }, ours)!
    peerId = req.peerId
    if (peerId !== undefined && !isPeerId(peerId)) throw prepare('bad-key', 'That is not a libp2p peer ID')
    if (req.paymentKey !== undefined) {
      const parsed = parsePaymentKey(req.paymentKey)
      if (parsed === null) throw prepare('bad-key', 'That is not a BRC-100 payment key')
      const mismatch = paymentKeyMismatch(parsed, ours)
      if (mismatch !== null) throw mismatch
      if (refusesBareKey(parsed, ours) && ctx.allowBareKey !== true) {
        throw prepare('bare-key', 'A bare payment key is a mainnet key; this wallet is on testnet. Ask for the key with its testnet: label, or pass allowBareKey.')
      }
      paymentKey = parsed.key
    }
  }
  if (peerId === undefined && paymentKey === undefined) throw prepare('no-route', 'Nothing to pay: no peer ID and no payment key')

  const amountSats = link?.amountSats ?? req.amountSats
  if (link?.amountSats !== undefined && req.amountSats !== undefined && req.amountSats !== link.amountSats) {
    throw prepare('amount-invalid', `The link asks for ${link.amountSats} sats, not ${req.amountSats}`)
  }
  if (amountSats === undefined || !Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw prepare('amount-invalid', 'The amount must be a whole number of satoshis, at least 1')
  }
  const rawRef = link?.requestRef ?? req.ref
  const requestRef = rawRef === undefined ? undefined : parseRequestRef(rawRef) ?? undefined
  if (rawRef !== undefined && requestRef === undefined) throw prepare('amount-invalid', 'That is not a payment request reference')
  const note = noteToSend(requestRef !== undefined ? { requestRef } : {}, req.note ?? link?.memo)
  const walletId = link?.walletId ?? req.walletId
  return {
    network,
    ...(peerId !== undefined ? { peerId } : {}),
    ...(paymentKey !== undefined ? { paymentKey } : {}),
    amountSats,
    ...(note !== undefined ? { note } : {}),
    ...(walletId !== undefined ? { walletId } : {}),
    ...(requestRef !== undefined ? { requestRef } : {}),
    ...(link?.domain !== undefined ? { domain: link.domain } : {}),
    ...(link !== undefined ? { signed: link.signature !== undefined } : {})
  }
}

/** Pays a link, peer or key, choosing the path as the app does. */
export async function pay (req: PayRequest, ctx: PayContext): Promise<PaymentResult> {
  const plan = await planPayment(req, ctx)
  let payeeDomain: PaymentResult['payeeDomain']
  if (plan.domain !== undefined) {
    ctx.onProgress?.({ path: plan.peerId !== undefined ? (ctx.libp2p !== undefined ? 'live' : 'offline') : 'peerpay', step: 'domain', detail: plan.domain })
    const check = await checkPayeeDomain({
      domain: plan.domain,
      network: plan.network,
      ...(plan.peerId !== undefined ? { peerId: plan.peerId } : {}),
      ...(plan.paymentKey !== undefined ? { paymentKey: plan.paymentKey } : {}),
      ...(ctx.domainFetch !== undefined ? { fetch: ctx.domainFetch } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {})
    })
    if (!check.verified) throw new DomainError(check.domain, check.problem)
    payeeDomain = { domain: check.domain, ...(check.name !== undefined ? { name: check.name } : {}) }
  }
  const attempts: PaymentError[] = []
  const funding: FundingContext = {
    ...(ctx.wallet !== undefined ? { wallet: ctx.wallet } : {}),
    ...(ctx.funder !== undefined ? { funder: ctx.funder } : {}),
    ...(ctx.originator !== undefined ? { originator: ctx.originator } : {}),
    ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {})
  }
  const fallback = (from: PaymentPath, to: PaymentPath, e: PaymentError): void => {
    attempts.push(e)
    ctx.onProgress?.({ path: to, step: 'fallback', detail: `${from}: ${e.code}` })
  }
  const attempt = async (path: PaymentPath, run: () => Promise<PaymentResult>): Promise<PaymentResult | PaymentError> => {
    try {
      return { ...(await run()), attempts: [...attempts], ...(payeeDomain !== undefined ? { payeeDomain } : {}) }
    } catch (e) {
      if (isPaymentError(e) && e.canPayAnotherWay) return e
      throw isPaymentError(e) ? e.withAttempts([...attempts]) : new PaymentError('funding-failed', String(e), { path, stage: 'pay', canPayAnotherWay: false, attempts: [...attempts], cause: e })
    }
  }
  const common = {
    amountSats: plan.amountSats,
    network: plan.network,
    ...(plan.note !== undefined ? { note: plan.note } : {}),
    ...(plan.walletId !== undefined ? { walletId: plan.walletId } : {})
  }
  let last: PaymentError | undefined
  let lastPath: PaymentPath | undefined

  if (plan.peerId !== undefined) {
    const payeePeerId = plan.peerId
    if (ctx.libp2p !== undefined) {
      const libp2p = ctx.libp2p
      const r = await attempt('live', async () => await payLive({ payeePeerId, ...common }, {
        ...funding, ...ctx.live, libp2p,
        ...(ctx.relays !== undefined ? { relays: ctx.relays } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {})
      }))
      if (!(r instanceof PaymentError)) return r
      last = r; lastPath = 'live'
    }
    if (ctx.ricochet !== undefined) {
      if (last !== undefined) fallback('live', 'offline', last)
      const ricochet = ctx.ricochet
      const identityKey = ctx.identityKey
      const r = await attempt('offline', async () => {
        if (identityKey === undefined) {
          throw new PaymentError('no-route', 'Offline payments need the payer\'s identity key: pass identityKey, the private key of the Ricochet client\'s libp2p node', { path: 'offline', stage: 'prepare', canPayAnotherWay: true })
        }
        return await payOffline({ payeePeerId, ...common }, {
          ...funding, ricochet, identityKey, ...(ctx.seal !== undefined ? { seal: ctx.seal } : {})
        })
      })
      if (!(r instanceof PaymentError)) return r
      last = r; lastPath = 'offline'
    }
  }
  // A link's key is the fallback only when the payee signed the link.
  const peerPayAllowed = plan.peerId === undefined || (ctx.peerPay?.fallback === true && plan.signed !== false)
  if (plan.paymentKey !== undefined && peerPayAllowed && ctx.wallet !== undefined) {
    if (last !== undefined && lastPath !== undefined) fallback(lastPath, 'peerpay', last)
    const paymentKey = plan.paymentKey
    const wallet = ctx.wallet
    const r = await attempt('peerpay', async () => await payViaPeerPay({ paymentKey, amountSats: plan.amountSats, ...(plan.note !== undefined ? { note: plan.note } : {}) }, {
      wallet,
      ...(ctx.peerPay?.host !== undefined ? { host: ctx.peerPay.host } : {}),
      ...(ctx.peerPay?.client !== undefined ? { client: ctx.peerPay.client } : {}),
      ...(ctx.originator !== undefined ? { originator: ctx.originator } : {}),
      ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {})
    }))
    if (!(r instanceof PaymentError)) return r
    last = r
  }
  if (last !== undefined) throw last.withAttempts(attempts)
  const why = plan.peerId !== undefined
    ? 'No path to the payee: pass a libp2p node (live) and/or a Ricochet client (offline)'
    : 'Paying a payment key needs a BRC-100 wallet (PeerPay)'
  throw prepare('no-route', why)
}
