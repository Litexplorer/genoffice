import { posix } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import JSZip from 'jszip'

/** One navigation target: a chapter (or a fragment inside one). */
export interface EpubTocEntry {
  label: string
  /** Zip-absolute chapter path, e.g. `OEBPS/text/ch01.xhtml`. */
  href: string
  children: EpubTocEntry[]
}

/** One spine item: the reading order the package declares. */
export interface EpubSpineItem {
  /** Zip-absolute path. */
  href: string
  mediaType: string
}

export interface EpubBook {
  title: string
  author: string
  language: string
  /** Directory of the OPF package; chapter hrefs inside it are relative. */
  rootDir: string
  spine: EpubSpineItem[]
  toc: EpubTocEntry[]
  has: (innerPath: string) => boolean
  read: (innerPath: string) => Promise<Uint8Array>
  contentType: (innerPath: string) => string
}

const EXT_MEDIA_TYPE: Record<string, string> = {
  xhtml: 'application/xhtml+xml',
  html: 'application/xhtml+xml',
  htm: 'application/xhtml+xml',
  css: 'text/css',
  js: 'text/javascript',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ncx: 'application/x-dtbncx+xml',
  xml: 'application/xml',
  txt: 'text/plain',
  json: 'application/json',
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
})

type XmlNode = Record<string, unknown>

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** Attribute value of a node, or '' when the node is a leaf or lacks the attribute. */
function attr(node: unknown, name: string): string {
  if (!node || typeof node !== 'object') return ''
  const value = (node as XmlNode)[`@_${name}`]
  return value === undefined || value === null ? '' : String(value)
}

/** First value for `key`, whether the element is a leaf (string) or a subtree. */
function first(node: unknown, key: string): unknown {
  if (!node || typeof node !== 'object') return undefined
  const value = (node as XmlNode)[key]
  if (value === undefined || value === null) return undefined
  return Array.isArray(value) ? value[0] : value
}

function child(node: unknown, key: string): XmlNode | undefined {
  if (!node || typeof node !== 'object') return undefined
  const value = (node as XmlNode)[key]
  if (!Array.isArray(value))
    return typeof value === 'object' && value !== null ? (value as XmlNode) : undefined
  for (const item of value) {
    if (item && typeof item === 'object') return item as XmlNode
  }
  return undefined
}

function children(node: unknown, key: string): XmlNode[] {
  if (!node || typeof node !== 'object') return []
  return asArray((node as XmlNode)[key] as XmlNode | XmlNode[] | undefined).filter(
    (item): item is XmlNode => Boolean(item) && typeof item === 'object',
  )
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node.trim()
  if (typeof node === 'number') return String(node)
  if (node && typeof node === 'object') {
    const text = (node as XmlNode)['#text']
    if (typeof text === 'string') return text.trim()
    if (typeof text === 'number') return String(text)
  }
  return ''
}

/** Zip entry names are URL-ish in OPF hrefs: `%20` for spaces, `#frag` for anchors. */
function normalizeEntryPath(path: string): string {
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // keep the raw form when the href has a stray `%`
  }
  const withoutFragment = decoded.split('#')[0] ?? ''
  return posix.normalize(withoutFragment).replace(/^\/+/, '')
}

function resolveFrom(baseDir: string, href: string): string {
  const withoutScheme = href.replace(/^[a-z][a-z0-9+.-]*:/i, '')
  return normalizeEntryPath(posix.join(baseDir, withoutScheme))
}

function mediaTypeFor(entryPath: string): string {
  const ext = entryPath.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MEDIA_TYPE[ext] ?? 'application/octet-stream'
}

function parseContainer(zip: JSZip): string {
  const file = zip.file('META-INF/container.xml')
  if (!file) throw new Error('not an EPUB: META-INF/container.xml is missing')
  return 'META-INF/container.xml'
}

interface Manifest {
  rootDir: string
  title: string
  author: string
  language: string
  spine: EpubSpineItem[]
  mediaTypeByPath: Map<string, string>
  navPath: string | undefined
  ncxPath: string | undefined
}

function parsePackage(opfPath: string, xml: string): Manifest {
  const doc = parser.parse(xml) as XmlNode
  const pkg = child(doc, 'package')
  if (!pkg) throw new Error('not an EPUB: package document is malformed')

  const rootDir = posix.dirname(opfPath) === '.' ? '' : posix.dirname(opfPath)
  const metadata = child(pkg, 'metadata')

  const mediaTypeByPath = new Map<string, string>()
  const hrefById = new Map<string, string>()
  const manifestNode = child(pkg, 'manifest')
  let navPath: string | undefined
  for (const item of children(manifestNode, 'item')) {
    const id = String(item['@_id'] ?? '')
    const href = String(item['@_href'] ?? '')
    if (!id || !href) continue
    const resolved = resolveFrom(rootDir, href)
    hrefById.set(id, resolved)
    const mediaType = String(item['@_media-type'] ?? '')
    mediaTypeByPath.set(resolved, mediaType || mediaTypeFor(resolved))
    // EPUB3 declares the nav document in the manifest; EPUB2 declares the NCX in spine@toc
    const properties = String(item['@_properties'] ?? '')
    if (properties.split(/\s+/).includes('nav')) navPath = resolved
  }

  const spineNode = child(pkg, 'spine')
  const spine: EpubSpineItem[] = []
  for (const itemref of children(spineNode, 'itemref')) {
    const idref = String(itemref['@_idref'] ?? '')
    const href = hrefById.get(idref)
    if (!href) continue
    spine.push({ href, mediaType: mediaTypeByPath.get(href) ?? mediaTypeFor(href) })
  }

  const ncxHref = String(spineNode?.['@_toc'] ?? '')
  const ncxPath = ncxHref ? (hrefById.get(ncxHref) ?? resolveFrom(rootDir, ncxHref)) : undefined

  return {
    rootDir,
    title: textOf(first(metadata, 'title')),
    author: textOf(first(metadata, 'creator')),
    language: textOf(first(metadata, 'language')),
    spine,
    mediaTypeByPath,
    navPath,
    ncxPath,
  }
}

function parseNavToc(navPath: string, xml: string): EpubTocEntry[] {
  const doc = parser.parse(xml) as XmlNode
  const html = child(doc, 'html') ?? doc
  const body = child(html, 'body') ?? html
  const navs = children(body, 'nav')
  const tocNav =
    navs.find((nav) =>
      String(nav['@_type'] ?? '')
        .split(/\s+/)
        .includes('toc'),
    ) ?? navs[0]
  const list = child(tocNav, 'ol') ?? child(body, 'ol')
  return list ? entriesFromList(list, posix.dirname(navPath)) : []
}

function entriesFromList(list: XmlNode, baseDir: string): EpubTocEntry[] {
  const entries: EpubTocEntry[] = []
  for (const item of children(list, 'li')) {
    const anchor = first(item, 'a')
    const href = attr(anchor, 'href')
    const label = textOf(anchor) || textOf(child(item, 'span'))
    const nested = child(item, 'ol')
    if (href) {
      entries.push({
        label: label || normalizeEntryPath(href),
        href: resolveFrom(baseDir, href),
        children: nested ? entriesFromList(nested, baseDir) : [],
      })
    } else if (nested) {
      entries.push(...entriesFromList(nested, baseDir))
    }
  }
  return entries
}

function parseNcxToc(ncxPath: string, xml: string): EpubTocEntry[] {
  const doc = parser.parse(xml) as XmlNode
  const navMap = child(doc, 'ncx') ? child(child(doc, 'ncx'), 'navMap') : child(doc, 'navMap')
  if (!navMap) return []
  return pointsFromNavMap(navMap, posix.dirname(ncxPath))
}

function pointsFromNavMap(navMap: XmlNode, baseDir: string): EpubTocEntry[] {
  const entries: EpubTocEntry[] = []
  for (const point of children(navMap, 'navPoint')) {
    const label = textOf(first(child(point, 'navLabel'), 'text'))
    const href = attr(child(point, 'content'), 'src')
    if (!href) continue
    entries.push({
      label: label || normalizeEntryPath(href),
      href: resolveFrom(baseDir, href),
      children: pointsFromNavMap(point, baseDir),
    })
  }
  return entries
}

/**
 * openEpub
 * 参数：bytes EPUB 文件的完整字节
 * 核心流程：读 container.xml 定位 OPF → 解析 metadata / manifest / spine →
 *           按 nav.xhtml（EPUB3）或 toc.ncx（EPUB2）建目录 → 返回包内只读访问器
 */
export async function openEpub(bytes: Uint8Array): Promise<EpubBook> {
  const zip = await JSZip.loadAsync(bytes)
  const containerPath = parseContainer(zip)
  const containerXml = await zip.file(containerPath)!.async('string')
  const rootfile = asArray(child(parser.parse(containerXml) as XmlNode, 'container'))
    .map((node) => child(node, 'rootfiles'))
    .map((node) => child(node, 'rootfile'))
    .find((node) => Boolean(node?.['@_full-path']))
  const opfPath = String(rootfile?.['@_full-path'] ?? '')
  if (!opfPath) throw new Error('not an EPUB: container.xml declares no rootfile')

  const opfFile = zip.file(opfPath)
  if (!opfFile) throw new Error(`not an EPUB: package document ${opfPath} is missing`)
  const manifest = parsePackage(opfPath, await opfFile.async('string'))

  let toc: EpubTocEntry[] = []
  for (const candidate of [manifest.navPath, manifest.ncxPath]) {
    if (!candidate) continue
    const file = zip.file(candidate)
    if (!file) continue
    const xml = await file.async('string')
    toc = candidate === manifest.ncxPath ? parseNcxToc(candidate, xml) : parseNavToc(candidate, xml)
    if (toc.length > 0) break
  }
  if (toc.length === 0) {
    toc = manifest.spine.map((item) => ({
      label: normalizeEntryPath(item.href),
      href: item.href,
      children: [],
    }))
  }

  return {
    title: manifest.title,
    author: manifest.author,
    language: manifest.language,
    rootDir: manifest.rootDir,
    spine: manifest.spine,
    toc,
    has: (innerPath) => Boolean(zip.file(innerPath)),
    read: async (innerPath) => {
      const file = zip.file(innerPath)
      if (!file) throw new Error(`EPUB resource not found: ${innerPath}`)
      return file.async('uint8array')
    },
    contentType: (innerPath) => manifest.mediaTypeByPath.get(innerPath) ?? mediaTypeFor(innerPath),
  }
}
