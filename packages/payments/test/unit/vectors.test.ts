/**
 * Byte compatibility with the app: every value of Appendix C reproduced.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import {
  anchorContextHex, anchorRecordJson, anchorSignaturePayload, bundleCanonicalBytes, decodePreKeySignalMessage,
  deriveOfflineDestination, firstChain, fromHex, parseAnchorRecord, parsePrekeyBundle, prekeyBundleJson, sealFirstMessage,
  toHex, utf8, verifyAnchorRecord, verifyPrekeyBundle, x25519Public, x3dhInitiator
} from '../support/internals.ts'
import { C } from '../fixtures/appendix-c.ts'
import { fill, identityFromPhrase, openPreKeyMessage, signAnchorRecord, signBundle } from '../support/payee.ts'

const keys = () => ({ registrationId: 12345, signedPreKeyId: 1, signedPreKeyPrivate: fill(0x11), oneTimePreKeys: new Map([[7, fill(0x22)]]) })

test('identity from the abandon…about phrase: PBKDF2 seed, Ed25519, X25519, peer ID', async () => {
  const id = await identityFromPhrase(C.phrase)
  assert.equal(toHex(id.seed), C.pbkdf2Seed)
  assert.equal(toHex(id.edPublic), C.ed25519Public)
  assert.equal(toHex(id.xPublic), C.x25519Public)
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

test('prekey bundle: canonical bytes, signatures, JSON, verification incl. the peer ID key', async () => {
  const id = await identityFromPhrase(C.phrase)
  const b = signBundle(id, keys(), 1760000000000)
  assert.equal(toHex(bundleCanonicalBytes(b)), C.bundleCanonicalBytesHex)
  assert.equal(prekeyBundleJson(b), C.bundleJson)
  const parsed = parsePrekeyBundle(JSON.parse(C.bundleJson))
  assert.equal(verifyPrekeyBundle(parsed, C.peerId), null)
  assert.match(verifyPrekeyBundle({ ...parsed, registrationId: 1 }, C.peerId)!, /bundle signature/)
  assert.match(verifyPrekeyBundle(parsed, '12D3KooWJfrcqqdoAcKUjAB6dGkC9KHCsTG5WKHZH8hk1wLs67it')!, /names peer/)
  // A bundle signed by another key that names our payee: the app takes it; we do not.
  const other = await identityFromPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow')
  const forged = signBundle({ ...other, peerId: C.peerId }, keys(), 1760000000000)
  assert.match(verifyPrekeyBundle(forged, C.peerId)!, /not the payee peer ID's key/)
  const iso = parsePrekeyBundle({ ...JSON.parse(C.bundleJson), publishedAt: '2025-10-09T08:53:20.000Z' })
  assert.equal(iso.publishedAt, 1760000000000)
})

test('X3DH and the first chain step: DH1-DH4, SK, CK0, MK0, CK1', () => {
  const bundle = parsePrekeyBundle(JSON.parse(C.bundleJson))
  assert.equal(toHex(x25519Public(fill(0x33))), C.payerX25519IdentityPublic)
  assert.equal(toHex(x25519Public(fromHex(C.payerEphemeralPrivate))), C.payerEphemeralPublic)
  const x = x3dhInitiator({
    identityPrivate: fill(0x33),
    ephemeralPrivate: fromHex(C.payerEphemeralPrivate),
    theirIdentity: fromHex(bundle.identityKeyPublicX25519),
    theirSignedPreKey: x25519Public(fill(0x11)),
    theirOneTimePreKey: x25519Public(fill(0x22))
  })
  assert.equal(toHex(x.dh1), C.dh1)
  assert.equal(toHex(x.dh2), C.dh2)
  assert.equal(toHex(x.dh3), C.dh3)
  assert.equal(toHex(x.dh4!), C.dh4)
  assert.equal(toHex(x.sk), C.sk)
  const chain = firstChain(x.sk)
  assert.equal(toHex(chain.ck0), C.ck0)
  assert.equal(toHex(chain.mk0), C.mk0)
  assert.equal(toHex(chain.ck1), C.ck1)
})

test('the full PreKeySignalMessage, byte for byte, from the printed ephemeral key and nonce', () => {
  const bundle = parsePrekeyBundle(JSON.parse(C.bundleJson))
  const sealed = sealFirstMessage(bundle, utf8(C.plaintext), {
    oneTimePreKey: 7, identityPrivate: fill(0x33), ephemeralPrivate: fromHex(C.payerEphemeralPrivate), nonce: fromHex(C.nonce), registrationId: 99
  })
  assert.equal(toHex(sealed.bytes), C.pkmHex)
  const m = decodePreKeySignalMessage(sealed.bytes)
  assert.equal(toHex(m.message.authTag), C.authTag)
  assert.equal(toHex(m.message.ephemeralPublicKey) + '00000000', C.aad)
})

test('the JS payee opens the app-made message and its own', async () => {
  const id = await identityFromPhrase(C.phrase)
  assert.equal(new TextDecoder().decode(openPreKeyMessage(id, keys(), fromHex(C.pkmHex))), C.plaintext)
  const bundle = parsePrekeyBundle(JSON.parse(C.bundleJson))
  for (const oneTimePreKey of ['random', 'none'] as const) {
    const s = sealFirstMessage(bundle, utf8('hello'), { oneTimePreKey })
    assert.equal(s.preKeyId, oneTimePreKey === 'none' ? undefined : 7)
    assert.equal(new TextDecoder().decode(openPreKeyMessage(id, keys(), s.bytes)), 'hello')
  }
  const wrong = { ...keys(), oneTimePreKeys: new Map() }
  assert.throws(() => openPreKeyMessage(id, wrong, sealFirstMessage(bundle, utf8('x'), { oneTimePreKey: 7 }).bytes), /One-time pre-key 7 not found/)
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
