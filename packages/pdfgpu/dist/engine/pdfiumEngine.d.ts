import type { PdfDocumentEngine } from '../types';
export interface PdfDocumentEngineCreateOptions {
    poolSize?: number;
}
export declare function createPdfDocumentEngine(options?: PdfDocumentEngineCreateOptions): Promise<PdfDocumentEngine>;
