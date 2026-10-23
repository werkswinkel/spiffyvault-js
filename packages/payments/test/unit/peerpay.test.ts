import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import {
  DEFAULT_MESSAGE_BOX_HOST, PaymentError, PeerPayUndeliveredError, createPeerPayClient, payViaPeerPay
} from '../../src/index.ts'
import type { MessageBoxSender } from '../../src/index.ts'
import { FakeWallet } from '../support/fake-wallet.ts'
import { payeeAcceptsToken } from '../support/peerpay-payee.ts'

class Box implements MessageBoxSender {
  sent: Array<{ message: { recipient: string, messageBox: string, body: string }, host?: string }> = []
  fail?: string
  async sendMessage (message: { recipient: string, messageBox: string, body: string }, host?: string): Promise<unknown> {
    if (this.fail !== undefined) throw new Error(this.fail)
    this.sent.push({ message, ...(host !== undefined ? { host } : {}) })
    return { status: 'success', messageId: 'ab'.repeat(32) }
  }
}

function payee (): { proto: ProtoWallet, key: string } {
  const root = PrivateKey.fromRandom()
  return { proto: new ProtoWallet(root), key: root.toPublicKey().toString() }
}

const asWallet = (w: FakeWallet): WalletInterface => w as unknown as WalletInterface

test('pays a BRC-29 output the payee derives, and delivers the token to the default host', async () => {
  const wallet = new FakeWallet()
  const box = new Box()
  const p = payee()
  const r = await payViaPeerPay({ paymentKey: p.key, amountSats: 1234, note: '  Coffee  ' }, { wallet: asWallet(wallet), client: box })
  assert.equal(r.path, 'peerpay')
  assert.equal(r.status, 'delivered')
  assert.equal(r.outputIndex, 0)
  assert.equal(box.sent.length, 1)
  const { message, host } = box.sent[0]!
  assert.equal(host, DEFAULT_MESSAGE_BOX_HOST)
  assert.equal(host, 'https://messagebox.bsvblockchain.tech')
  assert.equal(message.messageBox, 'payment_inbox')
  assert.equal(message.recipient, p.key)
  const token = JSON.parse(message.body)
  assert.deepEqual(Object.keys(token), ['customInstructions', 'transaction', 'amount', 'outputIndex', 'description'])
  assert.equal(token.description, 'Coffee')
  assert.equal(token.amount, 1234)
  assert.deepEqual(token.transaction.slice(0, 4), [1, 1, 1, 1])
  const sender = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const accepted = await payeeAcceptsToken(p.proto, sender, token)
  assert.equal(accepted.txid, r.txid)
  // PeerPay broadcasts: createAction without noSend, outputs kept in order.
  const create = wallet.calls.find(c => c.method === 'createAction')!.args as { options: Record<string, unknown> }
  assert.equal(create.options.noSend, undefined)
  assert.equal(create.options.randomizeOutputs, false)
  assert.equal(create.options.acceptDelayedBroadcast, false)
})

test('names the output index when the wallet puts change first', async () => {
  const wallet = new FakeWallet({ changeFirst: true })
  const box = new Box()
  const p = payee()
  const r = await payViaPeerPay({ paymentKey: p.key, amountSats: 500 }, { wallet: asWallet(wallet), client: box })
  assert.equal(r.outputIndex, 1)
  const token = JSON.parse(box.sent[0]!.message.body)
  assert.equal(token.outputIndex, 1)
  assert.equal('description' in token, false)
  await payeeAcceptsToken(p.proto, (await wallet.getPublicKey({ identityKey: true })).publicKey, token)
})

test('the host is configurable', async () => {
  const box = new Box()
  await payViaPeerPay({ paymentKey: payee().key, amountSats: 10 }, { wallet: asWallet(new FakeWallet()), client: box, host: 'https://box.example' })
  assert.equal(box.sent[0]!.host, 'https://box.example')
  const client = createPeerPayClient(asWallet(new FakeWallet()))
  assert.equal((client as unknown as { host: string }).host, DEFAULT_MESSAGE_BOX_HOST)
  const other = createPeerPayClient(asWallet(new FakeWallet()), 'https://box.example')
  assert.equal((other as unknown as { host: string }).host, 'https://box.example')
})

test('refuses a bad key, its own key and a bad amount before building anything', async () => {
  const wallet = new FakeWallet()
  const ctx = { wallet: asWallet(wallet), client: new Box() }
  await assert.rejects(payViaPeerPay({ paymentKey: '04' + 'ab'.repeat(32), amountSats: 1 }, ctx), (e: PaymentError) => e.code === 'bad-key' && e.canPayAnotherWay)
  const own = (await wallet.getPublicKey({ identityKey: true })).publicKey
  await assert.rejects(payViaPeerPay({ paymentKey: own, amountSats: 1 }, ctx), (e: PaymentError) => e.code === 'own-key')
  await assert.rejects(payViaPeerPay({ paymentKey: payee().key, amountSats: 0 }, ctx), (e: PaymentError) => e.code === 'amount-invalid')
  assert.equal(wallet.calls.some(c => c.method === 'createAction'), false)
})

test('a failed broadcast delivers nothing', async () => {
  const box = new Box()
  await assert.rejects(payViaPeerPay({ paymentKey: payee().key, amountSats: 10 }, { wallet: asWallet(new FakeWallet({ failBroadcast: true })), client: box }),
    (e: PaymentError) => e.code === 'broadcast-failed' && !e.canPayAnotherWay && e.txid !== undefined)
  assert.equal(box.sent.length, 0)
})

test('a wallet error is a funding failure', async () => {
  await assert.rejects(payViaPeerPay({ paymentKey: payee().key, amountSats: 10 }, { wallet: asWallet(new FakeWallet({ failCreate: 'Insufficient funds' })), client: new Box() }),
    (e: PaymentError) => e.code === 'funding-failed' && e.stage === 'pay')
})

test('an Atomic BEEF with a txid-only parent is not delivered (SpiffyVault refuses it)', async () => {
  const box = new Box()
  await assert.rejects(payViaPeerPay({ paymentKey: payee().key, amountSats: 10 }, { wallet: asWallet(new FakeWallet({ txidOnlyParent: true })), client: box }),
    (e: PaymentError) => e.code === 'beef-unusable' && e.stage === 'deliver' && e.txid !== undefined)
  assert.equal(box.sent.length, 0)
})

test('a failed delivery keeps the token for another try', async () => {
  const box = new Box()
  box.fail = 'HTTP 503'
  const p = payee()
  const wallet = new FakeWallet()
  const err = await payViaPeerPay({ paymentKey: p.key, amountSats: 10 }, { wallet: asWallet(wallet), client: box }).catch(e => e)
  assert.ok(err instanceof PeerPayUndeliveredError)
  assert.equal(err.canPayAnotherWay, false)
  assert.equal(err.recipient, p.key)
  await payeeAcceptsToken(p.proto, (await wallet.getPublicKey({ identityKey: true })).publicKey, err.token)
})

test('unproven ancestors are carried in the Atomic BEEF', async () => {
  const box = new Box()
  const p = payee()
  const wallet = new FakeWallet({ unprovenDepth: 2 })
  await payViaPeerPay({ paymentKey: p.key, amountSats: 10 }, { wallet: asWallet(wallet), client: box })
  const token = JSON.parse(box.sent[0]!.message.body)
  await payeeAcceptsToken(p.proto, (await wallet.getPublicKey({ identityKey: true })).publicKey, token)
})
