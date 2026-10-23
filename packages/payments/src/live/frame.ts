/**
 * The "ON" frame of /overnode/payment/1.0.0 (overnode_payment
 * protocol/message_frame.dart):
 *
 *     4F 4E | 01 | 01 | len (u32 BE) | UTF-8 JSON object
 *     magic  ver  proto
 *
 * The Dart reader calls read(8) and then read(len) once each, and a yamux
 * read returns at most one queued data frame, so a frame must reach it in
 * one yamux data frame: write it with one send() and keep it small.
 */

import { fromUtf8, utf8 } from '../bytes.ts'

export const FRAME_MAGIC = [0x4f, 0x4e] as const
export const FRAME_VERSION = 1
export const PAYMENT_PROTOCOL_ID = 1
export const FRAME_HEADER = 8

export function encodeOnFrame (payload: Record<string, unknown>, protocolId = PAYMENT_PROTOCOL_ID): Uint8Array {
  const json = utf8(JSON.stringify(payload))
  const out = new Uint8Array(FRAME_HEADER + json.length)
  out[0] = FRAME_MAGIC[0]
  out[1] = FRAME_MAGIC[1]
  out[2] = FRAME_VERSION
  out[3] = protocolId
  new DataView(out.buffer).setUint32(4, json.length, false)
  out.set(json, FRAME_HEADER)
  return out
}

export class FrameError extends Error {
  constructor (message: string) { super(message); this.name = 'FrameError' }
}

/** Header check as MessageFrame.read does: magic and version (the protocol byte is not checked). */
export function frameLength (header: Uint8Array): number {
  if (header.length < FRAME_HEADER) throw new FrameError(`Stream closed or insufficient data: got ${header.length} bytes, expected ${FRAME_HEADER}`)
  if (header[0] !== FRAME_MAGIC[0] || header[1] !== FRAME_MAGIC[1]) throw new FrameError('Invalid magic')
  if (header[2] !== FRAME_VERSION) throw new FrameError(`Unsupported version: ${header[2]}`)
  return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, false)
}

export function decodeOnFrame (frame: Uint8Array): Record<string, unknown> {
  const n = frameLength(frame)
  if (frame.length !== FRAME_HEADER + n) throw new FrameError(`frame is ${frame.length} bytes, header says ${FRAME_HEADER + n}`)
  const v: unknown = JSON.parse(fromUtf8(frame.subarray(FRAME_HEADER)))
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new FrameError('frame payload is not a JSON object')
  return v as Record<string, unknown>
}

type Chunk = Uint8Array | { subarray: () => Uint8Array }

export interface ReadFrameResult {
  payload: Record<string, unknown>
  /** How many chunks (yamux data frames) the frame came in; the Dart reader needs 1. */
  chunks: number
}

/**
 * Reads one ON frame from a libp2p stream (buffering across chunks, unlike
 * the Dart reader). Rejects on EOF, a bad header, or `signal`.
 */
export async function readOnFrame (source: AsyncIterable<Chunk>, signal?: AbortSignal): Promise<ReadFrameResult> {
  const reader = openFrameReader(source)
  try {
    return await reader.next(signal)
  } finally {
    reader.close()
  }
}

/** Reads successive ON frames from one stream; [close] ends the reading. */
export interface FrameReader {
  next: (signal?: AbortSignal) => Promise<ReadFrameResult>
  close: () => void
}

/**
 * A reader of successive ON frames from [source]: bytes past one frame are
 * kept for the next. For a stream that carries more than one reply, such
 * as a payee's payment_status and then its payment_network
 * (spiffyvault-voo).
 */
export function openFrameReader (source: AsyncIterable<Chunk>): FrameReader {
  const it = source[Symbol.asyncIterator]()
  let rest: Uint8Array = new Uint8Array(0)
  return {
    next: async (signal) => {
      const result = await readFrom(it, rest, signal)
      rest = result.rest
      return { payload: result.payload, chunks: result.chunks }
    },
    close: () => { void it.return?.() }
  }
}

async function readFrom (it: AsyncIterator<Chunk>, carried: Uint8Array, signal?: AbortSignal): Promise<ReadFrameResult & { rest: Uint8Array }> {
  const parts: Uint8Array[] = carried.length > 0 ? [carried] : []
  let have = carried.length
  let need = -1
  let chunks = 0
  const aborted = signal === undefined
    ? undefined
    : new Promise<never>((_resolve, reject) => {
      const fail = (): void => { reject(signal.reason instanceof Error ? signal.reason : new FrameError('timed out')) }
      if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true })
    })
  aborted?.catch(() => {})
  const all = (): Uint8Array => { const b = new Uint8Array(have); let o = 0; for (const p of parts) { b.set(p, o); o += p.length } return b }
  const done = (): (ReadFrameResult & { rest: Uint8Array }) | undefined => {
    if (need < 0 && have >= FRAME_HEADER) need = FRAME_HEADER + frameLength(all().subarray(0, FRAME_HEADER))
    if (need < 0 || have < need) return undefined
    const bytes = all()
    return { payload: decodeOnFrame(bytes.subarray(0, need)), chunks, rest: bytes.slice(need) }
  }
  const early = done()
  if (early !== undefined) return early
  for (;;) {
    const next = aborted === undefined ? await it.next() : await Promise.race([it.next(), aborted])
    if (next.done === true) throw new FrameError(have === 0 ? 'stream ended before a frame arrived' : 'stream ended inside a frame')
    const bytes = next.value instanceof Uint8Array ? next.value : next.value.subarray()
    if (bytes.length === 0) continue
    parts.push(bytes)
    have += bytes.length
    chunks++
    const result = done()
    if (result !== undefined) return result
  }
}
