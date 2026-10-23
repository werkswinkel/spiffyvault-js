/**
 * Serves build/browser on loopback and opens it in headless Chromium.
 * Uses Playwright's own Chromium when installed, else the system Google
 * Chrome (channel "chrome"); PAYMENTS_CHROMIUM_CHANNEL overrides.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'

const dir = fileURLToPath(new URL('../../build/browser/', import.meta.url))

export interface BrowserSession {
  page: Page
  /** Which browser ran, e.g. "chrome 141.0... (channel chrome)". */
  browser: string
  logs: string[]
  close: () => Promise<void>
}

async function serve (): Promise<{ server: Server, url: string }> {
  const server = createServer((req, res) => {
    const name = req.url === '/' || req.url === undefined ? 'index.html' : req.url.slice(1).split('?')[0]!
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(404).end(); return }
    readFile(dir + name).then(body => {
      res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body)
    }, () => { res.writeHead(404).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  // localhost is a secure context, as an https:// page would be.
  return { server, url: `http://localhost:${port}/` }
}

async function launch (args: string[]): Promise<{ browser: Browser, how: string }> {
  const channel = process.env.PAYMENTS_CHROMIUM_CHANNEL
  if (channel !== undefined) return { browser: await chromium.launch({ channel, headless: true, args }), how: `channel ${channel}` }
  try {
    return { browser: await chromium.launch({ headless: true, args }), how: 'Playwright Chromium' }
  } catch {
    return { browser: await chromium.launch({ channel: 'chrome', headless: true, args }), how: 'channel chrome' }
  }
}

export async function openPage (opts: { trustSpki?: string } = {}): Promise<BrowserSession> {
  const { server, url } = await serve()
  const args = opts.trustSpki !== undefined ? [`--ignore-certificate-errors-spki-list=${opts.trustSpki}`] : []
  const { browser, how } = await launch(args)
  const page = await browser.newPage()
  const logs: string[] = []
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`))
  await page.goto(url)
  await page.waitForFunction(() => document.title === 'ready', undefined, { timeout: 20_000 })
  return {
    page,
    browser: `${browser.browserType().name()} ${browser.version()} (${how}, headless)`,
    logs,
    close: async () => {
      await browser.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
  }
}
