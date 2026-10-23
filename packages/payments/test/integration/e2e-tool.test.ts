/**
 * tools/e2e-pay.ts against a local go-ricochet and a JS payee that is both
 * published for offline payments and reachable live through the relay.
 * No coins: the dry run checks every path; a real run reaches the
 * wallet-toolbox wallet (empty) and must stop there with nothing handed over.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { RicochetClient } from '@stephanfeb/ricochet/node'
import { PrivateKey } from '@bsv/sdk'
import { formatPaymentLink } from '../../src/node.ts'
import { relayedPayee } from './live-peers.ts'
import type { RelayedPayee } from './live-peers.ts'
import { newPayeeIdentity, publishPayee } from './payee-publish.ts'
import { startServer } from './server.ts'
import type { TestServer } from './server.ts'

const run = promisify(execFile)
const tool = fileURLToPath(new URL('../../tools/e2e-pay.ts', import.meta.url))
let server: TestServer
let payee: RelayedPayee
let dir: string
let link: string

before(async () => {
  server = await startServer()
  const id = await newPayeeIdentity()
  payee = await relayedPayee(server.udx, {}, id.libp2pKey)
  await publishPayee(payee.node, id, { peerId: server.peerId, addr: server.udx })
  link = formatPaymentLink({ network: 'testnet', peerId: id.peerId, paymentKey: PrivateKey.fromRandom().toPublicKey().toString(), amountSats: 1234, memo: 'E2E dry run' })
  dir = await mkdtemp(join(tmpdir(), 'spiffyvault-e2e-'))
})

after(async () => {
  await payee?.stop()
  await server?.stop()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

async function tool$ (...args: string[]): Promise<{ out: string, code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [tool, ...args], { env: { ...process.env, SPIFFYVAULT_E2E_KEY: join(dir, 'testnet.key') }, timeout: 90_000 })
    return { out: stdout + stderr, code: 0 }
  } catch (e) {
    const x = e as { stdout?: string, stderr?: string, code?: number }
    return { out: (x.stdout ?? '') + (x.stderr ?? ''), code: x.code ?? -1 }
  }
}

test('info makes a key outside the repo and prints the identity and funding address', async (t) => {
  const r = await tool$('info')
  t.diagnostic(r.out)
  assert.equal(r.code, 0)
  assert.match(r.out, /identity key: +0[23][0-9a-f]{64}/)
  assert.match(r.out, /funding address: [mn][1-9A-HJ-NP-Za-km-z]{25,34}/)
  assert.match(r.out, /balance: +0 sats/)
})

test('a key file inside the repository is refused', async () => {
  const { stdout, stderr } = await run(process.execPath, [tool, 'info'], { env: { ...process.env, SPIFFYVAULT_E2E_KEY: fileURLToPath(new URL('../../.e2e-test.key', import.meta.url)) } }).catch(e => e)
  assert.match(String(stdout) + String(stderr), /outside the repository/)
})

test('pay --dry-run checks offline readiness and the live route, and spends nothing', async (t) => {
  const r = await tool$('pay', link, '--dry-run', '--ricochet', `${server.peerId}=${server.udx}`)
  t.diagnostic(r.out)
  assert.equal(r.code, 0)
  assert.match(r.out, /amount 1234 sats/)
  assert.match(r.out, /offline: anchor 0[23][0-9a-f]{64} at wallet\/payment-anchor verifies/)
  assert.match(r.out, /offline: prekey bundle verifies/)
  assert.match(r.out, /live: the phone answers through the relay/)
  assert.match(r.out, /would ask the wallet for 1234 sats/)
  assert.equal(payee.payee.received.length, 0, 'no stream was opened to the payee')
})

test('a real run with an empty wallet gets an invoice and stops at funding, handing nothing over', async (t) => {
  const r = await tool$('pay', link, '--path', 'live', '--ricochet', `${server.peerId}=${server.udx}`)
  t.diagnostic(r.out)
  assert.equal(r.code, 2)
  assert.match(r.out, /\[live\] invoice/)
  assert.match(r.out, /failed: live funding-failed at pay/)
  assert.deepEqual(payee.payee.received.map(x => x.type), ['payment_request'])
  void RicochetClient
})
