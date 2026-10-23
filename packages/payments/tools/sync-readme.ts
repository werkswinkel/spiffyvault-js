/**
 * Copies the example regions into README.md, so the README shows exactly
 * the code the tests run. A block in the README looks like
 *
 *   <!-- example: examples/tour.ts#documents -->
 *   ```ts
 *   ...
 *   ```
 *   <!-- /example -->
 *
 * and a region in a source file is the lines between `// #region name`
 * and `// #endregion`. `node tools/sync-readme.ts` rewrites the README;
 * with --check it only reports whether the README is up to date.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

export function region (file: string, name: string): string {
  const lines = readFileSync(root + file, 'utf8').split('\n')
  const start = lines.findIndex(l => l.trim() === `// #region ${name}`)
  if (start < 0) throw new Error(`no region ${name} in ${file}`)
  const end = lines.findIndex((l, i) => i > start && l.trim() === '// #endregion')
  if (end < 0) throw new Error(`region ${name} in ${file} is not closed`)
  const body = lines.slice(start + 1, end)
  const indent = Math.min(...body.filter(l => l.trim() !== '').map(l => l.length - l.trimStart().length))
  return body.map(l => l.slice(indent)).join('\n')
}

export function render (readme: string): string {
  return readme.replace(/<!-- example: ([\w./-]+)#([\w-]+) -->\n[\s\S]*?<!-- \/example -->/g,
    (_m, file: string, name: string) => `<!-- example: ${file}#${name} -->\n\`\`\`ts\n${region(file, name)}\n\`\`\`\n<!-- /example -->`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = root + 'README.md'
  const current = readFileSync(path, 'utf8')
  const next = render(current)
  if (process.argv.includes('--check')) {
    if (next !== current) { console.error('README.md is out of date: run npm run readme'); process.exit(1) }
    console.log('README.md is up to date')
  } else {
    writeFileSync(path, next)
    console.log(next === current ? 'README.md unchanged' : 'README.md updated')
  }
}
