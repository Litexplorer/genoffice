/** Reading preferences shared by every book. */
export interface ReaderPrefs {
  fontSize: number
  theme: ReaderTheme
}

export type ReaderTheme = 'light' | 'sepia' | 'dark'

/** Where the reader left off in one book. */
export interface ReadingProgress {
  chapter: number
  /** 0..1 scroll offset inside the chapter. */
  ratio: number
}

export const FONT_STEPS = [90, 100, 110, 120, 135, 150] as const
export const MIN_FONT = FONT_STEPS[0]
export const MAX_FONT = FONT_STEPS[FONT_STEPS.length - 1]

const PREFS_KEY = 'genoffice.epub.prefs'
const PROGRESS_PREFIX = 'genoffice.epub.progress:'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

const DEFAULTS: ReaderPrefs = { fontSize: 100, theme: 'light' }

function clampFont(size: number): number {
  if (!Number.isFinite(size)) return DEFAULTS.fontSize
  return Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(size)))
}

export function loadPrefs(storage: StorageLike): ReaderPrefs {
  const raw = storage.getItem(PREFS_KEY)
  if (!raw) return { ...DEFAULTS }
  try {
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>
    const theme: ReaderTheme =
      parsed.theme === 'sepia' || parsed.theme === 'dark' ? parsed.theme : 'light'
    return { fontSize: clampFont(parsed.fontSize ?? DEFAULTS.fontSize), theme }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(storage: StorageLike, prefs: ReaderPrefs): void {
  storage.setItem(
    PREFS_KEY,
    JSON.stringify({ fontSize: clampFont(prefs.fontSize), theme: prefs.theme }),
  )
}

export function nextFontSize(current: number, direction: 1 | -1): number {
  const index = FONT_STEPS.findIndex((step) => step >= current)
  const at = index === -1 ? FONT_STEPS.length - 1 : index
  const next = Math.min(FONT_STEPS.length - 1, Math.max(0, at + direction))
  return FONT_STEPS[next] ?? DEFAULTS.fontSize
}

export function loadProgress(storage: StorageLike, bookPath: string): ReadingProgress | null {
  const raw = storage.getItem(PROGRESS_PREFIX + bookPath)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ReadingProgress>
    const chapter = Number(parsed.chapter)
    const ratio = Number(parsed.ratio)
    if (!Number.isFinite(chapter) || chapter < 0) return null
    return { chapter, ratio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0 }
  } catch {
    return null
  }
}

export function saveProgress(
  storage: StorageLike,
  bookPath: string,
  progress: ReadingProgress,
): void {
  storage.setItem(
    PROGRESS_PREFIX + bookPath,
    JSON.stringify({ chapter: progress.chapter, ratio: progress.ratio }),
  )
}

/** `href` is a zip-absolute chapter path; TOC targets may carry a `#fragment`. */
export function splitFragment(href: string): { href: string; fragment: string } {
  const hash = href.indexOf('#')
  if (hash === -1) return { href, fragment: '' }
  return { href: href.slice(0, hash), fragment: href.slice(hash + 1) }
}
