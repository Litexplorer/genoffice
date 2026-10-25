import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { runSpanSpecs } from '../src/renderer/editor/protected-render'
import {
  installMetafileImages,
  metafileLazyUrl,
  whenMetafilesReady,
  withMetafileSrc,
} from '../src/renderer/editor/metafile-images'

const HASH = 'a'.repeat(64)
const lazy = (name: string): string => `genoffice-docx-media://${HASH}/word/media/${name}`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('metafileLazyUrl', () => {
  it('recognizes lazily served metafiles only', () => {
    expect(metafileLazyUrl(lazy('image7.emf'))).toBe(lazy('image7.emf'))
    expect(metafileLazyUrl(lazy('image7.WMZ'))).toBe(lazy('image7.WMZ'))
    // pictures Chromium decodes stay plain sources
    expect(metafileLazyUrl(lazy('image1.png'))).toBeNull()
    expect(metafileLazyUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(metafileLazyUrl(undefined)).toBeNull()
  })
})

describe('withMetafileSrc', () => {
  it('defers a metafile source and keeps every other source inline', () => {
    const deferred: Record<string, string> = {}
    withMetafileSrc(deferred, lazy('image7.emf'))
    expect(deferred).toEqual({ 'data-metafile-src': lazy('image7.emf') })

    const inline: Record<string, string> = {}
    withMetafileSrc(inline, lazy('image1.png'))
    expect(inline).toEqual({ src: lazy('image1.png') })
  })
})

describe('installMetafileImages', () => {
  it('rasterizes queued pictures and clears the deferred source', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const img = document.createElement('img')
    img.dataset.metafileSrc = lazy('queued-image.emf')
    root.append(img)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(64) })),
    )

    const stop = installMetafileImages(root)
    await whenMetafilesReady()

    // jsdom has no canvas: the converter declines, the picture keeps its box
    // and stops asking to be converted
    expect(img.dataset.metafileSrc).toBeUndefined()
    expect(img.dataset.metafileFailed).toBe('1')
    expect(img.getAttribute('src')).toBeNull()
    stop()
    root.remove()
  })

  it('picks up pictures the streaming tail appends later', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(64) })),
    )
    const stop = installMetafileImages(root)
    const img = document.createElement('img')
    img.dataset.metafileSrc = lazy('streamed-image.wmf')
    root.append(img)
    await whenMetafilesReady()
    expect(img.dataset.metafileSrc).toBeUndefined()
    stop()
    root.remove()
  })
})

describe('metafile pictures in the render specs', () => {
  const HASH = 'b'.repeat(64)
  const emfUrl = `genoffice-docx-media://${HASH}/word/media/image9.emf`

  it('renders an inline metafile picture with a deferred source', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: editorExtensions,
      content: {
        type: 'doc',
        content: [
          {
            type: 'docParagraph',
            attrs: { docxIndex: 0 },
            content: [
              { type: 'docInlineImage', attrs: { dataUrl: emfUrl, widthPx: 120, heightPx: 80 } },
            ],
          },
        ],
      },
    })
    const img = editor.view.dom.querySelector('img.doc-inline-img')
    expect(img?.getAttribute('data-metafile-src')).toBe(emfUrl)
    expect(img?.getAttribute('src')).toBeNull()
    // offscreen pictures load and decode only when they are needed
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.getAttribute('decoding')).toBe('async')
    editor.destroy()
  })

  it('renders a protected (non-editable) metafile run with a deferred source', () => {
    const specs = runSpanSpecs({
      text: '',
      image: { dataUrl: emfUrl, widthPx: 40, heightPx: 30, xml: '<w:drawing/>' },
    })
    const spec = specs.find((s) => Array.isArray(s) && s[0] === 'img')
    expect(spec).toBeDefined()
    // an undefined attrs object would make ProseMirror's serializer throw
    expect(spec?.[1]).toMatchObject({
      'data-metafile-src': emfUrl,
      loading: 'lazy',
      decoding: 'async',
    })
  })
})
