export class LruTextureCache {
    constructor(maxEntries = 12) {
        this.maxEntries = maxEntries;
        this.map = new Map();
    }
    get(key) {
        const value = this.map.get(key);
        if (!value)
            return undefined;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(entry) {
        if (this.map.has(entry.key)) {
            this.map.delete(entry.key);
        }
        this.map.set(entry.key, entry);
        this.prune();
    }
    has(key) {
        return this.map.has(key);
    }
    keys() {
        return [...this.map.keys()];
    }
    size() {
        return this.map.size;
    }
    remove(key) {
        this.map.delete(key);
    }
    entries() {
        return this.map.entries();
    }
    retain(activeKeys) {
        const active = new Set(activeKeys);
        for (const key of this.map.keys()) {
            if (!active.has(key)) {
                const entry = this.map.get(key);
                this.releaseImage(entry?.image);
                this.map.delete(key);
            }
        }
    }
    prune() {
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value;
            if (!oldest)
                return;
            const entry = this.map.get(oldest);
            this.releaseImage(entry?.image);
            this.map.delete(oldest);
        }
    }
    releaseImage(image) {
        if (!image)
            return;
        const maybeBitmap = image;
        const isCanvas = typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement;
        const isImage = typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement;
        if (isCanvas || isImage) {
            return;
        }
        if (!maybeBitmap)
            return;
        maybeBitmap.close?.();
    }
    releaseAll() {
        for (const entry of this.map.values()) {
            this.releaseImage(entry.image);
        }
        this.map.clear();
    }
}
