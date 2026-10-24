import { describe, expect, it } from 'vitest'
import type { PmNode } from '../src/renderer/editor/convert'
import {
  PHASED_CONTENT_SETTLED_EVENT,
  PHASE1_BLOCKS,
  PHASE_CHUNK_BLOCKS,
  PHASED_MIN_BLOCKS,
  cancelPhasedContent,
  isPhasedContentPending,
  setContentPhased,
  waitForFullContent,
  type PhasedContentHost,
  type PhasedDocSource,
} from '../src/renderer/phased-content'

const docOf = (blocks: number): PmNode => ({
  type: 'doc',
  content: Array.from({ length: blocks }, (_, i) => ({
    type: 'docParagraph',
    attrs: { docxIndex: i },
  })),
})

/** host that records events; appends mark dirty like the editor's onUpdate does */
function makeHost(destroyed = false) {
  const state = {
    mounted: [] as PmNode[],
    events: [] as string[],
    dirty: false,
    loading: false,
  }
  const host: PhasedContentHost = {
    setContent: (d) => {
      state.mounted = [...(d.content ?? [])]
      state.events.push(`set:${state.mounted.length}`)
    },
    appendNodes: (nodes) => {
      state.mounted.push(...nodes)
      state.dirty = true
      state.events.push(`append:${nodes.length}`)
    },
    isDestroyed: () => destroyed,
    resetHistory: () => state.events.push('resetHistory'),
    setLoading: (v) => {
      state.loading = v
      state.events.push(`loading:${v}`)
    },
    getDirty: () => state.dirty,
    setDirty: (v) => {
      state.dirty = v
    },
  }
  return { host, state }
}

/** scheduler the test drains manually, one chunk per drain() call */
function makeScheduler() {
  const queue: Array<() => void> = []
  return {
    schedule: (cb: () => void) => queue.push(cb),
    drain: () => queue.shift()?.(),
    pending: () => queue.length,
  }
}

describe('setContentPhased', () => {
  it('mounts small documents in one pass without the loading flag', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS), s.schedule)
    expect(state.events).toEqual([`set:${PHASED_MIN_BLOCKS}`])
    expect(s.pending()).toBe(0)
  })

  it('streams a large document in chunks and lands the full content', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2 + 7
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    expect(state.mounted.length).toBe(PHASE1_BLOCKS)
    expect(state.loading).toBe(true)
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(blocks)
    // every block landed exactly once, in order
    expect(state.mounted.map((n) => n.attrs?.docxIndex)).toEqual(
      Array.from({ length: blocks }, (_, i) => i),
    )
    expect(state.loading).toBe(false)
    expect(state.events).toContain('resetHistory')
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it('streaming is not an edit: the dirty flag survives every chunk', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 50), s.schedule)
    while (s.pending() > 0) s.drain()
    expect(state.dirty).toBe(false)
  })

  it('cancelPhasedContent drops the pending tail and releases the save gate', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    s.drain() // first chunk lands
    const landed = state.mounted.length
    cancelPhasedContent()
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(landed)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it('a second phased mount cancels the first tail', () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    const first = makeHost()
    const s1 = makeScheduler()
    setContentPhased(first.host, docOf(blocks), s1.schedule)
    const second = makeHost()
    const s2 = makeScheduler()
    setContentPhased(second.host, docOf(blocks), s2.schedule)
    while (s1.pending() > 0) s1.drain()
    while (s2.pending() > 0) s2.drain()
    // the first document keeps only its phase-1 mount; the second is complete
    expect(first.state.mounted.length).toBe(PHASE1_BLOCKS)
    expect(second.state.mounted.length).toBe(blocks)
    expect(first.state.loading).toBe(false)
    expect(second.state.loading).toBe(false)
  })

  it('a rejected chunk falls back to the one-pass mount and releases the save gate', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2
    const { host, state } = makeHost()
    const { appendNodes, setContent } = host
    let appends = 0
    host.appendNodes = (nodes) => {
      if (++appends === 2) throw new Error('schema refused')
      appendNodes(nodes)
    }
    host.setContent = (d) => {
      setContent(d)
      state.dirty = true
    }
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    state.dirty = false
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(blocks)
    expect(state.events.at(-3)).toBe(`set:${blocks}`)
    // the remount is not an edit either
    expect(state.dirty).toBe(false)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it('reports a pending tail only while chunks remain', () => {
    const { host } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS), s.schedule)
    expect(isPhasedContentPending()).toBe(false)
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), s.schedule)
    expect(isPhasedContentPending()).toBe(true)
    while (s.pending() > 0) s.drain()
    expect(isPhasedContentPending()).toBe(false)
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), s.schedule)
    cancelPhasedContent()
    expect(isPhasedContentPending()).toBe(false)
  })

  it('announces the settled tail on document, and only then', () => {
    const { host } = makeHost()
    const { schedule, drain, pending } = makeScheduler()
    let announced = 0
    const onSettled = () => announced++
    document.addEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled)
    try {
      setContentPhased(host, docOf(PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2), schedule)
      expect(announced).toBe(0)
      drain()
      expect(announced).toBe(0)
      drain()
      expect(pending()).toBe(0)
      expect(announced).toBe(1)
      // small documents mount in one pass without a tail: nothing to announce
      setContentPhased(host, docOf(3), schedule)
      expect(announced).toBe(1)
    } finally {
      document.removeEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled)
    }
  })
})

/** a block model handed over as convertible ranges: records every conversion */
function makeSource(blocks: number) {
  const calls: Array<[number, number]> = []
  const source: PhasedDocSource = {
    length: blocks,
    slice: (from, to) => {
      calls.push([from, to])
      return Array.from({ length: to - from }, (_, i) => ({
        type: 'docParagraph',
        attrs: { docxIndex: from + i },
      }))
    },
  }
  return { source, calls }
}

describe('setContentPhased with a convertible source', () => {
  it('mounts a small source in one pass, converting it once', () => {
    const { host, state } = makeHost()
    const { source, calls } = makeSource(PHASED_MIN_BLOCKS)
    const s = makeScheduler()
    setContentPhased(host, source, s.schedule)
    expect(calls).toEqual([[0, PHASED_MIN_BLOCKS]])
    expect(state.events).toEqual([`set:${PHASED_MIN_BLOCKS}`])
    expect(s.pending()).toBe(0)
  })

  it('converts each chunk just before it mounts instead of the whole document up front', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2 + 7
    const { host, state } = makeHost()
    const { source, calls } = makeSource(blocks)
    const s = makeScheduler()
    setContentPhased(host, source, s.schedule)
    // only the first mount has been converted so far
    expect(calls).toEqual([[0, PHASE1_BLOCKS]])
    while (s.pending() > 0) s.drain()
    expect(calls).toEqual([
      [0, PHASE1_BLOCKS],
      [PHASE1_BLOCKS, PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS],
      [PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS, PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2],
      [PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2, blocks],
    ])
    expect(state.mounted.length).toBe(blocks)
    expect(state.mounted.map((n) => n.attrs?.docxIndex)).toEqual(
      Array.from({ length: blocks }, (_, i) => i),
    )
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })

  it('remounts the whole document from the source when a chunk is refused', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2
    const { host, state } = makeHost()
    const { source, calls } = makeSource(blocks)
    const { appendNodes, setContent } = host
    let appends = 0
    host.appendNodes = (nodes) => {
      if (++appends === 2) throw new Error('schema refused')
      appendNodes(nodes)
    }
    host.setContent = (d) => {
      setContent(d)
      state.dirty = true
    }
    const s = makeScheduler()
    setContentPhased(host, source, s.schedule)
    state.dirty = false
    while (s.pending() > 0) s.drain()
    expect(calls.at(-1)).toEqual([0, blocks])
    expect(state.mounted.length).toBe(blocks)
    expect(state.dirty).toBe(false)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBeUndefined()
  })
})
