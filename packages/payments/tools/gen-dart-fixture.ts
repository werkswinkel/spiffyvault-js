/**
 * Writes JS-made offline payment messages for the app's Dart test
 * (spiffyvault test/signal/js_interop_test.dart), which decrypts them with
 * the app's own SessionCipher and checks the plaintext, the
 * OfflinePaymentMessage, the BEEF (libspiffy BEEF.parse) and the BRC-42
 * destination (libspiffy Type42).
 *
 *   node tools/gen-dart-fixture.ts [out.json]
 *
 * Payee: the abandon…about phrase, signed prekey seed 0x11×32 (id 1),
 * one-time prekeys 0x22×32 (id 7) and 0x23×32 (id 8), anchor private key
 * 0x05×32. Payers and their keys are random; the output records them.
 */

import { writeFileSync } from 'node:fs'
import { PrivateKey } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import {
  anchorRecordJson, fromUtf8, payOffline, prekeyBundleJson, sealFirstMessage, toHex, utf8
} from '../test/support/internals.ts'
import { FakeWallet } from '../test/support/fake-wallet.ts'
import { MemRicochet } from '../test/support/mem-ricochet.ts'
import { ABANDON, fill, identityFromPhrase, identityFromSeed, openPreKeyMessage, signAnchorRecord, signBundle } from '../test/support/payee.ts'
import type { PayeePrekeys } from '../test/support/payee.ts'

const out = process.argv[2] ?? new URL('../test/fixtures/js-offline-messages.json', import.meta.url).pathname

const payee = await identityFromPhrase(ABANDON)
const keys: PayeePrekeys = { registrationId: 12345, signedPreKeyId: 1, signedPreKeyPrivate: fill(0x11), oneTimePreKeys: new Map([[7, fill(0x22)], [8, fill(0x23)]]) }
const anchorPriv = PrivateKey.fromHex('05'.repeat(32))
const bundle = signBundle(payee, keys, 1760000000000)
const record = signAnchorRecord(payee, { anchorPublicKey: anchorPriv.toPublicKey().toString(), epoch: 0, networkType: 'test', timestamp: 1760000000000 })

interface Entry { name: string, senderPeerId: string, pkmHex: string, plaintext: string, preKeyId: number | null, payment: boolean, amountSats?: number, txid?: string }
const messages: Entry[] = []

async function viaPayOffline (name: string, seed: number, note: string | undefined, oneTimePreKey: 'random' | 'none' | number, amountSats: number, depth = 0): Promise<void> {
  const server = new MemRicochet(payee.peerId)
  server.putDoc(payee.peerId, 'wallet/payment-anchor', anchorRecordJson(record))
  await server.sendMessage(payee.peerId, prekeyBundleJson(bundle), { folderPath: 'signal/prekeys', persistent: true })
  const payer = (await identityFromSeed(fill(seed))).peerId
  const wallet = new FakeWallet({ unprovenDepth: depth, coins: [1_000_000] })
  const r = await payOffline({ payeePeerId: payee.peerId, amountSats, ...(note !== undefined ? { note } : {}), network: 'testnet' },
    { wallet: wallet as unknown as WalletInterface, ricochet: server.as(payer), seal: { oneTimePreKey } })
  const m = server.mail.find(x => x.folderPath === 'wallet/offline-payments')!
  const plaintext = fromUtf8(openPreKeyMessage(payee, keys, m.payload))
  // the one-time prekey used (for 'random', read back from the bytes)
  const preKeyId = m.payload[4] === 1 ? new DataView(m.payload.buffer, m.payload.byteOffset).getUint32(5) : null
  messages.push({ name, senderPeerId: m.senderPeerId, pkmHex: toHex(m.payload), plaintext, preKeyId, payment: true, amountSats, txid: r.txid })
}

await viaPayOffline('payment-opk7', 0x31, 'Coffee · ref ABCD2345', 7, 2500)
await viaPayOffline('payment-3dh', 0x32, undefined, 'none', 1, 2)
await viaPayOffline('payment-random-opk', 0x33, 'Ünïcode ☕ note', 'random', 123456)
// Two first messages from one sender: the payee holds a session after the first.
await viaPayOffline('same-sender-1', 0x34, 'first', 8, 1000)
await viaPayOffline('same-sender-2', 0x34, 'second', 7, 2000)

// A large plaintext (not a payment): lengths beyond 64 KiB.
const big = 'x'.repeat(100_000)
const bigSealed = sealFirstMessage(bundle, utf8(big), { oneTimePreKey: 8 })
messages.push({ name: 'large-plaintext', senderPeerId: (await identityFromSeed(fill(0x35))).peerId, pkmHex: toHex(bigSealed.bytes), plaintext: big, preKeyId: 8, payment: false })

writeFileSync(out, JSON.stringify({
  note: 'Made by @spiffyvault/payments tools/gen-dart-fixture.ts; see that file.',
  payee: {
    phrase: ABANDON, peerId: payee.peerId, registrationId: keys.registrationId, signedPreKeyId: 1,
    signedPreKeySeedHex: toHex(fill(0x11)), oneTimePreKeys: [{ id: 7, seedHex: toHex(fill(0x22)) }, { id: 8, seedHex: toHex(fill(0x23)) }],
    anchorPrivateKeyHex: anchorPriv.toHex(), anchorRecordJson: anchorRecordJson(record), bundleJson: prekeyBundleJson(bundle)
  },
  messages
}, null, 1) + '\n')
console.log(`wrote ${messages.length} messages to ${out}`)
