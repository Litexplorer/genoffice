import { describe, expect, it } from 'vitest'
import { epubPathOf, epubResourceUrl } from '../src/shared/ipc'
import {
  FONT_STEPS,
  loadPrefs,
  loadProgress,
  nextFontSize,
  savePrefs,
  saveProgress,
  splitFragment,
} from '../src/renderer/reader-state'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

describe('reader prefs', () => {
  it('defaults to 100% light and clamps a size outside the steps', () => {
    const storage = memoryStorage()
    expect(loadPrefs(storage)).toEqual({ fontSize: 100, theme: 'light' })
    savePrefs(storage, { fontSize: 999, theme: 'dark' })
    expect(loadPrefs(storage)).toEqual({
      fontSize: FONT_STEPS[FONT_STEPS.length - 1],
      theme: 'dark',
    })
    savePrefs(storage, { fontSize: 10, theme: 'sepia' })
    expect(loadPrefs(storage)).toEqual({ fontSize: FONT_STEPS[0], theme: 'sepia' })
  })

  it('walks the font steps and stops at both ends', () => {
    expect(nextFontSize(100, 1)).toBe(110)
    expect(nextFontSize(100, -1)).toBe(90)
    expect(nextFontSize(FONT_STEPS[FONT_STEPS.length - 1], 1)).toBe(
      FONT_STEPS[FONT_STEPS.length - 1],
    )
    expect(nextFontSize(FONT_STEPS[0], -1)).toBe(FONT_STEPS[0])
  })
})

describe('reading progress', () => {
  it('round-trips per book path', () => {
    const storage = memoryStorage()
    saveProgress(storage, '/books/a.epub', { chapter: 3, ratio: 0.25 })
    expect(loadProgress(storage, '/books/a.epub')).toEqual({ chapter: 3, ratio: 0.25 })
    expect(loadProgress(storage, '/books/b.epub')).toBeNull()
  })

  it('ignores corrupt records instead of throwing', () => {
    const storage = memoryStorage()
    storage.setItem('genoffice.epub.progress:/x.epub', '{not json')
    expect(loadProgress(storage, '/x.epub')).toBeNull()
    storage.setItem('genoffice.epub.progress:/y.epub', JSON.stringify({ chapter: -2 }))
    expect(loadProgress(storage, '/y.epub')).toBeNull()
  })
})

describe('chapter urls', () => {
  it('round-trips a zip path through the resource scheme', () => {
    const url = epubResourceUrl('b7', 'OEBPS/text/ch 01.xhtml', 'note-3')
    expect(url).toBe('epub-book://b7/OEBPS/text/ch%2001.xhtml#note-3')
    expect(epubPathOf(url)).toEqual({ bookId: 'b7', href: 'OEBPS/text/ch 01.xhtml' })
  })

  it('rejects foreign schemes and keeps fragments apart', () => {
    expect(epubPathOf('https://example.com/a.xhtml')).toBeNull()
    expect(splitFragment('OEBPS/ch2.xhtml#sec2')).toEqual({
      href: 'OEBPS/ch2.xhtml',
      fragment: 'sec2',
    })
    expect(splitFragment('OEBPS/ch2.xhtml')).toEqual({ href: 'OEBPS/ch2.xhtml', fragment: '' })
  })
})
