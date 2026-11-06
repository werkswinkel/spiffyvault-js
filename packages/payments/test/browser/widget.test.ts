/**
 * The payment widget in headless Chrome, against a fake shop server the
 * test drives: what a computer and a phone show, progress, onPaid once, a
 * payee offline, a refusal, expiry and a new link, and an unreachable shop.
 * No relay needed: the widget only shows links and asks the shop.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
let browser: Browser
let bundle: string

const LIVE = 'https://spiffyvault.net/pay?n=testnet&p=12D3KooWRawPbxPtP1eZaJpumGnyWX2DcUyd3RQnydr3eAto4Az7&k=02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc&a=37000&m=Order%201042&r=K7Q2M9XD&d=shop.example&s=sig'
const PEERPAY = 'https://spiffyvault.net/pay?n=testnet&k=02a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc&a=37000&m=Order%201042&r=K7Q2M9XD'

before(async () => {
  const out = await build({
    stdin: { contents: 'export * from "./src/widget.ts"', resolveDir: root, loader: 'ts' },
    bundle: true, format: 'iife', globalName: 'SpiffyVaultWidget', platform: 'browser', target: 'es2022', write: false, logLevel: 'warning'
  })
  bundle = out.outputFiles[0]!.text
  try {
    browser = await chromium.launch({ headless: true })
  } catch {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  }
})

after(async () => { await browser?.close() })

/**
 * A page with the widget mounted. The fake shop answers `request` from
 * window.nextRequest and `status` from window.nextStatus (or throws when
 * it is the string "down"); window.calls records what the widget asked.
 */
async function mount (device: 'phone' | 'computer', expiresInMs = 600_000, extra = ''): Promise<Page> {
  const page = await browser.newPage({ viewport: device === 'phone' ? { width: 390, height: 844 } : { width: 1100, height: 800 } })
  page.on('pageerror', e => { console.log('pageerror', e.message) })
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="pay"></div>')
  await page.addScriptTag({ content: bundle })
  await page.evaluate(({ device, expiresInMs, LIVE, PEERPAY, extra }) => {
    const w = window as unknown as Record<string, unknown>
    w.calls = { request: [] as unknown[], status: 0, paid: 0 }
    w.nextRequest = (n: number) => ({ id: `order-${n}`, ref: 'K7Q2M9XD', network: 'testnet', amountSats: 37000, expiresAt: Date.now() + expiresInMs, links: { live: LIVE, peerpay: PEERPAY }, ...JSON.parse(extra || '{}') })
    w.nextStatus = { id: 'order-1', step: 'shown' }
    const calls = w.calls as { request: unknown[], status: number, paid: number }
    ;(w.SpiffyVaultWidget as { mountPayment: (el: HTMLElement, o: unknown) => void }).mountPayment(document.getElementById('pay')!, {
      device,
      pollEvery: 100,
      request: async (previous?: { id: string }) => {
        calls.request.push(previous?.id ?? null)
        return (w.nextRequest as (n: number) => unknown)(calls.request.length)
      },
      status: async (id: string) => {
        calls.status++
        if (w.nextStatus === 'down') throw new Error('shop down')
        return { ...(w.nextStatus as object), id }
      },
      onPaid: () => { calls.paid++ }
    })
  }, { device, expiresInMs, LIVE, PEERPAY, extra })
  await page.waitForSelector('.spiffyvault-pay', { state: 'attached' })
  return page
}

const setStatus = async (page: Page, s: object | 'down'): Promise<void> => {
  await page.evaluate(s => { (window as unknown as Record<string, unknown>).nextStatus = s }, s)
}
const text = async (page: Page, sel: string): Promise<string> => (await page.locator(sel).innerText()).trim()

test('on a computer: QR, the other ways open under it, progress beside it, the trust line', async () => {
  const page = await mount('computer')
  assert.equal(await page.locator('.spiffyvault-pay-qrcol .spiffyvault-pay-qr svg').count(), 1)
  assert.equal(await page.locator('details.spiffyvault-pay-more').getAttribute('open'), '')
  assert.equal(await text(page, '.spiffyvault-pay-more summary'), 'Other ways to pay')
  // The other ways sit under the QR, before the progress.
  assert.equal(await page.locator('.spiffyvault-pay-qrcol details').count(), 1)
  assert.equal(await page.getByText('Open in SpiffyVault on this computer').getAttribute('href'), LIVE)
  assert.equal(await page.getByText('Pay by PeerPay').getAttribute('href'), PEERPAY)
  assert.match(await text(page, '.spiffyvault-pay-steps li.is-now'), /^Link shown · expires in (10:00|9:5\d)$/)
  assert.equal(await text(page, '.spiffyvault-pay-title'), 'Waiting for your phone')
  assert.equal(await text(page, '.spiffyvault-pay-trust'), 'Payee listed by shop.example · link signed')
  assert.equal(await page.locator('.spiffyvault-pay-amount').first().innerText(), '37,000 sats')
  await page.close()
})

test('progress follows the shop, and onPaid is called once', async () => {
  const page = await mount('computer')
  await setStatus(page, { step: 'checking' })
  await page.waitForFunction(() => document.querySelector('.spiffyvault-pay-steps li.is-now')?.textContent === 'Payment received, checking it')
  assert.equal(await page.locator('.spiffyvault-pay-steps li.is-done').count(), 2)
  await setStatus(page, { step: 'paid', path: 'live', txid: 'ab'.repeat(32) })
  await page.waitForSelector('.spiffyvault-pay-done .spiffyvault-pay-pill')
  assert.equal(await text(page, '.spiffyvault-pay-done p'), 'Paid live from your wallet.')
  assert.equal(await page.locator('.spiffyvault-pay-done a').getAttribute('href'), `https://test.whatsonchain.com/tx/${'ab'.repeat(32)}`)
  assert.equal(await page.locator('.spiffyvault-pay-grid').isHidden(), true)
  const before = await page.evaluate(() => (window as unknown as { calls: { status: number } }).calls.status)
  await page.waitForTimeout(400)
  const calls = await page.evaluate(() => (window as unknown as { calls: { status: number, paid: number } }).calls)
  assert.equal(calls.paid, 1)
  assert.equal(calls.status, before, 'no polling once paid')
  await page.close()
})

test('on a phone: the app button first, "Pay another way" folded under it, the QR inside only when asked for', async () => {
  const page = await mount('phone')
  assert.equal(await page.getByText('Pay with SpiffyVault').getAttribute('href'), LIVE)
  assert.equal(await page.locator('svg').count(), 0)
  const details = page.locator('details.spiffyvault-pay-more')
  assert.equal(await details.getAttribute('open'), null)
  assert.equal(await text(page, '.spiffyvault-pay-more summary'), 'Pay another way')
  assert.equal(await text(page, '.spiffyvault-pay-title'), 'Waiting for your payment')
  // Folded right under the button, before the progress.
  const order = await page.evaluate(() => Array.from(document.querySelector('.spiffyvault-pay-col')!.children, c => c.className))
  assert.deepEqual(order.slice(0, 4), ['spiffyvault-pay-button is-primary', 'spiffyvault-pay-hint', 'spiffyvault-pay-more', 'spiffyvault-pay-title'])
  await page.locator('.spiffyvault-pay-more summary').click()
  assert.equal(await page.getByText('Pay by PeerPay').getAttribute('href'), PEERPAY)
  await page.getByText('Pay from another device').click()
  assert.equal(await page.locator('details.spiffyvault-pay-more .spiffyvault-pay-qr svg').count(), 1)
  assert.equal(await text(page, 'details .spiffyvault-pay-qrcol .spiffyvault-pay-hint'), 'Scan with SpiffyVault on your other device')
  // No horizontal scroll at phone width.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.close()
})

test('a payee that is away, a refusal, and PeerPay or mailbox progress each say so', async () => {
  const page = await mount('computer', 600_000, '{"payeeOnline":false}')
  assert.equal(await page.locator('.spiffyvault-pay-notice', { hasText: 'can\'t take live payments' }).isVisible(), true)
  await setStatus(page, { step: 'refused', reason: 'the amount changed', payeeOnline: true })
  await page.waitForSelector('.spiffyvault-pay-notice.is-bad:visible')
  assert.equal(await text(page, '.spiffyvault-pay-notice.is-bad'), 'Your payment did not go through: the amount changed. Nothing was taken. Try again.')
  assert.equal(await page.locator('.spiffyvault-pay-notice', { hasText: 'can\'t take live payments' }).isHidden(), true)
  await setStatus(page, { step: 'on-the-way', path: 'peerpay' })
  await page.waitForSelector('.spiffyvault-pay-notice.is-info:visible')
  assert.match(await text(page, '.spiffyvault-pay-notice.is-info'), /broadcast the payment/)
  await setStatus(page, { step: 'in-mailbox' })
  await page.waitForFunction(() => document.querySelector('.spiffyvault-pay-notice.is-info')?.textContent?.includes('mailbox') === true)
  await page.close()
})

test('an expired link offers a new one, which asks the shop with the old request', async () => {
  const page = await mount('computer', -1000)
  await page.waitForSelector('text=This payment link has expired')
  assert.equal(await page.locator('.spiffyvault-pay-grid').isHidden(), true)
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const make = w.nextRequest as (n: number) => Record<string, unknown>
    w.nextRequest = (n: number) => ({ ...make(n), expiresAt: Date.now() + 600_000 })
  })
  await page.getByText('Make a new link').click()
  await page.waitForSelector('.spiffyvault-pay-grid:visible')
  const calls = await page.evaluate(() => (window as unknown as { calls: { request: unknown[] } }).calls.request)
  assert.deepEqual(calls, [null, 'order-1'])
  await page.close()
})

test('README: the checkout page asks the shop over fetch and goes on when paid', async () => {
  const out = await build({
    stdin: { contents: 'export { checkout } from "./examples/widget.ts"', resolveDir: root, loader: 'ts' },
    bundle: true, format: 'iife', globalName: 'Checkout', platform: 'browser', target: 'es2022', write: false, logLevel: 'warning',
    alias: { '@spiffyvault/payments/widget': './src/widget.ts', '@spiffyvault/payments': './src/core.ts' }
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', e => { console.log('pageerror', e.message) })
  let paid = false
  let posts = 0
  await page.route('https://shop.example/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/checkout') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="pay"></div>' })
    if (url.pathname === '/orders/1042/thanks') return await route.fulfill({ contentType: 'text/html', body: '<p>Thanks</p>' })
    if (url.pathname !== '/orders/1042/payment') return await route.fulfill({ status: 404 })
    if (route.request().method() === 'POST') {
      posts++
      return await route.fulfill({ json: { id: '1042', ref: 'K7Q2M9XD', network: 'testnet', amountSats: 37000, expiresAt: Date.now() + 600_000, links: { live: LIVE, peerpay: PEERPAY } } })
    }
    return await route.fulfill({ json: paid ? { id: '1042', step: 'paid', path: 'live', txid: 'ab'.repeat(32) } : { id: '1042', step: 'shown' } })
  })
  await page.goto('https://shop.example/checkout')
  await page.addScriptTag({ content: out.outputFiles[0]!.text })
  await page.evaluate(() => { (window as unknown as { Checkout: { checkout: (id: string) => void } }).Checkout.checkout('1042') })
  await page.waitForSelector('.spiffyvault-pay-qr svg')
  assert.equal(posts, 1)
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.spiffyvault-pay')!).getPropertyValue('--spiffyvault-pay-accent').trim()), '#0b6e4f')
  paid = true
  await page.waitForURL('https://shop.example/orders/1042/thanks', { timeout: 10_000 })
  await page.close()
})

test('a shop that stops answering is said to be unreachable, and the widget keeps asking', async () => {
  const page = await mount('computer')
  await setStatus(page, 'down')
  await page.waitForSelector('text=The shop isn\'t answering right now', { timeout: 5000 })
  await setStatus(page, { step: 'shown' })
  await page.waitForSelector('text=The shop isn\'t answering right now', { state: 'hidden', timeout: 5000 })
  await page.close()
})
