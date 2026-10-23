import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { openEpub } from '../src/index'

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>A Small Book</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="text/ch1.xhtml">First</a></li>
        <li><a href="text/ch2.xhtml">Second</a>
          <ol><li><a href="text/ch2.xhtml#deep">Second, deeper</a></li></ol>
        </li>
      </ol>
    </nav>
  </body>
</html>`

async function buildEpub(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', CONTAINER)
  zip.file('OEBPS/content.opf', OPF)
  zip.file('OEBPS/nav.xhtml', NAV)
  zip.file('OEBPS/text/ch1.xhtml', '<html><body><h1>One</h1></body></html>')
  zip.file('OEBPS/text/ch2.xhtml', '<html><body><h1>Two</h1></body></html>')
  zip.file('OEBPS/styles/book.css', 'body { color: #111 }')
  return zip.generateAsync({ type: 'uint8array' })
}

describe('openEpub', () => {
  it('reads metadata, spine order and nested TOC from an EPUB3 package', async () => {
    const book = await openEpub(await buildEpub())
    expect(book.title).toBe('A Small Book')
    expect(book.author).toBe('Ada Lovelace')
    expect(book.language).toBe('en')
    expect(book.rootDir).toBe('OEBPS')
    expect(book.spine.map((item) => item.href)).toEqual([
      'OEBPS/text/ch1.xhtml',
      'OEBPS/text/ch2.xhtml',
    ])
    expect(book.toc.map((entry) => entry.label)).toEqual(['First', 'Second'])
    expect(book.toc[1]?.children.map((entry) => entry.label)).toEqual(['Second, deeper'])
  })

  it('serves inner resources by zip path with the manifest media type', async () => {
    const book = await openEpub(await buildEpub())
    expect(book.has('OEBPS/styles/book.css')).toBe(true)
    expect(book.has('OEBPS/styles/missing.css')).toBe(false)
    expect(book.contentType('OEBPS/styles/book.css')).toBe('text/css')
    expect(book.contentType('OEBPS/text/ch1.xhtml')).toBe('application/xhtml+xml')
    const css = await book.read('OEBPS/styles/book.css')
    expect(new TextDecoder().decode(css)).toContain('color: #111')
  })

  it('reads EPUB2 NCX labels, which parse as leaf text nodes', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/epub+zip')
    zip.file('META-INF/container.xml', CONTAINER.replace('OEBPS/content.opf', 'content.opf'))
    zip.file(
      'content.opf',
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>NCX Book</dc:title>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="text/c1.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`,
    )
    zip.file(
      'toc.ncx',
      `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>序言</text></navLabel>
      <content src="text/c1.html"/>
    </navPoint>
  </navMap>
</ncx>`,
    )
    zip.file('text/c1.html', '<html><body><p>hi</p></body></html>')

    const book = await openEpub(await zip.generateAsync({ type: 'uint8array' }))
    expect(book.toc.map((entry) => entry.label)).toEqual(['序言'])
    expect(book.toc[0]?.href).toBe('text/c1.html')
  })

  it('rejects a zip that is not an EPUB', async () => {
    const zip = new JSZip()
    zip.file('hello.txt', 'not a book')
    await expect(openEpub(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      /container\.xml/,
    )
  })
})
