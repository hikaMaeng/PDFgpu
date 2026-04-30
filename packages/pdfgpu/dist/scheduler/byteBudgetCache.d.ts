import type { PdfImageSource } from '../types';
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
}
export declare class RasterCache {
    private readonly maxBytes;
    private readonly entriesMap;
    private bytesUsed;
    constructor(options?: BitmapCacheConstructorOptions);
    getBytesBudget(): number;
    get usedBytes(): number;
    has(key: string): boolean;
    get(key: string): CachedRaster | undefined;
    set(entry: Omit<CachedRaster, 'bytes'> & {
        width: number;
        height: number;
        sourceWidth?: number;
        sourceHeight?: number;
        dpiRounded?: number;
    }): void;
    delete(key: string): void;
    keys(): string[];
    values(): CachedRaster[];
    entries(): CachedRaster[];
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
