/// <reference lib="webworker" />
// Dedicated worker entry: one PDFium WASM instance and one open document per
// worker. Created by `createPdfDocumentEngine` through `new Worker(new URL(...))`.
import { ensurePdfium, PdfiumDocument } from './pdfiumCore.js';
import type { WorkerRequest, WorkerResponse } from './workerProtocol.js';

type Scope = {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

const scope = globalThis as unknown as Scope;

let document: PdfiumDocument | null = null;
/**
 * Ids of requests received but not yet started.
 * - key: request id; scope: this worker; lifetime: from arrival until the
 *   request is dequeued by `handle`, which deletes it.
 * - bound: the number of requests queued on this worker.
 */
const queued = new Set<number>();
/**
 * Ids of queued requests the main thread has cancelled. Only ids still in
 * `queued` are added, so a cancel that races a finished request leaves
 * nothing behind. Cleared per id by `handle`. Bound: `queued.size`.
 */
const cancelled = new Set<number>();
/** Serializes rendering: PDFium state is shared by every request here. */
let chain: Promise<void> = Promise.resolve();

function reply(message: WorkerResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function fail(id: number, error: unknown) {
  const name = error instanceof DOMException || error instanceof Error ? error.name : undefined;
  const text = error instanceof Error ? error.message : String(error);
  reply({ id, ok: false, error: text, name });
}

async function handle(request: Exclude<WorkerRequest, { type: 'cancel' }>) {
  queued.delete(request.id);
  if (cancelled.delete(request.id)) {
    reply({ id: request.id, ok: false, error: 'render aborted', name: 'AbortError' });
    return;
  }
  try {
    switch (request.type) {
      case 'init': {
        const pdfium = await ensurePdfium();
        document = new PdfiumDocument(pdfium);
        reply({ id: request.id, ok: true });
        return;
      }
      case 'open': {
        if (!document) throw new Error('worker not initialized');
        const manifest = await document.open(new Uint8Array(request.bytes), request.manifest);
        reply({ id: request.id, ok: true, manifest });
        return;
      }
      case 'preview': {
        if (!document) throw new Error('worker not initialized');
        const raster = await document.renderPreview({ pageIndex: request.pageIndex, dpi: request.dpi });
        const source = raster.source as ImageBitmap;
        reply({ id: request.id, ok: true, raster: { ...raster, source } }, [source]);
        return;
      }
      case 'tile': {
        if (!document) throw new Error('worker not initialized');
        const raster = await document.renderTile({
          pageIndex: request.pageIndex,
          dpi: request.dpi,
          tileX: request.tileX,
          tileY: request.tileY,
          tileWidth: request.tileWidth,
          tileHeight: request.tileHeight
        });
        const source = raster.source as ImageBitmap;
        reply({ id: request.id, ok: true, raster: { ...raster, source } }, [source]);
        return;
      }
      case 'close': {
        await document?.dispose();
        reply({ id: request.id, ok: true });
        return;
      }
    }
  } catch (error) {
    fail(request.id, error);
  }
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    if (queued.has(request.target)) cancelled.add(request.target);
    return;
  }
  queued.add(request.id);
  chain = chain.then(() => handle(request));
});
