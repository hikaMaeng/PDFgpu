import type { PdfDocumentSource, PdfDocumentEngine, PdfTileRenderRequest, PdfLoadProgressListener } from '../types.js';
import { type WorkerLike } from './workerPoolEngine.js';
export declare function sourceToBytes(source: PdfDocumentSource, onProgress?: PdfLoadProgressListener): Promise<Uint8Array>;
export interface PdfDocumentEngineCreateOptions {
    /**
     * Number of rasterization workers. Each worker is a dedicated Web Worker
     * with its own PDFium WASM instance and its own copy of the document, so
     * pages render in parallel and off the main thread. Memory grows with the
     * pool: every worker holds the whole file plus its PDFium heap.
     *
     * Default: `min(4, navigator.hardwareConcurrency - 1)`, at least 1.
     * Values are clamped to 1..8.
     */
    poolSize?: number;
    /**
     * Creates one worker. Defaults to the bundled `pdfiumWorkerMain` module
     * worker. Exposed so hosts with unusual bundling (or tests) can supply
     * their own; when workers cannot be created at all, the engine falls back
     * to rendering on the main thread.
     */
    createWorker?: () => WorkerLike;
}
export declare function createPdfDocumentEngine(options?: PdfDocumentEngineCreateOptions): Promise<PdfDocumentEngine>;
export declare function normalizeTileRequest(request: PdfTileRenderRequest): PdfTileRenderRequest;
