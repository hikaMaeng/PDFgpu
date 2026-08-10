export type PdfImageSource = ImageBitmap | HTMLCanvasElement | HTMLImageElement;
export type PdfGpuBackend = 'webgpu' | 'unsupported' | 'error';
export type PdfGpuCapabilities = PdfGpuBackend;
export interface PdfRasterResult {
    source: PdfImageSource;
    width: number;
    height: number;
    dpi: number;
    pageIndex: number;
    kind: 'preview' | 'detail';
    tileX?: number;
    tileY?: number;
    tileWidth?: number;
    tileHeight?: number;
}
export interface PdfPageManifest {
    index: number;
    widthPts: number;
    heightPts: number;
    rotation: number;
}
export interface PdfDocumentManifest {
    pageCount: number;
    pages: PdfPageManifest[];
    documentId?: string;
    sourceDpi?: number;
}
export interface PdfPreviewRenderRequest {
    pageIndex: number;
    /** Optional full-page raster DPI used by deterministic capture flows. */
    dpi?: number;
    signal?: AbortSignal;
}
export interface PdfTileRenderRequest {
    pageIndex: number;
    dpi: number;
    tileX: number;
    tileY: number;
    tileWidth: number;
    tileHeight: number;
    signal?: AbortSignal;
}
export type PdfDocumentSource = string | URL | ArrayBuffer | Uint8Array | Blob | File;
export type PdfRasterProviderKind = 'in-memory' | 'webapi' | 'websocket';
export type PdfGpuViewMode = 'single' | 'spread';
export type PdfGpuSpreadPlacement = 'first-left' | 'first-right';
export type PdfGpuFitMode = 'none' | 'width' | 'height' | 'page';
export type PdfGpuScrollMode = 'continuous' | 'page';
export type PdfGpuLoadPhase = 'idle' | 'opening' | 'rendering' | 'ready' | 'error';
export interface PdfLoadProgress {
    loadedBytes: number;
    totalBytes?: number;
    ratio?: number;
}
export type PdfLoadProgressListener = (progress: PdfLoadProgress) => void;
export interface PdfRasterProvider {
    open(source: PdfDocumentSource, onProgress?: PdfLoadProgressListener): Promise<PdfDocumentManifest>;
    renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult>;
    renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult>;
    dispose(): void | Promise<void>;
    readonly kind?: PdfRasterProviderKind;
    readonly endpoint?: string;
    readonly queueDepth?: number;
}
export type PdfDocumentEngine = PdfRasterProvider;
export interface PdfGpuViewerOptions {
    container: HTMLElement;
    provider: PdfRasterProvider;
    engine?: PdfDocumentEngine;
    providerKind?: PdfRasterProviderKind;
    viewMode?: PdfGpuViewMode;
    spreadPlacement?: PdfGpuSpreadPlacement;
    fitMode?: PdfGpuFitMode;
    scrollMode?: PdfGpuScrollMode;
    initialZoom?: number;
    minZoom?: number;
    maxZoom?: number;
    overscanPages?: number;
    pageGap?: number;
    spreadGap?: number;
    detailDpi?: number;
}
export interface PdfGpuViewerState {
    backend: PdfGpuBackend;
    zoom: number;
    pageCount: number;
    provider: PdfRasterProviderKind;
    engine: PdfRasterProviderKind | 'pdfium';
    endpoint?: string;
    viewMode: PdfGpuViewMode;
    spreadPlacement: PdfGpuSpreadPlacement;
    fitMode: PdfGpuFitMode;
    scrollMode: PdfGpuScrollMode;
    queueDepth: number;
    renderQuality: 'idle' | 'preview' | 'detail';
    detailDpi: number;
    visiblePages: number[];
    loading: boolean;
    loadPhase: PdfGpuLoadPhase;
    loadProgress: number;
    loadProgressDeterminate: boolean;
    loadedPages: number;
    loadPageCount: number;
    error: string | null;
    activePage?: number;
}
export interface PdfGpuViewerController extends PdfGpuCaptureController {
    load(source: PdfDocumentSource): Promise<void>;
    setZoom(value: number): void;
    zoomIn(): void;
    zoomOut(): void;
    setViewMode(mode: PdfGpuViewMode): void;
    setSpreadPlacement(placement: PdfGpuSpreadPlacement): void;
    setFitMode(mode: PdfGpuFitMode): void;
    setScrollMode(mode: PdfGpuScrollMode): void;
    setDetailDpi(dpi: number): void;
    fitWidth(): void;
    fitHeight(): void;
    fitPage(): void;
    scrollToPage(index: number): void;
    projectOverlays(overlays: PdfGpuOverlayItem[]): PdfGpuOverlayProjection[];
    getState(): PdfGpuViewerState;
    subscribe(listener: (state: PdfGpuViewerState) => void): () => void;
    dispose(): void;
}
export type PdfGpuAbsoluteRect = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type PdfGpuScreenPoint = {
    x: number;
    y: number;
};
export type PdfGpuCaptureErrorCode = 'high-resolution-not-ready' | 'invalid-coordinates' | 'capture-too-small';
export declare class PdfGpuCaptureError extends Error {
    readonly code: PdfGpuCaptureErrorCode;
    constructor(code: PdfGpuCaptureErrorCode, message: string);
}
export interface PdfGpuCaptureResult {
    pageIndex: number;
    rect: PdfGpuAbsoluteRect;
    imageBase64: string;
    mimeType: 'image/png' | 'image/webp';
    quality: 'high-resolution';
    dpi: number;
}
export interface PdfGpuCaptureController {
    captureRegion(start: PdfGpuScreenPoint, end: PdfGpuScreenPoint, options?: {
        minSize?: number;
        signal?: AbortSignal;
    }): Promise<PdfGpuCaptureResult>;
}
export interface PdfGpuOverlayItem {
    pageIndex: number;
    rect: PdfGpuAbsoluteRect;
    borderColor: string;
    fillColor?: string;
    fillOpacity?: number;
    comment?: string;
}
export interface PdfGpuOverlayProjection {
    pageIndex: number;
    left: number;
    top: number;
    width: number;
    height: number;
    borderColor: string;
    fillColor?: string;
    fillOpacity?: number;
    comment?: string;
}
