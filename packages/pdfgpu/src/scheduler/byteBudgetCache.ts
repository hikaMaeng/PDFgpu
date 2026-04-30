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

const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;

function estimateBytes(width: number, height: number) {
  return width * height * 4;
}

function closeBitmap(source: PdfImageSource) {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    source.close();
  }
}

export class RasterCache {
  private readonly maxBytes: number;
  private readonly entriesMap = new Map<string, CachedRaster>();
  private bytesUsed = 0;

  constructor(options: BitmapCacheConstructorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  getBytesBudget() {
    return this.maxBytes;
  }

  get usedBytes() {
    return this.bytesUsed;
  }

  has(key: string): boolean {
    return this.entriesMap.has(key);
  }

  get(key: string): CachedRaster | undefined {
    const entry = this.entriesMap.get(key);
    if (!entry) return undefined;
    this.entriesMap.delete(key);
    this.entriesMap.set(key, entry);
    return entry;
  }

  set(entry: Omit<CachedRaster, 'bytes'> & { width: number; height: number; sourceWidth?: number; sourceHeight?: number; dpiRounded?: number }) {
    const bytes = estimateBytes(entry.width, entry.height);
    const normalized: CachedRaster = {
      key: entry.key,
      kind: entry.kind,
      pageIndex: entry.pageIndex,
      dpi: entry.dpi,
      tileX: entry.tileX,
      tileY: entry.tileY,
      tileWidth: entry.tileWidth,
      tileHeight: entry.tileHeight,
      width: entry.width,
      height: entry.height,
      sourceWidth: entry.sourceWidth ?? entry.width,
      sourceHeight: entry.sourceHeight ?? entry.height,
      dpiRounded: entry.dpiRounded ?? entry.dpi,
      source: entry.source,
      bytes
    };
    const existing = this.entriesMap.get(entry.key);
    if (existing) {
      this.bytesUsed -= existing.bytes;
      closeBitmap(existing.source);
      this.entriesMap.delete(entry.key);
    }

    this.entriesMap.set(entry.key, normalized);
    this.bytesUsed += bytes;
    this.evict(new Set());
  }

  delete(key: string) {
    const entry = this.entriesMap.get(key);
    if (!entry) return;
    closeBitmap(entry.source);
    this.entriesMap.delete(key);
    this.bytesUsed -= entry.bytes;
  }

  keys() {
    return [...this.entriesMap.keys()];
  }

  values() {
    return [...this.entriesMap.values()];
  }

  entries() {
    return this.values();
  }

  prune(keepKeys: Set<string>) {
    this.evict(keepKeys);
  }

  clear() {
    for (const entry of this.entriesMap.values()) {
      closeBitmap(entry.source);
    }
    this.entriesMap.clear();
    this.bytesUsed = 0;
  }

  private evict(keepKeys: Set<string>) {
    while (this.bytesUsed > this.maxBytes && this.entriesMap.size > 0) {
      const oldest = this.entriesMap.keys().next().value;
      if (!oldest) return;
      if (keepKeys.has(oldest)) {
        const movable = [...this.entriesMap.keys()].find((key) => !keepKeys.has(key));
        if (!movable) return;
        const moved = this.entriesMap.get(movable);
        if (!moved) return;
        this.delete(movable);
      } else {
        this.delete(oldest);
      }
    }
  }
}

export function cacheKey(parts: { kind: string; pageIndex: number; dpiBucket: number; tileX: number; tileY: number }) {
  return `${parts.kind}/${parts.pageIndex}/${Math.round(parts.dpiBucket)}/${parts.tileX}/${parts.tileY}`;
}
