import { describe, expect, it } from 'vitest'
import { createZoomCommitter } from '../src/renderer/zoom-commit'

/** a committer on a fake clock: timers run only when the test says so */
function harness(minIntervalMs?: number) {
  const applied: number[] = []
  let clock = 1000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const committer = createZoomCommitter({
    apply: (zoom) => applied.push(zoom),
    minIntervalMs,
    schedule: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: clock + ms, fn })
      return id
    },
    cancel: (id) => {
      timers.delete(id)
    },
  })
  const advance = (ms: number) => {
    clock += ms
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= clock) {
        timers.delete(id)
        clock = timer.at
        timer.fn()
      }
    }
  }
  return { committer, applied, advance, pendingTimers: () => timers.size }
}

describe('zoom committer', () => {
  it('applies a lone step once the input has been quiet', () => {
    const h = harness()
    h.committer.request(110)
    expect(h.applied).toEqual([])
    h.advance(199)
    expect(h.applied).toEqual([])
    h.advance(1)
    expect(h.applied).toEqual([110])
  })

  it('collapses a burst into one apply carrying the newest target', () => {
    const h = harness()
    for (const zoom of [110, 120, 130, 140, 150]) {
      h.committer.request(zoom)
      h.advance(50)
    }
    expect(h.applied).toEqual([])
    expect(h.pendingTimers()).toBe(1)
    h.advance(200)
    expect(h.applied).toEqual([150])
    expect(h.committer.pending()).toBeNull()
  })

  it('steps build on the in-flight target, not on the committed value', () => {
    const h = harness()
    h.committer.request(110)
    expect(h.committer.base(100)).toBe(110)
    h.committer.request(120)
    expect(h.committer.base(100)).toBe(120)
    h.advance(200)
    expect(h.committer.base(100)).toBe(100)
  })

  it('honours a custom quiet window', () => {
    const h = harness(500)
    h.committer.request(110)
    h.advance(400)
    expect(h.applied).toEqual([])
    h.advance(100)
    expect(h.applied).toEqual([110])
  })

  it('cancel drops a staged zoom without applying it', () => {
    const h = harness()
    h.committer.request(150)
    h.committer.cancel()
    expect(h.pendingTimers()).toBe(0)
    h.advance(500)
    expect(h.applied).toEqual([])
    expect(h.committer.pending()).toBeNull()
  })

  it('a request from inside the apply schedules exactly one more pass', () => {
    const applied: number[] = []
    let queued: (() => void) | null = null
    const committer = createZoomCommitter({
      apply: (zoom) => {
        applied.push(zoom)
        if (zoom === 110) committer.request(120)
      },
      schedule: (fn) => {
        queued = fn
        return 1
      },
      cancel: () => {
        queued = null
      },
    })
    committer.request(110)
    queued!()
    expect(applied).toEqual([110])
    queued!()
    expect(applied).toEqual([110, 120])
  })
})
