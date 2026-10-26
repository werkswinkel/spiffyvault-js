/**
 * @spiffyvault/payments: pay a SpiffyVault user from JavaScript.
 *
 * This entry is platform neutral: bring your own libp2p node (live) and
 * Ricochet client (offline). It registers the UDX multiaddr codec, because
 * SpiffyVault phones and the Ricochet server advertise /udx addresses.
 *
 * Bundlers that honour the "browser" and "node" export conditions pick
 * ./browser or ./node instead, which add createPaymentNode().
 */

import '@go-ricochet/libp2p-udx/multiaddr'

export * from './core.ts'
