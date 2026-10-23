/** An in-memory stand-in for a RicochetClient: documents and mailboxes, no network. */

import type { RicochetLike } from '../../src/index.ts'

export interface Stored {
  messageId: string
  senderPeerId: string
  recipientPeerId: string
  folderPath: string
  payload: Uint8Array
  priority: number
  persistent: boolean
  sequenceNumber: number
  flags: number
}

class Store {
  readonly docs = new Map<string, Uint8Array>()
  readonly mail: Stored[] = []
  refuse?: { status: number, message: string }
  throwOnSend?: Error
  seq = 1
}

export class MemRicochet implements RicochetLike {
  readonly peerId: string
  private readonly store: Store

  constructor (peerId: string, store: Store = new Store()) {
    this.peerId = peerId
    this.store = store
  }

  get mail (): Stored[] { return this.store.mail }
  set refuse (r: { status: number, message: string } | undefined) { this.store.refuse = r }
  set throwOnSend (e: Error | undefined) { this.store.throwOnSend = e }

  /** A client for another peer on the same "server". */
  as (peerId: string): MemRicochet { return new MemRicochet(peerId, this.store) }

  putDoc (owner: string, path: string, content: string): void { this.store.docs.set(`${owner}/${path}`, new TextEncoder().encode(content)) }

  async getDocument (...[owner, path]: Parameters<RicochetLike['getDocument']>): ReturnType<RicochetLike['getDocument']> {
    const content = this.store.docs.get(`${owner.toString()}/${path}`)
    return (content === undefined ? { status: 404 } : { status: 200, content, contentType: 'application/json' }) as never
  }

  async retrievePage (...[opts = {}]: Parameters<RicochetLike['retrievePage']>): ReturnType<RicochetLike['retrievePage']> {
    const owner = opts.targetPeerId?.toString() ?? this.peerId
    const messages = this.store.mail
      .filter(m => m.recipientPeerId === owner && m.folderPath === (opts.folderPath ?? '') && m.sequenceNumber >= (opts.fromSequence ?? 0))
      .slice(0, opts.maxMessages ?? 100)
    return { messages: messages.map(m => ({ ...m })) as never, hasMore: false }
  }

  async sendMessage (...[recipient, payload, opts = {}]: Parameters<RicochetLike['sendMessage']>): ReturnType<RicochetLike['sendMessage']> {
    const s = this.store
    if (s.throwOnSend !== undefined) throw s.throwOnSend
    if (s.refuse !== undefined) return { success: false, messageId: '', storedAtServer: '', errorMessage: s.refuse.message, status: s.refuse.status, retryAfterMs: 0 }
    const messageId = crypto.randomUUID()
    s.mail.push({
      messageId, senderPeerId: this.peerId, recipientPeerId: recipient.toString(), folderPath: opts.folderPath ?? '',
      payload: typeof payload === 'string' ? new TextEncoder().encode(payload) : Uint8Array.from(payload as Uint8Array),
      priority: opts.priority ?? 1, persistent: opts.persistent ?? false, sequenceNumber: s.seq++, flags: 0
    })
    return { success: true, messageId, storedAtServer: 'mem', errorMessage: '', status: 0, retryAfterMs: 0 }
  }
}
