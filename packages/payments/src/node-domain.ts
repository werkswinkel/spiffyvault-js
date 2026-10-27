/**
 * The domain check's fetch on Node.js (assessment finding 6). A link's `d`
 * is chosen by whoever made the link, so a shop's server that checks it
 * must not be made to reach its own network: the name is looked up once,
 * refused when any address is not public, and the connection is made to
 * the address looked up, so the name cannot change to a private one in
 * between. As the app's PayeeDomain does.
 */

import { lookup } from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { request } from 'node:https'
import type { LookupFunction } from 'node:net'
import { DomainFileTooLarge, MAX_DOMAIN_FILE_BYTES, isPrivateAddress } from './domain.ts'
import type { DomainFetch } from './domain.ts'

/** Thrown, through the request, for a name with an address that is not public. */
export class PrivateHostError extends Error {
  readonly code = 'EPRIVATEHOST'
}

const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: options.family ?? 0 }, (error, addresses: LookupAddress[]) => {
    if (error !== null) { callback(error, '', 0); return }
    if (addresses.length === 0 || addresses.some(a => isPrivateAddress(a.address))) {
      callback(new PrivateHostError(`${hostname} is not on the public internet`), '', 0)
      return
    }
    // Node asks for all addresses when it tries them in turn (autoSelectFamily).
    if (options.all === true) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

/**
 * Reads `url` over HTTPS from a public address only: GET, no redirects
 * (any status but 200 is no file), at most MAX_DOMAIN_FILE_BYTES. The
 * Node.js entry makes it checkPayeeDomain's default.
 */
export const nodeDomainFetch: DomainFetch = async (url, signal) => await new Promise((resolve, reject) => {
  const req = request(url, { method: 'GET', signal, lookup: publicLookup, headers: { accept: 'application/json' } }, response => {
    if (response.statusCode !== 200) {
      response.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let length = 0
    response.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_DOMAIN_FILE_BYTES) {
        response.destroy()
        reject(new DomainFileTooLarge())
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => { resolve(new Uint8Array(Buffer.concat(chunks))) })
    response.on('error', reject)
  })
  req.on('error', reject)
  req.end()
})
