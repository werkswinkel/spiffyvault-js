import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import { PaymentError } from '../../src/index.ts'
import { FrameError, checkInvoice, circuitAddress, decodeOnFrame, encodeOnFrame, invoiceOutputs, newSessionId, readOnFrame, toHex } from '../../src/internal.ts'
import { C } from '../fixtures/appendix-c.ts'

const addr = (): string => PrivateKey.fromRandom().toPublicKey().toAddress('testnet')

test('the ON frame: Appendix C ack vector, header rules', () => {
  assert.equal(toHex(encodeOnFrame({ type: 'ack' })), C.frameAck)
  assert.deepEqual(decodeOnFrame(encodeOnFrame({ type: 'x', n: 1 })), { type: 'x', n: 1 })
  const bad = encodeOnFrame({ type: 'x' })
  bad[2] = 2
  assert.throws(() => decodeOnFrame(bad), /Unsupported version: 2/)
  const magic = encodeOnFrame({ type: 'x' })
  magic[0] = 0
  assert.throws(() => decodeOnFrame(magic), FrameError)
  const proto = encodeOnFrame({ type: 'x' }, 9)
  assert.deepEqual(decodeOnFrame(proto), { type: 'x' }) // the reader does not check the protocol byte
})

test('readOnFrame buffers across chunks and counts them', async () => {
  const f = encodeOnFrame({ type: 'invoice_response', amount: '5' })
  async function * split (): AsyncGenerator<Uint8Array> { yield f.subarray(0, 3); yield f.subarray(3, 10); yield f.subarray(10) }
  const r = await readOnFrame(split())
  assert.deepEqual(r, { payload: { type: 'invoice_response', amount: '5' }, chunks: 3 })
  async function * whole (): AsyncGenerator<Uint8Array> { yield f }
  assert.equal((await readOnFrame(whole())).chunks, 1)
  async function * none (): AsyncGenerator<Uint8Array> {}
  await assert.rejects(readOnFrame(none()), /before a frame/)
})

test('a header claiming a frame over the limit is refused before buffering (assessment finding 1)', async () => {
  let pulled = 0
  async function * hostile (): AsyncGenerator<Uint8Array> {
    // A 4 GiB frame, then data for as long as the reader keeps reading.
    yield Uint8Array.of(0x4f, 0x4e, 0x01, 0x01, 0xff, 0xff, 0xff, 0xff)
    for (;;) { pulled++; yield new Uint8Array(64 * 1024) }
  }
  await assert.rejects(readOnFrame(hostile()), /over the limit of 262144/)
  assert.equal(pulled, 0)
  const f = encodeOnFrame({ type: 'x', pad: 'y'.repeat(100) })
  async function * one (): AsyncGenerator<Uint8Array> { yield f }
  await assert.rejects(readOnFrame(one(), undefined, { maxFrameBytes: 64 }), FrameError)
  assert.deepEqual((await readOnFrame(one(), undefined, { maxFrameBytes: f.length })).payload.type, 'x')
})

test('session IDs are random, not pay_<ms>', () => {
  const a = newSessionId()
  assert.match(a, /^pay_\d+_[0-9a-f]{24}$/)
  assert.notEqual(a, newSessionId())
})

test('circuit addresses', () => {
  assert.equal(circuitAddress('/dns4/r.example/tcp/1/wss/p2p/12D3KooWRelay', '12D3KooWPayee'), '/dns4/r.example/tcp/1/wss/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWPayee')
})

test('invoice checks as the Dart payer makes them', () => {
  const a1 = addr()
  const a2 = addr()
  const ok = { type: 'invoice_response', invoiceId: 'inv-1', addresses: [a1], amount: '1000', network: 'test' }
  assert.deepEqual(checkInvoice(ok, 1000, 'testnet'), { invoiceId: 'inv-1', addresses: [a1] })
  const refused = (m: Record<string, unknown>, net: 'testnet' | 'mainnet' = 'testnet', code = 'bad-invoice'): void => {
    assert.throws(() => checkInvoice(m, 1000, net), (e: PaymentError) => e.code === code && e.canPayAnotherWay)
  }
  refused({ ...ok, addresses: [] })
  refused({ ...ok, invoiceId: '' })
  refused({ ...ok, amount: '999' })
  refused({ ...ok, network: 'main' }, 'testnet', 'network-mismatch')
  refused({ ...ok, network: undefined }, 'mainnet') // a testnet address on mainnet
  refused({ ...ok, addresses: ['nonsense'] })
  const split = { ...ok, addresses: [a1, a2], outputs: [{ address: a1, sats: 600 }, { address: a2, sats: 400 }] }
  assert.equal(checkInvoice(split, 1000, 'testnet').outputs!.length, 2)
  refused({ ...split, outputs: [] })
  refused({ ...split, outputs: [{ address: a1, sats: 600 }, { address: a1, sats: 400 }] })
  refused({ ...split, outputs: [{ address: a1, sats: 600 }, { address: addr(), sats: 400 }] })
  refused({ ...split, outputs: [{ address: a1, sats: 1000 }] })
  refused({ ...split, outputs: [{ address: a1, sats: 600 }, { address: a2, sats: 300 }] })
  refused({ ...split, outputs: [{ address: a1, sats: 1000 }, { address: a2, sats: 0 }] })
  refused({ ...split, outputs: [{ address: a1, sats: 600.5 }, { address: a2, sats: 399.5 }] })
})

test('outputs: parts as given; equal shares with the remainder on the last (not dropped as the Dart payer does)', () => {
  const a1 = addr(); const a2 = addr(); const a3 = addr()
  assert.deepEqual(invoiceOutputs({ invoiceId: 'i', addresses: [a1] }, 1000, 'testnet').map(o => o.satoshis), [1000])
  assert.deepEqual(invoiceOutputs({ invoiceId: 'i', addresses: [a1, a2, a3] }, 1000, 'testnet').map(o => o.satoshis), [333, 333, 334])
  assert.deepEqual(invoiceOutputs({ invoiceId: 'i', addresses: [a1, a2], outputs: [{ address: a2, sats: 1 }, { address: a1, sats: 999 }] }, 1000, 'testnet')
    .map(o => [o.address, o.satoshis]), [[a2, 1], [a1, 999]])
})
