// The example site's page script: the widget, and who is signed in.
import { mountSignIn } from '@spiffyvault/sign-in/browser'

const me = await (await fetch('/me')).json() as { publicKey?: string }
const box = document.getElementById('sign-in')!
if (me.publicKey !== undefined) {
  box.textContent = `Signed in. Your key for this site: ${me.publicKey} `
  const out = document.createElement('a')
  out.href = '/sign-out'
  out.textContent = 'Sign out'
  box.append(out)
} else {
  const mode = new URLSearchParams(location.search).get('mode')
  mountSignIn(box, {
    ...(mode === 'code' || mode === 'return' ? { mode } : {}),
    start: async m => await (await fetch('/sign-in/start', { method: 'POST', body: m })).json(),
    poll: async nonce => await (await fetch(`/sign-in/poll?nonce=${encodeURIComponent(nonce)}`)).json(),
    onSignedIn: () => location.reload()
  })
}
