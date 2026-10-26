/**
 * The sign-in vectors (SpiffyVault doc/sign-in.md section 9): this copy has
 * the hash SpiffyVault writes next to its master copy, and every vector
 * comes out the same here: the site keys, the links, the signed texts and
 * the signatures, byte for byte, and the same challenges are refused.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, toBase64Url, toHex, utf8 } from '../../src/bytes.ts'
import { checkChallenge, challengeLink, parseChallengeLink, readChallenge, signedText } from '../../src/challenge.ts'
import { siteKey, siteSeed, signChallenge, verifyResponse } from '../../src/keys.ts'

const text = readFileSync(new URL('../fixtures/sign_in_v2.json', import.meta.url), 'utf8')
const v = JSON.parse(text)
const seed = fromHex(v.identitySeed)
const link = (json: unknown): string => `spiffyvault://auth?c=${toBase64Url(utf8(JSON.stringify(json)))}`

test('this copy has the hash of SpiffyVault\'s master copy', () => {
  const written = readFileSync(new URL('../fixtures/sign_in_v2.json.sha256', import.meta.url), 'utf8').split(' ')[0]
  assert.equal(toHex(sha256(utf8(text))), written)
  assert.equal(v.protocol, 'OIAP-v2')
})

test('the site seeds and keys', () => {
  for (const [domain, site] of Object.entries(v.sites as Record<string, { seed: string, publicKey: string }>)) {
    assert.equal(toHex(siteSeed(seed, domain)), site.seed)
    assert.equal(siteKey(seed, domain), site.publicKey)
  }
})

for (const [mode, e] of Object.entries(v.challenges as Record<string, any>)) {
  test(`mode ${mode}: the link, the signed text and the signature, as the app makes them`, () => {
    const c = readChallenge(e.challenge)
    assert.equal(challengeLink(c), e.link)
    assert.deepEqual(parseChallengeLink(e.link), c)
    assert.equal(signedText(c, e.code), e.signedText)
    const now = c.ts + 10
    assert.deepEqual(signChallenge(seed, c, e.code, now), e.response)
    assert.ok(verifyResponse(c, e.response, e.code))
    if (mode === 'code') {
      assert.ok(!verifyResponse(c, e.response, '000000'), 'another code does not verify')
      assert.ok(!verifyResponse({ ...c, name: 'Other Shop' }, e.response, e.code), 'another name does not verify')
    }
  })
}

for (const [name, json] of Object.entries(v.refused as Record<string, unknown>)) {
  test(`refused: ${name}`, () => {
    assert.throws(() => {
      const c = parseChallengeLink(link(json))
      checkChallenge(c, c.ts)
    })
  })
}

for (const [name, json] of Object.entries(v.local as Record<string, unknown>)) {
  test(`accepted for development: ${name}`, () => {
    const c = parseChallengeLink(link(json))
    checkChallenge(c, c.ts)
  })
}
