import { describe, expect, it } from 'vitest'
import {
  collectGapBands,
  compileGapBands,
  gapAboveAt,
  type GapBand,
} from '../src/renderer/pagination-gap-bands'

const rect = (top: number, height: number): DOMRect =>
  ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect

function withRect(el: HTMLElement, top: number, height: number): HTMLElement {
  Object.defineProperty(el, 'getBoundingClientRect', { value: () => rect(top, height) })
  return el
}

describe('gapAboveAt', () => {
  const bands: GapBand[] = [
    { off: 100, h: 40, pull: 0 },
    { off: 300, h: 60, pull: 12 },
    { off: 500, h: 20, pull: 0 },
  ]

  it('counts nothing above the first band', () => {
    expect(gapAboveAt(compileGapBands(bands), 50)).toEqual({ above: 0, pull: 0 })
    expect(gapAboveAt(compileGapBands([]), 50)).toEqual({ above: 0, pull: 0 })
  })

  it('sums the fully passed bands', () => {
    // the midpoint sits below band 2: both of the first two count whole
    expect(gapAboveAt(compileGapBands(bands), 400)).toEqual({ above: 100, pull: 12 })
  })

  it('counts a band the midpoint falls inside only partly', () => {
    expect(gapAboveAt(compileGapBands(bands), 320)).toEqual({ above: 60, pull: 12 })
  })

  it('counts a band whose top is exactly at the midpoint as not passed', () => {
    expect(gapAboveAt(compileGapBands(bands), 300)).toEqual({ above: 40, pull: 0 })
  })

  it('sums every band below the last one', () => {
    expect(gapAboveAt(compileGapBands(bands), 10_000)).toEqual({ above: 120, pull: 12 })
  })
})

describe('collectGapBands', () => {
  it('measures gaps against the flow element in zoom-1 px and keeps the pull-up', () => {
    const pm = withRect(document.createElement('div'), 1000, 0)
    const gap = withRect(document.createElement('div'), 1400, 400)
    gap.className = 'page-gap'
    gap.style.marginTop = '-20px'
    const header = withRect(document.createElement('div'), 2000, 50)
    header.className = 'page-repeat-header'
    const carry = withRect(document.createElement('div'), 3000, 90)
    carry.className = 'page-gap page-gap-carry'
    pm.append(gap, header, carry)

    const bands = collectGapBands(pm, 2)

    // the carry spacer is not a page turn: it never becomes a band
    expect(bands).toEqual([
      { off: 200, h: 200, pull: 20 },
      { off: 500, h: 25, pull: 0 },
    ])
  })

  it('drops the bands the caller skips', () => {
    const pm = withRect(document.createElement('div'), 0, 0)
    const gap = withRect(document.createElement('div'), 400, 100)
    gap.className = 'page-gap'
    const header = withRect(document.createElement('div'), 800, 100)
    header.className = 'page-repeat-header'
    pm.append(gap, header)

    const bands = collectGapBands(pm, 1, (el) => el.classList.contains('page-repeat-header'))

    expect(bands.map((b) => b.off)).toEqual([400])
  })
})
