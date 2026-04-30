import type { PdfImageSource } from '../types';

export interface CachedEntry {
  key: string;
  pageIndex: number;
  dpi: number;
  image: PdfImageSource;
  width: number;
  height: number;
}

export class LruTextureCache {
  private readonly map = new Map<string, CachedEntry>();

  constructor(private readonly maxEntries = 12) {}

  get(key: string): CachedEntry | undefined {
    const value = this.map.get(key);
    if (!value) return undefined;

    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(entry: CachedEntry) {
    if (this.map.has(entry.key)) {
      this.map.delete(entry.key);
    }

    this.map.set(entry.key, entry);
    this.prune();
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  size(): number {
    return this.map.size;
  }

  remove(key: string) {
    this.map.delete(key);
  }

  entries(): IterableIterator<[string, CachedEntry]> {
    return this.map.entries();
  }

  retain(activeKeys: string[]) {
    const active = new Set(activeKeys);
    for (const key of this.map.keys()) {
      if (!active.has(key)) {
        const entry = this.map.get(key);
        this.releaseImage(entry?.image);
        this.map.delete(key);
      }
    }
  }

  private prune() {
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (!oldest) return;
      const entry = this.map.get(oldest);
      this.releaseImage(entry?.image);
      this.map.delete(oldest);
    }
  }

  private releaseImage(image?: PdfImageSource) {
    if (!image) return;
    const maybeBitmap = image as ImageBitmap | null;
    const isCanvas =
      typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement;
    const isImage =
      typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement;
    if (isCanvas || isImage) {
      return;
    }
    if (!maybeBitmap) return;
    maybeBitmap.close?.();
  }

  releaseAll() {
    for (const entry of this.map.values()) {
      this.releaseImage(entry.image);
    }
    this.map.clear();
  }
}
