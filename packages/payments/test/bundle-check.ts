/**
 * Checks that the browser and neutral entries bundle for the browser with
 * no externals and pull in no Node.js built-ins, no UDX transport and no
 * @bsv/wallet-toolbox (a dev dependency for the E2E tool only), and that the node entry
 * bundles for Node. Bundles the built dist/ files (run `npm run build` first)
 * so it checks what the package ships.
 */

import { build } from 'esbuild'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const builtins = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)])
let failed = false

for (const entry of ['browser', 'index']) {
  const result = await build({
    entryPoints: [`${root}dist/${entry}.js`],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    metafile: true,
    logLevel: 'silent'
  })
  const imports = Object.values(result.metafile.inputs).flatMap(i => i.imports.map(x => x.path))
  const nodeImports = imports.filter(p => builtins.has(p) || p.startsWith('node:'))
  const inputs = Object.keys(result.metafile.inputs)
  const udxRoot = inputs.filter(p => (p.includes('@stephanfeb/libp2p-udx/') && !p.endsWith('/multiaddr.js')) || p.includes('@stephanfeb/udx/'))
  const toolbox = inputs.filter(p => p.includes('@bsv/wallet-toolbox'))
  const bytes = result.outputFiles[0]!.contents.length
  console.log(`${entry}: platform=browser, no externals, ${inputs.length} inputs, ${(bytes / 1024).toFixed(0)} KiB`)
  if (nodeImports.length > 0) { console.log(`  FAIL: Node built-ins: ${nodeImports.join(', ')}`); failed = true }
  if (udxRoot.length > 0) { console.log(`  FAIL: UDX transport code: ${udxRoot.join(', ')}`); failed = true }
  if (toolbox.length > 0) { console.log(`  FAIL: wallet-toolbox code: ${toolbox.slice(0, 5).join(', ')}`); failed = true }
  if (!inputs.some(p => p.endsWith('@stephanfeb/libp2p-udx/dist/multiaddr.js'))) { console.log('  FAIL: UDX codec registration missing'); failed = true }
}

const node = await build({
  entryPoints: [`${root}dist/node.js`],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false,
  metafile: true,
  logLevel: 'silent'
})
console.log(`node: platform=node, ${Object.keys(node.metafile.inputs).length} inputs, ${(node.outputFiles[0]!.contents.length / 1024).toFixed(0)} KiB`)

if (failed) process.exit(1)
console.log('bundle check passed')
