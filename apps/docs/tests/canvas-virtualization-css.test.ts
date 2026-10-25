/**
 * Offscreen top-level block skipping (step 4.1 of the large-document work).
 *
 * The rule ships OFF: measured on a 294-page document it cost 47 fps while
 * scrolling (13 fps against 60) because every re-entering block relays out
 * around the page-gap widgets. These assertions pin the opt-in shape and the
 * exemptions that keep pagination reading real geometry.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/renderer/styles.css'), 'utf8')

const rule =
  /html\[data-doc-cv='on'\][\s\S]*?\{[^}]*\}/.exec(css)?.[0].replace(/\/\*[\s\S]*?\*\//g, '') ?? ''

const precedingComment = (() => {
  const at = css.indexOf('content-visibility: auto')
  if (at < 0) return ''
  return css.slice(css.lastIndexOf('/*', at), at)
})()

describe('offscreen block skipping', () => {
  it('skips offscreen top-level blocks with a remembered size when opted in', () => {
    expect(rule).toContain('content-visibility: auto')
    expect(rule).toContain('contain-intrinsic-size: auto')
    expect(rule).toContain('.editor-scroll')
    expect(rule).toContain('.doc-page')
  })

  it('never applies without the opt-in attribute', () => {
    expect(rule).toContain("html[data-doc-cv='on']")
    expect(css).not.toContain('html:not([data-doc-cv=')
  })

  it('is off in every measuring state', () => {
    expect(rule).toContain(':not(.measuring-natural)')
    expect(rule).toContain(':not(.measuring-columns)')
  })

  it('records the measured regression that keeps it off by default', () => {
    expect(precedingComment).toMatch(/13 fps/)
    expect(precedingComment).toMatch(/60 fps/)
  })
})
