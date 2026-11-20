import type { PdfDocumentEngine, PdfDocumentManifest, PdfDocumentSource, PdfLoadProgressListener, PdfPreviewRenderRequest, PdfRasterResult, PdfTileRenderRequest } from '../types.js';
import type { WorkerRequest, WorkerResponse } from './workerProtocol.js';
import type { RasterTask } from '../scheduler/queue.js';
import type { ViewerRasterSlot } from '../scheduler/progressive.js';
/** The part of `Worker` the pool uses; lets tests supply a fake. */
export interface WorkerLike {
    postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
    addEventListener(type: 'message', listener: (event: {
        data: WorkerResponse;
    }) => void): void;
    addEventListener(type: 'error', listener: (event: {
        message?: string;
    }) => void): void;
    terminate(): void;
}
export interface WorkerPoolOptions {
    createWorker: () => WorkerLike;
    size: number;
    loadBytes: (source: PdfDocumentSource, onProgress?: PdfLoadProgressListener) => Promise<Uint8Array>;
}
/**
 * In-memory engine that rasterizes in a pool of dedicated workers.
 *
 * Each worker has its own PDFium WASM instance and its own copy of the
 * document, so `size` pages or tiles render at the same time, and none of
 * the rasterization runs on the main thread. Results come back as
 * transferred `ImageBitmap`s, ready for `copyExternalImageToTexture`.
 *
 * A request goes to the live worker with the fewest unanswered requests.
 */
export declare class WorkerPoolPdfEngine implements PdfDocumentEngine {
    private readonly options;
    readonly kind: "in-memory";
    private readonly slots;
    private readonly slotListeners;
    private manifest;
    private generation;
    private disposed;
    private constructor();
    /** Starts up to `size` workers. A partially initialized pool can still render. */
    static create(options: WorkerPoolOptions): Promise<WorkerPoolPdfEngine>;
    get queueDepth(): number;
    /** Workers that have not crashed. */
    get liveWorkers(): number;
    open(source: PdfDocumentSource, onProgress?: PdfLoadProgressListener): Promise<PdfDocumentManifest>;
    getViewerSlots(): ViewerRasterSlot[];
    subscribeViewerSlots(listener: () => void): () => void;
    tryRenderForViewer(id: number, task: RasterTask): Promise<PdfRasterResult> | undefined;
    renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult>;
    renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult>;
    dispose(): Promise<void>;
    private tileRequest;
    private render;
    private renderOn;
    private send;
    private createSlot;
    private liveSlots;
    /** Workers that have the current document open and have not crashed. */
    get readyWorkers(): number;
    private pickSlot;
    private openSlot;
    private slotAvailable;
    private notifySlots;
    private terminateAll;
    private assertPage;
}
