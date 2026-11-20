import type { PdfImageSource } from '../types.js';
type RenderKind = 'preview' | 'detail';
export interface CachedRaster {
    key: string;
    kind: RenderKind;
    pageIndex: number;
    dpi: number;
    tileX: number;
    tileY: number;
    tileWidth: number;
    tileHeight: number;
    sourceWidth: number;
    sourceHeight: number;
    dpiRounded: number;
    source: PdfImageSource;
    width: number;
    height: number;
    bytes: number;
}
export interface BitmapCacheConstructorOptions {
    maxBytes?: number;
    /**
     * Called once for every raster source that leaves the cache: eviction,
     * `delete`, `clear`, and replacing an existing key. The viewer wires this to
     * `PageRenderer.releaseTexture` so GPU texture lifetime follows the raster
     * it was uploaded from. Without it, the renderer keeps the texture for a
     * raster this cache has already dropped.
     */
    onRelease?: (source: PdfImageSource) => void;
}
export declare class RasterCache {
    private readonly maxBytes;
    private readonly entriesMap;
    private readonly onRelease;
    private bytesUsed;
    constructor(options?: BitmapCacheConstructorOptions);
    /** Releases downstream resources for `source`, then frees the bitmap. */
    private releaseSource;
    getBytesBudget(): number;
    get usedBytes(): number;
    canFit(bytes: number, keepKeys: ReadonlySet<string>): boolean;
    has(key: string): boolean;
    get(key: string): CachedRaster | undefined;
    set(entry: Omit<CachedRaster, 'bytes'> & {
        width: number;
        height: number;
        sourceWidth?: number;
        sourceHeight?: number;
        dpiRounded?: number;
    }, protectedKeys?: ReadonlySet<string>): void;
    delete(key: string): void;
    keys(): string[];
    values(): CachedRaster[];
    entries(): CachedRaster[];
    /**
     * Enforces the byte budget while protecting `keepKeys`. Despite the name,
     * this does NOT remove every entry outside `keepKeys`: below budget it is a
     * no-op, and above budget it evicts least-recently-used unprotected entries
     * until the cache fits again (or only protected entries remain).
     *
     * Callers can retain offscreen rasters for a return visit while the budget
     * has room. `onRelease` ties each GPU texture's lifetime to its raster.
     */
    prune(keepKeys: Set<string>): void;
    clear(): void;
    private evict;
}
export declare function cacheKey(parts: {
    kind: string;
    pageIndex: number;
    dpiBucket: number;
    tileX: number;
    tileY: number;
}): string;
export {};
