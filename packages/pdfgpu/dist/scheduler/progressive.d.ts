import type { PdfRasterResult } from '../types.js';
import { type DetailTask, type RasterTask } from './queue.js';
export interface ViewerRasterSlot {
    id: number;
    role: 'forward' | 'backward' | 'detail' | 'shared';
    available: boolean;
}
interface Viewport {
    activePage: number;
    visiblePages: readonly number[];
    pageCount: number;
    detailTiles(): DetailTask[];
}
interface Host {
    slots(): ViewerRasterSlot[];
    render(slot: number, task: RasterTask, signal?: AbortSignal): Promise<PdfRasterResult> | undefined;
    has(task: RasterTask): boolean;
    canPrefetch(pageIndex: number, anchor: number, bytes?: number): boolean;
    cache(task: RasterTask, raster: PdfRasterResult, prefetchAnchor?: number): boolean;
    changed(pageIndex: number): void;
    failed(error: unknown): void;
    prefetchRadius: number;
    abortStale?: boolean;
}
interface Clock {
    now(): number;
    wake(callback: () => void, delay: number): () => void;
}
/** Holds the latest view and one actual in-flight request per slot. */
export declare class ProgressiveRasterScheduler {
    private readonly host;
    private readonly time;
    private view?;
    private lastPage?;
    private document;
    private detailAfter;
    private prefetchAfter?;
    private moved;
    private anchor?;
    private cursors;
    private nextDirection;
    private tiles?;
    private detailSlot?;
    private cancelWake?;
    private pumping;
    private readonly running;
    private readonly failedPreviews;
    private readonly failedDetails;
    private readonly previewBytes;
    constructor(host: Host, time?: Clock);
    invalidate(moved?: boolean): void;
    reset(): void;
    update(view: Viewport): void;
    previewFailed(pageIndex: number): boolean;
    pump: () => void;
    private available;
    private needs;
    private advanceDetail;
    private detailTiles;
    private advancePrefetch;
    private cancelObsoleteRemoteWork;
    private start;
    private accept;
}
export {};
