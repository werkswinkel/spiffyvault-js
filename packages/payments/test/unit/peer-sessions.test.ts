/**
 * The peer-session vectors (SpiffyVault doc/peer-sessions.md section 9):
 * this copy has the hash SpiffyVault writes next to its master copy, and
 * every vector reads back here. The first messages are sealed again from
 * the printed keys, byte for byte as package:double_ratchet writes them.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cbc } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  concat, decodeBundle, decodeOneTimeKeyItem, encodeBundle, encodeOneTimeKeyItem, equalBytes, fromHex, fromUtf8, sealFirstMessage, toHex, utf8,
  verifyBundle, verifyOneTimeKeyItem
} from '../support/internals.ts'
import { decodeKey, dh, edPublicToX25519, encodeKey, identityOfSeed, kdfCk, kdfRk, messageKeys, x25519Public } from '../../src/sessions/keys.ts'
import { sealWithKeys } from '../../src/sessions/seal.ts'
import { identityFromSeed, openPreKeyMessage } from '../support/payee.ts'
import type { PayeeSessionKeys } from '../support/payee.ts'

const file = new URL('../fixtures/peer_sessions_v1.json', import.meta.url)
const text = readFileSync(file, 'utf8')
const v = JSON.parse(text)
const h = (s: string): Uint8Array => fromHex(s)

const bobKeys = (withOneTime: boolean): PayeeSessionKeys => ({
  signedPreKeyId: v.signedPreKey.id,
  signedPreKeyPrivate: h(v.signedPreKey.private),
  oneTimePreKeys: new Map(withOneTime ? [[v.oneTimePreKey.id, h(v.oneTimePreKey.private)]] : [])
})

test('this copy has the hash of SpiffyVault\'s master copy', () => {
  const written = readFileSync(new URL('../fixtures/peer_sessions_v1.json.sha256', import.meta.url), 'utf8').split(' ')[0]
  assert.equal(toHex(sha256(utf8(text))), written)
  assert.equal(v.application, 'peer-sessions/1')
})

test('each identity: its Ed25519 key, the X25519 form of it, and the peer ID made from it', async () => {
  for (const name of ['alice', 'bob']) {
    const id = await identityFromSeed(h(v[name].seed))
    assert.equal(toHex(id.edPublic), v[name].ed25519)
    assert.equal(toHex(edPublicToX25519(id.edPublic)), v[name].x25519)
    // The private side of the map agrees with the public one.
    assert.equal(toHex(x25519Public(identityOfSeed(h(v[name].seed)).x25519Private)), v[name].x25519)
    assert.equal(id.peerId, v[name].peerId)
  }
})

test('the bundles are Bob\'s, signed, with and without a one-time pre-key, and nobody else\'s', () => {
  const bundle = decodeBundle(h(v.bundle))
  assert.equal(toHex(bundle.identityKey), v.bob.ed25519)
  assert.equal(bundle.signedPreKeyId, v.signedPreKey.id)
  assert.equal(toHex(encodeKey(bundle.signedPreKey)), v.signedPreKey.public)
  assert.equal(bundle.oneTimePreKey, undefined)
  assert.equal(verifyBundle(bundle, v.bob.peerId), null)
  assert.equal(toHex(encodeBundle(bundle)), v.bundle)
  assert.match(verifyBundle(bundle, v.alice.peerId)!, /not the payee peer ID's key/)
  const tampered = h(v.bundle); tampered[40] = tampered[40]! ^ 1
  assert.match(verifyBundle(decodeBundle(tampered), v.bob.peerId)!, /signature/)
  assert.throws(() => decodeBundle(h(v.bundle).slice(1)))
  assert.throws(() => decodeBundle(concat(h(v.bundle), new Uint8Array([0]))))

  const withOne = decodeBundle(h(v.bundleWithOneTimePreKey))
  assert.equal(withOne.oneTimePreKey?.id, v.oneTimePreKey.id)
  assert.equal(toHex(encodeKey(withOne.oneTimePreKey!.key)), v.oneTimePreKey.public)
  assert.equal(toHex(encodeBundle(withOne)), v.bundleWithOneTimePreKey)
})

test('the one-time pre-key item is Bob\'s key, signed by Bob only', () => {
  const item = decodeOneTimeKeyItem(h(v.oneTimePreKey.item))!
  assert.equal(item.id, v.oneTimePreKey.id)
  assert.equal(toHex(encodeKey(item.key)), v.oneTimePreKey.public)
  assert.equal(toHex(encodeOneTimeKeyItem(item)), v.oneTimePreKey.item)
  assert.ok(verifyOneTimeKeyItem(item, h(v.bob.ed25519)))
  assert.ok(!verifyOneTimeKeyItem(item, h(v.alice.ed25519)))
  const tampered = h(v.oneTimePreKey.item); tampered[4] = tampered[4]! ^ 1
  assert.ok(!verifyOneTimeKeyItem(decodeOneTimeKeyItem(tampered)!, h(v.bob.ed25519)))
  assert.equal(decodeOneTimeKeyItem(tampered.slice(1)), null)
})

for (const [name, withOneTime] of [['withOneTimePreKey', true], ['withoutOneTimePreKey', false]] as const) {
  test(`the first message ${withOneTime ? 'with' : 'without'} a one-time pre-key, sealed again byte for byte; Bob opens it`, async () => {
    const first = v.firstMessage[name]
    const bundle = decodeBundle(h(withOneTime ? v.bundleWithOneTimePreKey : v.bundle))
    const sealed = sealWithKeys(bundle, h(v.alice.seed), utf8(v.firstMessage.plaintext), {
      ephemeralPrivate: h(v.aliceEphemeral.private), ratchetPrivate: h(v.aliceRatchet.private)
    })
    assert.equal(toHex(sealed.keys.sk), first.sk)
    assert.equal(toHex(sealed.keys.rootKey), first.rootKey)
    assert.equal(toHex(sealed.keys.chainKey), first.chainKey)
    assert.equal(toHex(sealed.keys.messageKey), first.messageKey)
    const mk = messageKeys(sealed.keys.messageKey)
    assert.deepEqual([toHex(mk.aesKey), toHex(mk.hmacKey), toHex(mk.iv)], [first.aesKey, first.hmacKey, first.iv])
    assert.equal(toHex(encodeKey(sealed.ephemeralPublic)), v.aliceEphemeral.public)
    assert.equal(toHex(sealed.bytes), first.preKeyMessage)
    assert.equal(sealed.oneTimePreKeyId, withOneTime ? v.oneTimePreKey.id : undefined)

    const bob = await identityFromSeed(h(v.bob.seed))
    const keys = bobKeys(withOneTime)
    assert.equal(fromUtf8(openPreKeyMessage(bob, keys, h(first.preKeyMessage), v.alice.peerId)), v.firstMessage.plaintext)
    // As another peer's message it is refused: the key is not that peer ID's.
    assert.throws(() => openPreKeyMessage(bob, bobKeys(withOneTime), h(first.preKeyMessage), v.bob.peerId), /UntrustedIdentity/)
    if (withOneTime) assert.throws(() => openPreKeyMessage(bob, keys, h(first.preKeyMessage), v.alice.peerId), /no one-time pre-key/)
  })
}

test('fresh keys: the payee opens what the payer seals, and a changed byte is refused', async () => {
  const bob = await identityFromSeed(h(v.bob.seed))
  const bundle = decodeBundle(h(v.bundleWithOneTimePreKey))
  const sealed = sealFirstMessage(bundle, h(v.alice.seed), utf8('hello'))
  assert.equal(fromUtf8(openPreKeyMessage(bob, bobKeys(true), sealed.bytes, v.alice.peerId)), 'hello')
  const changed = Uint8Array.from(sealed.bytes); changed[changed.length - 40] = changed[changed.length - 40]! ^ 1
  assert.throws(() => openPreKeyMessage(bob, bobKeys(true), changed, v.alice.peerId), /bad MAC/)
  assert.throws(() => sealFirstMessage({ ...bundle, signedPreKey: new Uint8Array(32) }, h(v.alice.seed), utf8('x')), /low-order/)
})

test('Bob\'s reply: the ratchet turns with his reply key, and Alice\'s side of it opens the message', () => {
  const r = v.reply
  const rk1 = h(v.firstMessage.withOneTimePreKey.rootKey)
  const theirs = decodeKey(h(r.bobRatchet.public))
  const asAlice = kdfRk(rk1, dh(h(v.aliceRatchet.private), theirs))
  const asBob = kdfRk(rk1, dh(h(r.bobRatchet.private), decodeKey(h(v.aliceRatchet.public))))
  assert.ok(equalBytes(asAlice.rootKey, asBob.rootKey))
  assert.equal(toHex(asAlice.rootKey), r.rootKey)
  assert.equal(toHex(asAlice.chainKey), r.chainKey)
  const { messageKey } = kdfCk(asAlice.chainKey)
  assert.equal(toHex(messageKey), r.messageKey)
  const { aesKey, hmacKey, iv } = messageKeys(messageKey)
  assert.deepEqual([toHex(aesKey), toHex(hmacKey), toHex(iv)], [r.aesKey, r.hmacKey, r.iv])

  const message = h(r.message)
  const header = message.slice(0, 43)
  assert.deepEqual([...header.slice(0, 2)], [1, 1])
  assert.equal(toHex(header.slice(2, 35)), r.bobRatchet.public)
  assert.equal(toHex(header.slice(35, 43)), '0000000000000000')
  const ciphertext = message.slice(43, message.length - 32)
  assert.equal(toHex(hmac(sha256, hmacKey, concat(h(v.associatedData), header, ciphertext))), toHex(message.slice(message.length - 32)))
  assert.equal(fromUtf8(cbc(aesKey, iv).decrypt(ciphertext)), r.plaintext)
  assert.equal(v.associatedData, v.alice.ed25519 + v.bob.ed25519)
})

test('the app record reads back', () => {
  assert.deepEqual(JSON.parse(fromUtf8(h(v.appRecord.bytes))), { v: 1, app: v.appRecord.app, at: v.appRecord.at })
})
