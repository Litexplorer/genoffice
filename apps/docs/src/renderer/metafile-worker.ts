import { metafileToDataUrl } from '@genoffice/docx-engine/metafile'

/**
 * Metafile rasterization off the UI thread.
 *
 * The vendored EMF/WMF converter draws into a canvas and encodes a PNG; a
 * picture can be 18 MB of metafile records, and on the renderer thread the
 * encode step was seen to never settle, wedging the on-demand queue. The parse
 * worker already rasterized these before they were served lazily, so the same
 * conversion runs here and only the finished data URL travels back.
 */

export interface MetafileWorkerRequest {
  id: number
  bytes: ArrayBuffer
  mime: string
  maxSidePx: number
}

export type MetafileWorkerResponse = { id: number; url: string | null }

self.onmessage = async (e: MessageEvent<MetafileWorkerRequest>) => {
  const { id, bytes, mime, maxSidePx } = e.data
  let url: string | null = null
  try {
    url = await metafileToDataUrl(new Uint8Array(bytes), mime, { maxSidePx })
  } catch {
    url = null
  }
  ;(self as unknown as { postMessage: (v: MetafileWorkerResponse) => void }).postMessage({
    id,
    url,
  })
}
