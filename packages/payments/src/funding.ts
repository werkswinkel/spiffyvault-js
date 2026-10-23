/**
 * Funding: getting a signed transaction that pays the outputs a path needs,
 * in the BEEF form that path's payee accepts.
 *
 * - Live and offline: the payee takes only BEEF V1 (`0100BEEF`) with the
 *   payment last, and broadcasts it itself; Atomic BEEF and V2 are refused
 *   (libspiffy utils/beef.dart). The wallet must not broadcast (`noSend`).
 * - PeerPay: Atomic BEEF (BRC-95) with no txid-only entries; the payer
 *   broadcasts.
 */

import { Beef, Transaction } from '@bsv/sdk'
import type { CreateActionArgs, CreateActionOutput, WalletInterface } from '@bsv/sdk'
import { toHex } from './bytes.ts'
import { PaymentError, errorText } from './errors.ts'
import type { PaymentPath } from './errors.ts'

export interface PaymentOutput {
  /** P2PKH locking script, hex. */
  lockingScript: string
  satoshis: number
  /** The address it pays, when there is one (live invoices). */
  address?: string
}

export interface FundInfo {
  path: PaymentPath
  /** False for live and offline: the payee broadcasts. */
  broadcast: boolean
  /** The payment's note, for the wallet's own records. */
  note?: string
  /** The payee, for the wallet's own records. */
  counterparty?: string
}

/**
 * A lower-level funder for wallets that are not BRC-100: given the outputs,
 * return BEEF bytes (V1 preferred; Atomic BEEF and V2 are converted) of a
 * signed transaction paying them, not broadcast. `abort` is called when the
 * payment is given up before the transaction left, to release its inputs.
 */
export type Funder = (outputs: PaymentOutput[], info: FundInfo) =>
Promise<Uint8Array | number[] | { beef: Uint8Array | number[], abort?: () => Promise<void> }>

/** A transaction built for one payment. */
export interface FundedPayment {
  txid: string
  /** BEEF V1, the payment last. */
  beefV1: Uint8Array
  /** Atomic BEEF as the wallet gave it (wallet funding only). */
  atomicBeef?: Uint8Array
  /** Releases the transaction's inputs; true when the wallet confirmed it. Safe to call once. */
  abort: () => Promise<boolean>
}

export const BEEF_V1_MAGIC = [0x01, 0x00, 0xbe, 0xef] as const
export const BEEF_V2_MAGIC = [0x02, 0x00, 0xbe, 0xef] as const
export const ATOMIC_BEEF_MAGIC = [0x01, 0x01, 0x01, 0x01] as const

export type BeefKind = 'v1' | 'v2' | 'atomic' | 'unknown'

export function beefKind (bytes: Uint8Array | readonly number[]): BeefKind {
  const m = (magic: readonly number[]): boolean => magic.every((b, i) => bytes[i] === b)
  if (m(BEEF_V1_MAGIC)) return 'v1'
  if (m(BEEF_V2_MAGIC)) return 'v2'
  if (m(ATOMIC_BEEF_MAGIC)) return 'atomic'
  return 'unknown'
}

/**
 * Any BEEF (V1, V2 or Atomic) of a payment as BEEF V1 with the payment last
 * and every ancestor back to a merkle proof included. Throws when the input
 * has txid-only entries the conversion cannot fill (the payee would refuse).
 */
export function toBeefV1 (beef: Uint8Array | readonly number[], txid?: string): { beefV1: Uint8Array, txid: string } {
  const bytes = Array.from(beef)
  const kind = beefKind(bytes)
  let tx: Transaction
  if (kind === 'atomic') tx = Transaction.fromAtomicBEEF(bytes)
  else if (kind === 'v1' || kind === 'v2') tx = Transaction.fromBEEF(bytes, txid)
  else throw new TypeError('not BEEF')
  const id = tx.id('hex')
  if (txid !== undefined && id !== txid) throw new TypeError(`BEEF subject is ${id}, not ${txid}`)
  // Throws on a missing source transaction (a txid-only entry).
  const out = Uint8Array.from(tx.toBEEF(false))
  if (beefKind(out) !== 'v1') throw new TypeError('conversion did not produce BEEF V1')
  return { beefV1: out, txid: id }
}

/** Facts about a BEEF V1 the live and offline payees check: version, subject last. */
export function inspectBeefV1 (bytes: Uint8Array): { txid: string, transactions: number, proofs: number } {
  if (beefKind(bytes) !== 'v1') throw new TypeError('not BEEF V1')
  const b = Beef.fromBinary(Array.from(bytes))
  const last = b.txs.at(-1)
  if (last === undefined) throw new TypeError('BEEF has no transactions')
  if (b.txs.some(t => t.isTxidOnly)) throw new TypeError('BEEF has txid-only entries')
  return { txid: last.txid, transactions: b.txs.length, proofs: b.bumps.length }
}

/**
 * Checks an Atomic BEEF for PeerPay: BRC-95 framing, subject `txid`, and
 * no txid-only entries (SpiffyVault refuses them, libspiffy utils/atomic_beef.dart).
 */
export function checkAtomicBeefForPeerPay (bytes: Uint8Array | readonly number[], txid: string): void {
  if (beefKind(bytes) !== 'atomic') throw new TypeError('not Atomic BEEF')
  const b = Beef.fromBinary(Array.from(bytes))
  if (b.atomicTxid !== txid) throw new TypeError(`Atomic BEEF subject is ${String(b.atomicTxid)}, not ${txid}`)
  if (b.txs.some(t => t.isTxidOnly)) throw new TypeError('Atomic BEEF has txid-only entries')
}

/** Network of a BRC-100 wallet, in the link's spelling. */
export async function walletNetwork (wallet: WalletInterface): Promise<'mainnet' | 'testnet'> {
  const { network } = await wallet.getNetwork({})
  return network === 'mainnet' ? 'mainnet' : 'testnet'
}

function fundingError (path: PaymentPath, message: string, cause?: unknown): PaymentError {
  return new PaymentError('funding-failed', message, { path, stage: 'pay', canPayAnotherWay: false, cause })
}

/**
 * Builds the payment with a BRC-100 wallet: createAction with the exact
 * outputs, `noSend` and `randomizeOutputs: false`; the result converted to
 * BEEF V1. abort() calls abortAction with the txid as reference (wallet-
 * toolbox accepts a txid there).
 */
export async function fundWithWallet (wallet: WalletInterface, outputs: PaymentOutput[], info: FundInfo,
  extra: { description?: string, originator?: string } = {}): Promise<FundedPayment> {
  const args: CreateActionArgs = {
    description: extra.description ?? 'SpiffyVault payment',
    outputs: outputs.map((o): CreateActionOutput => ({
      lockingScript: o.lockingScript,
      satoshis: o.satoshis,
      outputDescription: o.address !== undefined ? `Payment to ${o.address}` : 'SpiffyVault payment'
    })),
    options: { noSend: !info.broadcast, randomizeOutputs: false, ...(info.broadcast ? { acceptDelayedBroadcast: false } : {}) }
  }
  let result
  try {
    result = await wallet.createAction(args, extra.originator)
  } catch (e) {
    throw fundingError(info.path, `The wallet could not build the payment: ${errorText(e)}`, e)
  }
  const txid = result.txid
  const tx = result.tx
  if (txid === undefined || tx === undefined) throw fundingError(info.path, 'The wallet returned no transaction')
  let aborted = false
  const abort = async (): Promise<boolean> => {
    if (aborted) return true
    try {
      await wallet.abortAction({ reference: txid }, extra.originator)
      aborted = true
      return true
    } catch {
      return false
    }
  }
  const atomic = Uint8Array.from(tx)
  try {
    const { beefV1 } = toBeefV1(atomic, txid)
    return { txid, beefV1, atomicBeef: atomic, abort }
  } catch (e) {
    if (!info.broadcast) await abort()
    throw new PaymentError('beef-unusable', `The wallet's transaction cannot be handed to a SpiffyVault payee: ${errorText(e)}`,
      { path: info.path, stage: 'pay', canPayAnotherWay: !info.broadcast, txid, aborted: !info.broadcast, cause: e })
  }
}

/** Builds the payment with a lower-level Funder. */
export async function fundWithFunder (funder: Funder, outputs: PaymentOutput[], info: FundInfo): Promise<FundedPayment> {
  let got
  try {
    got = await funder(outputs, info)
  } catch (e) {
    throw fundingError(info.path, `The funder could not build the payment: ${errorText(e)}`, e)
  }
  const beef = got instanceof Uint8Array || Array.isArray(got) ? got : got.beef
  const abortFn = got instanceof Uint8Array || Array.isArray(got) ? undefined : got.abort
  let done = false
  const abort = async (): Promise<boolean> => {
    if (done || abortFn === undefined) return done
    try { await abortFn(); done = true; return true } catch { return false }
  }
  let converted
  try {
    converted = beefKind(beef) === 'v1' ? { beefV1: Uint8Array.from(beef), txid: inspectBeefV1(Uint8Array.from(beef)).txid } : toBeefV1(beef)
  } catch (e) {
    await abort()
    throw new PaymentError('beef-unusable', `The funder's BEEF cannot be handed to a SpiffyVault payee: ${errorText(e)}`,
      { path: info.path, stage: 'pay', canPayAnotherWay: true, aborted: true, cause: e })
  }
  checkPays(converted.beefV1, outputs, info.path, abort)
  return { txid: converted.txid, beefV1: converted.beefV1, abort }
}

/** The payment must pay every requested output (a funder could get it wrong). */
function checkPays (beefV1: Uint8Array, outputs: PaymentOutput[], path: PaymentPath, abort: () => Promise<boolean>): void {
  const tx = Transaction.fromBEEF(Array.from(beefV1))
  const have = tx.outputs.map(o => ({ script: o.lockingScript.toHex(), sats: o.satoshis ?? 0, used: false }))
  for (const want of outputs) {
    const hit = have.find(h => !h.used && h.script === want.lockingScript.toLowerCase() && h.sats === want.satoshis)
    if (hit === undefined) {
      void abort()
      throw new PaymentError('beef-unusable', `The funded transaction does not pay ${want.satoshis} sats to ${want.address ?? want.lockingScript}`,
        { path, stage: 'pay', canPayAnotherWay: true, aborted: true })
    }
    hit.used = true
  }
}

/** Hex of BEEF bytes, lowercase (the offline message's `beefHex`). */
export const beefHex = (b: Uint8Array): string => toHex(b)
