import { net, protocol } from 'electron'
import type { CustomScheme } from 'electron'
import { pathToFileURL } from 'node:url'
import {
  DOCX_MEDIA_SCHEME_PRIVILEGE,
  RENDERER_SCHEME,
  RENDERER_SCHEME_PRIVILEGE,
  resolveRendererFile,
} from './renderer-scheme'

let schemesRegistered = false

/**
 * 参数：schemes（要注册为 privileged 的自定义协议）
 * 核心流程：进程内只允许注册一次；Electron 的第二次调用会丢弃第一次的清单，
 * 而不是与之合并，重复注册会让渲染进程静默退化成非安全上下文
 */
export function registerPrivilegedSchemesOnce(schemes: CustomScheme[]): void {
  if (schemesRegistered) {
    throw new Error(
      'protocol.registerSchemesAsPrivileged was called twice: Electron replaces the first ' +
        'scheme list, so the earlier privileges (secure, standard, fetch) are lost',
    )
  }
  schemesRegistered = true
  protocol.registerSchemesAsPrivileged(schemes)
}

/** Before app ready. `extraSchemes` lets a host register its own schemes in the
 * same call instead of a second one, which would discard these privileges. */
export function registerRendererScheme(extraSchemes: CustomScheme[] = []): void {
  registerPrivilegedSchemesOnce([
    RENDERER_SCHEME_PRIVILEGE,
    DOCX_MEDIA_SCHEME_PRIVILEGE,
    ...extraSchemes,
  ])
}

/** After app ready: serve each module's built renderer directory. */
export function installRendererProtocol(roots: Record<string, string>): void {
  const table = new Map(Object.entries(roots))
  protocol.handle(RENDERER_SCHEME, (request) => {
    const file = resolveRendererFile(table, request.url)
    if (!file) return new Response(null, { status: 404 })
    return net
      .fetch(pathToFileURL(file).toString())
      .catch(() => new Response(null, { status: 404 }))
  })
}
