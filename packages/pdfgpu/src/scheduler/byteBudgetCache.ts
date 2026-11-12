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
  private readonly onRelease: ((source: PdfImageSource) => void) | undefined;
  private bytesUsed = 0;

  constructor(options: BitmapCacheConstructorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onRelease = options.onRelease;
  }

  /** Releases downstream resources for `source`, then frees the bitmap. */
  private releaseSource(source: PdfImageSource) {
    this.onRelease?.(source);
    closeBitmap(source);
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

  set(
    entry: Omit<CachedRaster, 'bytes'> & { width: number; height: number; sourceWidth?: number; sourceHeight?: number; dpiRounded?: number },
    protectedKeys: ReadonlySet<string> = new Set(),
  ) {
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
      if (existing.source !== normalized.source) {
        this.releaseSource(existing.source);
      }
      this.entriesMap.delete(entry.key);
    }

    this.entriesMap.set(entry.key, normalized);
    this.bytesUsed += bytes;
    this.evict(protectedKeys);
  }

  delete(key: string) {
    const entry = this.entriesMap.get(key);
    if (!entry) return;
    this.entriesMap.delete(key);
    this.bytesUsed -= entry.bytes;
    this.releaseSource(entry.source);
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

  /**
   * Enforces the byte budget while protecting `keepKeys`. Despite the name,
   * this does NOT remove every entry outside `keepKeys`: below budget it is a
   * no-op, and above budget it evicts least-recently-used unprotected entries
   * until the cache fits again (or only protected entries remain).
   *
   * That is deliberate. The viewer's keep set covers only visible pages and
   * the active page +-1, so a strict prune would drop rasters two pages away
   * and re-render them on scroll-back. Measured in Chrome (WebGPU, zoomed,
   * DPI 384): scrolling back three screens uploaded 0 new textures because
   * the rasters were still cached. GPU textures follow the same lifetime via
   * `onRelease`, so GPU memory is bounded by this same budget.
   */
  prune(keepKeys: Set<string>) {
    this.evict(keepKeys);
  }

  clear() {
    const sources = [...this.entriesMap.values()].map((entry) => entry.source);
    this.entriesMap.clear();
    this.bytesUsed = 0;
    for (const source of sources) {
      this.releaseSource(source);
    }
  }

  private evict(keepKeys: ReadonlySet<string>) {
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
