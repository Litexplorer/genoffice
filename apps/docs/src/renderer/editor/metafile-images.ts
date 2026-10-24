import { isMetafilePartPath, parseLazyMediaUrl } from '@genoffice/docx-engine/lazy-media'
import { isMetafileMime, metafileToDataUrl } from '@genoffice/docx-engine/metafile'
import type { MetafileWorkerRequest, MetafileWorkerResponse } from '../metafile-worker'

/**
 * On-demand rasterization of lazily served metafiles.
 *
 * An EMF/WMF part cannot be shown by an <img>, and pre-rasterizing it during
 * the parse was catastrophic: a 58 MB document holding 1 GB of EMF became 56
 * giant PNG data URLs (117 MB of base64) that the model carried, the worker
 * cloned and the DOM held — seconds of inflate plus an unavoidable re-layout
 * on every zoom. The bytes now stay in the source file; each picture is
 * rasterized when it appears on screen, capped to a sane device size.
 */

/** longest raster side: metafiles are authored in thousands of device px */
export const METAFILE_RASTER_MAX_PX = 1600
/** conversions in flight; more would contend with typing and pagination */
const MAX_CONCURRENT = 2
/** a picture that never finishes converting must not wedge the queue */
const CONVERT_TIMEOUT_MS = 30_000

let worker: Worker | null = null
let nextJob = 0
const inflight = new Map<number, (url: string | null) => void>()

/** the conversion worker, or null when the platform has none (tests, fallback) */
function getWorker(): Worker | null {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null
  try {
    worker = new Worker(new URL('../metafile-worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
  worker.onmessage = (e: MessageEvent<MetafileWorkerResponse>) => {
    const resolve = inflight.get(e.data.id)
    if (!resolve) return
    inflight.delete(e.data.id)
    resolve(e.data.url)
  }
  // a crashed converter fails its waiting pictures and starts a fresh worker
  worker.onerror = () => {
    for (const resolve of inflight.values()) resolve(null)
    inflight.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

/** rasterize off the UI thread: the encode step can be seconds of canvas work */
function rasterizeInWorker(bytes: ArrayBuffer, mime: string): Promise<string | null> {
  const w = getWorker()
  if (!w)
    return Promise.resolve(
      metafileToDataUrl(new Uint8Array(bytes), mime, { maxSidePx: METAFILE_RASTER_MAX_PX }),
    )
  const id = ++nextJob
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inflight.delete(id)
      resolve(null)
    }, CONVERT_TIMEOUT_MS)
    inflight.set(id, (url) => {
      clearTimeout(timer)
      resolve(url)
    })
    w.postMessage(
      { id, bytes, mime, maxSidePx: METAFILE_RASTER_MAX_PX } satisfies MetafileWorkerRequest,
      [bytes],
    )
  })
}

const MIME_BY_EXT: Record<string, string> = {
  emf: 'image/emf',
  wmf: 'image/wmf',
  emz: 'image/x-emz',
  wmz: 'image/x-wmz',
}

/**
 * the lazy-media URL when it names a metafile part, else null
 * url - a picture source from the document model
 */
export function metafileLazyUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const ref = parseLazyMediaUrl(url)
  return ref && isMetafilePartPath(ref.partPath) ? url : null
}

const converted = new Map<string, Promise<string | null>>()

/**
 * point an <img> at a document picture: metafiles become a deferred source the
 * observer fills in, everything else is a plain src
 * attrs - the DOM attrs being built for the picture
 * src - the model's picture source
 */
export function withMetafileSrc(attrs: Record<string, string>, src: string): void {
  const metafile = metafileLazyUrl(src)
  if (metafile) attrs['data-metafile-src'] = metafile
  else attrs.src = src
}

/**
 * rasterize one lazy metafile into a capped PNG data URL
 * url - genoffice-docx-media URL of the part
 * returns the data URL, or null when the bytes are gone or the converter
 *         cannot render them (the element then keeps its empty box)
 */
export function rasterizeMetafile(url: string): Promise<string | null> {
  const hit = converted.get(url)
  if (hit) return hit
  const pending = (async () => {
    const part = parseLazyMediaUrl(url)?.partPath ?? ''
    const mime = MIME_BY_EXT[part.split('.').pop()?.toLowerCase() ?? '']
    if (!isMetafileMime(mime)) return null
    const res = await fetch(url)
    if (!res.ok) return null
    return rasterizeInWorker(await res.arrayBuffer(), mime)
  })().catch(() => null)
  converted.set(url, pending)
  return pending
}

let queue: HTMLImageElement[] = []
/** pictures already picked up: a reader that mounts a second editor (document
 *  swap, tab reuse) must not enqueue the same node twice — and must not lose
 *  the tail a previous observer had queued */
const queued = new WeakSet<HTMLImageElement>()
let active = 0
let timer: ReturnType<typeof setTimeout> | null = null
let waiters: Array<() => void> = []

/** idle scheduling: conversions must never delay typing, scrolling or a pass */
function requestIdle(cb: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback
  if (typeof ric === 'function') ric(cb, { timeout: 400 })
  else setTimeout(cb, 32)
}

function flushWaiters(): void {
  if (queue.length > 0 || active > 0) return
  for (const wake of waiters.splice(0)) wake()
}

function schedule(): void {
  if (timer !== null) return
  timer = setTimeout(() => {
    timer = null
    step()
  }, 0)
}

function step(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const img = queue.shift() as HTMLImageElement
    // a streaming tail can drop a queued picture before it is reached
    if (!img.isConnected || !img.dataset.metafileSrc) continue
    active++
    void apply(img).finally(() => {
      active--
      if (queue.length > 0) requestIdle(step)
      else flushWaiters()
    })
  }
  if (queue.length === 0) flushWaiters()
}

async function apply(img: HTMLImageElement): Promise<void> {
  const url = img.dataset.metafileSrc
  if (!url) return
  delete img.dataset.metafileSrc
  const src = await rasterizeMetafile(url)
  if (src) {
    if (img.isConnected) img.src = src
    return
  }
  img.dataset.metafileFailed = '1'
}

function collect(node: Element | null): void {
  if (!node) return
  const imgs =
    node instanceof HTMLImageElement
      ? [node]
      : Array.from(node.querySelectorAll<HTMLImageElement>('img[data-metafile-src]'))
  for (const img of imgs) {
    if (queued.has(img)) continue
    queued.add(img)
    queue.push(img)
  }
  if (imgs.length > 0) schedule()
}

/**
 * rasterize the metafiles of an editor DOM as they appear
 * root - the ProseMirror element; a streaming open appends inside it
 * returns a teardown for the observer
 */
export function installMetafileImages(root: HTMLElement): () => void {
  collect(root)
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const added of record.addedNodes) if (added.nodeType === 1) collect(added as Element)
  })
  observer.observe(root, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
  }
}

/** true while any metafile picture is still waiting for its raster */
export function hasPendingMetafiles(): boolean {
  return queue.length > 0 || active > 0
}

/** resolves once every queued metafile has been rasterized (export/print gate) */
export async function whenMetafilesReady(): Promise<void> {
  // a picture appended in this same tick is still in the MutationObserver's
  // microtask queue: let that callback run before deciding nothing is pending
  if (queue.length === 0 && active === 0) await Promise.resolve()
  if (queue.length === 0 && active === 0) return
  await new Promise<void>((resolve) => waiters.push(resolve))
}
