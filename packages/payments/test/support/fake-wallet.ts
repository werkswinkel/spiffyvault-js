/**
 * A stand-in BRC-100 wallet for tests: real keys (ProtoWallet), real signed
 * transactions, funded from coins whose parents carry a one-transaction
 * merkle proof (the block's merkle root is the parent's txid). Enough for
 * BEEF, BRC-29 and BRC-42 checks; nothing is broadcast.
 */

import { BEEF_V2, Beef, LockingScript, MerklePath, P2PKH, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk'
import type {
  AbortActionArgs, CreateActionArgs, CreateActionResult, GetPublicKeyArgs, WalletEncryptArgs, CreateHmacArgs
} from '@bsv/sdk'

interface Coin { tx: Transaction, vout: number, sats: number, reserved: boolean }

export interface FakeWalletOptions {
  network?: 'mainnet' | 'testnet'
  rootKey?: PrivateKey
  /** Satoshis of each funding coin. */
  coins?: number[]
  /** Put change at output 0 and the requested outputs after it (as libspiffy does). */
  changeFirst?: boolean
  /** Give the parent as a txid-only entry in the Atomic BEEF (a wallet "known txid"). */
  txidOnlyParent?: boolean
  /** Number of unproven ancestors between the proven coin and the payment. */
  unprovenDepth?: number
  /** Make createAction fail. */
  failCreate?: string
  /** A wallet without BRC-111 module `nosend` (BRC-177): refuses a `p nosend …` label, as BRC-111 requires. */
  noBrc177?: boolean
  /** Answer abortAction with aborted: false, as Wallet Toolbox does for a payment the network holds. */
  refuseAbort?: boolean
  /** Report the broadcast as failed. */
  failBroadcast?: boolean
  fee?: number
}

export class FakeWallet {
  readonly root: PrivateKey
  readonly proto: ProtoWallet
  readonly network: 'mainnet' | 'testnet'
  readonly coins: Coin[] = []
  readonly actions = new Map<string, { status: 'nosend' | 'sent' | 'aborted', args: CreateActionArgs, tx: Transaction, coin: Coin }>()
  readonly calls: Array<{ method: string, args: unknown }> = []
  private readonly fundKey: PrivateKey
  private readonly opts: FakeWalletOptions
  private height = 900_000

  constructor (opts: FakeWalletOptions = {}) {
    this.opts = opts
    this.root = opts.rootKey ?? PrivateKey.fromRandom()
    this.proto = new ProtoWallet(this.root)
    this.network = opts.network ?? 'testnet'
    this.fundKey = PrivateKey.fromRandom()
    for (const sats of opts.coins ?? [100_000]) this.addCoin(sats)
  }

  /** A coin of `sats`, with `unprovenDepth` unproven ancestors above a proven one. */
  addCoin (sats: number): void {
    const lock = new P2PKH().lock(this.fundKey.toPublicKey().toHash() as number[])
    const proven = new Transaction(1, [{
      sourceTXID: '00'.repeat(32), sourceOutputIndex: this.coins.length, unlockingScript: LockingScript.fromHex('51'), sequence: 0xffffffff
    }], [{ lockingScript: lock, satoshis: sats + 1000 * (this.opts.unprovenDepth ?? 0) }], 0)
    const txid = proven.id('hex')
    proven.merklePath = new MerklePath(this.height++, [[{ offset: 0, hash: txid, txid: true }]])
    let tip = proven
    for (let i = 0; i < (this.opts.unprovenDepth ?? 0); i++) {
      const next = new Transaction(2, [{
        sourceTransaction: tip, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(this.fundKey), sequence: 0xffffffff
      }], [{ lockingScript: lock, satoshis: (tip.outputs[0]!.satoshis ?? 0) - 1000 }], 0)
      tip = next
    }
    this.coins.push({ tx: tip, vout: 0, sats: tip.outputs[0]!.satoshis ?? 0, reserved: false })
  }

  async signPending (): Promise<void> {
    for (const c of this.coins) await signChain(c.tx)
  }

  async getNetwork (): Promise<{ network: 'mainnet' | 'testnet' }> { return { network: this.network } }

  async getPublicKey (args: GetPublicKeyArgs): Promise<{ publicKey: string }> {
    this.calls.push({ method: 'getPublicKey', args })
    return await this.proto.getPublicKey(args)
  }

  async encrypt (args: WalletEncryptArgs): Promise<{ ciphertext: number[] }> { return await this.proto.encrypt(args) }
  async createHmac (args: CreateHmacArgs): Promise<{ hmac: number[] }> { return await this.proto.createHmac(args) }

  async createAction (args: CreateActionArgs): Promise<CreateActionResult> {
    this.calls.push({ method: 'createAction', args })
    if (this.opts.failCreate !== undefined) throw new Error(this.opts.failCreate)
    if (this.opts.noBrc177 === true && (args.labels ?? []).some(l => l.startsWith('p nosend'))) throw new Error('Unsupported permission module: nosend')
    const outputs = args.outputs ?? []
    const need = outputs.reduce((s, o) => s + o.satoshis, 0)
    const fee = this.opts.fee ?? 200
    const coin = this.coins.find(c => !c.reserved && c.sats >= need + fee)
    if (coin === undefined) throw new Error('Insufficient funds')
    await signChain(coin.tx)
    const requested = outputs.map(o => ({ lockingScript: LockingScript.fromHex(o.lockingScript), satoshis: o.satoshis }))
    const change = { lockingScript: new P2PKH().lock(this.fundKey.toPublicKey().toHash() as number[]), satoshis: coin.sats - need - fee }
    const tx = new Transaction(1, [{
      sourceTransaction: coin.tx, sourceOutputIndex: coin.vout, unlockingScriptTemplate: new P2PKH().unlock(this.fundKey), sequence: 0xffffffff
    }], this.opts.changeFirst === true ? [change, ...requested] : [...requested, change], 0)
    await tx.sign()
    const txid = tx.id('hex')
    coin.reserved = true
    const noSend = args.options?.noSend === true
    this.actions.set(txid, { status: noSend ? 'nosend' : 'sent', args, tx, coin })
    let atomic = tx.toAtomicBEEF()
    if (this.opts.txidOnlyParent === true) {
      const beef = Beef.fromBinary(atomic)
      beef.version = BEEF_V2
      beef.makeTxidOnly(coin.tx.id('hex'))
      atomic = beef.toBinaryAtomic(txid)
    }
    const result: CreateActionResult = { txid, tx: atomic }
    if (!noSend) result.sendWithResults = [{ txid, status: this.opts.failBroadcast === true ? 'failed' : 'unproven' }]
    return result
  }

  async abortAction (args: AbortActionArgs): Promise<{ aborted: boolean }> {
    this.calls.push({ method: 'abortAction', args })
    const a = this.actions.get(args.reference)
    if (a === undefined || a.status !== 'nosend') throw new Error('not an abortable action')
    if (this.opts.refuseAbort === true) return { aborted: false }
    a.status = 'aborted'
    a.coin.reserved = false
    return { aborted: true }
  }

  /** The payment transaction of an action. */
  tx (txid: string): Transaction { return this.actions.get(txid)!.tx }
}

async function signChain (tx: Transaction): Promise<void> {
  for (const i of tx.inputs) if (i.sourceTransaction !== undefined) await signChain(i.sourceTransaction)
  if (tx.inputs.some(i => i.unlockingScript === undefined && i.unlockingScriptTemplate !== undefined)) await tx.sign()
}
