/**
 * The payee's Signal prekey bundle (lib/signal/models/signal_prekey_bundle.dart):
 * messages the payee sends to its own public mailbox `signal/prekeys`
 * (per-network suffix). Read and checked as lib/services/signal_prekey_lookup.dart
 * does, plus one check the app lacks: the bundle's Ed25519 identity key
 * must be the key inside the payee's peer ID.
 */

import { ed25519 } from '@noble/curves/ed25519.js'
import { NoServerError, ProtocolError } from '@stephanfeb/ricochet/core'
import { concat, fromBase64, fromHex, fromUtf8, i64be, toHex, u32be, utf8 } from '../bytes.ts'
import { PaymentError, errorText } from '../errors.ts'
import { PREKEYS_FOLDER, forNetwork } from '../networks.ts'
import type { Network } from '../networks.ts'
import { ed25519KeyOfPeerId } from '../peer.ts'
import type { RicochetLike } from '../ricochet.ts'

export interface OneTimePreKey { id: number, key: string }

export interface PrekeyBundle {
  registrationId: number
  /** Hex, 32 bytes. */
  identityKeyPublicEd25519: string
  /** Hex, 32 bytes. */
  identityKeyPublicX25519: string
  /** Base64, 32 bytes. */
  signedPreKeyPublic: string
  signedPreKeyId: number
  /** Base64 Ed25519 signature over the raw SPK bytes. */
  signedPreKeySignature: string
  oneTimePreKeys: OneTimePreKey[]
  /** Unix milliseconds. */
  publishedAt: number
  peerId: string
  /** Base64 Ed25519 signature over bundleCanonicalBytes(). */
  bundleSignature: string
}

/** The bundle in `json`, with the field types the app's reader insists on. Throws when it is not one. */
export function parsePrekeyBundle (json: unknown): PrekeyBundle {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new TypeError('bundle is not a JSON object')
  const o = json as Record<string, unknown>
  const str = (k: string): string => { const v = o[k]; if (typeof v !== 'string') throw new TypeError(`bundle ${k} is not a string`); return v }
  const int = (k: string): number => { const v = o[k]; if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new TypeError(`bundle ${k} is not an integer`); return v }
  const opks = o.oneTimePreKeys
  if (!Array.isArray(opks)) throw new TypeError('bundle oneTimePreKeys is not a list')
  const oneTimePreKeys = opks.map((e: unknown): OneTimePreKey => {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new TypeError('one-time prekey is not an object')
    const r = e as Record<string, unknown>
    if (typeof r.id !== 'number' || !Number.isSafeInteger(r.id) || typeof r.key !== 'string') throw new TypeError('one-time prekey has no id or key')
    return { id: r.id, key: r.key }
  })
  const p = o.publishedAt
  let publishedAt: number
  if (typeof p === 'number' && Number.isSafeInteger(p)) publishedAt = p
  else if (typeof p === 'string' && !Number.isNaN(Date.parse(p))) publishedAt = Date.parse(p)
  else throw new TypeError('bundle publishedAt is neither milliseconds nor a date')
  return {
    registrationId: int('registrationId'),
    identityKeyPublicEd25519: str('identityKeyPublicEd25519'),
    identityKeyPublicX25519: str('identityKeyPublicX25519'),
    signedPreKeyPublic: str('signedPreKeyPublic'),
    signedPreKeyId: int('signedPreKeyId'),
    signedPreKeySignature: str('signedPreKeySignature'),
    oneTimePreKeys,
    publishedAt,
    peerId: str('peerId'),
    bundleSignature: str('bundleSignature')
  }
}

/** The bundle as the app writes it (SignalPreKeyBundle.toJson key order). */
export function prekeyBundleJson (b: PrekeyBundle): string {
  return JSON.stringify({
    registrationId: b.registrationId,
    identityKeyPublicEd25519: b.identityKeyPublicEd25519,
    identityKeyPublicX25519: b.identityKeyPublicX25519,
    signedPreKeyPublic: b.signedPreKeyPublic,
    signedPreKeyId: b.signedPreKeyId,
    signedPreKeySignature: b.signedPreKeySignature,
    oneTimePreKeys: b.oneTimePreKeys.map(k => ({ id: k.id, key: k.key })),
    publishedAt: b.publishedAt,
    peerId: b.peerId,
    bundleSignature: b.bundleSignature
  })
}

/** The bytes `bundleSignature` covers (SignalPreKeyBundle.toCanonicalBytes). */
export function bundleCanonicalBytes (b: PrekeyBundle): Uint8Array {
  const parts: Uint8Array[] = [
    u32be(b.registrationId),
    utf8(b.identityKeyPublicEd25519),
    utf8(b.identityKeyPublicX25519),
    utf8(b.signedPreKeyPublic),
    u32be(b.signedPreKeyId),
    utf8(b.signedPreKeySignature),
    u32be(b.oneTimePreKeys.length)
  ]
  for (const k of b.oneTimePreKeys) parts.push(u32be(k.id), utf8(k.key))
  parts.push(i64be(b.publishedAt), utf8(b.peerId))
  return concat(...parts)
}

function verifyEd (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {
  try { return ed25519.verify(sig, msg, pub) } catch { return false }
}

/**
 * Null when the bundle may be used to seal a message for `payeePeerId`;
 * otherwise why not. The app's checks (peer ID, bundle signature, signed
 * prekey signature) and ours (the Ed25519 key is the peer ID's; key sizes).
 */
export function verifyPrekeyBundle (b: PrekeyBundle, payeePeerId: string): string | null {
  if (b.peerId !== payeePeerId) return `bundle names peer ${b.peerId}, expected ${payeePeerId}`
  let ed: Uint8Array, x: Uint8Array, spk: Uint8Array, spkSig: Uint8Array, bundleSig: Uint8Array
  try {
    ed = fromHex(b.identityKeyPublicEd25519)
    x = fromHex(b.identityKeyPublicX25519)
    spk = fromBase64(b.signedPreKeyPublic)
    spkSig = fromBase64(b.signedPreKeySignature)
    bundleSig = fromBase64(b.bundleSignature)
  } catch (e) {
    return `bundle has a malformed key or signature: ${errorText(e)}`
  }
  if (ed.length !== 32 || x.length !== 32 || spk.length !== 32) return 'bundle keys are not 32 bytes'
  if (!verifyEd(bundleSig, bundleCanonicalBytes(b), ed)) return 'bundle signature does not verify'
  const peerKey = ed25519KeyOfPeerId(payeePeerId)
  if (peerKey === null || toHex(peerKey) !== toHex(ed)) return 'bundle identity key is not the payee peer ID\'s key'
  if (!verifyEd(spkSig, spk, ed)) return 'signed prekey signature does not verify'
  for (const k of b.oneTimePreKeys) {
    let kb: Uint8Array
    try { kb = fromBase64(k.key) } catch { return `one-time prekey ${k.id} is not base64` }
    if (kb.length !== 32) return `one-time prekey ${k.id} is not 32 bytes`
    if (k.id < 0 || k.id > 0xffffffff) return `one-time prekey id ${k.id} is not a uint32`
  }
  return null
}

const fail = (code: 'prekeys-missing' | 'prekeys-not-public' | 'prekeys-invalid' | 'server-unreachable', message: string, cause?: unknown): PaymentError =>
  new PaymentError(code, message, { path: 'offline', stage: code === 'server-unreachable' ? 'connect' : 'request', canPayAnotherWay: true, cause })

/**
 * Reads the payee's prekey bundle: retrieve from the payee's public mailbox
 * (`fromSequence` 1, at most 10), take the last message the payee sent
 * (highest sequence, not the newest publishedAt), parse and verify it.
 */
export async function fetchPrekeyBundle (ricochet: RicochetLike, payeePeerId: string, network: Network): Promise<PrekeyBundle> {
  const folderPath = forNetwork(PREKEYS_FOLDER, network)
  let page
  try {
    page = await ricochet.retrievePage({ targetPeerId: payeePeerId, folderPath, fromSequence: 1, maxMessages: 10 })
  } catch (e) {
    if (e instanceof ProtocolError && e.status === 404) throw fail('prekeys-missing', 'The payee has not published its encryption keys', e)
    if (e instanceof ProtocolError && e.status === 403) throw fail('prekeys-not-public', 'The payee\'s encryption keys are not public', e)
    if (e instanceof NoServerError) throw fail('server-unreachable', `Could not reach the Ricochet server: ${errorText(e)}`, e)
    throw fail('prekeys-missing', `Could not read the payee's encryption keys: ${errorText(e)}`, e)
  }
  const bundles: PrekeyBundle[] = []
  const sorted = [...page.messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
  for (const m of sorted) {
    if (m.senderPeerId !== payeePeerId) continue
    if (m.folderPath !== '' && m.folderPath !== folderPath) continue
    try { bundles.push(parsePrekeyBundle(JSON.parse(fromUtf8(m.payload)))) } catch { /* the app skips what it cannot parse */ }
  }
  const latest = bundles.at(-1)
  if (latest === undefined) throw fail('prekeys-missing', 'The payee has not published its encryption keys')
  const problem = verifyPrekeyBundle(latest, payeePeerId)
  if (problem !== null) throw fail('prekeys-invalid', `The payee's encryption keys do not verify: ${problem}`)
  return latest
}
