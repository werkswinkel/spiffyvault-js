/**
 * SignInSite (SpiffyVault doc/sign-in.md sections 4 and 7), with the app's
 * half played by signChallenge, which the vectors tie to the app.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from '../../src/bytes.ts'
import { parseChallengeLink } from '../../src/challenge.ts'
import { siteKey, signChallenge } from '../../src/keys.ts'
import { SignInSite } from '../../src/site.ts'

const T0 = 1793000000
const phone = randomBytes(32)

function site (now = { t: T0 }): SignInSite {
  return new SignInSite({
    domain: 'shop.example',
    callback: 'https://shop.example/sign-in/callback',
    name: 'Example Shop',
    returnBase: 'https://shop.example/sign-in/return',
    now: () => now.t
  })
}

test('mode code: the asking browser gets the key once, after the phone signs with the right code', async () => {
  const s = site()
  const started = await s.start({ mode: 'code', browser: 'b1', place: 'Lagos, Nigeria' })
  assert.match(started.code!, /^\d{6}$/)
  assert.ok(!started.link.includes(started.code!), 'the code is not in the QR code')
  const c = parseChallengeLink(started.link)
  assert.equal(c.place, 'Lagos, Nigeria')

  assert.deepEqual(await s.poll(started.nonce, 'b1'), { state: 'waiting' })
  const reply = await s.answer(signChallenge(phone, c, started.code, T0))
  assert.deepEqual(reply.body, { ok: true })
  assert.equal(reply.publicKey, siteKey(phone, 'shop.example'))

  assert.deepEqual(await s.poll(started.nonce, 'someone-else'), { state: 'gone' }, 'another browser with the nonce gets nothing')
  assert.deepEqual(await s.poll(started.nonce, 'b1'), { state: 'signed-in', publicKey: siteKey(phone, 'shop.example') })
  assert.deepEqual(await s.poll(started.nonce, 'b1'), { state: 'gone' }, 'once only')
})

test('mode code: a wrong code uses up the challenge', async () => {
  const s = site()
  const started = await s.start({ mode: 'code', browser: 'b1' })
  const c = parseChallengeLink(started.link)
  const wrong = started.code === '000000' ? '000001' : '000000'
  assert.deepEqual((await s.answer(signChallenge(phone, c, wrong, T0))).body, { ok: false, error: 'code' })
  assert.deepEqual((await s.answer(signChallenge(phone, c, started.code, T0))).body, { ok: false, error: 'used' })
  assert.deepEqual(await s.poll(started.nonce, 'b1'), { state: 'refused' })
})

test('a response signed for another challenge, site or key is refused', async () => {
  const s = site()
  const a = await s.start({ mode: 'code', browser: 'b1' })
  const b = await s.start({ mode: 'code', browser: 'b1' })
  const forA = signChallenge(phone, parseChallengeLink(a.link), a.code, T0)
  assert.deepEqual((await s.answer({ ...forA, nonce: b.nonce })).body, { ok: false, error: 'code' })
  // A was not answered yet: a swapped key reads as a signature that does not verify.
  assert.deepEqual((await s.answer({ ...forA, public_key: siteKey(randomBytes(32), 'shop.example') })).body, { ok: false, error: 'code' })
  assert.deepEqual((await s.answer(forA)).body, { ok: false, error: 'used' })
  // Signed for the same nonce at another site: another key, another text.
  const c = await s.start({ mode: 'code', browser: 'b1' })
  const forOtherSite = signChallenge(phone, { ...parseChallengeLink(c.link), domain: 'other.example', callback: 'https://other.example/cb' }, c.code, T0)
  assert.deepEqual((await s.answer(forOtherSite)).body, { ok: false, error: 'code' })
})

test('late, unknown and malformed answers', async () => {
  const now = { t: T0 }
  const s = site(now)
  const started = await s.start({ mode: 'code', browser: 'b1' })
  const r = signChallenge(phone, parseChallengeLink(started.link), started.code, T0)
  now.t = T0 + 301
  assert.deepEqual((await s.answer(r)).body, { ok: false, error: 'expired' })
  assert.deepEqual((await s.answer({ ...r, nonce: 'A'.repeat(22) })).body, { ok: false, error: 'unknown' })
  assert.deepEqual((await s.answer({ nonce: r.nonce })).body, { ok: false, error: 'bad-request' })
  assert.deepEqual((await s.answer(null)).status, 400)
})

test('mode return: the return link carries a one-time token; polling never gives the key', async () => {
  const s = site()
  const started = await s.start({ mode: 'return', browser: 'b1' })
  assert.equal(started.code, undefined)
  const c = parseChallengeLink(started.link)
  const reply = await s.answer(signChallenge(phone, c, undefined, T0))
  assert.equal(reply.body.ok, true)
  const url = new URL((reply.body as { return_url: string }).return_url)
  assert.equal(`${url.origin}${url.pathname}`, 'https://shop.example/sign-in/return')

  assert.deepEqual(await s.poll(started.nonce, 'b1'), { state: 'gone' }, 'the browser that asked does not get it by polling')
  const token = url.searchParams.get('t')!
  assert.equal(await s.redeem(token), siteKey(phone, 'shop.example'))
  assert.equal(await s.redeem(token), undefined, 'once only')
})

test('the site refuses settings the app would refuse', () => {
  const base = { domain: 'shop.example', callback: 'https://shop.example/cb', name: 'Shop' }
  assert.throws(() => new SignInSite({ ...base, callback: 'https://evil.example/cb' }))
  assert.throws(() => new SignInSite({ ...base, callback: 'http://shop.example/cb' }))
  assert.throws(() => new SignInSite({ ...base, returnBase: 'https://evil.example/r' }))
  assert.throws(() => new SignInSite({ ...base, domain: 'Shop.Example' }))
  assert.throws(() => new SignInSite({ ...base, name: 'x'.repeat(65) }))
  new SignInSite({ domain: 'localhost', callback: 'http://localhost:8787/cb', name: 'Dev' })
})
