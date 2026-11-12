import { normalizeDetailDpi } from './dpi.js';
const TILE_SIZE = 512;
function abortError() {
    return new DOMException('render aborted', 'AbortError');
}
function closeIfBitmap(source) {
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap)
        source.close();
    else
        source?.close?.();
}
/**
 * In-memory engine that rasterizes in a pool of dedicated workers.
 *
 * Each worker has its own PDFium WASM instance and its own copy of the
 * document, so `size` pages or tiles render at the same time, and none of
 * the rasterization runs on the main thread. Results come back as
 * transferred `ImageBitmap`s, ready for `copyExternalImageToTexture`.
 *
 * A request goes to the live worker with the fewest unanswered requests.
 */
export class WorkerPoolPdfEngine {
    constructor(options) {
        this.options = options;
        this.kind = 'in-memory';
        this.manifest = null;
        this.generation = 0;
        this.disposed = false;
        this.slots = Array.from({ length: Math.max(1, options.size) }, () => this.createSlot());
    }
    /** Starts `size` workers and waits until each has loaded PDFium. */
    static async create(options) {
        const engine = new WorkerPoolPdfEngine(options);
        try {
            await Promise.all(engine.slots.map((slot) => engine.send(slot, { type: 'init' })));
        }
        catch (error) {
            engine.terminateAll();
            throw error;
        }
        return engine;
    }
    get queueDepth() {
        return this.slots.length;
    }
    /** Workers that have not crashed. */
    get liveWorkers() {
        return this.slots.filter((slot) => !slot.dead).length;
    }
    async open(source, onProgress) {
        this.generation += 1;
        const token = this.generation;
        const bytes = await this.options.loadBytes(source, onProgress);
        const live = this.liveSlots();
        const [first, ...rest] = live;
        for (const slot of live)
            slot.docGeneration = 0;
        // The first worker extracts the manifest; the rest reuse it instead of
        // walking every page again. Each worker gets its own copy of the bytes
        // (transferred, so the copy is not duplicated again in flight).
        const firstCopy = bytes.slice().buffer;
        const opened = await this.send(first, { type: 'open', bytes: firstCopy }, [firstCopy]);
        const manifest = opened.manifest;
        if (!manifest)
            throw new Error('worker returned no manifest');
        if (token !== this.generation) {
            await this.closeDocuments();
            throw new DOMException('open aborted', 'AbortError');
        }
        first.docGeneration = token;
        this.manifest = manifest;
        // Return as soon as one worker can render; the others open in the
        // background and join the pool when ready, so the first preview never
        // waits for the slowest worker. (In the Chrome measurement all four
        // workers opened a 1.8MB file within 2ms of each other, so the gain there
        // was small; it matters when one worker is slow or a file is large.)
        for (const slot of rest) {
            const copy = bytes.slice().buffer;
            this.send(slot, { type: 'open', bytes: copy, manifest }, [copy]).then(() => {
                if (token === this.generation)
                    slot.docGeneration = token;
            }, (error) => {
                if (token === this.generation && !this.disposed) {
                    console.warn('[pdfgpu] pdfium worker failed to open the document', error);
                }
            });
        }
        return manifest;
    }
    async renderPreview(request) {
        this.assertPage(request.pageIndex);
        return this.render({ type: 'preview', pageIndex: request.pageIndex, dpi: request.dpi }, request.signal);
    }
    async renderTile(request) {
        this.assertPage(request.pageIndex);
        return this.render({
            type: 'tile',
            pageIndex: request.pageIndex,
            dpi: normalizeDetailDpi(request.dpi),
            tileX: request.tileX,
            tileY: request.tileY,
            tileWidth: request.tileWidth ?? TILE_SIZE,
            tileHeight: request.tileHeight ?? TILE_SIZE
        }, request.signal);
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.generation += 1;
        this.manifest = null;
        this.terminateAll();
    }
    async render(message, signal) {
        if (signal?.aborted)
            throw abortError();
        const slot = this.pickSlot();
        const response = await this.send(slot, message, [], signal);
        if (!response.raster)
            throw new Error('worker returned no raster');
        return response.raster;
    }
    send(slot, message, transfer = [], signal) {
        if (slot.dead)
            return Promise.reject(new Error('pdfium worker is not running'));
        const id = slot.nextId;
        slot.nextId += 1;
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, abandoned: false };
            slot.pending.set(id, entry);
            if (signal) {
                const onAbort = () => {
                    if (entry.abandoned)
                        return;
                    entry.abandoned = true;
                    // The worker skips it if it has not started; if it has, the
                    // finished raster is closed on arrival instead of delivered.
                    slot.worker.postMessage({ id: -1, type: 'cancel', target: id });
                    reject(abortError());
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }
            slot.worker.postMessage({ ...message, id }, transfer);
        });
    }
    createSlot() {
        const worker = this.options.createWorker();
        const slot = { worker, pending: new Map(), nextId: 1, dead: false, docGeneration: 0 };
        worker.addEventListener('message', (event) => {
            const response = event.data;
            const entry = slot.pending.get(response.id);
            if (!entry)
                return;
            slot.pending.delete(response.id);
            if (entry.abandoned) {
                if (response.ok && response.raster)
                    closeIfBitmap(response.raster.source);
                return;
            }
            if (response.ok) {
                entry.resolve(response);
            }
            else {
                const error = response.name === 'AbortError'
                    ? abortError()
                    : Object.assign(new Error(response.error), { name: response.name ?? 'Error' });
                entry.reject(error);
            }
        });
        worker.addEventListener('error', (event) => {
            // A crashed worker answers nothing more: fail what it held and stop
            // routing to it. Other workers keep serving.
            slot.dead = true;
            const error = new Error(`pdfium worker failed: ${event.message ?? 'unknown error'}`);
            for (const entry of slot.pending.values()) {
                if (!entry.abandoned)
                    entry.reject(error);
            }
            slot.pending.clear();
        });
        return slot;
    }
    liveSlots() {
        const live = this.slots.filter((slot) => !slot.dead);
        if (live.length === 0)
            throw new Error('no pdfium worker is running');
        return live;
    }
    /** Workers that have the current document open and have not crashed. */
    get readyWorkers() {
        return this.slots.filter((slot) => !slot.dead && slot.docGeneration === this.generation).length;
    }
    pickSlot() {
        let best = null;
        for (const slot of this.liveSlots()) {
            if (slot.docGeneration !== this.generation)
                continue;
            if (!best || slot.pending.size < best.pending.size)
                best = slot;
        }
        if (!best)
            throw new Error('no pdfium worker has the document open');
        return best;
    }
    async closeDocuments() {
        await Promise.allSettled(this.liveSlots().map((slot) => this.send(slot, { type: 'close' })));
    }
    terminateAll() {
        for (const slot of this.slots) {
            for (const entry of slot.pending.values()) {
                if (!entry.abandoned)
                    entry.reject(abortError());
            }
            slot.pending.clear();
            slot.dead = true;
            slot.worker.terminate();
        }
    }
    assertPage(pageIndex) {
        if (this.disposed)
            throw new Error('engine is disposed');
        if (!this.manifest)
            throw new Error('document not opened');
        if (pageIndex < 0 || pageIndex >= this.manifest.pageCount) {
            throw new Error(`invalid page index: ${pageIndex}`);
        }
    }
}
