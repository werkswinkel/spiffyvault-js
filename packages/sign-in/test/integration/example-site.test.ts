/**
 * The example site end to end over HTTP, with the app's half played by
 * signChallenge: both modes, the browser cookie, and the page in Chromium.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { randomBytes } from '../../src/bytes.ts'
import { parseChallengeLink } from '../../src/challenge.ts'
import { siteKey, signChallenge } from '../../src/keys.ts'
import type { Started } from '../../src/site.ts'
import { startExampleSite } from '../../examples/site.ts'
import type { ExampleSite } from '../../examples/site.ts'

let s: ExampleSite
const phone = randomBytes(32)

before(async () => { s = await startExampleSite() })
after(async () => { await s.close() })

/** A browser: fetch with its own cookies. */
function browser () {
  const jar = new Map<string, string>()
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const r = await fetch(new URL(path, s.url), {
      ...init, redirect: 'manual', headers: { ...(init.headers as object), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }
    })
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const [k, v] = kv!.split('='); jar.set(k!, v!)
    }
    return r
  }
}

/** The phone: sign the challenge and post it to the callback. */
async function approve (link: string, code?: string): Promise<{ status: number, body: any }> {
  const c = parseChallengeLink(link)
  const r = await fetch(c.callback, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signChallenge(phone, c, code)) })
  return { status: r.status, body: await r.json() }
}

test('mode code: the asking browser is signed in; a browser with only the nonce is not', async () => {
  const mine = browser()
  const theirs = browser()
  const started = await (await mine('/sign-in/start', { method: 'POST', body: 'code' })).json() as Started
  assert.deepEqual(await approve(started.link, started.code), { status: 200, body: { ok: true } })
  assert.equal((await (await theirs(`/sign-in/poll?nonce=${started.nonce}`)).json()).state, 'gone')
  assert.equal((await (await mine(`/sign-in/poll?nonce=${started.nonce}`)).json()).state, 'signed-in')
  assert.deepEqual(await (await mine('/me')).json(), { publicKey: siteKey(phone, 'localhost') })
  assert.deepEqual(await (await theirs('/me')).json(), {})
})

test('mode code: the wrong code is refused and the challenge is used up', async () => {
  const mine = browser()
  const started = await (await mine('/sign-in/start', { method: 'POST', body: 'code' })).json() as Started
  const wrong = started.code === '123456' ? '654321' : '123456'
  assert.deepEqual(await approve(started.link, wrong), { status: 400, body: { ok: false, error: 'code' } })
  assert.deepEqual(await approve(started.link, started.code), { status: 409, body: { ok: false, error: 'used' } })
  assert.equal((await (await mine(`/sign-in/poll?nonce=${started.nonce}`)).json()).state, 'refused')
})

test('mode return: whichever browser opens the return link is signed in, once', async () => {
  const asking = browser()
  const phoneBrowser = browser()
  const started = await (await asking('/sign-in/start', { method: 'POST', body: 'return' })).json() as Started
  const reply = await approve(started.link)
  assert.equal(reply.status, 200)
  const back = await phoneBrowser(reply.body.return_url)
  assert.equal(back.status, 303)
  assert.deepEqual(await (await phoneBrowser('/me')).json(), { publicKey: siteKey(phone, 'localhost') })
  assert.equal((await (await asking(`/sign-in/poll?nonce=${started.nonce}`)).json()).state, 'gone', 'polling never gives it')
  assert.equal((await browser()(reply.body.return_url)).status, 410, 'the link works once')
})

test('Chromium: the page shows the QR code and the code, and signs in when the phone approves', async () => {
  // Playwright's own Chromium when it is installed, else the system Chrome (as the payments harness does).
  const chrome = await chromium.launch({ headless: true }).catch(async () => await chromium.launch({ channel: 'chrome', headless: true }))
  try {
    const page = await chrome.newPage()
    const startedP = page.waitForResponse(r => r.url().endsWith('/sign-in/start'))
    await page.goto(`${s.url}/?mode=code`)
    const started = await (await startedP).json() as Started
    await page.locator('.spiffyvault-sign-in-qr svg').waitFor()
    assert.equal(await page.locator('.spiffyvault-sign-in-code').textContent(), started.code)
    assert.equal((await approve(started.link, started.code)).status, 200)
    await page.getByText('Signed in.').waitFor({ timeout: 10000 })
    assert.match(await page.locator('#sign-in').textContent() ?? '', new RegExp(siteKey(phone, 'localhost')))
  } finally {
    await chrome.close()
  }
})
