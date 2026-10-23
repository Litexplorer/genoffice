/// <reference types="vite/client" />
import type { EpubApi } from '../shared/ipc'

declare global {
  interface Window {
    epub: EpubApi
  }
}

export {}
