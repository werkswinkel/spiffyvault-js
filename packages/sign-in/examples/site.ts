/**
 * An example site with Sign in with SpiffyVault: plain node:http, sessions
 * in memory. Run `npm run example`, or with `HOST=192.168.1.5` (this
 * computer's address on the network) so a phone on the same network can
 * reach the callback, then open http://<HOST>:8787/ and scan.
 *
 * Endpoints: POST /sign-in/start (sets the browser cookie), GET
 * /sign-in/poll, POST /sign-in/callback (the app), GET /sign-in/return
 * (mode return), GET /me.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { SignInSite } from '@spiffyvault/sign-in'

export interface ExampleSite { url: string, site: SignInSite, close: () => Promise<void> }

const cookies = (req: IncomingMessage): Record<string, string> =>
  Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=') as [string, string]).filter(([k]) => k !== ''))

const id = (): string => randomBytes(18).toString('base64url')

async function body (req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const chunk of req) {
    s += chunk
    if (s.length > 16384) throw new Error('body too large')
  }
  return s
}

function send (res: ServerResponse, status: number, value: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(value))
}

export async function startExampleSite (opts: { host?: string, port?: number } = {}): Promise<ExampleSite> {
  const host = opts.host ?? 'localhost'
  const server: Server = createServer()
  await new Promise<void>(resolve => server.listen(opts.port ?? 0, host === 'localhost' ? '127.0.0.1' : '0.0.0.0', resolve))
  const port = (server.address() as { port: number }).port
  const origin = `http://${host}:${port}`
  const site = new SignInSite({ domain: host, callback: `${origin}/sign-in/callback`, name: 'Example Site', returnBase: `${origin}/sign-in/return` })
  const sessions = new Map<string, string>()

  const script = (await build({
    entryPoints: [fileURLToPath(new URL('./page.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false
  })).outputFiles[0]!.text
  const page = `<!doctype html><meta charset="utf-8"><title>Example Site</title>
<style>body{font:16px system-ui;margin:2rem}.spiffyvault-sign-in-qr svg{width:220px;height:220px}.spiffyvault-sign-in-code{font:600 2rem ui-monospace,monospace;letter-spacing:.3em}</style>
<h1>Example Site</h1><div id="sign-in"></div><script type="module">${script}</script>`

  const session = (sid: string): string => `sv_session=${sid}; HttpOnly; SameSite=Lax; Path=/`

  server.on('request', (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin)
      const jar = cookies(req)
      try {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(page)
        } else if (req.method === 'GET' && url.pathname === '/me') {
          const key = sessions.get(jar.sv_session ?? '')
          send(res, 200, key !== undefined ? { publicKey: key } : {})
        } else if (req.method === 'POST' && url.pathname === '/sign-in/start') {
          const mode = await body(req)
          if (mode !== 'code' && mode !== 'return') { send(res, 400, { error: 'mode' }); return }
          const browser = jar.sv_browser ?? id()
          send(res, 200, await site.start({ mode, browser }), { 'set-cookie': `sv_browser=${browser}; HttpOnly; SameSite=Lax; Path=/` })
        } else if (req.method === 'GET' && url.pathname === '/sign-in/poll') {
          const r = await site.poll(url.searchParams.get('nonce') ?? '', jar.sv_browser ?? '')
          if (r.state !== 'signed-in') { send(res, 200, r); return }
          const sid = id()
          sessions.set(sid, r.publicKey)
          send(res, 200, { state: 'signed-in' }, { 'set-cookie': session(sid) })
        } else if (req.method === 'POST' && url.pathname === '/sign-in/callback') {
          let json: unknown
          try { json = JSON.parse(await body(req)) } catch { json = null }
          const reply = await site.answer(json)
          send(res, reply.status, reply.body)
        } else if (req.method === 'GET' && url.pathname === '/sign-in/return') {
          const key = await site.redeem(url.searchParams.get('t') ?? '')
          if (key === undefined) { send(res, 410, { error: 'used or unknown' }); return }
          const sid = id()
          sessions.set(sid, key)
          res.writeHead(303, { location: '/', 'set-cookie': session(sid) })
          res.end()
        } else {
          send(res, 404, { error: 'not found' })
        }
      } catch (e) {
        send(res, 500, { error: String(e) })
      }
    })()
  })

  return { url: origin, site, close: async () => await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startExampleSite({ host: process.env.HOST ?? 'localhost', port: Number(process.env.PORT ?? 8787) })
  console.log(`Example site at ${s.url}/  (add ?mode=code or ?mode=return to choose)`)
}
