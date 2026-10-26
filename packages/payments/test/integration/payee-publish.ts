/**
 * Publishes a JS stand-in payee on a Ricochet server the way the app does:
 * a public `signal/v2/bundle` mailbox holding the signed bundle and a claim
 * mailbox `signal/v2/one-time-keys` of signed one-time pre-keys (sent to
 * itself, persistent; lib/peer_sessions/owner_keys.dart), and the signed
 * anchor record as a public JSON document (payment_anchor_publisher.dart).
 */

import { PrivateKey } from '@bsv/sdk'
import { RicochetClient } from '@go-ricochet/ricochet/node'
import type { RicochetNode } from '@go-ricochet/ricochet/node'
import { anchorRecordJson, forNetwork, randomBytes } from '../support/internals.ts'
import type { Network } from '../../src/index.ts'
import { identityFromSeed, publishSessionKeys, signAnchorRecord } from '../support/payee.ts'
import type { PayeeIdentity, PayeeSessionKeys } from '../support/payee.ts'

export interface PublishedPayee {
  id: PayeeIdentity
  keys: PayeeSessionKeys
  anchor: PrivateKey
  client: RicochetClient
}

export async function publishPayee (node: RicochetNode, id: PayeeIdentity, server: { peerId: string, addr: string }, network: Network = 'testnet'): Promise<PublishedPayee> {
  const client = new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.addr] }] })
  const keys: PayeeSessionKeys = { signedPreKeyId: 1, signedPreKeyPrivate: randomBytes(32), oneTimePreKeys: new Map([[1, randomBytes(32)], [2, randomBytes(32)], [3, randomBytes(32)]]) }
  const anchor = PrivateKey.fromRandom()
  await publishSessionKeys(client, id, keys, network)
  const networkType = network === 'mainnet' ? 'main' : network === 'regtest' ? 'regtest' : 'test'
  const record = signAnchorRecord(id, { anchorPublicKey: anchor.toPublicKey().toString(), epoch: 0, networkType, timestamp: Date.now() })
  await client.putDocument(id.peerId, forNetwork('wallet/payment-anchor', network), anchorRecordJson(record), { contentType: 'application/json', visibility: 'public' })
  return { id, keys, anchor, client }
}

export async function newPayeeIdentity (): Promise<PayeeIdentity> { return await identityFromSeed(randomBytes(32)) }
