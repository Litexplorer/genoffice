import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { epubPathOf, epubResourceUrl, type EpubOpenResult, type EpubTocNode } from '../shared/ipc'
import {
  loadPrefs,
  loadProgress,
  nextFontSize,
  savePrefs,
  saveProgress,
  splitFragment,
  type ReaderPrefs,
  type ReaderTheme,
} from './reader-state'

const LABELS = {
  en: {
    contents: 'Contents',
    previous: 'Previous chapter',
    next: 'Next chapter',
    fontDown: 'Smaller text',
    fontUp: 'Larger text',
    theme: 'Theme',
    light: 'Light',
    sepia: 'Sepia',
    dark: 'Dark',
    loading: 'Opening book…',
    empty: 'No book is open.',
    image: 'Image',
    close: 'Close',
  },
  zh: {
    contents: '目录',
    previous: '上一章',
    next: '下一章',
    fontDown: '缩小字号',
    fontUp: '放大字号',
    theme: '主题',
    light: '明亮',
    sepia: '护眼',
    dark: '深色',
    loading: '正在打开…',
    empty: '没有打开的书。',
    image: '图片',
    close: '关闭',
  },
} as const

const labels = navigator.language.toLowerCase().startsWith('zh') ? LABELS.zh : LABELS.en

interface BridgeMessage {
  type?: string
  ratio?: number
  href?: string
  src?: string
  key?: string
  edge?: 'start' | 'end'
}

function TocList(props: {
  nodes: EpubTocNode[]
  active: number
  onPick: (chapter: number, fragment: string) => void
  depth?: number
}) {
  return (
    <ul className={`toc-list${props.depth ? ' toc-nested' : ''}`}>
      {props.nodes.map((node, i) => (
        <li key={`${node.label}-${i}`}>
          <button
            type="button"
            className={node.chapter === props.active ? 'toc-row is-active' : 'toc-row'}
            disabled={node.chapter < 0}
            title={node.label}
            onClick={() => props.onPick(node.chapter, node.fragment)}
          >
            {node.label}
          </button>
          {node.children.length > 0 ? (
            <TocList
              nodes={node.children}
              active={props.active}
              onPick={props.onPick}
              depth={(props.depth ?? 0) + 1}
            />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

export default function App() {
  const [book, setBook] = useState<EpubOpenResult | null>(null)
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [fragment, setFragment] = useState('')
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs(localStorage))
  const [tocOpen, setTocOpen] = useState(true)
  const [image, setImage] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  /** scroll offset to restore once the next chapter document loads */
  const pendingRatio = useRef<number | null>(null)
  const bookRef = useRef<EpubOpenResult | null>(null)
  const indexRef = useRef(0)
  /** guards against one wheel gesture flipping several chapters */
  const lastEdgeAt = useRef(0)

  bookRef.current = book
  indexRef.current = index

  useEffect(() => {
    window.epub
      .consumePending()
      .then((result) => {
        if (!result) {
          setError(labels.empty)
          return
        }
        setBook(result)
        const saved = loadProgress(localStorage, result.path)
        if (saved && saved.chapter < result.chapters.length) {
          setIndex(saved.chapter)
          pendingRatio.current = saved.ratio
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(
    () =>
      window.epub.onFileRenamed((oldPath, newPath) => {
        const current = bookRef.current
        if (!current || current.path !== oldPath) return
        const saved = loadProgress(localStorage, oldPath)
        if (saved) saveProgress(localStorage, newPath, saved)
        setBook({ ...current, path: newPath })
      }),
    [],
  )

  const goChapter = useCallback((target: number, nextFragment = '') => {
    const current = bookRef.current
    if (!current || target < 0 || target >= current.chapters.length) return
    setFragment(nextFragment)
    setIndex(target)
    saveProgress(localStorage, current.path, { chapter: target, ratio: 0 })
  }, [])

  const src = useMemo(() => {
    if (!book) return ''
    const chapter = book.chapters[index]
    if (!chapter) return ''
    return epubResourceUrl(book.bookId, chapter.href, fragment || undefined)
  }, [book, index, fragment])

  const applyToFrame = useCallback(() => {
    const frame = frameRef.current?.contentWindow
    if (!frame) return
    frame.postMessage({ type: 'epub-apply', fontSize: prefs.fontSize, theme: prefs.theme }, '*')
    if (pendingRatio.current !== null) {
      frame.postMessage({ type: 'epub-scroll', ratio: pendingRatio.current }, '*')
      pendingRatio.current = null
    }
  }, [prefs])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as BridgeMessage | null
      if (!data || typeof data.type !== 'string') return
      const current = bookRef.current
      if (!current) return

      if (data.type === 'epub-progress') {
        saveProgress(localStorage, current.path, {
          chapter: indexRef.current,
          ratio: typeof data.ratio === 'number' ? data.ratio : 0,
        })
        return
      }
      if (data.type === 'epub-image') {
        if (data.src) setImage(data.src)
        return
      }
      if (data.type === 'epub-edge') {
        const now = Date.now()
        if (now - lastEdgeAt.current < 900) return
        lastEdgeAt.current = now
        if (data.edge === 'end') goChapter(indexRef.current + 1)
        else if (data.edge === 'start') goChapter(indexRef.current - 1)
        return
      }
      if (data.type === 'epub-key') {
        if (data.key === 'prev') goChapter(indexRef.current - 1)
        if (data.key === 'next') goChapter(indexRef.current + 1)
        return
      }
      if (data.type === 'epub-link' && data.href) {
        const parsed = epubPathOf(data.href)
        if (!parsed) return
        const target = current.chapters.findIndex((chapter) => chapter.href === parsed.href)
        if (target === -1) return
        goChapter(target, decodeURIComponent(splitFragment(data.href).fragment))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [goChapter])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') goChapter(index - 1)
      else if (event.key === 'ArrowRight') goChapter(index + 1)
      else if (event.key === 'Escape') setImage(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goChapter, index])

  const changeFont = (direction: 1 | -1) => {
    const next = { ...prefs, fontSize: nextFontSize(prefs.fontSize, direction) }
    setPrefs(next)
    savePrefs(localStorage, next)
  }

  const changeTheme = (theme: ReaderTheme) => {
    const next = { ...prefs, theme }
    setPrefs(next)
    savePrefs(localStorage, next)
  }

  if (error) return <div className="reader-message">{error}</div>
  if (!book) return <div className="reader-message">{labels.loading}</div>

  const chapter = book.chapters[index]

  return (
    <div className="reader" data-theme={prefs.theme}>
      <header className="reader-bar">
        <button
          type="button"
          className="icon-button"
          aria-label={labels.contents}
          title={labels.contents}
          onClick={() => setTocOpen((open) => !open)}
        >
          ☰
        </button>
        <div className="reader-title">
          <span className="reader-book">{book.title}</span>
          {book.author ? <span className="reader-author">{book.author}</span> : null}
        </div>
        <div className="reader-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={labels.fontDown}
            title={labels.fontDown}
            onClick={() => changeFont(-1)}
          >
            A-
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={labels.fontUp}
            title={labels.fontUp}
            onClick={() => changeFont(1)}
          >
            A+
          </button>
          <select
            className="theme-select"
            aria-label={labels.theme}
            value={prefs.theme}
            onChange={(event) => changeTheme(event.currentTarget.value as ReaderTheme)}
          >
            <option value="light">{labels.light}</option>
            <option value="sepia">{labels.sepia}</option>
            <option value="dark">{labels.dark}</option>
          </select>
        </div>
      </header>

      <div className="reader-body">
        {tocOpen ? (
          <aside className="reader-toc">
            <div className="toc-heading">{labels.contents}</div>
            <TocList
              nodes={book.toc}
              active={index}
              onPick={(target, nextFragment) => goChapter(target, nextFragment)}
            />
          </aside>
        ) : null}

        <main className="reader-main">
          <iframe
            ref={frameRef}
            className="reader-frame"
            title={chapter?.label ?? book.title}
            src={src}
            onLoad={applyToFrame}
          />
          <footer className="reader-foot">
            <button
              type="button"
              className="icon-button"
              aria-label={labels.previous}
              title={labels.previous}
              disabled={index <= 0}
              onClick={() => goChapter(index - 1)}
            >
              ‹
            </button>
            <span className="reader-progress">
              {chapter?.label ?? ''} · {index + 1}/{book.chapters.length}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={labels.next}
              title={labels.next}
              disabled={index >= book.chapters.length - 1}
              onClick={() => goChapter(index + 1)}
            >
              ›
            </button>
          </footer>
        </main>
      </div>

      {image ? (
        <div
          className="image-overlay"
          role="dialog"
          aria-label={labels.image}
          onClick={() => setImage(null)}
        >
          <img src={image} alt={labels.image} />
          <button
            type="button"
            className="icon-button overlay-close"
            aria-label={labels.close}
            onClick={() => setImage(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  )
}
