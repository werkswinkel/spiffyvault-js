/**
 * The fixture the app's Dart test (spiffyvault test/signal/js_interop_test.dart)
 * decrypts: it must still open with the JS payee, so a change that breaks
 * it shows here before the Dart run.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PrivateKey } from '@bsv/sdk'
import { fromHex, fromUtf8 } from '../support/internals.ts'
import { collectOfflinePayment } from '../support/offline-payee.ts'
import { identityFromPhrase, openPreKeyMessage } from '../support/payee.ts'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/js-offline-messages.json', import.meta.url), 'utf8'))

test('every message of the Dart fixture opens with the JS payee', async () => {
  const p = fixture.payee
  const id = await identityFromPhrase(p.phrase)
  assert.equal(id.peerId, p.peerId)
  const keys = {
    registrationId: p.registrationId,
    signedPreKeyId: p.signedPreKeyId,
    signedPreKeyPrivate: fromHex(p.signedPreKeySeedHex),
    oneTimePreKeys: new Map<number, Uint8Array>(p.oneTimePreKeys.map((k: { id: number, seedHex: string }) => [k.id, fromHex(k.seedHex)]))
  }
  assert.ok(fixture.messages.length >= 6)
  for (const m of fixture.messages) {
    const bytes = fromHex(m.pkmHex)
    assert.equal(fromUtf8(openPreKeyMessage(id, keys, bytes)), m.plaintext, m.name)
    if (m.payment === true) {
      const c = collectOfflinePayment(id, keys, PrivateKey.fromHex(p.anchorPrivateKeyHex), { senderPeerId: m.senderPeerId, payload: bytes })
      assert.equal(c.txid, m.txid)
      assert.equal(c.paidSats, m.amountSats)
    }
  }
})
