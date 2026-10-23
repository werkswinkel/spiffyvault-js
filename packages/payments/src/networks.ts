/**
 * Networks, and the Ricochet folders and document paths that are kept
 * apart per network (lib/config/network_folders.dart in the app).
 */

/** The link's spelling (`n`): what PaymentLink.network holds. */
export type Network = 'mainnet' | 'testnet' | 'regtest'

/** libspiffy's spelling: anchor `networkType`, invoice `network`. */
export type WalletNetworkType = 'main' | 'test' | 'regtest'

/** Any spelling to the link's: mainnet, regtest, else testnet (NetworkName.canonical). */
export function canonicalNetwork (network: string | null | undefined): Network {
  const n = network?.trim().toLowerCase()
  if (n === 'main' || n === 'mainnet' || n === 'livenet') return 'mainnet'
  if (n === 'regtest') return 'regtest'
  return 'testnet'
}

/** The link's `n` values the app reads; null for anything else. */
export function linkNetwork (value: string | null | undefined): Network | null {
  switch (value?.trim().toLowerCase()) {
    case 'mainnet': case 'main': return 'mainnet'
    case 'testnet': case 'test': return 'testnet'
    case 'regtest': return 'regtest'
    default: return null
  }
}

/**
 * libspiffy's network type for a network: 'main', 'test' or 'regtest'
 * (lib/config/network_policy.dart:25 lists exactly these three).
 */
export function walletNetworkType (network: Network): WalletNetworkType {
  return network === 'mainnet' ? 'main' : network === 'regtest' ? 'regtest' : 'test'
}

export const OFFLINE_PAYMENTS_FOLDER = 'wallet/offline-payments'
export const PREKEYS_FOLDER = 'signal/prekeys'
export const PAYMENT_ANCHOR_DOCUMENT = 'wallet/payment-anchor'

/** `base` as used on `network`: testnet keeps the bare name. */
export function forNetwork (base: string, network: Network): string {
  if (network === 'mainnet') return `${base}/mainnet`
  if (network === 'regtest') return `${base}/regtest`
  return base
}

/** P2PKH address version byte: mainnet 0x00, testnet and regtest 0x6f. */
export function p2pkhVersion (network: Network): number { return network === 'mainnet' ? 0x00 : 0x6f }

/** SpiffyVault's Ricochet server (lib/config/ricochet_server.dart), the same for every network. */
export const SPIFFYVAULT_RICOCHET = {
  peerId: '12D3KooWJfrcqqdoAcKUjAB6dGkC9KHCsTG5WKHZH8hk1wLs67it',
  /** UDX, for Node.js and Electron (resolve the DNS name first: UDX dials IPs only). */
  udx: '/dns4/ricochet.spiffyvault.net/udp/55223/udx/p2p/12D3KooWJfrcqqdoAcKUjAB6dGkC9KHCsTG5WKHZH8hk1wLs67it',
  /** The app's fallback when DNS fails. */
  udxIp: '/ip4/152.42.240.103/udp/55223/udx/p2p/12D3KooWJfrcqqdoAcKUjAB6dGkC9KHCsTG5WKHZH8hk1wLs67it',
  /** WebSockets over TLS, for browsers. */
  wss: '/dns4/ricochet.spiffyvault.net/tcp/55223/wss/p2p/12D3KooWJfrcqqdoAcKUjAB6dGkC9KHCsTG5WKHZH8hk1wLs67it'
} as const

/** BSVA's public MessageBox server, which SpiffyVault uses for PeerPay on every network. */
export const DEFAULT_MESSAGE_BOX_HOST = 'https://messagebox.bsvblockchain.tech'
