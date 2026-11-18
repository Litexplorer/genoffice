import { describe, expect, it } from 'vitest'
import { landingIsBodyText } from '../src/renderer/editor/page-gap-nav'

/** the slice of ProseMirror's ResolvedPos the guard reads */
const docWith = (isTextblock: boolean) => ({
  resolve: () => ({ parent: { isTextblock } }),
})

describe('landingIsBodyText', () => {
  it('accepts a position inside a textblock', () => {
    expect(landingIsBodyText(docWith(true), 10)).toBe(true)
  })

  it('rejects a position on a leaf widget (page break, protected run)', () => {
    expect(landingIsBodyText(docWith(false), 10)).toBe(false)
  })

  it('rejects a position the document cannot resolve', () => {
    const broken = {
      resolve: () => {
        throw new RangeError('Position out of range')
      },
    }
    expect(landingIsBodyText(broken, 1e9)).toBe(false)
  })
})
