import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installPerfProbe,
  perfEnd,
  perfPhase,
  perfReset,
  perfSnapshot,
  perfStart,
} from '../src/renderer/perf-probe'

afterEach(() => {
  perfReset()
  localStorage.removeItem('docs:perf')
})

describe('perf probe phases', () => {
  it('records named phases and resets them for the next open', () => {
    perfPhase('open:parse', 1234.4)
    const started = perfStart()
    const measured = perfEnd('open:fetch', started)
    expect(measured).toBeGreaterThanOrEqual(0)

    const snap = perfSnapshot()
    expect(snap.phases['open:parse']).toBe(1234)
    expect(snap.phases['open:fetch']).toBeGreaterThanOrEqual(0)

    perfReset()
    expect(perfSnapshot().phases).toEqual({})
  })

  it('copies the pagination probe numbers when they exist', () => {
    ;(window as unknown as { __pageDebug?: unknown }).__pageDebug = {
      blocks: new Array(10),
      slices: new Array(3),
      remeasureMs: 42.6,
      measureMs: 11.2,
      setGapsMs: 9.9,
    }
    const layout = perfSnapshot().layout
    expect(layout).toEqual({ blocks: 10, pages: 3, passMs: 43, measureMs: 11, setGapsMs: 10 })
    delete (window as unknown as { __pageDebug?: unknown }).__pageDebug
  })
})

describe('perf probe installation', () => {
  it('exposes window.__docsPerf and only collects once enabled', () => {
    installPerfProbe()
    const api = (window as unknown as { __docsPerf?: Record<string, unknown> }).__docsPerf
    expect(api).toBeDefined()
    expect(typeof api!.report).toBe('function')

    vi.spyOn(console, 'table').mockImplementation(() => {})
    const on = (api!.enable as () => string)()
    expect(on).toContain('on')
    expect(localStorage.getItem('docs:perf')).toBe('1')
    const off = (api!.disable as () => string)()
    expect(off).toContain('off')
    expect(localStorage.getItem('docs:perf')).toBeNull()
    vi.restoreAllMocks()
  })
})
