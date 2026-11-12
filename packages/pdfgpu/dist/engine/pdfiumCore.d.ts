import type { PdfDocumentManifest, PdfPreviewRenderRequest, PdfRasterResult, PdfTileRenderRequest } from '../types.js';
export type PdfiumWrapped = {
    pdfium: {
        wasmExports: {
            malloc(size: number): number;
            free(ptr: number): void;
        };
        HEAPU8: Uint8Array;
    };
} & PdfiumFunctions;
type PdfiumFunctions = {
    PDFiumExt_Init: () => void;
    FPDF_GetPageCount: (docPtr: number) => number;
    FPDF_LoadMemDocument: (dataPtr: number, length: number, password: string | number | null) => number;
    FPDF_CloseDocument: (docPtr: number) => void;
    FPDF_LoadPage: (docPtr: number, pageIndex: number) => number;
    FPDF_ClosePage: (pagePtr: number) => void;
    FPDF_GetPageWidthF: (pagePtr: number) => number;
    FPDF_GetPageHeightF: (pagePtr: number) => number;
    EPDF_GetPageRotationByIndex: (docPtr: number, pageIndex: number) => number;
    FPDFBitmap_Create: (width: number, height: number, alpha: number) => number;
    FPDFBitmap_FillRect: (bitmapPtr: number, left: number, top: number, width: number, height: number, color: number) => void;
    FPDF_RenderPageBitmap: (bitmapPtr: number, pagePtr: number, startX: number, startY: number, width: number, height: number, rotate: number, flags: number) => void;
    FPDFBitmap_GetBuffer: (bitmapPtr: number) => number;
    FPDFBitmap_Destroy: (bitmapPtr: number) => void;
};
export declare const TILE_SIZE = 512;
export declare function clamp(value: number, min: number, max: number): number;
export declare function ensurePdfium(): Promise<PdfiumWrapped>;
/**
 * One PDFium document opened on one PDFium WASM instance.
 *
 * Runs wherever `ensurePdfium` runs: on the main thread (fallback engine) or
 * inside a dedicated worker (`pdfiumWorkerMain.ts`), where each worker owns
 * its own WASM instance and therefore its own copy of the document.
 */
export declare class PdfiumDocument {
    private readonly pdfium;
    private loaded;
    private currentManifest;
    constructor(pdfium: PdfiumWrapped);
    open(bytes: Uint8Array, manifest?: PdfDocumentManifest): Promise<PdfDocumentManifest>;
    renderPreview(request: PdfPreviewRenderRequest & {
        signal?: AbortSignal;
    }): Promise<PdfRasterResult>;
    renderTile(request: PdfTileRenderRequest & {
        signal?: AbortSignal;
    }): Promise<PdfRasterResult>;
    dispose(): Promise<void>;
    private requireOpen;
}
export {};
