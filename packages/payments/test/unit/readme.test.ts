import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { render } from '../../tools/sync-readme.ts'

test('README code blocks are the example regions the tests run', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes('<!-- example: '), 'README has example blocks')
  assert.equal(render(readme), readme, 'README.md is out of date: run npm run readme')
})

test('every ts block in the README is an example block', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const blocks = readme.split('```ts').length - 1
  const examples = readme.split('<!-- example: ').length - 1
  assert.equal(blocks, examples)
})
