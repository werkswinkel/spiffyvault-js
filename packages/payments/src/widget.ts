/**
 * The payment widget: drop it into a checkout and the page takes SpiffyVault
 * payments.
 *
 *   mountPayment(document.getElementById('pay'), {
 *     request: previous => fetch(previous === undefined ? '/api/checkout' : `/api/pay/${previous.id}/renew`,
 *       { method: 'POST' }).then(r => r.json()),
 *     status: id => fetch(`/api/pay/${id}`).then(r => r.json()),
 *     onPaid: paid => location.assign(`/thanks/${paid.id}`)
 *   })
 *
 * The shop's server makes the request with the payee's createPaymentRequest
 * and answers `status` from what its payee saw. The widget shows the QR on a
 * computer and the app button on a phone, the other ways to pay right under
 * them, the progress, the expiry and a new link, and calls `onPaid` once.
 * It holds no secret: it shows links and progress, nothing more. The shop's
 * server should trust its own record of the payment, not this callback.
 *
 * This entry has no libp2p in it; a page that only shows the widget stays
 * small.
 */

import { renderSVG } from 'uqr'
import type { PaymentPath } from './errors.ts'
import type { PaymentRequest, RequestStatus, RequestStep } from './request.ts'

export type { PaymentRequest, RequestStatus, RequestStep } from './request.ts'

type LiveStep = 'shown' | 'phone-connected' | 'checking' | 'on-the-way' | 'paid'
const LIVE_STEPS: LiveStep[] = ['shown', 'phone-connected', 'checking', 'on-the-way', 'paid']

/** The words the widget shows; pass the ones you want in another language. */
export interface PaymentLabels {
  scan: string
  scanOther: string
  open: string
  openHint: string
  otherWays: string
  anotherWay: string
  openHere: string
  fromAnotherDevice: string
  peerpay: string
  peerpayHint: string
  copy: string
  copied: string
  copyFailed: string
  waitingPhone: string
  waitingPayment: string
  steps: Record<LiveStep, string>
  expiresIn: (time: string) => string
  payeeOffline: string
  inMailbox: string
  peerpaySeen: string
  refused: (reason: string | undefined) => string
  expired: string
  newLink: string
  paid: string
  paidBy: (path: PaymentPath | undefined) => string
  viewTx: string
  trustDomain: (domain: string) => string
  trustSigned: string
  trustKey: string
  sats: (amount: number) => string
  loading: string
  loadFailed: string
  tryAgain: string
  unreachable: string
}

export const englishPaymentLabels: PaymentLabels = {
  scan: 'Scan with SpiffyVault on your phone',
  scanOther: 'Scan with SpiffyVault on your other device',
  open: 'Pay with SpiffyVault',
  openHint: 'Opens the SpiffyVault app on this device.',
  otherWays: 'Other ways to pay',
  anotherWay: 'Pay another way',
  openHere: 'Open in SpiffyVault on this computer',
  fromAnotherDevice: 'Pay from another device',
  peerpay: 'Pay by PeerPay',
  peerpayHint: 'PeerPay works from any BRC-100 wallet: it broadcasts the payment and leaves it for the shop.',
  copy: 'Copy link',
  copied: 'Copied',
  copyFailed: 'Could not copy',
  waitingPhone: 'Waiting for your phone',
  waitingPayment: 'Waiting for your payment',
  steps: {
    shown: 'Link shown',
    'phone-connected': 'Phone connected, invoice sent',
    checking: 'Payment received, checking it',
    'on-the-way': 'Broadcast, waiting for the network',
    paid: 'Paid'
  },
  expiresIn: time => ` · expires in ${time}`,
  payeeOffline: 'The shop can\'t take live payments right now. You can still pay: your phone leaves the payment for the shop, and the order confirms when it collects it.',
  inMailbox: 'Your payment is waiting in the shop\'s mailbox. It usually confirms within a minute.',
  peerpaySeen: 'Your wallet has broadcast the payment. It confirms when the shop collects it, usually within seconds.',
  refused: reason => `Your payment did not go through${reason !== undefined && reason !== '' ? `: ${reason}` : ''}. Nothing was taken. Try again.`,
  expired: 'This payment link has expired. Nothing was paid. Already paid it? Give it a minute: a late payment still matches by its reference.',
  newLink: 'Make a new link',
  paid: 'Paid',
  paidBy: path => path === 'live' ? 'Paid live from your wallet.' : path === 'peerpay' ? 'Paid by PeerPay.' : path === 'offline' ? 'Paid through the shop\'s mailbox.' : 'Paid.',
  viewTx: 'See the transaction',
  trustDomain: domain => `Payee listed by ${domain} · link signed`,
  trustSigned: 'Link signed by the payee',
  trustKey: 'Paying the payee\'s key by PeerPay',
  sats: amount => `${amount.toLocaleString('en-US')} sats`,
  loading: 'Getting a payment link…',
  loadFailed: 'The shop could not make a payment link.',
  tryAgain: 'Try again',
  unreachable: 'The shop isn\'t answering right now. Still trying.'
}

export type PaymentWidgetEvent =
  | { kind: 'request', request: PaymentRequest }
  | { kind: 'status', status: RequestStatus }
  | { kind: 'chosen', way: 'app' | 'open-here' | 'peerpay' | 'copy' | 'qr-on-phone' }
  | { kind: 'error', during: 'request' | 'status', message: string }

export interface MountPaymentOptions {
  /**
   * A request from the shop's server: at the start with no argument, and
   * with the expired one when the payer asks for a new link.
   */
  request: (previous?: PaymentRequest) => Promise<PaymentRequest>
  /** What the payee has seen of request `id`. Polled while it is open. */
  status: (id: string) => Promise<RequestStatus>
  /** Push instead of waiting for the next poll: call `onStatus` on each change, return a stop function. Polling continues, slower. */
  subscribe?: (id: string, onStatus: (status: RequestStatus) => void) => () => void
  /** Called once, when the payee reports the request paid. */
  onPaid: (status: RequestStatus, request: PaymentRequest) => void
  /** Everything the widget does, for a developer view or analytics. */
  onEvent?: (event: PaymentWidgetEvent) => void
  labels?: Partial<PaymentLabels>
  /** The shop's accent colour, for the main button and the current step. */
  accent?: string
  /** False: add no stylesheet; style the `spiffyvault-pay-*` classes yourself. */
  styles?: boolean
  /** Default: `phone` on a phone or tablet, `computer` elsewhere. */
  device?: 'phone' | 'computer'
  /** Milliseconds between status polls. Default 2000; 15000 with `subscribe`. */
  pollEvery?: number
}

/** True on a phone or tablet: the browser and the app are on one device. */
export function onPhone (): boolean {
  const ua = globalThis.navigator?.userAgent ?? ''
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (/Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1)
}

/** Where step `step` puts the progress list: the index of the step in progress. */
export function progressIndex (step: RequestStep): number {
  switch (step) {
    case 'phone-connected': return 1
    case 'checking': return 2
    case 'on-the-way': case 'in-mailbox': return 3
    case 'paid': return 5
    default: return 0
  }
}

/** "m:ss" left until `expiresAt`, or null once it has passed. */
export function timeLeft (expiresAt: number, now: number): string | null {
  const ms = expiresAt - now
  if (ms <= 0) return null
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** What the trust line says about `request`'s live link. */
export function trustLine (request: PaymentRequest, labels: PaymentLabels): string {
  if (request.links.live === undefined) return labels.trustKey
  const q = new URL(request.links.live).searchParams
  const domain = q.get('d')
  if (!q.has('s')) return labels.trustKey
  return domain !== null ? labels.trustDomain(domain) : labels.trustSigned
}

/** True when the payer can no longer pay `request`'s links and has paid nothing yet. */
export function lapsed (request: PaymentRequest, step: RequestStep, now: number): boolean {
  if (step === 'expired') return true
  // A payment under way is never cut off by the clock: it may still land.
  return (step === 'shown' || step === 'refused') && now > request.expiresAt
}

function explorer (network: string, txid: string): string {
  return `https://${network === 'mainnet' ? '' : 'test.'}whatsonchain.com/tx/${txid}`
}

const STYLE_ID = 'spiffyvault-pay-styles'
/** The widget's stylesheet. Under a CSP without inline styles, serve dist/widget.css (`@spiffyvault/payments/widget.css`) and pass `styles: false`. */
export const paymentWidgetCss = `
.spiffyvault-pay{--sv-accent:var(--spiffyvault-pay-accent,#1f6fd0);--sv-ok:#2d8a4e;--sv-warn:#b7791f;--sv-bad:#c0392b;--sv-line:color-mix(in srgb,currentColor 18%,transparent);--sv-soft:color-mix(in srgb,currentColor 62%,transparent);display:flex;flex-direction:column;gap:14px;font:inherit;color:inherit}
.spiffyvault-pay *{box-sizing:border-box}
.spiffyvault-pay [hidden]{display:none!important}
.spiffyvault-pay p{margin:0}
.spiffyvault-pay-grid{display:grid;grid-template-columns:auto minmax(0,1fr);gap:24px;align-items:start}
@media (max-width:560px){.spiffyvault-pay-grid{grid-template-columns:minmax(0,1fr)}}
.spiffyvault-pay-qrcol{display:flex;flex-direction:column;align-items:center;gap:6px;width:240px;max-width:100%}
.spiffyvault-pay-qr svg{display:block;width:220px;height:220px;max-width:100%;background:#fff;padding:8px;border-radius:8px;border:1px solid var(--sv-line)}
.spiffyvault-pay-amount{font-weight:700;font-variant-numeric:tabular-nums}
.spiffyvault-pay-hint,.spiffyvault-pay-trust{font-size:.875em;color:var(--sv-soft)}
.spiffyvault-pay-qrcol .spiffyvault-pay-hint{text-align:center}
.spiffyvault-pay-col{display:flex;flex-direction:column;gap:10px;min-width:0}
.spiffyvault-pay-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:.55em 1em;border-radius:8px;border:1.5px solid var(--sv-line);background:transparent;color:inherit;font:inherit;font-weight:600;line-height:1.2;text-decoration:none;cursor:pointer;text-align:center}
.spiffyvault-pay-button:hover{border-color:var(--sv-soft)}
.spiffyvault-pay-button.is-primary{align-self:flex-start;background:var(--sv-accent);border-color:var(--sv-accent);color:#fff;font-size:1.05em;padding:.75em 1.4em}
.spiffyvault-pay-button.is-small{font-size:.875em;padding:.45em .8em}
.spiffyvault-pay-button:focus-visible,.spiffyvault-pay-more>summary:focus-visible{outline:2px solid var(--sv-accent);outline-offset:2px}
.spiffyvault-pay-more{align-self:stretch}
.spiffyvault-pay-more>summary{cursor:pointer;font-weight:600;padding:2px 0}
.spiffyvault-pay-more-body{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.spiffyvault-pay-actions{display:flex;flex-wrap:wrap;gap:8px}
.spiffyvault-pay-qrcol .spiffyvault-pay-actions{flex-direction:column}
.spiffyvault-pay-more-body .spiffyvault-pay-qrcol{align-self:center}
.spiffyvault-pay-title{margin:0;font-size:1.1em;font-weight:700}
.spiffyvault-pay-steps{list-style:none;margin:0;padding:0 0 0 4px;border-left:3px solid var(--sv-line)}
.spiffyvault-pay-steps li{position:relative;padding:3px 0 3px 14px;color:var(--sv-soft)}
.spiffyvault-pay-steps li::before{content:"";position:absolute;left:-9px;top:.62em;width:12px;height:12px;border-radius:50%;background:Canvas;border:2px solid var(--sv-line)}
.spiffyvault-pay-steps li.is-done{color:inherit}
.spiffyvault-pay-steps li.is-done::before{background:var(--sv-ok);border-color:var(--sv-ok)}
.spiffyvault-pay-steps li.is-now{color:inherit;font-weight:700}
.spiffyvault-pay-steps li.is-now::before{border-color:var(--sv-accent);border-width:3px}
.spiffyvault-pay-notice{padding:10px 12px;border:1px solid var(--sv-line);border-left:4px solid var(--sv-warn);border-radius:8px}
.spiffyvault-pay-notice.is-bad{border-left-color:var(--sv-bad)}
.spiffyvault-pay-notice.is-info{border-left-color:var(--sv-accent)}
.spiffyvault-pay-done{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.spiffyvault-pay-pill{display:inline-block;font-size:.75em;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border:1.5px solid var(--sv-ok);color:var(--sv-ok);border-radius:999px;padding:1px 9px}
.spiffyvault-pay-done a{color:inherit}
`

function addStyles (): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = paymentWidgetCss
  document.head.append(style)
}

/** Shows a payment in `element`. The returned function stops it and clears the element. */
export function mountPayment (element: HTMLElement, opts: MountPaymentOptions): () => void {
  const labels: PaymentLabels = { ...englishPaymentLabels, ...opts.labels, steps: { ...englishPaymentLabels.steps, ...opts.labels?.steps } }
  const phone = (opts.device ?? (onPhone() ? 'phone' : 'computer')) === 'phone'
  const pollEvery = opts.pollEvery ?? (opts.subscribe !== undefined ? 15_000 : 2000)
  const emit = (e: PaymentWidgetEvent): void => { try { opts.onEvent?.(e) } catch { /* the page's own handler */ } }
  if (opts.styles !== false) addStyles()

  let stopped = false
  let request: PaymentRequest | undefined
  let status: RequestStatus | undefined
  let paidSent = false
  let failures = 0
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined

  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    if (cls !== '') e.className = cls.split(' ').map(c => c.startsWith('is-') ? c : `spiffyvault-pay-${c}`).join(' ')
    if (text !== undefined) e.textContent = text
    return e
  }
  const button = (text: string, cls: string, onClick: () => void): HTMLButtonElement => {
    const b = h('button', `button ${cls}`, text)
    b.type = 'button'
    b.addEventListener('click', onClick)
    return b
  }
  const link = (text: string, cls: string, href: string, way: 'app' | 'open-here' | 'peerpay'): HTMLAnchorElement => {
    const a = h('a', `button ${cls}`, text)
    a.href = href
    a.addEventListener('click', () => { emit({ kind: 'chosen', way }) })
    return a
  }

  const root = h('div', '')
  root.className = 'spiffyvault-pay'
  if (opts.accent !== undefined) root.style.setProperty('--spiffyvault-pay-accent', opts.accent)
  element.replaceChildren(root)

  // Parts updated as the status changes; built for each request.
  let parts: {
    offline: HTMLElement, refused: HTMLElement, info: HTMLElement, unreachable: HTMLElement,
    pay: HTMLElement, steps: HTMLOListElement, expired: HTMLElement, done: HTMLElement
  } | undefined

  const qrBlock = (text: string, hint: string): HTMLElement => {
    const col = h('div', 'qrcol')
    const qr = h('div', 'qr')
    // renderSVG builds the SVG from the link alone; no outside markup goes in.
    qr.innerHTML = renderSVG(text, { ecc: 'M', border: 2 })
    qr.setAttribute('role', 'img')
    qr.setAttribute('aria-label', 'QR code of the payment link')
    col.append(qr, h('div', 'amount', labels.sats(request!.amountSats)), h('p', 'hint', hint))
    return col
  }

  const copyButton = (r: PaymentRequest): HTMLButtonElement => {
    const b = button(labels.copy, 'is-small', () => {
      emit({ kind: 'chosen', way: 'copy' })
      const text = r.links.live ?? r.links.peerpay ?? ''
      navigator.clipboard.writeText(text).then(() => { b.textContent = labels.copied }, () => { b.textContent = labels.copyFailed })
      setTimeout(() => { b.textContent = labels.copy }, 2000)
    })
    return b
  }

  const build = (r: PaymentRequest): void => {
    const main = r.links.live ?? r.links.peerpay
    const offline = h('p', 'notice', labels.payeeOffline)
    const refused = h('p', 'notice is-bad')
    const info = h('p', 'notice is-info')
    const unreachable = h('p', 'notice', labels.unreachable)
    const steps = h('ol', 'steps')
    const waiting = h('p', 'title', phone ? labels.waitingPayment : labels.waitingPhone)
    const trust = h('p', 'trust', trustLine(r, labels))
    const pay = h('div', phone ? 'col' : 'grid')

    const more = h('details', 'more')
    const summary = h('summary', '', phone ? labels.anotherWay : labels.otherWays)
    const moreBody = h('div', 'more-body')
    const actions = h('div', 'actions')
    more.append(summary, moreBody)

    if (phone) {
      if (main !== undefined) pay.append(link(labels.open, 'is-primary', main, 'app'), h('p', 'hint', labels.openHint))
      if (r.links.peerpay !== undefined && r.links.live !== undefined) actions.append(link(labels.peerpay, 'is-small', r.links.peerpay, 'peerpay'))
      actions.append(copyButton(r))
      moreBody.append(actions)
      if (main !== undefined) {
        // The QR is for a second device: inside the fold, shown when asked for.
        const show = button(labels.fromAnotherDevice, 'is-small', () => {
          emit({ kind: 'chosen', way: 'qr-on-phone' })
          show.remove()
          actions.after(qrBlock(main, labels.scanOther))
        })
        actions.prepend(show)
      }
      if (r.links.peerpay !== undefined) moreBody.append(h('p', 'hint', labels.peerpayHint))
      pay.append(more, waiting, steps, trust)
    } else {
      const left = main !== undefined ? qrBlock(main, labels.scan) : h('div', 'qrcol')
      more.open = true
      if (main !== undefined) actions.append(link(labels.openHere, 'is-small', main, 'open-here'))
      if (r.links.peerpay !== undefined && r.links.live !== undefined) actions.append(link(labels.peerpay, 'is-small', r.links.peerpay, 'peerpay'))
      actions.append(copyButton(r))
      moreBody.append(actions)
      if (r.links.peerpay !== undefined) moreBody.append(h('p', 'hint', labels.peerpayHint))
      left.append(more)
      const right = h('div', 'col')
      right.append(waiting, steps, trust)
      pay.append(left, right)
    }

    const expired = h('div', 'col')
    const again = button(labels.newLink, 'is-primary', () => { void load(request) })
    expired.append(h('p', 'notice', labels.expired), again)

    const done = h('div', 'done')
    root.replaceChildren(offline, unreachable, refused, info, pay, expired, done)
    parts = { offline, refused, info, unreachable, pay, steps, expired, done }
  }

  const render = (): void => {
    if (request === undefined || parts === undefined) return
    const step: RequestStep = status?.step ?? 'shown'
    const now = Date.now()
    const p = parts

    if (step === 'paid') {
      p.done.replaceChildren(h('span', 'pill', labels.paid), h('div', 'amount', labels.sats(request.amountSats)), h('p', '', labels.paidBy(status?.path)))
      if (status?.txid !== undefined) {
        const a = h('a', 'trust', labels.viewTx)
        a.href = explorer(request.network, status.txid)
        a.target = '_blank'
        a.rel = 'noopener'
        p.done.append(a)
      }
      for (const e of [p.offline, p.refused, p.info, p.unreachable, p.pay, p.expired]) e.hidden = true
      p.done.hidden = false
      return
    }

    const gone = lapsed(request, step, now)
    p.done.hidden = true
    p.expired.hidden = !gone
    p.pay.hidden = gone
    p.offline.hidden = gone || (status?.payeeOnline ?? request.payeeOnline) !== false
    p.unreachable.hidden = gone || failures < 3
    p.refused.hidden = gone || step !== 'refused'
    if (step === 'refused') p.refused.textContent = labels.refused(status?.reason)
    const infoText = step === 'in-mailbox' ? labels.inMailbox : step === 'on-the-way' && status?.path === 'peerpay' ? labels.peerpaySeen : null
    p.info.hidden = gone || infoText === null
    if (infoText !== null) p.info.textContent = infoText
    if (gone) return

    const at = progressIndex(step)
    const left = timeLeft(request.expiresAt, now)
    p.steps.replaceChildren(...LIVE_STEPS.map((s, i) => {
      const li = h('li', i < at ? 'is-done' : i === at ? 'is-now' : '', labels.steps[s] + (s === 'shown' && left !== null && at === 0 ? labels.expiresIn(left) : ''))
      if (i === at) li.setAttribute('aria-current', 'step')
      return li
    }))
  }

  const take = (s: RequestStatus): void => {
    if (stopped || request === undefined || s.id !== request.id) return
    status = s
    emit({ kind: 'status', status: s })
    render()
    if (s.step === 'paid' && !paidSent) {
      paidSent = true
      stopWatching()
      opts.onPaid(s, request)
    }
  }

  let polling = false
  const poll = async (): Promise<void> => {
    clearTimeout(pollTimer)
    if (stopped || request === undefined || paidSent || polling) return
    polling = true
    const id = request.id
    try {
      const s = await opts.status(id)
      failures = 0
      take(s)
    } catch (e) {
      failures++
      emit({ kind: 'error', during: 'status', message: e instanceof Error ? e.message : String(e) })
      render()
    }
    polling = false
    if (!stopped && !paidSent && request?.id === id) pollTimer = setTimeout(() => { void poll() }, pollEvery)
  }

  const stopWatching = (): void => {
    clearTimeout(pollTimer)
    clearInterval(clock)
    unsubscribe?.()
    unsubscribe = undefined
  }

  const load = async (previous?: PaymentRequest): Promise<void> => {
    stopWatching()
    root.replaceChildren(h('p', 'hint', labels.loading))
    let r: PaymentRequest
    try {
      r = await opts.request(previous)
    } catch (e) {
      if (stopped) return
      emit({ kind: 'error', during: 'request', message: e instanceof Error ? e.message : String(e) })
      root.replaceChildren(h('p', 'notice is-bad', labels.loadFailed), button(labels.tryAgain, '', () => { void load(previous) }))
      return
    }
    if (stopped) return
    request = r
    status = undefined
    failures = 0
    emit({ kind: 'request', request: r })
    build(r)
    render()
    if (opts.subscribe !== undefined) unsubscribe = opts.subscribe(r.id, take)
    clock = setInterval(render, 1000)
    // A poll of the previous request may still be out; it answers into nothing.
    polling = false
    void poll()
  }

  // Back from the app: ask at once instead of waiting for the next poll.
  const onVisible = (): void => { if (document.visibilityState === 'visible') void poll() }
  document.addEventListener('visibilitychange', onVisible)

  void load()
  return () => {
    stopped = true
    stopWatching()
    document.removeEventListener('visibilitychange', onVisible)
    element.replaceChildren()
  }
}
