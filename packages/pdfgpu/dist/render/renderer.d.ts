import type { PdfImageSource } from '../types.js';
export type RenderedTile = {
    source: PdfImageSource;
    left: number;
    top: number;
    width: number;
    height: number;
};
export type Frame = {
    width: number;
    height: number;
    tiles: RenderedTile[];
};
export declare class PageRenderer {
    private lastFrame;
    private _backend;
    private initError;
    private isInitialized;
    private device;
    private context;
    private format;
    private pipeline;
    private sampler;
    private frameCanvas;
    private frameContext;
    private frameCount;
    /**
     * GPU textures uploaded from raster sources.
     *
     * - key: the `PdfImageSource` object identity of a cached raster.
     * - scope: this renderer instance; one entry per distinct raster source.
     * - lifetime: created on first draw of that source, destroyed when the
     *   source leaves `RasterCache` (which calls `releaseTexture`) or on
     *   `dispose`.
     * - bound: the raster cache's byte budget. Every source drawn in a frame is
     *   a live cache entry, so GPU bytes track cache bytes; `gpuTextureBytes`
     *   exposes the running total.
     * - cleared by: `RasterCache`'s `onRelease` hook (eviction, `delete`,
     *   `clear`, and replacing a key) and `dispose`. Nothing else removes
     *   entries, so a missing hook is a leak, not a slow release. A `WeakMap`
     *   cannot do this job: the entry holds `source`, so any strong list of
     *   entries keeps every key alive.
     */
    private readonly gpuTextures;
    private gpuBytes;
    init(canvas: HTMLCanvasElement): Promise<'webgpu' | 'unsupported' | 'error'>;
    render(canvas: HTMLCanvasElement, frame: Frame): void;
    renderLastFrameToCanvas(canvas: HTMLCanvasElement): boolean;
    renderLastPreviewFrameToCanvas(canvas: HTMLCanvasElement): boolean;
    get state(): 'webgpu' | 'unsupported' | 'error';
    get reason(): string;
    /** Number of GPU textures currently held. */
    get gpuTextureCount(): number;
    /** Bytes of GPU texture memory currently held, at 4 bytes per pixel. */
    get gpuTextureBytes(): number;
    /**
     * Destroys the GPU texture uploaded from `source`, if any.
     *
     * Called by `RasterCache` whenever a raster leaves the cache. Returns true
     * when a texture was destroyed, so callers can account for the release.
     */
    releaseTexture(source: PdfImageSource): boolean;
    /** Destroys every GPU texture held by this renderer. */
    releaseAllTextures(): void;
    dispose(): void;
    private renderWebGpu;
    private getOrCreateTexture;
    private render2d;
    private getFrameCanvas;
    private createPipeline;
}
