/**
 * Offscreen top-level blocks are skipped by the renderer (step 4.1 of the large
 * document work). Two properties must hold or pagination and print go wrong:
 * every measuring state disables the skip, and a kill switch exists for a
 * document whose layout disagrees.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/renderer/styles.css'), 'utf8')

/** the block-skip rule, comments stripped */
const rule = (() => {
  const at = css.indexOf('content-visibility: auto')
  if (at < 0) return ''
  const start = css.lastIndexOf('html:', at)
  const end = css.indexOf('}', at)
  return css.slice(start, end + 1).replace(/\/\*[\s\S]*?\*\//g, '')
})()

describe('offscreen block skipping', () => {
  it('skips offscreen top-level blocks with a remembered size', () => {
    expect(rule).toContain('content-visibility: auto')
    expect(rule).toContain('contain-intrinsic-size: auto')
    expect(rule).toContain('.editor-scroll')
    expect(rule).toContain('.doc-page')
  })

  it('is off in every measuring state', () => {
    expect(rule).toContain(':not(.measuring-natural)')
    expect(rule).toContain(':not(.measuring-columns)')
  })

  it('has a kill switch that needs no rebuild', () => {
    expect(rule).toContain("html:not([data-doc-cv='off'])")
  })
})
