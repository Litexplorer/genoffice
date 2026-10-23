import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BrowserWindow, WebContentsView, app, ipcMain, protocol } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import {
  installRendererProtocol,
  registerRendererScheme,
  rendererUrl,
} from '@genoffice/electron-utils'
import { openEpub, type EpubBook, type EpubTocEntry } from '../../../../packages/epub/src/index'
import {
  EPUB_CHANNELS,
  EPUB_SCHEME,
  type EpubChapter,
  type EpubOpenResult,
  type EpubTocNode,
} from '../shared/ipc'

interface RuntimePaths {
  preloadPath: string
  rendererUrl?: string
}

let runtime: RuntimePaths = { preloadPath: '' }

export function configureEpubRuntime(paths: RuntimePaths): void {
  runtime = paths
}

/** Parsed books keyed by the id their resource URLs carry. */
const books = new Map<string, EpubBook>()
const bookIdByWc = new Map<number, string>()
/** Path opened for each tab, kept until the renderer asks for it after mount. */
const pendingPathByWc = new Map<number, string>()
let nextBookId = 1

/**
 * Script injected into every served XHTML chapter: applies the reader's font
 * size and theme, reports scroll progress, and forwards link/image clicks to
 * the shell renderer (the chapter document is cross-origin to it).
 */
// XHTML is XML: the script body must be CDATA, or `&&` and `<` inside it abort
// the XML parse and Chromium renders its own error page instead of the chapter.
const BRIDGE_SCRIPT = `<script><![CDATA[(function(){
  var send=function(m){try{parent.postMessage(m,'*')}catch(e){}};
  var style=document.createElement('style');
  document.documentElement.appendChild(style);
  function apply(o){
    document.documentElement.style.fontSize=(o.fontSize||100)+'%';
    var bg='#fff',fg='#1c1c1c';
    if(o.theme==='dark'){bg='#1b1b1b';fg='#d8d8d8'}
    else if(o.theme==='sepia'){bg='#f4ecd8';fg='#3a2f22'}
    style.textContent='html{background:'+bg+' !important;}'+
      'body{background:'+bg+' !important;color:'+fg+' !important;'+
      'padding:28px 36px !important;box-sizing:border-box;}'+
      'img{max-width:100% !important;height:auto !important;}';
  }
  window.addEventListener('message',function(e){
    var d=e.data||{};
    if(d.type==='epub-apply')apply(d);
    else if(d.type==='epub-scroll'){
      var h=Math.max(1,document.documentElement.scrollHeight-window.innerHeight);
      window.scrollTo(0,Math.round((d.ratio||0)*h));
    }
  });
  var last=0;
  window.addEventListener('scroll',function(){
    var now=Date.now();
    if(now-last<200)return;
    last=now;
    var h=Math.max(1,document.documentElement.scrollHeight-window.innerHeight);
    send({type:'epub-progress',ratio:Math.min(1,Math.max(0,window.scrollY/h))});
  },{passive:true});
  document.addEventListener('click',function(e){
    var t=e.target;
    if(!t)return;
    if(t.tagName==='IMG'){e.preventDefault();send({type:'epub-image',src:t.currentSrc||t.src});return}
    var a=t.closest?t.closest('a'):null;
    if(!a)return;
    var href=a.getAttribute('href')||'';
    if(!href)return;
    if(/^javascript:/i.test(href)){e.preventDefault();return}
    if(/^[a-z][a-z0-9+.-]*:/i.test(href)){a.target='_blank';a.rel='noopener';return}
    e.preventDefault();
    send({type:'epub-link',href:a.href});
  });
  var edgeArmed={start:true,end:true};
  function atEnd(){
    var h=document.documentElement.scrollHeight-window.innerHeight;
    return h<=0||window.scrollY>=h-4;
  }
  window.addEventListener('wheel',function(e){
    if(e.deltaY>0&&atEnd()&&edgeArmed.end){
      edgeArmed.end=false;
      send({type:'epub-edge',edge:'end'});
    } else if(e.deltaY<0&&window.scrollY<=4&&edgeArmed.start){
      edgeArmed.start=false;
      send({type:'epub-edge',edge:'start'});
    }
  },{passive:true});
  window.addEventListener('scroll',function(){
    var h=document.documentElement.scrollHeight-window.innerHeight;
    if(window.scrollY<h-40)edgeArmed.end=true;
    if(window.scrollY>40)edgeArmed.start=true;
  },{passive:true});
  window.addEventListener('keydown',function(e){
    var h=Math.max(1,document.documentElement.scrollHeight-window.innerHeight);
    if(e.key==='ArrowLeft'&&window.scrollY<=0)send({type:'epub-key',key:'prev'});
    else if(e.key==='ArrowRight'&&window.scrollY>=h-1)send({type:'epub-key',key:'next'});
  });
  send({type:'epub-ready'});
})()]]></script>`

/** XHTML is XML: append before the closing body tag, or at the end when there is none. */
function injectBridge(html: string): string {
  const close = html.lastIndexOf('</body>')
  if (close === -1) return html + BRIDGE_SCRIPT
  return `${html.slice(0, close)}${BRIDGE_SCRIPT}${html.slice(close)}`
}

function toTocNodes(entries: EpubTocEntry[], chapterByHref: Map<string, number>): EpubTocNode[] {
  return entries.map((entry) => ({
    label: entry.label,
    chapter: chapterByHref.get(entry.href.split('#')[0] ?? '') ?? -1,
    fragment: entry.href.includes('#') ? (entry.href.split('#')[1] ?? '') : '',
    children: toTocNodes(entry.children, chapterByHref),
  }))
}

/** TOC label per chapter, keyed by spine index (walked depth first). */
function tocLabels(toc: EpubTocNode[], into: Map<number, string>): void {
  for (const node of toc) {
    if (node.chapter >= 0 && !into.has(node.chapter)) into.set(node.chapter, node.label)
    tocLabels(node.children, into)
  }
}

function openResult(bookId: string, path: string, book: EpubBook): EpubOpenResult {
  const chapterByHref = new Map<string, number>()
  book.spine.forEach((item, index) => chapterByHref.set(item.href, index))
  const toc = toTocNodes(book.toc, chapterByHref)
  const labels = new Map<number, string>()
  tocLabels(toc, labels)
  // Split files (part0006_split_001.xhtml) are spine entries the TOC never
  // names, so they inherit the chapter they belong to instead of a file name.
  let inherited = ''
  const chapters: EpubChapter[] = book.spine.map((item, index) => {
    inherited = labels.get(index) ?? inherited
    return {
      href: item.href,
      label: inherited || basename(item.href).replace(/\.[^.]+$/, ''),
    }
  })
  return {
    bookId,
    path,
    title: book.title || basename(path).replace(/\.epub$/i, ''),
    author: book.author,
    language: book.language,
    chapters,
    toc,
  }
}

/** Must run before app ready, and only once per process. */
export function registerEpubSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EPUB_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ])
}

function serveBookResource(request: Request): Response | Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response(null, { status: 400 })
  }
  const book = books.get(url.hostname)
  if (!book) return new Response(null, { status: 404 })

  let href: string
  try {
    href = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return new Response(null, { status: 400 })
  }
  if (!book.has(href)) return new Response(null, { status: 404 })

  const type = book.contentType(href)
  return book.read(href).then((bytes) => {
    // Chapter documents need the bridge; everything else is served byte for byte.
    if (type.includes('html')) {
      const html = injectBridge(new TextDecoder().decode(bytes))
      return new Response(html, {
        headers: { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' },
      })
    }
    // Response only accepts ArrayBuffer-backed bodies; slice the exact view.
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    return new Response(body, {
      headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
    })
  })
}

let ipcRegistered = false

export function registerEpubIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  protocol.handle(EPUB_SCHEME, serveBookResource)
  ipcMain.handle(EPUB_CHANNELS.consumePending, consumePending)
}

/** Keep the reader's path (used for progress keys and the window title) in step with a rename. */
export function epubFileRenamed(contents: WebContents, oldPath: string, newPath: string): void {
  if (contents.isDestroyed()) return
  contents.send(EPUB_CHANNELS.fileRenamed, oldPath, newPath)
}

/** Drop the tab's book once its view goes away so the zip bytes can be collected. */
export function releaseEpubForWebContents(contents: WebContents): void {
  const id = bookIdByWc.get(contents.id)
  if (id) books.delete(id)
  bookIdByWc.delete(contents.id)
  pendingPathByWc.delete(contents.id)
}

async function consumePending(event: IpcMainInvokeEvent): Promise<EpubOpenResult | null> {
  const wcId = event.sender.id
  const path = pendingPathByWc.get(wcId)
  if (!path) return null
  pendingPathByWc.delete(wcId)

  const bookId = `b${nextBookId++}`
  const book = await openEpub(readFileSync(path))
  books.set(bookId, book)
  bookIdByWc.set(wcId, bookId)
  return openResult(bookId, path, book)
}

export function createEpubView(openPath?: string | null): WebContentsView {
  registerEpubIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (openPath) pendingPathByWc.set(view.webContents.id, openPath)
  view.webContents.once('destroyed', () => releaseEpubForWebContents(view.webContents))
  void view.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'epub'))
  return view
}

/** Standalone window mode: `npm run dev -w @genoffice/epub`, an .epub path may be passed via argv. */
export function startEpubStandalone(): void {
  registerEpubSchemes()
  registerRendererScheme()
  configureEpubRuntime({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
  })
  void app.whenReady().then(() => {
    installRendererProtocol({ epub: join(__dirname, '../renderer') })
    registerEpubIpc()
    const win = new BrowserWindow({
      width: 1100,
      height: 850,
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const argPath = process.argv.slice(1).find((arg) => /\.epub$/i.test(arg) && existsSync(arg))
    if (argPath) pendingPathByWc.set(win.webContents.id, argPath)
    void win.loadURL(rendererUrl(runtime.rendererUrl, 'epub'))
  })
  app.on('window-all-closed', () => app.quit())
}
