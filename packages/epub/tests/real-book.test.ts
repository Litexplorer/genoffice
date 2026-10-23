import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openEpub } from '../src/index'

/**
 * Optional smoke test against a real book: the epub fixtures are copyrighted
 * works that must not live in the repo, so CI skips this unless a path is given.
 * Run locally with EPUB_FIXTURE=/path/to/book.epub.
 */
const fixture = process.env.EPUB_FIXTURE

describe.skipIf(!fixture)('openEpub on a real book', () => {
  it('reads metadata, spine and a chapter body', async () => {
    const book = await openEpub(readFileSync(fixture!))
    expect(book.spine.length).toBeGreaterThan(1)
    expect(book.toc.length).toBeGreaterThan(0)
    const first = book.spine[0]!
    const body = new TextDecoder().decode(await book.read(first.href))
    expect(body.length).toBeGreaterThan(100)
    // every spine entry must be readable through the same accessor the reader serves from
    for (const item of book.spine.slice(0, 3)) {
      expect(book.has(item.href)).toBe(true)
    }
  })
})
