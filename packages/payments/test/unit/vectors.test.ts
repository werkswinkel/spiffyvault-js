/**
 * Byte compatibility with the app: the identity of Appendix C and the
 * app's anchor vectors (peer sessions are peer-sessions.test.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'node:fs'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  anchorContextHex, anchorRecordJson, anchorSignedText, deriveOfflineDestination, parseAnchorRecord, toHex, utf8, verifyAnchorRecord
} from '../support/internals.ts'
import { C } from '../fixtures/appendix-c.ts'
import { identityFromPhrase } from '../support/payee.ts'

test('identity from the abandon…about phrase: PBKDF2 seed, Ed25519, peer ID', async () => {
  const id = await identityFromPhrase(C.phrase)
  assert.equal(toHex(id.seed), C.pbkdf2Seed)
  assert.equal(toHex(id.edPublic), C.ed25519Public)
  assert.equal(id.peerId, C.peerId)
})

// The app's master copy (test/vectors/payment_anchor_v3.json), checked
// against the hash written next to it.
const anchorText = readFileSync(new URL('../fixtures/payment_anchor_v3.json', import.meta.url), 'utf8')
const A = JSON.parse(anchorText)

test('anchor vectors: the file is the one its hash names', () => {
  const written = readFileSync(new URL('../fixtures/payment_anchor_v3.json.sha256', import.meta.url), 'utf8').trim()
  assert.equal(toHex(sha256(utf8(anchorText))), written)
})

test('anchor contexts: testnet keeps its own, mainnet and regtest name the network', () => {
  for (const [network, c] of Object.entries(A.contexts as Record<string, Record<string, string>>)) {
    assert.equal(anchorContextHex(A.identityPublicKey, 0, network), c.offlineEpoch0)
    assert.equal(anchorContextHex(A.identityPublicKey, 1, network), c.offlineEpoch1)
  }
})

const check = (c: { record: unknown, network: string, readAt: string, checkedAt: number }): string | null =>
  verifyAnchorRecord(parseAnchorRecord(c.record), A.peerId, c.network, c.readAt, c.checkedAt)

for (const [name, c] of Object.entries(A.records as Record<string, { record: unknown, network: string, readAt: string, checkedAt: number, signedText: string }>)) {
  test(`anchor record verifies: ${name}`, () => {
    assert.equal(check(c), null)
    const record = parseAnchorRecord(c.record)
    assert.equal(anchorSignedText(record), c.signedText)
    assert.equal(anchorRecordJson(record), JSON.stringify(c.record))
  })
}

for (const [name, c] of Object.entries(A.refused as Record<string, { record: unknown, network: string, readAt: string, checkedAt: number, because: string }>)) {
  test(`anchor record refused: ${name}`, () => {
    assert.ok(check(c)?.includes(c.because), `${check(c)} does not say ${c.because}`)
  })
}

test('BRC-42 offline destination: the go-sdk BRC-29 pin libspiffy tests', () => {
  // libspiffy test/crypto/type42_brc29_test.dart:22-30
  const anchorPriv = '6a1751169c111b4667a6539ee1be6b7cd9f6e9c8fe011a5f2fe31e03a15e0ede'
  const anchorPub = PrivateKey.fromHex(anchorPriv).toPublicKey().toString()
  const d = deriveOfflineDestination(anchorPub, 'ctx', 'testnet', {
    senderPrivateKey: 'cab2500e206f31bc18a8af9d6f44f0b9a208c32d5cca2b22acfe9d1a213b2f36', prefix: 'SfKxPIJNgdI=', suffix: 'NaGLC6fMH50='
  })
  assert.equal(d.childPublicKey, '0311687dd083f8585e3e4efbb9e5bbe6ce8c6c495f1f6e6f16eff1b0d8393d05c2')
  assert.equal(d.address, 'mqAtCUB3FhfWaHpbcxigNZ1j4rsskWZvFj')
  assert.equal(d.derivation.invoiceNumber, '2-3241645161d8-SfKxPIJNgdI= NaGLC6fMH50=')
  assert.deepEqual(Object.keys(d.derivation), ['anchorPublicKey', 'anchorContext', 'senderPublicKey', 'invoiceNumber'])
  // and the payee re-derives the same key from its private anchor
  const child = PrivateKey.fromHex(anchorPriv).deriveChild(PrivateKey.fromHex('cab2500e206f31bc18a8af9d6f44f0b9a208c32d5cca2b22acfe9d1a213b2f36').toPublicKey(), d.derivation.invoiceNumber)
  assert.equal(child.toPublicKey().toString(), d.childPublicKey)
  const fresh = deriveOfflineDestination(anchorPub, 'ctx', 'mainnet')
  assert.match(fresh.derivation.invoiceNumber, /^2-3241645161d8-[A-Za-z0-9+/]{22}== [A-Za-z0-9+/]{22}==$/)
  assert.match(fresh.address, /^1/)
})
