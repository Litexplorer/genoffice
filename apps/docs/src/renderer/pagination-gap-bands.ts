/**
 * Page-boundary bands in document coordinates.
 *
 * The status-bar page number ("locate") needs the page-gap height above the
 * viewport midpoint on every scroll event. Querying `.page-gap` across the
 * whole document and reading every gap's rect each time made scrolling cost
 * O(pages) layout reads on a long document, so the bands are collected once
 * per pagination pass and queried with a binary search afterwards.
 *
 * Coordinates are document px at zoom 1: independent of scroll position, and
 * comparable across zoom levels once divided by the live zoom factor.
 */

export interface GapBand {
  /** band top, measured from the flow element's top */
  off: number
  /** band height */
  h: number
  /** mixed-column pull-up the gap carries as a negative top margin */
  pull: number
}

export interface GapBandIndex {
  bands: GapBand[]
  /** fulls[i] = summed height of bands [0, i) */
  fulls: Float64Array
  /** pulls[i] = summed pull-up of bands [0, i) */
  pulls: Float64Array
}

/** page-turn gaps only: inline gaps and repeated header clones count, the
 *  carry spacers of a split floating table do not (they move the anchor, not
 *  the page) */
const GAP_SELECTOR = '.page-gap:not(.page-gap-carry), .page-repeat-header'

/**
 * collect the page-gap bands of the flow element
 * pm - the measured flow (.ProseMirror)
 * zoomFactor - the live canvas zoom, so the bands land in zoom-1 px
 * skip - bands that carry no page turn for this document (a repeated header
 *        inside a floating table)
 */
export function collectGapBands(
  pm: HTMLElement,
  zoomFactor: number,
  skip?: (el: HTMLElement) => boolean,
): GapBand[] {
  const origin = pm.getBoundingClientRect().top
  const bands: GapBand[] = []
  for (const el of pm.querySelectorAll<HTMLElement>(GAP_SELECTOR)) {
    if (skip?.(el)) continue
    const r = el.getBoundingClientRect()
    bands.push({
      off: (r.top - origin) / zoomFactor,
      h: r.height / zoomFactor,
      pull: Math.max(0, -parseFloat(el.style.marginTop) || 0),
    })
  }
  return bands
}

/** sum the bands once: two running totals the query can sample in O(log n) */
export function compileGapBands(bands: GapBand[]): GapBandIndex {
  const fulls = new Float64Array(bands.length)
  const pulls = new Float64Array(bands.length)
  let h = 0
  let pull = 0
  for (let i = 0; i < bands.length; i++) {
    fulls[i] = h
    pulls[i] = pull
    h += bands[i].h
    pull += bands[i].pull
  }
  return { bands, fulls, pulls }
}

/**
 * gap height and pull-up above a midpoint (zoom-1 px from the flow top)
 * index - bands compiled for the current layout
 * midDoc - the midpoint in the same coordinate space
 * returns the fully passed bands plus the part of the band the midpoint falls
 *         inside; a scroll inside one gap counts that gap partly, like the
 *         measured version did
 */
export function gapAboveAt(index: GapBandIndex, midDoc: number): { above: number; pull: number } {
  const { bands, fulls, pulls } = index
  let lo = 0
  let hi = bands.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bands[mid].off < midDoc) lo = mid + 1
    else hi = mid
  }
  const last = lo - 1
  if (last < 0) return { above: 0, pull: 0 }
  const band = bands[last]
  return {
    above: fulls[last] + Math.min(band.h, midDoc - band.off),
    pull: pulls[last] + band.pull,
  }
}
