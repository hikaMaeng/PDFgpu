import type { PdfDocumentEngine } from '../types.js';
export interface PdfDocumentEngineCreateOptions {
    poolSize?: number;
}
export declare function createPdfDocumentEngine(options?: PdfDocumentEngineCreateOptions): Promise<PdfDocumentEngine>;
