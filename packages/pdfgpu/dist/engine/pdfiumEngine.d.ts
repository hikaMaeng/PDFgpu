import type { PdfDocumentEngine } from '../types';
export declare function normalizeDetailDpi(rawDpi: number): number;
export interface PdfDocumentEngineCreateOptions {
    poolSize?: number;
}
export declare function createPdfDocumentEngine(options?: PdfDocumentEngineCreateOptions): Promise<PdfDocumentEngine>;
