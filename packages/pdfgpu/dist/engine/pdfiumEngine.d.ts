import type { PdfDocumentEngine } from '../types.js';
export interface PdfDocumentEngineCreateOptions {
    /**
     * Accepted for compatibility; currently has no effect.
     *
     * Every in-memory "worker" shared the same PDFium WASM instance on the main
     * thread, so a pool of N rendered nothing in parallel while each `open()`
     * copied the whole file into the WASM heap N times (and the viewer limits
     * in-memory concurrency to 1 anyway). The engine therefore keeps exactly one
     * document instance. Real parallel rasterization needs Web Workers, each with
     * its own PDFium instance; this option is reserved for that.
     */
    poolSize?: number;
}
export declare function createPdfDocumentEngine(_options?: PdfDocumentEngineCreateOptions): Promise<PdfDocumentEngine>;
