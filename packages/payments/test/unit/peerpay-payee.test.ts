/**
 * Being paid by PeerPay (acceptPeerPayPayments) against the library's own
 * payer (payViaPeerPay), with an in-memory inbox: checking the token,
 * keeping before acknowledging, retries, giving up, and refusals.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { P2PKH, PrivateKey, ProtoWallet, PublicKey } from '@bsv/sdk'
import type { ChainTracker, WalletInterface } from '@bsv/sdk'
import { DEFAULT_MESSAGE_BOX_HOST, PEERPAY_MESSAGE_BOX, acceptPeerPayPayments, payViaPeerPay } from '../../src/index.ts'
import type { PeerPayInbox, PeerPayInboxMessage, PeerPayPayee, PeerPayPayeeEvent, PeerPayPayeeOptions, PeerPayToken, ReceivedPeerPayment } from '../../src/index.ts'
import { FakeWallet } from '../support/fake-wallet.ts'

const anyRoot: ChainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => 1_000_000 }

class Inbox implements PeerPayInbox {
  messages: PeerPayInboxMessage[] = []
  hosts: string[] = []
  acked: string[] = []
  listFails?: string
  ackFails?: string
  private next = 1
  add (sender: string, body: unknown): string {
    const messageId = `m${this.next++}`
    this.messages.push({ messageId, sender, body })
    return messageId
  }
  async listMessagesLite (args: { messageBox: string, host: string }): Promise<PeerPayInboxMessage[]> {
    if (this.listFails !== undefined) throw new Error(this.listFails)
    assert.equal(args.messageBox, PEERPAY_MESSAGE_BOX)
    this.hosts.push(args.host)
    return this.messages.map(m => ({ ...m }))
  }
  async acknowledgeMessage (args: { messageIds: string[], host: string }): Promise<unknown> {
    if (this.ackFails !== undefined) throw new Error(this.ackFails)
    this.hosts.push(args.host)
    this.acked.push(...args.messageIds)
    this.messages = this.messages.filter(m => !args.messageIds.includes(m.messageId))
    return { status: 'success' }
  }
}

async function world () {
  const root = PrivateKey.fromRandom()
  const wallet = new ProtoWallet(root)
  const paymentKey = root.toPublicKey().toString()
  const payerWallet = new FakeWallet({ coins: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000] })
  const payer = (await payerWallet.getPublicKey({ identityKey: true })).publicKey
  const inbox = new Inbox()
  const paid: ReceivedPeerPayment[] = []
  const events: PeerPayPayeeEvent[] = []
  const broadcasts: string[] = []
  let clock = 1_000_000
  let refuseBroadcast: string | undefined
  let keepFails: string | undefined
  const start = async (extra: Partial<PeerPayPayeeOptions> = {}): Promise<PeerPayPayee> => {
    const payee = await acceptPeerPayPayments({
      network: 'testnet',
      wallet,
      client: inbox,
      chainTracker: anyRoot,
      broadcaster: async chain => {
        broadcasts.push(chain[chain.length - 1]!.id('hex'))
        return refuseBroadcast === undefined ? { accepted: true, status: 'SEEN_ON_NETWORK' } : { accepted: false, error: refuseBroadcast }
      },
      onPayment: p => { if (keepFails !== undefined) throw new Error(keepFails); paid.push(p) },
      onEvent: e => events.push(e),
      checkEveryMs: 3600_000,
      now: () => clock,
      ...extra
    })
    // The first check runs as it starts; let it finish before the test looks.
    await payee.collectNow()
    return payee
  }
  /** A token made by the library's payer for `key` (this wallet's by default). */
  const token = async (amountSats: number, note?: string, key = paymentKey): Promise<{ token: PeerPayToken, txid: string }> => {
    let body = ''
    const r = await payViaPeerPay({ paymentKey: key, amountSats, ...(note !== undefined ? { note } : {}) }, {
      wallet: payerWallet as unknown as WalletInterface,
      client: { sendMessage: async m => { body = m.body; return { messageId: 'x' } } }
    })
    return { token: JSON.parse(body) as PeerPayToken, txid: r.txid! }
  }
  const pay = async (amountSats: number, note?: string): Promise<{ messageId: string, txid: string }> => {
    const t = await token(amountSats, note)
    return { messageId: inbox.add(payer, t.token), txid: t.txid }
  }
  return {
    root, wallet, payer, inbox, paid, events, broadcasts, start, token, pay,
    later: (ms: number) => { clock += ms },
    refuseBroadcast: (e: string | undefined) => { refuseBroadcast = e },
    keepFails: (e: string | undefined) => { keepFails = e }
  }
}

test('takes a payment: checked, seen on the network, kept, then acknowledged; the wallet can spend the output', async () => {
  const w = await world()
  const payee = await w.start()
  const r = await w.pay(2500, 'Order 1042 · ref K7Q2M9XD')
  await payee.collectNow()
  payee.stop()
  assert.ok(payee.checkedAt !== undefined)
  assert.equal(w.paid.length, 1)
  const p = w.paid[0]!
  assert.equal(p.messageId, r.messageId)
  assert.equal(p.txid, r.txid)
  assert.equal(p.paidSats, 2500)
  assert.equal(p.amountSats, 2500)
  assert.equal(p.note, 'Order 1042 · ref K7Q2M9XD')
  assert.equal(p.senderIdentityKey, w.payer)
  assert.equal(p.networkStatus, 'SEEN_ON_NETWORK')
  assert.equal(p.transaction.id('hex'), r.txid)
  assert.deepEqual(Array.from(p.atomicBeef.slice(0, 4)), [1, 1, 1, 1])
  assert.deepEqual(w.broadcasts, [r.txid])
  // The output's key, as Wallet Toolbox derives it for a BRC-29 payment remittance.
  assert.equal(p.outputs.length, 1)
  const o = p.outputs[0]!
  assert.equal(o.senderIdentityKey, w.payer)
  const child = w.root.deriveChild(PublicKey.fromString(w.payer), `2-3241645161d8-${o.derivationPrefix} ${o.derivationSuffix}`)
  assert.equal(p.transaction.outputs[o.outputIndex]!.lockingScript.toHex(), new P2PKH().lock(child.toPublicKey().toHash() as number[]).toHex())
  assert.deepEqual(w.inbox.acked, [r.messageId])
  assert.ok(w.inbox.hosts.every(h => h === DEFAULT_MESSAGE_BOX_HOST))
  assert.deepEqual(w.events.map(e => e.kind), ['paid'])
})

test('when keeping fails, the message stays on the server and is offered again', async () => {
  const w = await world()
  const payee = await w.start()
  const r = await w.pay(700)
  w.keepFails('disk full')
  await payee.collectNow()
  assert.equal(w.paid.length, 0)
  assert.deepEqual(w.inbox.acked, [])
  assert.ok(w.events.some(e => e.kind === 'keep-failed' && e.error === 'disk full'))
  // Never given up while it is keeping that fails.
  w.later(2 * 3600_000)
  await payee.collectNow()
  assert.deepEqual(w.inbox.acked, [])
  w.keepFails(undefined)
  await payee.collectNow()
  payee.stop()
  assert.deepEqual(w.paid.map(p => p.txid), [r.txid])
  assert.deepEqual(w.inbox.acked, [r.messageId])
})

test('a payment kept but not acknowledged is acknowledged on the next pass, not offered again', async () => {
  const w = await world()
  const payee = await w.start()
  const r = await w.pay(400)
  w.inbox.ackFails = 'server busy'
  await payee.collectNow()
  assert.equal(w.paid.length, 1)
  w.inbox.ackFails = undefined
  await payee.collectNow()
  payee.stop()
  assert.equal(w.paid.length, 1)
  assert.deepEqual(w.inbox.acked, [r.messageId])
})

test('a second token for a payment already taken is acknowledged without being offered again', async () => {
  const w = await world()
  const payee = await w.start()
  const t = await w.token(300)
  w.inbox.add(w.payer, t.token)
  await payee.collectNow()
  const again = w.inbox.add(w.payer, t.token)
  await payee.collectNow()
  payee.stop()
  assert.equal(w.paid.length, 1)
  assert.ok(w.inbox.acked.includes(again))
})

test('refuses and acknowledges what is not a payment to this wallet', async () => {
  const w = await world()
  const payee = await w.start()
  try {
    const notToken = w.inbox.add(w.payer, 'hello')
    const other = await w.token(500, undefined, PrivateKey.fromRandom().toPublicKey().toString())
    const elsewhere = w.inbox.add(w.payer, other.token)
    const wrong = await w.token(600)
    const lying = w.inbox.add(w.payer, { ...wrong.token, amount: 6000 })
    const fromOther = w.inbox.add(PrivateKey.fromRandom().toPublicKey().toString(), (await w.token(800)).token)
    const missing = await w.token(900)
    const noOutput = w.inbox.add(w.payer, { ...missing.token, outputIndex: 7 })
    await payee.collectNow()
    const reason = (id: string): string | undefined => {
      const e = w.events.find(e => e.kind === 'refused' && e.messageId === id)
      return e?.kind === 'refused' ? e.reason : undefined
    }
    assert.equal(reason(notToken), 'it is not a payment token')
    assert.equal(reason(elsewhere), 'the payment pays nothing to this wallet')
    assert.equal(reason(lying), 'output 0 pays 600 satoshis, not the 6000 the token says')
    // The key is derived with the sender's identity key: a token passed on by someone else does not match.
    assert.equal(reason(fromOther), 'the payment pays nothing to this wallet')
    assert.equal(reason(noOutput), 'the transaction has no output 7')
    assert.equal(w.paid.length, 0)
    assert.equal(w.broadcasts.length, 0)
    assert.deepEqual(w.inbox.messages, [])
  } finally {
    payee.stop()
  }
})

test('a payment that cannot be checked is tried on later passes, then refused and acknowledged', async () => {
  const w = await world()
  const payee = await w.start({ chainTracker: { isValidRootForHeight: async () => { throw new Error('chain unreachable') }, currentHeight: async () => 1_000_000 } })
  try {
    const r = await w.pay(250)
    await payee.collectNow()
    w.later(30 * 60_000)
    await payee.collectNow()
    assert.equal(w.events.filter(e => e.kind === 'error' && e.messageId === r.messageId && /chain unreachable/.test(e.error)).length, 2)
    assert.deepEqual(w.inbox.acked, [])
    w.later(31 * 60_000)
    await payee.collectNow()
    assert.ok(w.events.some(e => e.kind === 'refused' && /chain unreachable/.test(e.reason)))
    assert.deepEqual(w.inbox.acked, [r.messageId])
    assert.equal(w.broadcasts.length, 0)
  } finally {
    payee.stop()
  }
})

test('a payment the network will not take is tried on later passes, then given up as not broadcast', async () => {
  const w = await world()
  const payee = await w.start({ giveUpMs: 60_000 })
  const r = await w.pay(300)
  w.refuseBroadcast('missing inputs')
  await payee.collectNow()
  assert.deepEqual(w.inbox.acked, [])
  w.later(61_000)
  await payee.collectNow()
  payee.stop()
  assert.equal(w.paid.length, 0)
  assert.ok(w.events.some(e => e.kind === 'not-broadcast' && e.txid === r.txid && /missing inputs/.test(e.error)))
  assert.deepEqual(w.inbox.acked, [r.messageId])
})

test('a message the wallet could not open is kept for a later pass; an inbox that cannot be read is reported', async () => {
  const w = await world()
  const payee = await w.start()
  const id = w.inbox.add(w.payer, '[Error: Failed to decrypt or parse message]')
  await payee.collectNow()
  assert.ok(w.events.some(e => e.kind === 'error' && e.messageId === id && e.error === 'the message could not be opened'))
  assert.deepEqual(w.inbox.acked, [])
  const before = payee.checkedAt
  w.later(1000)
  w.inbox.listFails = 'offline'
  await payee.collectNow()
  payee.stop()
  assert.ok(w.events.some(e => e.kind === 'error' && e.messageId === undefined && e.error === 'offline'))
  assert.equal(payee.checkedAt, before)
})

test('the host is the one you choose, for reading and acknowledging', async () => {
  const w = await world()
  const payee = await w.start({ host: 'https://box.example' })
  await w.pay(100)
  await payee.collectNow()
  payee.stop()
  assert.equal(w.paid.length, 1)
  assert.ok(w.inbox.hosts.length >= 2)
  assert.ok(w.inbox.hosts.every(h => h === 'https://box.example'))
})
