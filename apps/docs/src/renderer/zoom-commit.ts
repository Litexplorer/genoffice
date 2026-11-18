/**
 * Interactive zoom commits (wheel, buttons, slider, shortcuts) each re-lay out
 * the whole canvas: a CSS `zoom` change invalidates the computed style of every
 * node under `.doc-zoom`, measured at ~900 ms of Recalculate Style on a
 * 297-page document. Chromium hands the next wheel event to the renderer only
 * after the previous one has been handled, so a gesture can never be batched
 * after the fact — the expensive pass has to be kept out of the gesture itself.
 *
 * The committer therefore debounces: every request pushes the apply out by
 * `minIntervalMs`, so a gesture costs one re-lay-out once the input goes quiet.
 * The caller paints the zoom change in the meantime (a transform preview), so
 * the deferred pass is invisible.
 *
 * Parameters
 * apply — receives the newest requested zoom
 * minIntervalMs — how long the input must stay quiet before the apply
 * schedule / cancel — injectable timer, so tests stay synchronous
 *
 * 核心流程
 * request() 记录最新目标值并重置定时器 → 输入静止 minIntervalMs 后提交一次 → 期间的新请求只覆盖 pending，不重复提交
 */
export interface ZoomCommitOptions {
  /** hand the newest requested zoom to React (one whole-canvas re-lay-out) */
  apply: (zoom: number) => void
  /** how long the input must stay quiet before the apply */
  minIntervalMs?: number
  /** schedule fn for ms from now, returning a handle */
  schedule?: (fn: () => void, ms: number) => number
  /** drop a handle returned by schedule */
  cancel?: (handle: number) => void
}

export interface ZoomCommitter {
  /** newest requested zoom, or null when nothing is in flight */
  pending: () => number | null
  /** the value a new step should build on: the in-flight target, else `fallback` */
  base: (fallback: number) => number
  /** record a target zoom; the apply runs once the input has been quiet */
  request: (zoom: number) => void
  /** drop the in-flight target (a programmatic zoom takes over instead) */
  cancel: () => void
}

export function createZoomCommitter({
  apply,
  minIntervalMs = 200,
  schedule = (fn, ms) => setTimeout(fn, ms) as unknown as number,
  cancel = (handle) => clearTimeout(handle),
}: ZoomCommitOptions): ZoomCommitter {
  let target: number | null = null
  let handle: number | null = null

  const flush = (): void => {
    handle = null
    const zoom = target
    target = null
    if (zoom == null) return
    apply(zoom)
  }

  return {
    pending: () => target,
    base: (fallback) => (target == null ? fallback : target),
    request: (zoom) => {
      target = zoom
      // debounce: a newer request postpones the pass instead of adding one
      if (handle != null) cancel(handle)
      handle = schedule(flush, minIntervalMs)
    },
    cancel: () => {
      if (handle != null) cancel(handle)
      handle = null
      target = null
    },
  }
}
