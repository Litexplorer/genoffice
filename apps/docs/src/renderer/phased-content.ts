import type { PmNode } from './editor/convert'

/**
 * Word-style progressive open for large documents.
 *
 * Mounting a 60-page document in one setContent keeps the "Opening…" screen up
 * until the whole ProseMirror DOM is built and laid out — the dominant share of
 * cold-open time. Instead, mount enough blocks to overfill the first screens,
 * let the browser paint them, then append the tail in frame-sized chunks while
 * the user already reads page 1 (the page count in the status bar grows as the
 * tail streams in, like Word's background pagination).
 *
 * The node conversion rides along: callers pass a PhasedDocSource and each
 * chunk is converted just before it mounts, instead of every block node being
 * built before the first screen can paint.
 *
 * While the tail streams the document is incomplete, so:
 * - the editor stays editable except at the append boundary (the streaming
 *   tail guard refuses edits in or after the last mounted block),
 * - saves must wait on waitForFullContent() — a mid-stream save would
 *   serialize, and write to disk, a truncated document,
 * - appends bypass undo history and restore the dirty flag, so streaming is
 *   not an edit; history resets once the tail lands unless the user edited
 *   meanwhile (their undo stack must survive).
 */
export interface PhasedContentHost {
  /** full replace (Tiptap setContent) */
  setContent(doc: PmNode): void
  /** append top-level nodes at the document end, outside undo history */
  appendNodes(nodes: PmNode[]): void
  isDestroyed(): boolean
  resetHistory(): void
  /** read-only + save-gate flag while the tail streams */
  setLoading(loading: boolean): void
  getDirty(): boolean
  setDirty(dirty: boolean): void
}

/** dispatched on document once a streamed tail has fully landed (layout
 *  measurers skip the tail's chunks and measure the whole document once) */
export const PHASED_CONTENT_SETTLED_EVENT = 'genoffice:phased-content-settled'

/**
 * A document handed over as convertible ranges instead of a finished node tree:
 * building every block node up front took seconds on a 30k-block document, so
 * the conversion runs chunk by chunk with the mount instead of ahead of it.
 */
export interface PhasedDocSource {
  /** top-level nodes the finished document holds */
  length: number
  /** convert top-level nodes [from, to); builds nothing outside the range */
  slice(from: number, to: number): PmNode[]
}

/** wrap a finished node tree as a source (the pre-converted call shape) */
function sourceOfDoc(pmDoc: PmNode): PhasedDocSource {
  const content = pmDoc.content ?? []
  return { length: content.length, slice: (from, to) => content.slice(from, to) }
}

function isSource(doc: PmNode | PhasedDocSource): doc is PhasedDocSource {
  return typeof (doc as PhasedDocSource).slice === 'function'
}

/** the document over [from, to) of the source; a node keeps its own top-level attrs */
function docSlice(
  doc: PmNode | PhasedDocSource,
  source: PhasedDocSource,
  from = 0,
  to = source.length,
): PmNode {
  const content = source.slice(from, to)
  return isSource(doc) ? { type: 'doc', content } : { ...doc, content }
}

/** blocks in the first synchronous mount: overfills the first screens at any zoom */
export const PHASE1_BLOCKS = 64
/** blocks appended per scheduled chunk while the tail streams in */
export const PHASE_CHUNK_BLOCKS = 128
/** documents at or below this many top-level blocks mount in one pass as before */
export const PHASED_MIN_BLOCKS = 192

/** bumping the token cancels the pending tail (its chunks become no-ops) */
let token = 0
let settled: Promise<void> = Promise.resolve()
/** clears the loading flag / resolves settled when a load is cancelled mid-stream */
let cancelPending: (() => void) | null = null

/** Resolves when the streaming tail has fully landed (immediately when none is pending). */
export function waitForFullContent(): Promise<void> {
  return settled
}

/** true while a phased open still has tail chunks to append */
export function isPhasedContentPending(): boolean {
  return cancelPending !== null
}

/** Any full content replacement outside the phased path must drop a pending tail. */
export function cancelPhasedContent(): void {
  token++
  cancelPending?.()
  cancelPending = null
}

/**
 * Double-rAF: the browser paints the previous mount between the two callbacks.
 * A timer races the frames: a background tab (a hidden shell view keeps
 * document.hidden false but is handed about one frame a second) would
 * otherwise stretch a long open into hours, one chunk per second.
 */
export const PAINTED_FRAME_FALLBACK_MS = 80
const nextPaintedFrame = (cb: () => void): void => {
  let done = false
  let raf2 = 0
  const fire = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
    cb()
  }
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(fire)
  })
  const timer = setTimeout(fire, PAINTED_FRAME_FALLBACK_MS)
}

export function setContentPhased(
  host: PhasedContentHost,
  doc: PmNode | PhasedDocSource,
  schedule: (cb: () => void) => void = nextPaintedFrame,
): void {
  cancelPhasedContent()
  // a source converts per chunk; a finished tree keeps the old slice behaviour
  const source = isSource(doc) ? doc : sourceOfDoc(doc)
  const my = ++token
  if (source.length <= PHASED_MIN_BLOCKS) {
    host.setContent(docSlice(doc, source))
    return
  }
  host.setContent(docSlice(doc, source, 0, PHASE1_BLOCKS))
  let settle!: () => void
  settled = new Promise<void>((resolve) => (settle = resolve))
  host.setLoading(true)
  cancelPending = () => {
    host.setLoading(false)
    settle()
  }
  let index = PHASE1_BLOCKS
  // a refused chunk remounted the whole document: whatever the user typed
  // before is gone with it, and an undo must not bring the truncated
  // pre-remount document back
  let remounted = false
  const finish = () => {
    if (my !== token) return
    // still "pending" through the history reset: it re-creates the plugin
    // views, whose constructors would otherwise measure the whole document
    // once before the settled event asks for the same pass again
    if (!host.isDestroyed() && (remounted || !host.getDirty())) host.resetHistory()
    cancelPending = null
    host.setLoading(false)
    settle()
    if (typeof document !== 'undefined')
      document.dispatchEvent(new Event(PHASED_CONTENT_SETTLED_EVENT))
  }
  const appendChunk = () => {
    if (my !== token) return
    if (host.isDestroyed()) return finish()
    const chunk = source.slice(index, Math.min(index + PHASE_CHUNK_BLOCKS, source.length))
    index += chunk.length
    const wasDirty = host.getDirty()
    try {
      host.appendNodes(chunk)
    } catch {
      // a refused chunk falls back to the one-pass mount instead of leaving the file truncated
      remounted = true
      try {
        host.setContent(docSlice(doc, source))
      } catch {
        /* same failure as the one-pass path */
      }
      host.setDirty(wasDirty)
      return finish()
    }
    host.setDirty(wasDirty)
    if (index < source.length) schedule(appendChunk)
    else finish()
  }
  schedule(appendChunk)
}
