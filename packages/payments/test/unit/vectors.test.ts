/**
 * Byte compatibility with the app: every value of Appendix C reproduced
 * (the identity and the anchor record; peer sessions are peer-sessions.test.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import {
  anchorContextHex, anchorRecordJson, anchorSignaturePayload, deriveOfflineDestination, parseAnchorRecord, toHex, verifyAnchorRecord
} from '../support/internals.ts'
import { C } from '../fixtures/appendix-c.ts'
import { identityFromPhrase, signAnchorRecord } from '../support/payee.ts'

test('identity from the abandon…about phrase: PBKDF2 seed, Ed25519, peer ID', async () => {
  const id = await identityFromPhrase(C.phrase)
  assert.equal(toHex(id.seed), C.pbkdf2Seed)
  assert.equal(toHex(id.edPublic), C.ed25519Public)
  assert.equal(id.peerId, C.peerId)
})

test('anchor record: context, signed digest, record JSON, verification', async () => {
  const id = await identityFromPhrase(C.phrase)
  assert.equal(anchorContextHex(C.ed25519Public, 0), C.anchorContextHex)
  const rec = signAnchorRecord(id, { anchorPublicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', epoch: 0, networkType: 'test', timestamp: 1760000000000 })
  assert.equal(toHex(anchorSignaturePayload(rec)), C.anchorPayloadSha256)
  assert.equal(anchorRecordJson(rec), C.anchorRecordJson)
  const parsed = parseAnchorRecord(JSON.parse(C.anchorRecordJson))
  assert.equal(verifyAnchorRecord(parsed, C.peerId, 'test'), null)
  assert.match(verifyAnchorRecord(parsed, C.peerId, 'main')!, /network test, not main/)
  assert.match(verifyAnchorRecord({ ...parsed, timestamp: 1 }, C.peerId, 'test')!, /signature/)
  assert.match(verifyAnchorRecord({ ...parsed, epoch: 1 }, C.peerId, 'test')!, /anchor context/)
  assert.match(verifyAnchorRecord({ ...parsed, version: 1 }, C.peerId, 'test')!, /version 1/)
  assert.match(verifyAnchorRecord(parsed, '12D3KooWJfrcqqdoAcKUjAB6dGkC9KHCsTG5WKHZH8hk1wLs67it', 'test')!, /names peer/)
  assert.match(verifyAnchorRecord({ ...parsed, anchorPublicKey: '04' + parsed.anchorPublicKey.slice(2) }, C.peerId, 'test')!, /signature|compressed/)
})

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
