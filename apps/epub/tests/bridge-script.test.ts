// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EPUB_BRIDGE_SCRIPT, injectBridge } from '../src/main/bridge-script'

interface Mounted {
  /** Vertical scroll offset the fake viewport is currently at. */
  y: () => number
  /** Messages the chapter sent to the reader (window.parent). */
  sent: () => Array<Record<string, unknown>>
  /** Page-turn keys only, in order — other bridge messages are ignored here. */
  keys: () => string[]
  clear: () => void
}

const VIEWPORT = 600
const cleanups: Array<() => void> = []

function bridgeCode(): string {
  return EPUB_BRIDGE_SCRIPT.replace(/^<script><!\[CDATA\[/, '').replace(/\]\]><\/script>$/, '')
}

/**
 * 参数：scrollHeight（章节内容高度）、startY（初始滚动位置）
 * 核心流程：记录注入脚本注册的监听器（用完后摘掉，避免用例间互相干扰），
 * 用可控实现替换滚动 API，再执行脚本并返回滚动位置与消息队列
 */
function mount(options: { scrollHeight: number; startY?: number }): Mounted {
  let offset = options.startY ?? 0
  const max = Math.max(0, options.scrollHeight - VIEWPORT)
  const messages: Array<Record<string, unknown>> = []
  const removers: Array<() => void> = []

  const track = (target: Window | Document): (() => void) => {
    const original = target.addEventListener.bind(target)
    target.addEventListener = ((
      type: string,
      handler: EventListenerOrEventListenerObject,
      init?: boolean | AddEventListenerOptions,
    ) => {
      original(type, handler, init)
      removers.push(() => target.removeEventListener(type, handler, init))
    }) as typeof target.addEventListener
    return () => {
      target.addEventListener = original
    }
  }

  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => offset })
  Object.defineProperty(window, 'scrollX', { configurable: true, get: () => 0 })
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    value: options.scrollHeight,
  })
  Object.defineProperty(document.documentElement, 'scrollWidth', {
    configurable: true,
    value: 800,
  })

  const clamp = (next: number) => Math.min(max, Math.max(0, next))
  window.scrollTo = ((_x: number, next: number) => {
    offset = clamp(next)
  }) as typeof window.scrollTo
  window.scrollBy = ((_x: number, next: number) => {
    offset = clamp(offset + next)
  }) as typeof window.scrollBy

  vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
    messages.push(message as Record<string, unknown>)
  }) as typeof window.postMessage)

  const restoreWindow = track(window)
  const restoreDocument = track(document)
  new Function(bridgeCode())()
  restoreWindow()
  restoreDocument()
  cleanups.push(...removers)

  messages.length = 0
  return {
    y: () => offset,
    sent: () => messages,
    keys: () => messages.filter((m) => m.type === 'epub-key').map((m) => String(m.key)),
    clear: () => {
      messages.length = 0
    },
  }
}

function key(name: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: name, cancelable: true, bubbles: true })
}

function wheel(deltaY: number): WheelEvent {
  return new WheelEvent('wheel', { deltaY, bubbles: true })
}

function nav(dir: 'next' | 'prev', unit: 'line' | 'page'): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'epub-nav', dir, unit } }))
}

function scrollTo(y: number): void {
  window.scrollTo(0, y)
  window.dispatchEvent(new Event('scroll'))
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

describe('epub bridge: vertical keys scroll before paging', () => {
  it('leaves mid-chapter scrolling to the browser and does not turn the page', () => {
    const bridge = mount({ scrollHeight: 3000, startY: 300 })
    const down = key('ArrowDown')
    window.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    expect(bridge.keys()).toEqual([])
  })

  it('pages forward only once the bottom is reached', () => {
    const bridge = mount({ scrollHeight: 3000 })
    window.dispatchEvent(key('ArrowDown'))
    expect(bridge.keys()).toEqual([])

    // 滚到底部之后，再按一次向下才翻页
    scrollTo(2400)
    bridge.clear()
    const atBottom = key('ArrowDown')
    window.dispatchEvent(atBottom)
    expect(atBottom.defaultPrevented).toBe(true)
    expect(bridge.keys()).toEqual(['next'])
  })

  it('scrolls up natively inside the chapter before paging', () => {
    const bridge = mount({ scrollHeight: 3000, startY: 600 })
    const up = key('ArrowUp')
    window.dispatchEvent(up)
    expect(up.defaultPrevented).toBe(false)
    expect(bridge.keys()).toEqual([])
  })

  it('pages backward only at the top', () => {
    const bridge = mount({ scrollHeight: 3000 })
    window.dispatchEvent(key('ArrowUp'))
    expect(bridge.keys()).toEqual(['prev'])
  })

  it('keeps PageDown inside the chapter until the boundary', () => {
    const bridge = mount({ scrollHeight: 3000 })
    window.dispatchEvent(key('PageDown'))
    expect(bridge.y()).toBe(540)
    expect(bridge.keys()).toEqual([])

    scrollTo(2400)
    bridge.clear()
    window.dispatchEvent(key('PageDown'))
    expect(bridge.keys()).toEqual(['next'])
  })

  it('pages left/right immediately when the chapter does not scroll sideways', () => {
    const bridge = mount({ scrollHeight: 3000, startY: 900 })
    window.dispatchEvent(key('ArrowRight'))
    window.dispatchEvent(key('ArrowLeft'))
    expect(bridge.keys()).toEqual(['next', 'prev'])
  })

  it('treats a chapter that fits the viewport as already at both ends', () => {
    const bridge = mount({ scrollHeight: 400 })
    window.dispatchEvent(key('ArrowDown'))
    window.dispatchEvent(key('ArrowUp'))
    expect(bridge.keys()).toEqual(['next', 'prev'])
  })
})

describe('epub bridge: wheel turns the page at the boundary only', () => {
  it('ignores the wheel while the chapter still scrolls', () => {
    const bridge = mount({ scrollHeight: 3000, startY: 300 })
    window.dispatchEvent(wheel(200))
    window.dispatchEvent(wheel(-200))
    expect(bridge.sent()).toEqual([])
  })

  it('asks for the next chapter at the bottom, once per gesture', () => {
    const bridge = mount({ scrollHeight: 3000, startY: 2400 })
    window.dispatchEvent(wheel(120))
    window.dispatchEvent(wheel(120))
    expect(bridge.sent().map((message) => message.edge)).toEqual(['end'])

    // 离开底部后重新武装，下一次触底还能翻页
    scrollTo(1200)
    scrollTo(2400)
    bridge.clear()
    window.dispatchEvent(wheel(120))
    expect(bridge.sent().map((message) => message.edge)).toEqual(['end'])
  })

  it('asks for the previous chapter at the top', () => {
    const bridge = mount({ scrollHeight: 3000 })
    window.dispatchEvent(wheel(-120))
    expect(bridge.sent().map((message) => message.edge)).toEqual(['start'])
  })
})

describe('epub bridge: navigation forwarded from the reader chrome', () => {
  it('scrolls a line at a time and only pages at the boundary', () => {
    const bridge = mount({ scrollHeight: 3000 })
    nav('next', 'line')
    expect(bridge.y()).toBe(48)
    nav('next', 'page')
    expect(bridge.y()).toBe(588)
    expect(bridge.keys()).toEqual([])

    scrollTo(2400)
    bridge.clear()
    nav('next', 'line')
    expect(bridge.keys()).toEqual(['next'])
  })

  it('pages backward when already at the top', () => {
    const bridge = mount({ scrollHeight: 3000 })
    nav('prev', 'line')
    expect(bridge.keys()).toEqual(['prev'])
  })
})

describe('injectBridge', () => {
  it('appends the script before the closing body tag', () => {
    const html = injectBridge('<html><body><p>x</p></body></html>')
    expect(html.indexOf('epub-ready')).toBeGreaterThan(-1)
    expect(html.indexOf('epub-ready')).toBeLessThan(html.indexOf('</body>'))
  })

  it('falls back to appending when there is no body tag', () => {
    const html = injectBridge('<p>x</p>')
    expect(html.startsWith('<p>x</p>')).toBe(true)
    expect(html).toContain('epub-ready')
  })
})
