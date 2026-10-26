# @spiffyvault/sign-in

Sign in with SpiffyVault (OIAP-v2) on your site. The user approves in the
SpiffyVault app; your site gets a public key that the app made for your
site alone, signed for this one sign-in.

- On a computer the page shows a QR code and a 6-digit code. The user scans
  the QR code and types the code into the app, which proves they can see
  the browser that asked.
- On a phone the page shows a button that opens the app. After approval the
  app opens your one-time return link, and the browser that opens it is
  signed in.

The protocol is SpiffyVault's `doc/sign-in.md`. Version 0.1.0 is not on npm.
Node.js 22.18 or later, or any browser. ESM only.

## On your server

```ts
import { SignInSite } from '@spiffyvault/sign-in'

const site = new SignInSite({
  domain: 'shop.example',                                // your users' keys are made from it: keep it
  callback: 'https://shop.example/sign-in/callback',     // where the app posts
  name: 'Example Shop',                                  // what the app shows
  returnBase: 'https://shop.example/sign-in/return'      // for sign-in on the phone
})
```

Four endpoints:

| Endpoint | Does |
|---|---|
| `POST /sign-in/start` | `site.start({ mode, browser, place })`: `browser` is your own id for this browser, from a cookie you set here; `place` is where the browser appears to be, if you know (for example `Lagos, Nigeria` from its IP address). Return the result to the page. |
| `GET /sign-in/poll?nonce=` | `site.poll(nonce, browser)`: on `signed-in`, start your session for `publicKey`. Only the browser that asked gets it, once. |
| `POST /sign-in/callback` | `site.answer(body)`: reply with its `status` and `body`. One attempt per challenge: a wrong code uses it up. |
| `GET /sign-in/return?t=` | `site.redeem(t)`: start your session for the key it returns, then redirect. |

The user is the key: `publicKey` (64 hex characters) is the same each time
this SpiffyVault identity signs in to `domain`, and different at every
other site.

`SignInSite` keeps pending sign-ins in memory. With more than one server
process, pass a `store` that implements `SignInStore` over your shared
store.

## In the page

```ts
import { mountSignIn } from '@spiffyvault/sign-in/browser'

mountSignIn(document.getElementById('sign-in')!, {
  start: async mode => await (await fetch('/sign-in/start', { method: 'POST', body: mode })).json(),
  poll: async nonce => await (await fetch(`/sign-in/poll?nonce=${nonce}`)).json(),
  onSignedIn: () => location.reload()
})
```

It chooses the QR code on a computer and the button on a phone; pass
`mode` to choose yourself, and `labels` for your own words.

## Example

`npm run example` serves `examples/site.ts` at http://localhost:8787/. To
try it with a phone, run it with this computer's network address, for
example `HOST=192.168.1.5 npm run example`, and open
http://192.168.1.5:8787/ in a browser.

## What it defends against

- A changed callback, name or place: the app signs all of them.
- A QR code that reaches the user without its browser (a forwarded picture,
  a printed code): there is no code to type.
- Someone who learns the nonce: the session goes only to the browser that
  asked, or the one that opens the return link.
- Linking users across sites: each site gets its own key.

It does not stop a phishing page that relays a live challenge and its code.
The app warns the user to type only a code shown on the site named, and
shows the place you report.
