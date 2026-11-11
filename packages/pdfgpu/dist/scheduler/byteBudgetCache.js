const DEFAULT_MAX_BYTES = 192 * 1024 * 1024;
function estimateBytes(width, height) {
    return width * height * 4;
}
function closeBitmap(source) {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
        source.close();
    }
}
export class RasterCache {
    constructor(options = {}) {
        this.entriesMap = new Map();
        this.bytesUsed = 0;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.onRelease = options.onRelease;
    }
    /** Releases downstream resources for `source`, then frees the bitmap. */
    releaseSource(source) {
        this.onRelease?.(source);
        closeBitmap(source);
    }
    getBytesBudget() {
        return this.maxBytes;
    }
    get usedBytes() {
        return this.bytesUsed;
    }
    has(key) {
        return this.entriesMap.has(key);
    }
    get(key) {
        const entry = this.entriesMap.get(key);
        if (!entry)
            return undefined;
        this.entriesMap.delete(key);
        this.entriesMap.set(key, entry);
        return entry;
    }
    set(entry, protectedKeys = new Set()) {
        const bytes = estimateBytes(entry.width, entry.height);
        const normalized = {
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
    delete(key) {
        const entry = this.entriesMap.get(key);
        if (!entry)
            return;
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
    prune(keepKeys) {
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
    evict(keepKeys) {
        while (this.bytesUsed > this.maxBytes && this.entriesMap.size > 0) {
            const oldest = this.entriesMap.keys().next().value;
            if (!oldest)
                return;
            if (keepKeys.has(oldest)) {
                const movable = [...this.entriesMap.keys()].find((key) => !keepKeys.has(key));
                if (!movable)
                    return;
                const moved = this.entriesMap.get(movable);
                if (!moved)
                    return;
                this.delete(movable);
            }
            else {
                this.delete(oldest);
            }
        }
    }
}
export function cacheKey(parts) {
    return `${parts.kind}/${parts.pageIndex}/${Math.round(parts.dpiBucket)}/${parts.tileX}/${parts.tileY}`;
}
