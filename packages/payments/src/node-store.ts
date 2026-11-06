/** A file for an offline payee's keys and opened payments (Node.js). */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { OfflinePayeeState, OfflinePayeeStore } from './offline-payee.ts'

/**
 * Keeps the state in `path` as JSON, readable by its owner only (it holds
 * private keys). Each save writes a new file and renames it over the old,
 * so a crash leaves one or the other, never half of one.
 */
export function offlinePayeeFileStore (path: string): OfflinePayeeStore {
  return {
    load: async () => {
      let text: string
      try { text = readFileSync(path, 'utf8') } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
      const state = JSON.parse(text) as OfflinePayeeState
      if (state.version !== 1) throw new Error(`${path} is not an offline payee state this version reads`)
      return state
    },
    save: async state => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      renameSync(tmp, path)
    }
  }
}
