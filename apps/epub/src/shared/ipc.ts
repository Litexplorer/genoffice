/** One TOC row after the spine mapping: `chapter` indexes into the chapter list. */
export interface EpubTocNode {
  label: string
  /** -1 when the TOC target is not part of the spine (EPUB2 NCX often links notes pages). */
  chapter: number
  fragment: string
  children: EpubTocNode[]
}

export interface EpubChapter {
  /** Zip-absolute path, e.g. `OEBPS/text/ch01.xhtml`. */
  href: string
  label: string
}

export interface EpubOpenResult {
  bookId: string
  path: string
  title: string
  author: string
  language: string
  chapters: EpubChapter[]
  toc: EpubTocNode[]
}

export const EPUB_CHANNELS = {
  consumePending: 'epub:consume-pending',
  fileRenamed: 'epub:file-renamed',
} as const

/** Custom scheme that serves the book's inner files; one origin per bookId. */
export const EPUB_SCHEME = 'epub-book'

/** `epub-book://<bookId>/OEBPS/text/ch01.xhtml` — path segments are URL-encoded. */
export function epubResourceUrl(bookId: string, href: string, fragment?: string): string {
  const path = href
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${EPUB_SCHEME}://${bookId}/${path}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`
}

/** Zip-absolute path back out of an `epub-book://` URL; null for foreign URLs. */
export function epubPathOf(url: string): { bookId: string; href: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${EPUB_SCHEME}:`) return null
  let href: string
  try {
    href = parsed.pathname
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return null
  }
  return { bookId: parsed.hostname, href }
}

export interface EpubApi {
  consumePending: () => Promise<EpubOpenResult | null>
  onFileRenamed: (handler: (oldPath: string, newPath: string) => void) => () => void
}
