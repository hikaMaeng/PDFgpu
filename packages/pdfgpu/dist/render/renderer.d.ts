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
    /** Canvas passed to `init`; kept so a lost device can be rebuilt on it. */
    private targetCanvas;
    /**
     * True once `getContext('webgpu')` succeeded on the target canvas. Such a
     * canvas can never return a 2D context, so the 2D fallback must not be
     * attempted on it (it used to throw '2d context unavailable' every frame).
     */
    private canvasBoundToWebGpu;
    private disposed;
    private loggedUndrawable;
    /**
     * Called after a lost GPU device has been replaced and the renderer can draw
     * again. The viewer wires this to a repaint; nothing is drawn until then.
     */
    onDeviceRestored: (() => void) | null;
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
    /**
     * Vertex buffer shared by every tile of a frame.
     *
     * - scope: this renderer instance; exactly one buffer at a time.
     * - lifetime: created on the first frame, reallocated only to grow,
     *   destroyed by `dispose`.
     * - bound: the largest frame's tile count x 96 bytes, floor 4KB.
     * - cleared by: `releaseVertexBuffer`, called from `ensureVertexBuffer` when
     *   growing and from `dispose`.
     */
    private vertexBuffer;
    private vertexBufferBytes;
    init(canvas: HTMLCanvasElement): Promise<'webgpu' | 'unsupported' | 'error'>;
    render(canvas: HTMLCanvasElement, frame: Frame): void;
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
    /**
     * Rebuilds the renderer on the same canvas when the GPU device is lost
     * (GPU process restart, driver reset). Textures of the dead device are
     * dropped without `destroy()` - they no longer exist - and re-uploaded from
     * the raster cache on the next frames. A loss caused by our own `dispose()`
     * (reason 'destroyed', or a device that is no longer current) is ignored.
     */
    private watchDeviceLoss;
    dispose(): void;
    private renderWebGpu;
    private getOrCreateTexture;
    /**
     * Bind group for `entry`, built once per (texture, pipeline) pair.
     *
     * Returns null when the device, pipeline or sampler is missing, or when the
     * texture has no view, so the caller skips the tile rather than drawing with
     * a half-built binding.
     */
    private getOrCreateBindGroup;
    /**
     * Shared vertex buffer large enough for `byteLength`.
     *
     * One buffer holds every tile of a frame; each tile draws from it with a
     * `firstVertex` offset. The buffer is reallocated only when a frame needs
     * more room than the last one did, and it grows monotonically, so a viewer
     * that settles at a tile count stops allocating entirely. Capacity is
     * bounded by the tile count the scheduler produces, and `dispose`
     * (via `releaseVertexBuffer`) is what frees it.
     */
    private ensureVertexBuffer;
    private releaseVertexBuffer;
    private render2d;
    private getFrameCanvas;
    private createPipeline;
}
