import { describe, expect, it, vi } from 'vitest'

/**
 * Electron clears `view.webContents` before it emits the webContents
 * 'destroyed' event, so the teardown has to run off the id captured when the
 * view was built. Re-reading the property inside the handler threw a
 * TypeError, which surfaced as an "uncaught exception in the main process"
 * dialog on every epub tab close and left the parsed book pinned in memory.
 */
const harness = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  ipcHandlers: new Map<string, (event: unknown) => unknown>(),
}))

vi.mock('electron', () => {
  class WebContentsView {
    webContents:
      | {
          id: number
          once: (event: string, listener: () => void) => void
          loadURL: (url: string) => Promise<void>
        }
      | undefined

    constructor() {
      this.webContents = {
        id: 7,
        once: (event, listener) => harness.listeners.set(event, listener),
        loadURL: () => Promise.resolve(),
      }
    }
  }

  return {
    WebContentsView,
    BrowserWindow: class {},
    app: { whenReady: () => Promise.resolve(), quit: () => undefined },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown) => unknown) => {
        harness.ipcHandlers.set(channel, handler)
      },
    },
    protocol: { handle: () => undefined },
  }
})

vi.mock('@genoffice/electron-utils', () => ({
  installRendererProtocol: () => undefined,
  registerRendererScheme: () => undefined,
  rendererUrl: () => 'app://genoffice/epub/index.html',
}))

vi.mock('../../../packages/epub/src/index', () => ({
  openEpub: () => {
    throw new Error('openEpub is not exercised by this test')
  },
}))

// A released tab never reaches the read; touching the file means the teardown
// left the pending path behind.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: () => {
      throw new Error('pending path was not released by the teardown')
    },
  }
})

describe('epub view teardown', () => {
  it('drops the tab book when the view has already lost its webContents', async () => {
    const { createEpubView } = await import('../src/main/epub-main')
    const view = createEpubView('/books/sample.epub') as unknown as {
      webContents: unknown
    }

    const destroyed = harness.listeners.get('destroyed')
    expect(destroyed).toBeTypeOf('function')
    const consumePending = [...harness.ipcHandlers.values()][0]
    expect(consumePending).toBeTypeOf('function')

    // Electron drops the reference before the event fires.
    view.webContents = undefined
    expect(() => destroyed?.()).not.toThrow()

    // The captured id still finds its book: a second consume returns null
    // because the pending path was released by the teardown.
    await expect(consumePending?.({ sender: { id: 7 } })).resolves.toBeNull()
  })
})
