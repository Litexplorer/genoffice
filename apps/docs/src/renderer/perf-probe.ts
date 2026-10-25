/**
 * Runtime performance probe.
 *
 * Open-time and pagination numbers already live on `__pageDebug`; this adds the
 * two things that panel could not answer: where an open spends its time (bytes,
 * parse, font prepare, first mount) and how the editor behaves afterwards
 * (long tasks and frame rate). Collection is opt-in through
 * `localStorage['docs:perf'] = '1'` (window.__docsPerf.enable() flips it too), so
 * a normal session pays nothing but the phase marks.
 */

/** a main-thread stall Chromium reported as a long task */
export interface LongTask {
  /** ms since the probe started */
  at: number
  /** duration in ms */
  ms: number
}

export interface PerfSnapshot {
  /** named open phases, in ms */
  phases: Record<string, number>
  /** recent long tasks (newest last) */
  longTasks: LongTask[]
  /** frames per second of the last sampled second, or null when not sampling */
  fps: number | null
  /** document-wide numbers copied from the pagination probe */
  layout: {
    blocks: number
    pages: number
    passMs: number
    measureMs: number
    setGapsMs: number
  } | null
}

const PHASE_LIMIT = 32
const LONG_TASK_LIMIT = 200
const STORAGE_KEY = 'docs:perf'

const phases = new Map<string, number>()
let longTasks: LongTask[] = []
let startedAt = performance.now()
let observer: PerformanceObserver | null = null
let frameHandle = 0
let frames = 0
let fps: number | null = null
let fpsSampledAt = 0

function collecting(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function sampleFrames(now: number): void {
  frames++
  if (fpsSampledAt === 0) fpsSampledAt = now
  else if (now - fpsSampledAt >= 1000) {
    fps = Math.round((frames * 1000) / (now - fpsSampledAt))
    frames = 0
    fpsSampledAt = now
  }
  frameHandle = requestAnimationFrame(sampleFrames)
}

function startCollecting(): void {
  if (observer) return
  startedAt = performance.now()
  // Long tasks are what the user feels as "stuck"; frame rate says whether
  // scrolling itself keeps up.
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          at: Math.round(entry.startTime - startedAt),
          ms: Math.round(entry.duration),
        })
      }
      if (longTasks.length > LONG_TASK_LIMIT) longTasks = longTasks.slice(-LONG_TASK_LIMIT)
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // a platform without long-task support still gets phases and frame rate
    observer = null
  }
  if (typeof requestAnimationFrame === 'function') frameHandle = requestAnimationFrame(sampleFrames)
}

function stopCollecting(): void {
  observer?.disconnect()
  observer = null
  if (frameHandle) cancelAnimationFrame(frameHandle)
  frameHandle = 0
  fps = null
  frames = 0
  fpsSampledAt = 0
}

/** record one measured phase (no-op cost when the probe is off) */
export function perfPhase(name: string, ms: number): void {
  if (phases.size >= PHASE_LIMIT && !phases.has(name)) return
  phases.set(name, Math.round(ms))
}

/** start a phase clock */
export function perfStart(): number {
  return performance.now()
}

/** close a phase opened with perfStart() */
export function perfEnd(name: string, start: number): number {
  const ms = performance.now() - start
  perfPhase(name, ms)
  return ms
}

/** clear every collected number (a fresh open, or a new measurement round) */
export function perfReset(): void {
  phases.clear()
  longTasks = []
  startedAt = performance.now()
  frames = 0
  fpsSampledAt = 0
}

/** the current numbers, including the pagination probe's layout figures */
export function perfSnapshot(): PerfSnapshot {
  const debug = (window as unknown as { __pageDebug?: Record<string, unknown> }).__pageDebug
  const blocks = debug?.blocks as unknown[] | undefined
  const slices = debug?.slices as unknown[] | undefined
  return {
    phases: Object.fromEntries(phases),
    longTasks: [...longTasks],
    fps,
    layout: debug
      ? {
          blocks: blocks?.length ?? 0,
          pages: slices?.length ?? 0,
          passMs: Math.round(Number(debug.remeasureMs ?? 0)),
          measureMs: Math.round(Number(debug.measureMs ?? 0)),
          setGapsMs: Math.round(Number(debug.setGapsMs ?? 0)),
        }
      : null,
  }
}

/**
 * install the probe once per page
 *
 * Always exposes `window.__docsPerf` so a user (or a bug report) can enable it
 * and read the numbers back; collection itself starts only when opted in.
 */
export function installPerfProbe(): void {
  const api = {
    enable: () => {
      try {
        localStorage.setItem(STORAGE_KEY, '1')
      } catch {
        /* private mode: run without the flag still counts this session */
      }
      perfReset()
      startCollecting()
      return 'perf probe on'
    },
    disable: () => {
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }
      stopCollecting()
      return 'perf probe off'
    },
    reset: perfReset,
    snapshot: perfSnapshot,
    report: (): void => {
      const s = perfSnapshot()
      console.table(s.phases)
      if (s.layout) console.table(s.layout)
      if (s.longTasks.length) {
        const top = [...s.longTasks].sort((a, b) => b.ms - a.ms).slice(0, 10)
        console.table(top)
      }
      console.log('fps', s.fps, 'long tasks', s.longTasks.length)
    },
  }
  ;(window as unknown as { __docsPerf?: typeof api }).__docsPerf = api
  if (collecting()) startCollecting()
}
