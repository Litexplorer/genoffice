import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Resolve workspace packages from this checkout's sources: in a git worktree
// node_modules is a symlink into the main checkout, so bare specifiers would
// silently bundle the other checkout's (possibly stale) code.
const localAlias = {
  // docx-engine re-exports the redaction tag constants from agent-core, which
  // ships raw TS source: left external, the packaged main process requires a
  // .ts file out of app.asar/node_modules and Node refuses to strip its types
  // (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — the window then never opens.
  '@genoffice/agent-core/redact-range': resolve(
    __dirname,
    '../../packages/agent-core/src/redact-range.ts',
  ),
  '@genoffice/docx-engine/lazy-media': resolve(
    __dirname,
    '../../packages/docx-engine/src/lazy-media.ts',
  ),
  '@genoffice/docx-engine/zip-splice': resolve(
    __dirname,
    '../../packages/docx-engine/src/zip-splice.ts',
  ),
  // the renderer rasterizes lazily served metafiles on demand
  '@genoffice/docx-engine/metafile': resolve(
    __dirname,
    '../../packages/docx-engine/src/metafile.ts',
  ),
  '@genoffice/docx-engine': resolve(__dirname, '../../packages/docx-engine/src/index.ts'),
}

export default defineConfig({
  // Main and preload use only electron + node builtins; bundle everything so
  // the packaged app doesn't rely on node_modules at runtime.
  // @genoffice/* deps ship as raw TS source with extensionless imports, so they
  // must be bundled — externalizing them yields ERR_MODULE_NOT_FOUND under Node
  // (same setup as apps/slides).
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@genoffice/docx-engine',
          '@genoffice/agent-core',
          '@genoffice/electron-utils',
          '@genoffice/font-metrics',
        ],
      }),
    ],
    resolve: { alias: localAlias },
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge must be bundled, not externalized.
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: localAlias },
    server: {
      // Overridable so multiple genoffice dev instances can coexist (default 5173).
      port: Number(process.env.DOCS_DEV_PORT) || 5173,
      strictPort: Boolean(process.env.DOCS_DEV_PORT),
    },
  },
})
