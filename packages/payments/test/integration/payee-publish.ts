/**
 * Publishes a JS stand-in payee on a Ricochet server the way the app does:
 * a public `signal/prekeys` mailbox holding the signed bundle (sent to
 * itself, persistent), and the signed anchor record as a public JSON
 * document (signal_prekey_publisher.dart, payment_anchor_publisher.dart).
 */

import { PrivateKey } from '@bsv/sdk'
import { RicochetClient } from '@stephanfeb/ricochet/node'
import type { RicochetNode } from '@stephanfeb/ricochet/node'
import { anchorRecordJson, forNetwork, prekeyBundleJson, randomBytes } from '../support/internals.ts'
import type { Network } from '../../src/index.ts'
import { identityFromSeed, signAnchorRecord, signBundle } from '../support/payee.ts'
import type { PayeeIdentity, PayeePrekeys } from '../support/payee.ts'

export interface PublishedPayee {
  id: PayeeIdentity
  keys: PayeePrekeys
  anchor: PrivateKey
  client: RicochetClient
}

export async function publishPayee (node: RicochetNode, id: PayeeIdentity, server: { peerId: string, addr: string }, network: Network = 'testnet'): Promise<PublishedPayee> {
  const client = new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.addr] }] })
  const keys: PayeePrekeys = { registrationId: 7777, signedPreKeyId: 1, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map([[1, randomBytes(32)], [2, randomBytes(32)], [3, randomBytes(32)]]) }
  const anchor = PrivateKey.fromRandom()
  const folder = forNetwork('signal/prekeys', network)
  await client.createMailbox(folder, 'public', { retentionDays: 30, retentionCount: 5 })
  const sent = await client.sendMessage(id.peerId, prekeyBundleJson(signBundle(id, keys, Date.now())), { folderPath: folder, priority: 1, persistent: true })
  if (!sent.success) throw new Error(`prekey publish refused: ${sent.errorMessage}`)
  const networkType = network === 'mainnet' ? 'main' : network === 'regtest' ? 'regtest' : 'test'
  const record = signAnchorRecord(id, { anchorPublicKey: anchor.toPublicKey().toString(), epoch: 0, networkType, timestamp: Date.now() })
  await client.putDocument(id.peerId, forNetwork('wallet/payment-anchor', network), anchorRecordJson(record), { contentType: 'application/json', visibility: 'public' })
  return { id, keys, anchor, client }
}

export async function newPayeeIdentity (): Promise<PayeeIdentity> { return await identityFromSeed(randomBytes(32)) }
