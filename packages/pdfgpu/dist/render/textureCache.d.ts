import type { PdfImageSource } from '../types';
export interface CachedEntry {
    key: string;
    pageIndex: number;
    dpi: number;
    image: PdfImageSource;
    width: number;
    height: number;
}
export declare class LruTextureCache {
    private readonly maxEntries;
    private readonly map;
    constructor(maxEntries?: number);
    get(key: string): CachedEntry | undefined;
    set(entry: CachedEntry): void;
    has(key: string): boolean;
    keys(): string[];
    size(): number;
    remove(key: string): void;
    entries(): IterableIterator<[string, CachedEntry]>;
    retain(activeKeys: string[]): void;
    private prune;
    private releaseImage;
    releaseAll(): void;
}
