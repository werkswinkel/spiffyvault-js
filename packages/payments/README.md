# @spiffyvault/payments

Pay a SpiffyVault user from a web app, a JavaScript or Electron wallet, or
a Node.js service. Payer side only. The bytes on the wire are the same as
the SpiffyVault app's, on all three of its payment paths:

| Path | How | Who broadcasts |
|---|---|---|
| Live | A libp2p stream `/overnode/payment/1.0.0` to the payee's phone, through the Ricochet server's circuit relay. The phone makes an invoice and checks the payment by SPV. | The payee |
| Offline | The payment, sealed with the app's Signal-style encryption, is left in the payee's Ricochet mailbox. The phone collects it later. | The payee |
| PeerPay | A standard BRC-29 PeerPay token on a MessageBox server (BRC-100 interop). | The payer |

The contract is the app's `doc/payment-protocol.md`. Every code block below
is copied from `examples/`, and the tests run those files.

## Install

Version 0.1.0 is not on npm. Node.js 22.18 or later. ESM only.

| Import | For | Adds |
|---|---|---|
| `@spiffyvault/payments/browser` | Browsers | `createPaymentNode()`: WebSockets and the circuit relay transport |
| `@spiffyvault/payments/node` | Node.js, Electron main | `createPaymentNode()`: UDX, WebSockets and the circuit relay transport; `resolveDnsAddrs()` |
| `@spiffyvault/payments` (core) | Any, with your own libp2p node | Nothing platform-specific |

The package uses `@stephanfeb/ricochet` for the Ricochet server (offline
path), `@bsv/sdk` for transactions and keys, and
`@bsv/message-box-client` for PeerPay. The browser entry has no Node.js code.

## In Node.js

<!-- example: examples/node.ts#node-imports -->
```ts
import { RicochetClient } from '@stephanfeb/ricochet/node'
import { SPIFFYVAULT_RICOCHET, createPaymentNode, pay } from '@spiffyvault/payments/node'
import type { WalletInterface } from '@bsv/sdk'
```
<!-- /example -->

<!-- example: examples/node.ts#node -->
```ts
// One libp2p node: the payer's peer ID for both the live and the offline path.
const { node } = await createPaymentNode()
const ricochet = new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.addr] }] })
try {
  const result = await pay({ link }, {
    wallet, // any BRC-100 WalletInterface: it builds and signs, you never see keys
    libp2p: node, // live: through the server's circuit relay
    relays: [server.addr],
    ricochet, // offline: the payee's Ricochet mailbox
    onProgress: p => console.log(`[${p.path}] ${p.step}`)
  })
  console.log(`${result.status} by ${result.path}: ${result.txid}`)
  return result.path
} finally {
  await ricochet.close()
  await node.stop()
}
```
<!-- /example -->

UDX dials IP addresses only: use `SPIFFYVAULT_RICOCHET.udxIp`, or
`resolveDnsAddrs([SPIFFYVAULT_RICOCHET.udx])`.

## In a browser

<!-- example: examples/browser.ts#browser-imports -->
```ts
import { RicochetClient } from '@stephanfeb/ricochet/browser'
import { SPIFFYVAULT_RICOCHET, createPaymentNode, pay } from '@spiffyvault/payments/browser'
import type { WalletInterface } from '@bsv/sdk'
```
<!-- /example -->

<!-- example: examples/browser.ts#browser -->
```ts
// WebSockets only: the page reaches the Ricochet server over WSS, and the
// payee's phone (UDX) through the server's circuit relay.
const { node } = await createPaymentNode(nodeOptions) // tests allow loopback addresses here
const ricochet = new RicochetClient(node, { servers: [{ peerId: server.peerId, addrs: [server.wss] }] })
try {
  const { path, txid } = await pay({ link }, { wallet, libp2p: node, relays: [server.wss], ricochet })
  return { path, txid }
} finally {
  await ricochet.close()
  await node.stop()
}
```
<!-- /example -->

## How `pay()` chooses a path

`pay()` follows the app's pay-link screen (`pay_link_screen.dart`,
`payment_service.dart`):

1. With a peer ID (`p`): **live** first, if you pass `libp2p`.
2. Then **offline**, if you pass `ricochet`, but only when live failed
   before any transaction was handed over: the phone could not be reached,
   or it sent no usable invoice. A failure after that point stops here, so
   the payee is never paid twice.
3. **PeerPay** when the link has only a key (`k`). After live and offline
   failed safely, only with `peerPay: { fallback: true }`: the app offers
   this to the user and never does it on its own.

Before anything is asked of anyone, `pay()` checks the link (the app's
rules exactly: `parsePaymentLink`), refuses a link or key for another
network than the wallet's, refuses a bare BRC-100 key from a testnet wallet
unless `allowBareKey` is set (keys outside links carry a `testnet:` or
`regtest:` label off mainnet), takes the link's amount, and puts
`ref <r>` into the note for a payment-request link.

The result names the path, the txid and the status:

| Status | Path | Meaning |
|---|---|---|
| `completed` | live | The phone checked the payment by SPV and the network holds it. |
| `sent` | live | The phone checked it and ARC accepted it, but the network had not answered within `timeouts.networkMs` (default 60 s). Do not pay again; watch the txid. |
| `handed-off` | offline | The sealed payment is in the payee's mailbox. The phone broadcasts it when it collects it. |
| `delivered` | peerpay | Your wallet broadcast it and the token is in the payee's message box. |

`result.attempts` lists the paths that failed safely before.

## Links

<!-- example: examples/parts.ts#link-imports -->
```ts
import { linkMismatch, noteToSend, parsePaymentLink } from '@spiffyvault/payments'
```
<!-- /example -->

<!-- example: examples/parts.ts#link -->
```ts
const link = parsePaymentLink(text) // null when it is not a valid SpiffyVault link
if (link === null) return null
const wrongNetwork = linkMismatch(link, 'mainnet') !== null // a testnet link from a mainnet wallet
const note = noteToSend(link, link.memo) // adds "ref <r>" for a payment-request link
```
<!-- /example -->

## Links that name a website

A link may name the shop's domain (`d=shop.example`). The app then reads
`https://shop.example/.well-known/spiffyvault.json` and pays only when that
file lists the link's payee for the payer's network, signed by the payee's
own peer key. `pay()` does the same: a link whose domain does not vouch for
its payee fails with `DomainError` (`domain-refused`) before anything is
asked of the payee, and a paid one comes back with `result.payeeDomain`.
To show the payee before paying:

<!-- example: examples/parts.ts#domain-imports -->
```ts
import { checkPayeeDomain, domainEntry, domainFileText } from '@spiffyvault/payments'
import type { DomainFetch, PaymentLink, PeerKeySigner } from '@spiffyvault/payments'
```
<!-- /example -->

<!-- example: examples/parts.ts#domain -->
```ts
const check = await checkPayeeDomain({
  domain: link.domain,
  network: link.network,
  ...(link.peerId !== undefined ? { peerId: link.peerId } : {}),
  ...(link.paymentKey !== undefined ? { paymentKey: link.paymentKey } : {}),
  ...(fetch !== undefined ? { fetch } : {})
})
if (!check.verified) return null // refuse: check.problem says why ('not-listed', 'unreachable', …)
return `${check.name ?? check.domain} · verified for ${check.domain}`
```
<!-- /example -->

The check reads over HTTPS, follows no redirect, waits 5 s and reads at most
16 KiB. In a browser the site must send `Access-Control-Allow-Origin` for the
file; without it the answer is `unreachable`, as is a missing file served
without that header. Either way the link is refused.

The SpiffyVault app writes the file for its user (Identity, Your website).
A shop's server can write it with the payee's libp2p Ed25519 key; the entry
is byte for byte the app's for the same key:

<!-- example: examples/parts.ts#domain-entry -->
```ts
const entry = await domainEntry({ domain: 'shop.example', peerId, paymentKey, networks: ['mainnet'], name: 'Corner Shop' }, peerKey)
const file = domainFileText([entry]) // serve at https://shop.example/.well-known/spiffyvault.json
```
<!-- /example -->

## Signed links

The app signs the links it makes: `s` is the payee's Ed25519 signature,
by the key in the peer ID, over every other field, amount and note
included. A payer refuses a signed link whose signature does not check
(`LinkChangedError`, `link-changed`): someone changed it. A link with a peer
ID that is not signed is still paid, but `pay()` never falls back from the
peer ID to its payment key, since only the signature ties the key to the
peer ID.

A shop that sets its own amount drops `s` and adds `a` and `m` to the
payee's fields. A server that holds the payee's key can sign instead:

<!-- example: examples/parts.ts#signed-imports -->
```ts
import { formatPaymentLink, linkSignatureValid, signPaymentLink } from '@spiffyvault/payments'
```
<!-- /example -->

<!-- example: examples/parts.ts#signed -->
```ts
const link = await signPaymentLink({ network: 'mainnet', peerId, amountSats: 2500, memo: 'Order 1042' }, peerKey)
const text = formatPaymentLink(link) // …&s=<signature>: changing any field now fails the check
const valid = linkSignatureValid(link) // a payer's check; pay() makes it too
```
<!-- /example -->

## One path at a time

`payLive`, `payOffline` and `payViaPeerPay` do one path each, with no
fallback.

<!-- example: examples/parts.ts#perpath-imports -->
```ts
import { payOffline, payViaPeerPay } from '@spiffyvault/payments'
```
<!-- /example -->

<!-- example: examples/parts.ts#perpath -->
```ts
const offline = await payOffline({ payeePeerId, amountSats: 1000, note: 'Coffee', network: 'testnet' }, { wallet, ricochet })
const peerpay = await payViaPeerPay({ paymentKey, amountSats: 1000, note: 'Coffee' }, {
  wallet,
  host: 'https://messagebox.bsvblockchain.tech', // the default; set your own here
  ...(client !== undefined ? { client } : {}) // the tests deliver to a stand-in
})
```
<!-- /example -->

The PeerPay host defaults to `https://messagebox.bsvblockchain.tech`, BSVA's
public server, which SpiffyVault reads on purpose. `@bsv/message-box-client`
alone defaults to an older host that SpiffyVault reads only until
2026-11-14. The token is sent to the host you choose; there is no overlay
lookup.

## Funding

With a BRC-100 wallet (`WalletInterface` from `@bsv/sdk`), the library asks
`createAction` for the exact outputs a path needs, with
`randomizeOutputs: false`:

- Live and offline: `noSend: true` (the payee broadcasts). The wallet's
  Atomic BEEF is converted to BEEF V1 with the payment last, the only form
  the payee takes. A payment given up before it left is aborted with
  `abortAction` (txid as the reference). After it left, it is never aborted.
- PeerPay: the wallet broadcasts (`acceptDelayedBroadcast: false`), and the
  token carries the Atomic BEEF, checked for txid-only entries, which
  SpiffyVault refuses.

For a wallet that is not BRC-100, pass a `funder` instead (live and
offline only):

<!-- example: examples/parts.ts#funder-imports -->
```ts
import type { Funder } from '@spiffyvault/payments'
```
<!-- /example -->

<!-- example: examples/parts.ts#funder -->
```ts
// For a wallet that is not BRC-100: build, sign, do NOT broadcast, return BEEF.
const funder: Funder = async (outputs, info) => {
  // outputs: [{ lockingScript (hex), satoshis, address? }]; info.broadcast is false
  // for live and offline (the payee broadcasts). PeerPay needs a BRC-100 wallet.
  const beef = await build(outputs) // BEEF V1 preferred; V2 and Atomic BEEF are converted
  return { beef, abort: release } // abort(): the payment was given up before it left
}
```
<!-- /example -->

The library checks that the funded transaction pays every output it asked
for. It does not check the fee: the payee's ARC refuses a fee that is too
low, after the payment was handed over.

## Errors

Every failure is a `PaymentError` with a `code`, the `path`, the `stage` it
reached, the `txid` once there is one, and `canPayAnotherWay`.

<!-- example: examples/parts.ts#errors-imports -->
```ts
import { PaymentError } from '@spiffyvault/payments'
```
<!-- /example -->

<!-- example: examples/parts.ts#errors -->
```ts
try {
  await attempt()
  return 'paid'
} catch (e) {
  if (!(e instanceof PaymentError)) throw e
  if (e.canPayAnotherWay) return `nothing left; safe to try again or another way (${e.code})`
  // The payee may hold the transaction: never pay again; watch e.txid.
  return `do not pay again: ${e.code} ${e.txid ?? ''}`
}
```
<!-- /example -->

| Code | Stage | Meaning |
|---|---|---|
| `bad-link`, `bad-key`, `bare-key`, `own-key`, `network-mismatch`, `amount-invalid`, `no-route` | prepare | Nothing was asked of anyone. |
| `link-changed` | prepare | The link's signature does not match its fields (`LinkChangedError`): it was changed after the payee signed it. Do not pay it. |
| `domain-refused` | prepare | The link's domain does not vouch for its payee (`DomainError`, with `domain` and `problem`): the link may have been changed. Do not pay it. |
| `payee-unreachable`, `server-unreachable` | connect | The phone, or the Ricochet server, could not be reached. |
| `no-invoice`, `bad-invoice`, `anchor-missing`, `anchor-invalid`, `anchor-other-network`, `prekeys-*` | request | No usable invoice (live) or anchor and prekeys (offline). Nothing was built. |
| `funding-failed` | pay | The wallet could not build it. `pay()` does not fall back (another path would fail the same way). |
| `invoice-expired`, `frame-too-large`, `beef-unusable` | pay | Built, then aborted before it left (`aborted: true`). |
| `mailbox-refused` | deliver | The mailbox refused it; aborted. |
| `delivery-unknown` | deliver | The submission's answer was lost. It may be in the mailbox: inputs stay reserved. |
| `not-confirmed`, `payee-refused` | settle | Handed to the phone; no good answer. Inputs stay reserved. Release them only once the txid is not on the network. |
| `network-refused` | settle | The phone took it, then the network refused it (for example a double spend): the payee was not paid. Inputs stay reserved until the txid is known not to be on the network. |
| `broadcast-failed`, `peerpay-undelivered` | pay, deliver | PeerPay: the broadcast failed, or the token was not delivered after it. `PeerPayUndeliveredError` keeps the token for `deliverPeerPayToken()`. |

## Being paid

A node can be paid live the way a phone is: the app pays its peer ID
through the Ricochet server's circuit relay, and the payment arrives as it
happens.

<!-- example: examples/payee.ts#payee-imports -->
```ts
import { acceptLivePayments, createPaymentNode, formatPaymentLink, waitUntilReachable } from '@spiffyvault/payments/node'
import type { LivePayeeOptions, ReceivedLivePayment } from '@spiffyvault/payments/node'
```
<!-- /example -->

<!-- example: examples/payee.ts#payee -->
```ts
// A reservation on the relay, and identify push, so the app finds this peer ID.
const { node } = await createPaymentNode({ payee: true, ...(relay !== undefined ? { relay } : {}) })
await waitUntilReachable(node)
const payee = await acceptLivePayments(node, {
  network: 'testnet',
  invoiceAddress: r => addressFor(r.invoiceId), // a new address per invoice, one you can spend
  onPayment: p => { keep(p) }, // checked by SPV and on the network: keep p.beefV1 and p.vouts
  onEvent: e => { console.log(`payee: ${e.kind}`) },
  ...checks // the tests use a stand-in chain and broadcaster; the defaults are WhatsOnChain and ARC
})
// The app pays this link live; signPaymentLink() adds a signature.
const link = formatPaymentLink({ network: 'testnet', peerId: node.peerId.toString(), amountSats: 2500 })
```
<!-- /example -->

In a browser, import from `@spiffyvault/payments/browser`: the same
`createPaymentNode({ payee: true })` listens through the relay's WSS
address. https://shop.spiffyvault.net/pay-from-browser/ is a page built this
way.

How the app finds the payee: before every live payment it asks the Ricochet
server's DHT for the peer ID (FIND_PEER) and dials the relay address it gets
back. The server only knows that address if the payee told it after the
reservation was made. Its first identify with the server runs before the
reservation exists, so a payee needs identify push (`identifyPush` from
`@libp2p/identify`), which `createPaymentNode` always turns on. A js-libp2p
node of your own without it can be dialled directly but not found, and the
app reports it as not online.

What `acceptLivePayments` does, as the app's payee does:

- Answers `payment_request` with an invoice for the address
  `invoiceAddress` returns, or with `payment_error` when `screen` refuses
  it. The invoice is held for 60 s.
- Takes the `beef_payment` only for that invoice and from the same payer.
  It reads the BEEF V1, checks that the outputs to the invoice's address pay
  at least the amount, and checks the transaction by SPV (`chainTracker`).
- Broadcasts the unproven ancestors, then the payment (`broadcaster`,
  default `arcBroadcaster`: ARC, following a `RECEIVED` answer for a few
  seconds).
- Calls `onPayment`, then tells the payer it is done. When `onPayment`
  throws, the payer still hears success: the payment is on the network.
  Keep the coin (`beefV1`, `vouts`, the invoice's key) before returning.
- A payment that does not check out is refused (`payee-refused` for the
  payer); one the network refuses is reported as not broadcast
  (`not-confirmed`). Nothing is kept for either.

## What the library does, and does not do

- It checks the payee's anchor record as the app does, and checks one more
  thing than the app: the prekey bundle's Ed25519 key must be the key in
  the payee's peer ID.
- It uses a random live `sessionId` (`pay_<ms>_<96 random bits>`), not the
  app's `pay_<ms>`.
- It writes each live frame with one `send()` and keeps it under 64 KiB,
  less on a relayed connection with a byte allowance. The phone reads a
  frame with one yamux read. A payment too large for that is aborted and
  `pay()` falls back to offline.
- It builds and sends within the phone's 60 s invoice window; when building
  takes too long it aborts.
- It does not follow a payment on the network after handing it over (no
  indexer lookups), and it does not reclaim a stranded offline payment. A
  payment the payee never collects stays `noSend` in your wallet: after 3
  days the app would spend its inputs back to itself.

## Testing

From `packages/payments`:

| Command | Needs | What |
|---|---|---|
| `npm run test:unit` | | Links, frames, BEEF, derivation, the app's test vectors, path choice |
| `npm run test:integration` | PostgreSQL, Go, `../go-ricochet` | A local go-ricochet (throwaway database `ricochet_payments_test`): offline submit and payee-side decrypt; live through the relay to a mock payee, over UDX |
| `npm run test:browser` | as above, plus Chrome | Live from headless Chrome over WS and WSS, through the relay to a UDX payee; offline from Chrome |
| `npm run check:bundle` | | The browser entries have no Node built-ins, no UDX transport and no wallet-toolbox |
| `node tools/gen-dart-fixture.ts <out.json>` | | JS-made offline messages for the app's `test/signal/js_interop_test.dart` |

## A real payment on testnet

`tools/e2e-pay.ts` pays a phone's payment link from a
`@bsv/wallet-toolbox` testnet wallet and prints every step. It uses the
toolbox's network services (WhatsOnChain, ARC); the library does not. Run
it from `packages/payments` with Node.js 22 (`npm install` at the
repository root first).

1. Pick a key file outside this repository. The tool makes it on first use:

   ```sh
   export SPIFFYVAULT_E2E_KEY=~/.spiffyvault-e2e/testnet.key
   node tools/e2e-pay.ts info
   ```

   It prints the wallet's identity key and a funding address.
2. Send testnet coins (some 20 000 satoshis) to the funding address. Wait
   for one confirmation, then take the coins into the wallet:

   ```sh
   node tools/e2e-pay.ts fund <txid>
   node tools/e2e-pay.ts info      # the balance now shows them
   ```

3. On the phone (a testnet build): Home, **Get paid**, the **My code** tab,
   **SpiffyVault** under "Who will scan it?", **Ask for an amount**, type
   an amount (and a note), **Share link**. Send the text to the computer.
   It looks like `https://spiffyvault.net/pay?n=testnet&p=12D3KooW…&k=02…&a=…`.
4. Dry run, with the app open:

   ```sh
   node tools/e2e-pay.ts pay '<link>' --dry-run
   ```

   Expect "offline: anchor … verifies", "offline: prekey bundle verifies"
   and "live: the phone answers through the relay". Nothing is spent.
5. Live, with the app open in the foreground:

   ```sh
   node tools/e2e-pay.ts pay '<link>' --path live
   ```

   Expect `done: completed by live`. On the phone: an incoming payment with
   the amount and the note, from the payer peer ID the tool printed (shortened).
6. Offline:

   ```sh
   node tools/e2e-pay.ts pay '<link>' --path offline
   ```

   Expect `done: handed-off by offline`. The phone imports it from its
   mailbox (at once if the app is open, else within 30 s of opening it) and
   broadcasts it.
7. PeerPay (the link must have `k`):

   ```sh
   node tools/e2e-pay.ts pay '<link>' --path peerpay
   ```

   Expect `done: delivered by peerpay`. The phone polls its message box
   every 30 s.
8. Follow any payment with `node tools/e2e-pay.ts status <txid>`.

Without `--path`, the tool runs `pay()`: live, then offline. If a run ends
in `not-confirmed` or `delivery-unknown`, do not pay again: the phone may
hold the payment. `abort <txid>` releases the inputs of a live or offline
payment only when you know the phone did not take it.

## License

Apache-2.0
