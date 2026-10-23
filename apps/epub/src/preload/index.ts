import { contextBridge, ipcRenderer } from 'electron'
import { EPUB_CHANNELS, type EpubApi } from '../shared/ipc'

const api: EpubApi = {
  consumePending: () => ipcRenderer.invoke(EPUB_CHANNELS.consumePending),
  onFileRenamed: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, oldPath: string, newPath: string) =>
      handler(oldPath, newPath)
    ipcRenderer.on(EPUB_CHANNELS.fileRenamed, listener)
    return () => ipcRenderer.removeListener(EPUB_CHANNELS.fileRenamed, listener)
  },
}

contextBridge.exposeInMainWorld('epub', api)
