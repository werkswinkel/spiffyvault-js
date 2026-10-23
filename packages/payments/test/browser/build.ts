/**
 * Bundles the browser test page with esbuild (platform browser, no
 * externals) into build/browser/.
 */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = `${root}build/browser`
await mkdir(out, { recursive: true })
await build({
  entryPoints: [`${root}test/browser/page.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: `${out}/page.bundle.js`,
  logLevel: 'warning'
})
await writeFile(`${out}/index.html`, '<!doctype html><meta charset="utf-8"><title>loading</title><script type="module" src="page.bundle.js"></script>\n')
console.log(`built ${out}/page.bundle.js`)
