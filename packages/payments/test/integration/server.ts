/**
 * Copied from ricochet-js (test/integration/server.ts) with its own
 * database name and binary path, and the circuit relay service on with
 * loopback-friendly limits.
 *
 * Builds and runs a throwaway go-ricochet server from the local source tree
 * for the integration tests: its own PostgreSQL database (created from the
 * repo's schema.sql and dropped afterwards), a temporary data directory and
 * identity, listening on loopback over UDX, TCP, WebSocket and, when openssl
 * is available, TLS WebSocket with a self-signed certificate.
 *
 * Environment:
 *   RICOCHET_SRC      go-ricochet checkout (default ../go-ricochet next to this repo)
 *   RICOCHET_TEST_DB  database name (default ricochet_payments_test)
 *   RICOCHET_PG_HOST  PostgreSQL host (default localhost), RICOCHET_PG_PORT (default 5432),
 *                     RICOCHET_PG_USER (default $USER), RICOCHET_PG_PASSWORD (default none).
 *                     `npm run test:db` starts one in Docker: see test/docker-compose.yml.
 *   RICOCHET_KEEP     keep the temp dir and database for inspection
 */

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const here = new URL('.', import.meta.url).pathname
export const ricochetSrc = resolve(process.env.RICOCHET_SRC ?? join(here, '../../../../../go-ricochet'))
export const dbName = process.env.RICOCHET_TEST_DB ?? 'ricochet_payments_test'
const pgHost = process.env.RICOCHET_PG_HOST ?? 'localhost'
const pgPort = process.env.RICOCHET_PG_PORT ?? '5432'
const pgUser = process.env.RICOCHET_PG_USER ?? process.env.USER ?? 'postgres'
const pgPassword = process.env.RICOCHET_PG_PASSWORD ?? ''
if (!/^\d+$/.test(pgPort)) throw new Error(`RICOCHET_PG_PORT is not a port: ${pgPort}`)

if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('test')) {
  throw new Error(`refusing to use database "${dbName}": the name must contain "test" and only [a-z0-9_]`)
}

export interface TestServer {
  peerId: string
  udx: string
  tcp: string
  ws: string
  /** TLS WebSocket address, when a certificate could be made. */
  wss?: string
  /** PEM of the self-signed certificate behind wss. */
  certPem?: string
  /** base64 SHA-256 of the certificate's SubjectPublicKeyInfo, for Chromium. */
  certSpki?: string
  log: () => string
  stop: () => Promise<void>
}

async function freeTcpPort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => { resolve(port) })
    })
  })
}

async function freeUdpPort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createSocket('udp4')
    s.once('error', reject)
    s.bind(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => { resolve(port) })
    })
  })
}

async function psql (db: string, args: string[]): Promise<string> {
  const { stdout } = await run('psql', ['-h', pgHost, '-p', pgPort, '-U', pgUser, '-v', 'ON_ERROR_STOP=1', '-q', '-X', db, ...args],
    { env: { ...process.env, ...(pgPassword !== '' ? { PGPASSWORD: pgPassword } : {}) } })
  return stdout
}

/**
 * Turns on version history for one document. The protocol has no way to do
 * this (documents.history_enabled defaults to false and nothing sets it), so
 * the test sets it in its own throwaway database.
 */
export async function enableDocumentHistory (owner: string, path: string): Promise<void> {
  if (!/^\w+$/.test(owner) || !/^[\w/-]+$/.test(path)) throw new Error('unexpected owner or path')
  await psql(dbName, ['-c', `UPDATE documents SET history_enabled = true WHERE owner_peer_id = '${owner}' AND path = '${path}'`])
}

export async function dropDatabase (): Promise<void> {
  await psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`])
}

async function createDatabase (): Promise<void> {
  await dropDatabase()
  await psql('postgres', ['-c', `CREATE DATABASE ${dbName}`])
  await psql(dbName, ['-f', join(ricochetSrc, 'schema.sql')])
}

let built: Promise<string> | undefined

/** go build ./cmd/ricochet into a temp dir, once per process. */
export async function buildServer (): Promise<string> {
  built ??= (async () => {
    // A fixed place, so repeated runs do not pile up binaries; go build's
    // cache makes the rebuild quick.
    const out = join(tmpdir(), 'ricochet-payments-bin', 'ricochet')
    await run('go', ['build', '-o', out, './cmd/ricochet'], { cwd: ricochetSrc, maxBuffer: 1 << 24 })
    return out
  })()
  return await built
}

async function makeCert (dir: string): Promise<{ cert: string, key: string, pem: string, spki: string } | undefined> {
  const cert = join(dir, 'cert.pem')
  const key = join(dir, 'key.pem')
  try {
    await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'])
  } catch {
    return undefined
  }
  const pem = await readFile(cert, 'utf8')
  const spkiDer = new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })
  return { cert, key, pem, spki: createHash('sha256').update(spkiDer).digest('base64') }
}

export interface ServerOptions {
  /**
   * Cut each relayed connection after this long or this many bytes, so
   * peers see a limited connection. go-ricochet sets no limit by default
   * (since 40fa8a0); an operator may set one.
   */
  relayLimit?: { durationSec: number, dataBytes: number }
}

/** go-libp2p's own relay limits, which go-ricochet used before 40fa8a0. */
export const GO_LIBP2P_RELAY_LIMIT = { durationSec: 120, dataBytes: 128 * 1024 }

export async function startServer (options: ServerOptions = {}): Promise<TestServer> {
  if (!existsSync(join(ricochetSrc, 'cmd/ricochet'))) throw new Error(`go-ricochet source not found at ${ricochetSrc} (set RICOCHET_SRC)`)
  const binary = await buildServer()
  await createDatabase()
  const dir = await mkdtemp(join(tmpdir(), 'ricochet-payments-'))
  const [udxPort, tcpPort, wsPort, wssPort] = [await freeUdpPort(), await freeTcpPort(), await freeTcpPort(), await freeTcpPort()]
  const cert = await makeCert(dir)

  const listen = [
    `/ip4/127.0.0.1/udp/${udxPort}/udx`,
    `/ip4/127.0.0.1/tcp/${tcpPort}`,
    `/ip4/127.0.0.1/tcp/${wsPort}/ws`,
    ...(cert !== undefined ? [`/ip4/127.0.0.1/tcp/${wssPort}/tls/ws`] : [])
  ]
  const config = [
    'server:',
    '  transports: [udx, tcp, websocket]',
    '  listen_addresses:',
    ...listen.map(a => `    - ${a}`),
    ...(cert !== undefined ? ['  websocket_tls:', `    cert_file: ${cert.cert}`, `    key_file: ${cert.key}`] : []),
    '  bootstrap_peers: []',
    'features:',
    '  enable_relay: true',
    '  enable_relay_service: true',
    // Every test peer is on 127.0.0.1: lift the per-IP reservation cap (default 8).
    'relay_limits:',
    '  max_reservations_per_ip: 256',
    '  max_reservations_per_peer: 16',
    ...(options.relayLimit !== undefined
      ? [`  connection_duration_sec: ${options.relayLimit.durationSec}`, `  connection_data: ${options.relayLimit.dataBytes}`]
      : []),
    'storage:',
    `  data_directory: ${join(dir, 'data')}`,
    'database:',
    `  host: ${pgHost}`,
    `  port: ${pgPort}`,
    `  name: ${dbName}`,
    `  username: ${pgUser}`,
    '  sslmode: disable',
    'ops:',
    '  enabled: false',
    ''
  ].join('\n')
  await writeFile(join(dir, 'config.yaml'), config)

  let output = ''
  const child: ChildProcess = spawn(binary, ['--development', '--config', join(dir, 'config.yaml'), '--data-dir', join(dir, 'data')], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RICOCHET_PG_PASSWORD: pgPassword }
  })
  child.stdout!.on('data', (d: Buffer) => { output += d.toString() })
  child.stderr!.on('data', (d: Buffer) => { output += d.toString() })
  const exited = new Promise<number | null>(resolve => child.once('exit', code => { resolve(code) }))

  const peerId = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => { reject(new Error(`server did not start:\n${output}`)) }, 30_000)
    const check = (): void => {
      const m = /Peer ID: (12D3KooW\w+)/.exec(output)
      if (m !== null) { clearTimeout(deadline); resolve(m[1]!) }
    }
    child.stdout!.on('data', check)
    child.stderr!.on('data', check)
    void exited.then(code => { clearTimeout(deadline); reject(new Error(`server exited (${code}):\n${output}`)) })
  })

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    await exited
    clearTimeout(timer)
    await writeFile(join(dir, 'server.log'), output)
    if (process.env.RICOCHET_KEEP === undefined) {
      await rm(dir, { recursive: true, force: true })
      await dropDatabase()
    }
  }

  const p = `/p2p/${peerId}`
  return {
    peerId,
    udx: `/ip4/127.0.0.1/udp/${udxPort}/udx${p}`,
    tcp: `/ip4/127.0.0.1/tcp/${tcpPort}${p}`,
    ws: `/ip4/127.0.0.1/tcp/${wsPort}/ws${p}`,
    ...(cert !== undefined ? { wss: `/ip4/127.0.0.1/tcp/${wssPort}/tls/ws${p}`, certPem: cert.pem, certSpki: cert.spki } : {}),
    log: () => output,
    stop
  }
}
