import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BEEF_V2, Beef, Transaction } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import {
  PaymentError, type PaymentOutput, beefKind, fundWithFunder, fundWithWallet, inspectBeefV1, p2pkhScriptForAddress, toBeefV1, toHex
} from '../../src/index.ts'
import { FakeWallet } from '../support/fake-wallet.ts'

const asWallet = (w: FakeWallet): WalletInterface => w as unknown as WalletInterface
const ADDR = 'mqAtCUB3FhfWaHpbcxigNZ1j4rsskWZvFj'
const out = [{ lockingScript: p2pkhScriptForAddress(ADDR, 'testnet'), satoshis: 1000, address: ADDR }]

test('wallet funding asks for noSend and ordered outputs, and gives BEEF V1 with the payment last', async () => {
  const w = new FakeWallet({ unprovenDepth: 2 })
  const f = await fundWithWallet(asWallet(w), out, { path: 'offline', broadcast: false })
  const args = w.calls.find(c => c.method === 'createAction')!.args as { options: Record<string, unknown> }
  assert.equal(args.options.noSend, true)
  assert.equal(args.options.randomizeOutputs, false)
  assert.equal(toHex(f.beefV1.slice(0, 4)), '0100beef')
  assert.equal(beefKind(f.atomicBeef!), 'atomic')
  const info = inspectBeefV1(f.beefV1)
  assert.equal(info.txid, f.txid)
  assert.equal(info.transactions, 4) // proven coin, two unproven ancestors, the payment
  assert.equal(info.proofs, 1)
  assert.equal(Beef.fromBinary(Array.from(f.beefV1)).txs.at(-1)!.txid, f.txid)
  assert.equal(await f.abort(), true)
  assert.equal(w.actions.get(f.txid)!.status, 'aborted')
})

test('toBeefV1 converts Atomic BEEF and V2, and refuses txid-only parents', async () => {
  const w = new FakeWallet()
  const r = await w.createAction({ description: 'test pay', outputs: [{ ...out[0]!, outputDescription: 'x' }], options: { noSend: true } })
  const atomic = r.tx!
  const v1 = toBeefV1(atomic, r.txid)
  assert.equal(v1.txid, r.txid)
  const v2 = Beef.fromBinary(atomic)
  v2.version = BEEF_V2
  assert.equal(beefKind(v2.toBinary()), 'v2')
  assert.deepEqual(toBeefV1(v2.toBinary(), r.txid).beefV1, v1.beefV1)
  const tw = new FakeWallet({ txidOnlyParent: true })
  const t = await tw.createAction({ description: 'test pay', outputs: [{ ...out[0]!, outputDescription: 'x' }], options: { noSend: true } })
  assert.throws(() => toBeefV1(t.tx!, t.txid))
  // and wallet funding aborts the action then
  const tw2 = new FakeWallet({ txidOnlyParent: true })
  await assert.rejects(fundWithWallet(asWallet(tw2), out, { path: 'live', broadcast: false }),
    (e: PaymentError) => e.code === 'beef-unusable' && e.aborted && e.canPayAnotherWay)
  assert.equal([...tw2.actions.values()][0]!.status, 'aborted')
})

test('a funder may return V1, Atomic BEEF or V2; a wrong output is refused and aborted', async () => {
  const w = new FakeWallet({ coins: [10_000, 10_000, 10_000, 10_000] })
  let aborted = 0
  const funder = async (outputs: PaymentOutput[]) => {
    const r = await w.createAction({ description: 'test pay', outputs: outputs.map(o => ({ ...o, outputDescription: 'x' })), options: { noSend: true } })
    return { beef: r.tx!, abort: async () => { aborted++ } }
  }
  const f = await fundWithFunder(funder, out, { path: 'offline', broadcast: false })
  assert.equal(beefKind(f.beefV1), 'v1')
  const asV1 = async () => toBeefV1((await w.createAction({ description: 'test pay', outputs: [{ ...out[0]!, outputDescription: 'x' }], options: { noSend: true } })).tx!).beefV1
  const g = await fundWithFunder(asV1, out, { path: 'live', broadcast: false })
  assert.equal(Transaction.fromBEEF(Array.from(g.beefV1)).id('hex'), g.txid)
  const wrong = [{ ...out[0]!, satoshis: 999 }]
  // A funder that pays 1000 when asked for 999:
  const liar = async () => ({ beef: (await w.createAction({ description: 'test pay', outputs: [{ ...out[0]!, outputDescription: 'x' }], options: { noSend: true } })).tx!, abort: async () => { aborted++ } })
  await assert.rejects(fundWithFunder(liar, wrong, { path: 'live', broadcast: false }), (e: PaymentError) => e.code === 'beef-unusable')
  assert.ok(aborted >= 1)
  await assert.rejects(fundWithFunder(async () => new Uint8Array([1, 2, 3]), out, { path: 'live', broadcast: false }), (e: PaymentError) => e.code === 'beef-unusable')
  await assert.rejects(fundWithFunder(async () => { throw new Error('no coins') }, out, { path: 'live', broadcast: false }),
    (e: PaymentError) => e.code === 'funding-failed' && !e.canPayAnotherWay)
})

test('P2PKH scripts refuse an address of the other network', () => {
  assert.equal(p2pkhScriptForAddress(ADDR, 'testnet').length, 50)
  assert.throws(() => p2pkhScriptForAddress(ADDR, 'mainnet'), /not a mainnet address/)
  assert.throws(() => p2pkhScriptForAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'testnet'), /not a testnet address/)
  assert.throws(() => p2pkhScriptForAddress('nonsense', 'testnet'))
})
