// A sign-in name or place with an invisible format character is refused,
// as the app refuses it (review finding 11).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChallengeError, readChallenge } from '../../src/challenge.ts'

const json = (name: string, place?: string): Record<string, unknown> => ({
  v: 2,
  domain: 'shop.example',
  nonce: 'AAECAwQFBgcICQoLDA0ODw',
  ts: 1793000000,
  mode: 'code',
  callback: 'https://shop.example/api/sign-in/callback',
  name,
  ...(place === undefined ? {} : { place })
})

test('a right-to-left override, an isolate or a zero-width space is refused', () => {
  for (const bad of ['Shop\u202Epohs', 'Shop \u2067x\u2069', 'Ex\u200Bample']) {
    assert.throws(() => readChallenge(json(bad)), ChallengeError, bad)
    assert.throws(() => readChallenge(json('Example Shop', bad)), ChallengeError, bad)
  }
})

test('a plain name, and a zero-width joiner as in an emoji, are not', () => {
  assert.equal(readChallenge(json('Example Shop', 'Lagos, Nigeria')).name, 'Example Shop')
  assert.ok(readChallenge(json('Caf\u00E9 \uD83D\uDC69\u200D\uD83D\uDCBB')))
})
