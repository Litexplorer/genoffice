import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  // @genoffice/electron-utils ships as TS source — must be bundled
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/electron-utils'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@genoffice/electron-utils'] })],
  },
  renderer: {
    plugins: [react()],
    server: {
      port: Number(process.env.EPUB_DEV_PORT) || 5179,
      strictPort: Boolean(process.env.EPUB_DEV_PORT),
    },
  },
})
