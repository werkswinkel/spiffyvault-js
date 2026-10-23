/**
 * End-to-end tool: pay a real SpiffyVault payment link on testnet from a
 * @bsv/wallet-toolbox wallet, printing every step. Testnet only.
 *
 *   SPIFFYVAULT_E2E_KEY=~/.spiffyvault-e2e/testnet.key node tools/e2e-pay.ts <command>
 *
 * Commands:
 *   info                       identity key, funding address, balance
 *   fund <txid>[:<vout>]       take a P2PKH output paid to the funding address into the wallet
 *   pay <link> [options]       pay a payment link
 *       --path auto|live|offline|peerpay   default auto (live, then offline; PeerPay for a key-only link)
 *       --amount <sats>        when the link has no amount
 *       --note <text>          default the link's note
 *       --peerpay-fallback     auto: allow PeerPay after live and offline failed safely
 *       --host <url>           message box host (default https://messagebox.bsvblockchain.tech)
 *       --dry-run              check everything that can be checked without spending, stop before createAction
 *       --ricochet <peerId>=<multiaddr>   another Ricochet server (tests; default SpiffyVault's)
 *   status <txid>              what the network says about a transaction
 *   abort <txid>               release the inputs of a payment the payee did NOT take (live/offline, not broadcast)
 *
 * The key file holds a 64-hex root private key. It is made (mode 0600) when
 * missing, and must be outside this repository. The wallet database is
 * <key file>.sqlite next to it. This tool uses the wallet-toolbox's network
 * services (WhatsOnChain, ARC); the payments package itself uses none.
 */

import { createRequire } from 'node:module'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys'
import { RicochetClient } from '@stephanfeb/ricochet/node'
import {
  SPIFFYVAULT_RICOCHET, createPaymentNode, dialPayee, fetchAnchor, fetchPrekeyBundle, isPaymentError, pay, payLive, payOffline,
  payViaPeerPay, planPayment, resolveDnsAddrs
} from '../src/node.ts'
import type { PaymentProgress, PayPlan } from '../src/node.ts'

// wallet-toolbox is CommonJS and uses @bsv/sdk's CommonJS build: keys it
// takes must come from that copy (the ESM and CJS classes differ).
const sdkCjs = createRequire(import.meta.url)('@bsv/sdk') as typeof import('@bsv/sdk')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function say (line: string): void { console.log(line) }
function fail (line: string): never { console.error(`error: ${line}`); process.exit(1) }

function keyFile (): string {
  const raw = process.env.SPIFFYVAULT_E2E_KEY
  if (raw === undefined || raw === '') fail('set SPIFFYVAULT_E2E_KEY to a key file path outside this repository, e.g. ~/.spiffyvault-e2e/testnet.key')
  const path = resolve(raw.replace(/^~(?=\/)/, process.env.HOME ?? '~'))
  if (path.startsWith(repoRoot + '/')) fail(`the key file must be outside the repository (${repoRoot})`)
  return path
}

function loadRootKey (path: string): PrivateKey {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, PrivateKey.fromRandom().toHex() + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
    say(`made a new testnet root key in ${path} (keep it; fund the address below)`)
  }
  const hex = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(hex)) fail(`${path} does not hold a 64-hex private key`)
  return PrivateKey.fromHex(hex)
}

/** The funding key: a BRC-42 child of the root for the root itself, so it differs from the identity key. */
function fundingKey (root: PrivateKey): PrivateKey { return root.deriveChild(root.toPublicKey(), 'spiffyvault-e2e funding') }

async function openWallet (path: string) {
  const root = loadRootKey(path)
  const identityKey = root.toPublicKey().toString()
  const setup = await Setup.createWalletSQLite({
    env: { chain: 'test', identityKey, identityKey2: identityKey, filePath: `${path}.sqlite`, taalApiKey: '', devKeys: { [identityKey]: root.toHex() }, mySQLConnection: '' },
    rootKeyHex: root.toHex(),
    filePath: `${path}.sqlite`,
    databaseName: 'spiffyvault_e2e'
  })
  return { root, setup, wallet: setup.wallet as unknown as WalletInterface }
}

async function close (setup: Awaited<ReturnType<typeof openWallet>>['setup']): Promise<void> {
  try { await setup.wallet.destroy() } catch { /* the toolbox may have nothing to close */ }
}

const progress = (p: PaymentProgress): void => say(`  [${p.path}] ${p.step}${p.detail !== undefined ? `: ${p.detail}` : ''}`)

async function cmdInfo (path: string): Promise<void> {
  const { root, setup } = await openWallet(path)
  const fk = fundingKey(root)
  say(`network:        testnet`)
  say(`identity key:   ${root.toPublicKey().toString()}   (BRC-100 identity; the PeerPay sender)`)
  say(`funding address: ${fk.toPublicKey().toAddress('testnet')}   (send testnet coins here, then: fund <txid>)`)
  say(`balance:        ${await setup.wallet.balance()} sats spendable in the wallet`)
  await close(setup)
}

async function cmdFund (path: string, arg: string | undefined): Promise<void> {
  if (arg === undefined || !/^[0-9a-f]{64}(:\d+)?$/i.test(arg)) fail('fund <txid>[:<vout>]')
  const { root, setup } = await openWallet(path)
  const fk = fundingKey(root)
  const address = fk.toPublicKey().toAddress('testnet')
  const [txid, voutText] = arg.toLowerCase().split(':') as [string, string | undefined]
  say(`fetching ${txid} and its proof (wallet-toolbox services)…`)
  const beef = await setup.services.getBeefForTxid(txid)
  const tx = beef.findTxid(txid)?.tx
  if (tx === undefined) fail(`the network gave no transaction ${txid}`)
  const script = Utils.toHex([0x76, 0xa9, 0x14, ...(Hash.hash160(fk.toPublicKey().encode(true) as number[])), 0x88, 0xac])
  const vouts = voutText !== undefined ? [Number(voutText)] : tx.outputs.flatMap((o, i) => o.lockingScript.toHex() === script ? [i] : [])
  if (vouts.length === 0) fail(`${txid} pays nothing to ${address}`)
  const cjsKey = sdkCjs.PrivateKey.fromHex(fk.toHex())
  const keyPair = { privateKey: cjsKey, publicKey: cjsKey.toPublicKey(), address } as unknown as Parameters<typeof Setup.fundWalletFromP2PKHOutpoints>[2]
  const r = await Setup.fundWalletFromP2PKHOutpoints(setup.wallet, vouts.map(v => `${txid}.${v}`), keyPair, beef.toBinary())
  for (const x of r) say(`  ${x.outpoint}: ${x.success ? `taken in (${x.txid ?? ''})` : `failed: ${x.error ?? ''}`}`)
  say(`balance: ${await setup.wallet.balance()} sats`)
  await close(setup)
}

function ricochetServer (override: string | undefined): { peerId: string, addrs: string[] } {
  if (override === undefined) return { peerId: SPIFFYVAULT_RICOCHET.peerId, addrs: [] }
  const [peerId, addr] = override.split('=') as [string, string | undefined]
  if (addr === undefined) fail('--ricochet <peerId>=<multiaddr>')
  return { peerId, addrs: [addr] }
}

async function cmdPay (path: string, link: string | undefined, o: Record<string, string | boolean | undefined>): Promise<void> {
  if (link === undefined) fail('pay <link>')
  const mode = String(o.path ?? 'auto')
  if (!['auto', 'live', 'offline', 'peerpay'].includes(mode)) fail('--path auto|live|offline|peerpay')
  const dry = o['dry-run'] === true
  const { setup, wallet } = await openWallet(path)
  say(`payer identity key: ${(await wallet.getPublicKey({ identityKey: true })).publicKey}`)
  say(`balance: ${await setup.wallet.balance()} sats`)

  say('1. reading the link')
  const plan: PayPlan = await planPayment({
    link, ...(typeof o.amount === 'string' ? { amountSats: Number(o.amount) } : {}), ...(typeof o.note === 'string' ? { note: o.note } : {})
  }, { wallet, network: 'testnet' }).catch((e: unknown) => fail(isPaymentError(e) ? `${e.code}: ${e.message}` : String(e)))
  say(`   network ${plan.network}; amount ${plan.amountSats} sats; peer ${plan.peerId ?? '(none)'}; key ${plan.paymentKey ?? '(none)'}`)
  say(`   note: ${plan.note ?? '(none)'}; payee wallet: ${plan.walletId ?? '(active)'}; request ref: ${plan.requestRef ?? '(none)'}`)
  if (plan.network !== 'testnet') fail('this tool pays testnet links only')

  // A stable payer peer ID, from the key file.
  const seed = Hash.sha256([...setup.rootKey.toArray(), ...Utils.toArray('spiffyvault-e2e libp2p', 'utf8')])
  const { node } = await createPaymentNode({ privateKey: await generateKeyPairFromSeed('Ed25519', Uint8Array.from(seed)) })
  say(`payer peer ID: ${node.peerId.toString()}`)
  const server = ricochetServer(typeof o.ricochet === 'string' ? o.ricochet : undefined)
  const addrs = server.addrs.length > 0
    ? server.addrs
    : [...(await resolveDnsAddrs([SPIFFYVAULT_RICOCHET.udx]).catch(() => [])).map(a => a.toString()), SPIFFYVAULT_RICOCHET.udxIp, SPIFFYVAULT_RICOCHET.wss]
  say(`Ricochet server ${server.peerId} at ${addrs.join(', ')}`)
  const ricochet = new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs }] })
  const relays = addrs.filter(a => !a.startsWith('/dns'))
  const host = typeof o.host === 'string' ? o.host : undefined
  const common = { amountSats: plan.amountSats, network: plan.network, ...(plan.note !== undefined ? { note: plan.note } : {}), ...(plan.walletId !== undefined ? { walletId: plan.walletId } : {}) }

  try {
    if (dry) {
      say('2. dry run: nothing is built, signed, sent or broadcast')
      if (plan.peerId !== undefined) {
        try {
          const a = await fetchAnchor(ricochet, plan.peerId, plan.network, { ...(plan.walletId !== undefined ? { walletId: plan.walletId } : {}), ...(plan.note !== undefined ? { note: plan.note } : {}) })
          say(`   offline: anchor ${a.record.anchorPublicKey} at ${a.path} verifies (epoch ${a.record.epoch}, ${new Date(a.record.timestamp).toISOString()})`)
          const b = await fetchPrekeyBundle(ricochet, plan.peerId, plan.network)
          say(`   offline: prekey bundle verifies (signed prekey ${b.signedPreKeyId}, ${b.oneTimePreKeys.length} one-time prekeys, published ${new Date(b.publishedAt).toISOString()})`)
        } catch (e) { say(`   offline: not ready: ${isPaymentError(e) ? `${e.code}: ` : ''}${e instanceof Error ? e.message : String(e)}`) }
        try {
          const conn = await dialPayee(node, plan.peerId, relays, AbortSignal.timeout(30_000))
          say(`   live: the phone answers through the relay (${conn.remoteAddr.toString()}); no stream was opened`)
        } catch (e) { say(`   live: the phone cannot be reached now: ${e instanceof Error ? e.message : String(e)}`) }
      }
      if (plan.paymentKey !== undefined) say(`   peerpay: would pay ${plan.paymentKey} on ${host ?? 'https://messagebox.bsvblockchain.tech'} (the payer broadcasts)`)
      say(`   would ask the wallet for ${plan.amountSats} sats plus fee; balance ${await setup.wallet.balance()} sats`)
      return
    }
    say(`2. paying by ${mode}`)
    const ctx = { wallet, onProgress: progress }
    let r
    if (mode === 'live') r = await payLive({ payeePeerId: plan.peerId ?? fail('the link has no peer ID'), ...common }, { ...ctx, libp2p: node, relays })
    else if (mode === 'offline') r = await payOffline({ payeePeerId: plan.peerId ?? fail('the link has no peer ID'), ...common }, { ...ctx, ricochet })
    else if (mode === 'peerpay') r = await payViaPeerPay({ paymentKey: plan.paymentKey ?? fail('the link has no payment key'), amountSats: plan.amountSats, ...(plan.note !== undefined ? { note: plan.note } : {}) }, { ...ctx, ...(host !== undefined ? { host } : {}) })
    else r = await pay({ link, ...(typeof o.amount === 'string' ? { amountSats: Number(o.amount) } : {}), ...(typeof o.note === 'string' ? { note: o.note } : {}) },
      { ...ctx, network: 'testnet', libp2p: node, relays, ricochet, peerPay: { ...(host !== undefined ? { host } : {}), fallback: o['peerpay-fallback'] === true } })
    say(`3. done: ${r.status} by ${r.path}; txid ${r.txid}`)
    for (const a of r.attempts) say(`   earlier attempt: ${a.path ?? '?'} ${a.code}: ${a.message}`)
    if (r.path === 'live') say(`   the phone checked it by SPV${r.broadcasted === true ? ' and is broadcasting it' : ' (it did not say it broadcast)'}`)
    if (r.path === 'offline') say('   it waits in the phone\'s mailbox; the phone broadcasts it when it collects (open the app; it pulls every 30 s)')
    if (r.path === 'peerpay') say('   broadcast by this wallet; the phone imports the token from its message box (it polls every 30 s)')
    say(`   follow it: node tools/e2e-pay.ts status ${r.txid}`)
  } catch (e) {
    if (isPaymentError(e)) {
      say(`failed: ${e.path ?? ''} ${e.code} at ${e.stage}: ${e.message}`)
      if (e.txid !== undefined) say(`   txid ${e.txid}; ${e.aborted ? 'aborted, inputs released' : e.canPayAnotherWay ? 'nothing handed over' : 'MAY BE WITH THE PAYEE: do not pay again; check status'}`)
      for (const a of e.attempts) say(`   earlier attempt: ${a.path ?? '?'} ${a.code}: ${a.message}`)
      process.exitCode = 2
    } else throw e
  } finally {
    await ricochet.close()
    await node.stop()
    await close(setup)
  }
}

async function cmdStatus (path: string, txid: string | undefined): Promise<void> {
  if (txid === undefined) fail('status <txid>')
  const { setup } = await openWallet(path)
  const s = await setup.services.getStatusForTxids([txid])
  say(JSON.stringify(s.results, null, 2))
  await close(setup)
}

async function cmdAbort (path: string, txid: string | undefined): Promise<void> {
  if (txid === undefined) fail('abort <txid>')
  const { setup, wallet } = await openWallet(path)
  try {
    say(JSON.stringify(await wallet.abortAction({ reference: txid })))
  } finally { await close(setup) }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    path: { type: 'string' }, amount: { type: 'string' }, note: { type: 'string' }, host: { type: 'string' }, ricochet: { type: 'string' },
    'dry-run': { type: 'boolean' }, 'peerpay-fallback': { type: 'boolean' }
  }
})
const [command, arg] = positionals
const path = keyFile()
switch (command) {
  case 'info': await cmdInfo(path); break
  case 'fund': await cmdFund(path, arg); break
  case 'pay': await cmdPay(path, arg, values); break
  case 'status': await cmdStatus(path, arg); break
  case 'abort': await cmdAbort(path, arg); break
  default: fail('commands: info | fund <txid>[:<vout>] | pay <link> [--path …] [--dry-run] | status <txid> | abort <txid>')
}
process.exit(process.exitCode ?? 0)
