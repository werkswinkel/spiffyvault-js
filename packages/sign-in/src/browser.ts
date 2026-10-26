/**
 * Sign in with SpiffyVault in the page (SpiffyVault doc/sign-in.md section
 * 7): on a computer, a QR code with the 6-digit code beside it, then the
 * page polls until the phone approves; on a phone, a button that opens the
 * app, which sends the browser back through the site's return link.
 *
 *   mountSignIn(el, {
 *     start: mode => fetch('/sign-in/start', { method: 'POST', body: mode }).then(r => r.json()),
 *     poll: nonce => fetch(`/sign-in/poll?nonce=${nonce}`).then(r => r.json()),
 *     onSignedIn: () => location.reload()
 *   })
 *
 * The site's own endpoints call SignInSite; `start` sets the browser's
 * cookie, `poll` reads it.
 */

import { renderSVG } from 'uqr'
import type { Mode } from './challenge.ts'
import type { PollResult, Started } from './site.ts'

/** The words the widget shows; pass your own for another language. */
export interface SignInLabels {
  scan: string
  typeCode: string
  open: string
  waiting: string
  expired: string
  refused: string
  again: string
}

export const englishLabels: SignInLabels = {
  scan: 'Scan with SpiffyVault',
  typeCode: 'Then type this code in the app:',
  open: 'Sign in with SpiffyVault',
  waiting: 'Waiting for the app…',
  expired: 'This code has expired.',
  refused: 'The sign-in was refused.',
  again: 'Get a new code'
}

export interface MountOptions {
  /** Ask the site for a new challenge in `mode`. */
  start: (mode: Mode) => Promise<Started>
  /** Mode code: ask the site about the challenge `nonce`. */
  poll: (nonce: string) => Promise<PollResult>
  /** Mode code: the phone approved; the site has the session cookie now. */
  onSignedIn: () => void
  /** Default: `return` on a phone or tablet, `code` elsewhere. */
  mode?: Mode
  labels?: SignInLabels
  /** Milliseconds between polls. Default 2000. */
  pollEvery?: number
}

/** True on a phone or tablet: the browser and the app are on one device. */
export function onPhone (): boolean {
  const ua = globalThis.navigator?.userAgent ?? ''
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (/Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1)
}

/** Shows sign-in in `element`. The returned function stops polling and clears it. */
export function mountSignIn (element: HTMLElement, opts: MountOptions): () => void {
  const labels = opts.labels ?? englishLabels
  const mode = opts.mode ?? (onPhone() ? 'return' : 'code')
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const el = (tag: string, cls: string, text?: string): HTMLElement => {
    const e = document.createElement(tag)
    e.className = `spiffyvault-sign-in-${cls}`
    if (text !== undefined) e.textContent = text
    return e
  }

  const end = (message: string): void => {
    element.replaceChildren(el('p', 'status', message))
    const again = el('button', 'again', labels.again) as HTMLButtonElement
    again.type = 'button'
    again.onclick = () => { void show() }
    element.append(again)
  }

  const show = async (): Promise<void> => {
    clearTimeout(timer)
    const started = await opts.start(mode)
    if (stopped) return
    if (mode === 'return') {
      const a = el('a', 'open', labels.open) as HTMLAnchorElement
      a.href = started.link
      element.replaceChildren(a)
      return
    }
    const qr = el('div', 'qr')
    // renderSVG builds the SVG from the link alone; no outside markup goes in.
    qr.innerHTML = renderSVG(started.link, { ecc: 'M', border: 2 })
    const code = el('p', 'code', started.code ?? '')
    code.setAttribute('aria-label', (started.code ?? '').split('').join(' '))
    element.replaceChildren(el('p', 'scan', labels.scan), qr, el('p', 'type', labels.typeCode), code, el('p', 'status', labels.waiting))

    const tick = async (): Promise<void> => {
      if (stopped) return
      let r: PollResult
      try {
        r = await opts.poll(started.nonce)
      } catch {
        r = { state: 'waiting' }
      }
      if (stopped) return
      if (r.state === 'signed-in') { opts.onSignedIn(); return }
      if (r.state === 'refused') { end(labels.refused); return }
      if (r.state === 'gone' || Date.now() / 1000 > started.expiresAt) { end(labels.expired); return }
      timer = setTimeout(() => { void tick() }, opts.pollEvery ?? 2000)
    }
    timer = setTimeout(() => { void tick() }, opts.pollEvery ?? 2000)
  }

  void show()
  return () => {
    stopped = true
    clearTimeout(timer)
    element.replaceChildren()
  }
}
