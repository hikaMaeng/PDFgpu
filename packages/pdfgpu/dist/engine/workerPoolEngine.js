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
        this.slots = [];
        this.slotListeners = new Set();
        this.manifest = null;
        this.generation = 0;
        this.disposed = false;
    }
    /** Starts up to `size` workers. A partially initialized pool can still render. */
    static async create(options) {
        const engine = new WorkerPoolPdfEngine(options);
        let initializationError;
        for (let index = 0; index < Math.max(1, options.size); index += 1) {
            try {
                engine.slots.push(engine.createSlot());
            }
            catch (error) {
                initializationError = error;
            }
        }
        await Promise.all(engine.slots.map(async (slot) => {
            try {
                await engine.send(slot, { type: 'init' });
            }
            catch (error) {
                initializationError = error;
                slot.dead = true;
                slot.worker.terminate();
            }
        }));
        if (engine.liveWorkers === 0)
            throw initializationError ?? new Error('no pdfium worker started');
        return engine;
    }
    get queueDepth() {
        return this.liveWorkers;
    }
    /** Workers that have not crashed. */
    get liveWorkers() {
        return this.slots.filter((slot) => !slot.dead).length;
    }
    async open(source, onProgress) {
        if (this.disposed)
            throw new Error('engine is disposed');
        const token = ++this.generation;
        this.manifest = null;
        const bytes = await this.options.loadBytes(source, onProgress);
        if (token !== this.generation)
            throw abortError();
        const live = this.liveSlots();
        let manifest;
        let openError;
        for (const slot of live) {
            try {
                manifest = (await this.openSlot(slot, bytes)).manifest;
                if (!manifest)
                    throw new Error('worker returned no manifest');
            }
            catch (error) {
                if (token !== this.generation)
                    throw abortError();
                slot.failedGeneration = token;
                openError = error;
                continue;
            }
            if (token !== this.generation)
                throw abortError();
            slot.docGeneration = token;
            break;
        }
        if (!manifest)
            throw openError ?? new Error('no pdfium worker opened the document');
        this.manifest = manifest;
        this.notifySlots();
        // One worker inspects the PDF; the others reuse its manifest and join
        // as soon as their document is open.
        for (const slot of live) {
            if (slot.dead || slot.docGeneration === token || slot.failedGeneration === token)
                continue;
            void this.openSlot(slot, bytes, manifest).then(() => {
                if (token !== this.generation)
                    return;
                slot.docGeneration = token;
                this.notifySlots();
            }, (error) => {
                if (token !== this.generation)
                    return;
                slot.failedGeneration = token;
                console.warn('[pdfgpu] pdfium worker failed to open the document', error);
                this.notifySlots();
            });
        }
        return manifest;
    }
    getViewerSlots() {
        const eligible = this.slots.filter((slot) => !slot.dead && slot.failedGeneration !== this.generation).slice(0, 4);
        const roles = eligible.length === 1 ? ['shared']
            : eligible.length === 2 ? ['forward', 'detail'] : ['forward', 'backward', 'detail', 'detail'];
        return eligible.map((slot, index) => ({
            id: this.slots.indexOf(slot),
            role: roles[index],
            available: this.slotAvailable(slot),
        }));
    }
    subscribeViewerSlots(listener) {
        this.slotListeners.add(listener);
        return () => { this.slotListeners.delete(listener); };
    }
    tryRenderForViewer(id, task) {
        const slot = this.slots[id];
        if (!slot || !this.slotAvailable(slot))
            return;
        this.assertPage(task.pageIndex);
        const { pageIndex, dpi } = task;
        if (task.kind === 'preview')
            return this.renderOn(slot, { type: 'preview', pageIndex, dpi });
        const { tileX, tileY, tileWidth, tileHeight } = task;
        return this.renderOn(slot, this.tileRequest({ pageIndex, dpi, tileX, tileY, tileWidth, tileHeight }));
    }
    async renderPreview(request) {
        this.assertPage(request.pageIndex);
        return this.render({ type: 'preview', pageIndex: request.pageIndex, dpi: request.dpi }, request.signal);
    }
    async renderTile(request) {
        this.assertPage(request.pageIndex);
        return this.render(this.tileRequest(request), request.signal);
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.generation += 1;
        this.manifest = null;
        this.terminateAll();
        this.slotListeners.clear();
    }
    tileRequest(request) {
        return {
            type: 'tile',
            pageIndex: request.pageIndex,
            dpi: normalizeDetailDpi(request.dpi),
            tileX: request.tileX,
            tileY: request.tileY,
            tileWidth: request.tileWidth ?? TILE_SIZE,
            tileHeight: request.tileHeight ?? TILE_SIZE,
        };
    }
    async render(message, signal) {
        if (signal?.aborted)
            throw abortError();
        return this.renderOn(this.pickSlot(), message, signal);
    }
    async renderOn(slot, message, signal) {
        if (signal?.aborted)
            throw abortError();
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
                    reject(abortError());
                    if (!slot.dead)
                        slot.worker.postMessage({ id: -1, type: 'cancel', target: id });
                };
                signal.addEventListener('abort', onAbort, { once: true });
                entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
            }
            try {
                slot.worker.postMessage({ ...message, id }, transfer);
            }
            catch (error) {
                slot.pending.delete(id);
                entry.detachAbort?.();
                reject(error);
                this.notifySlots();
            }
        });
    }
    createSlot() {
        const worker = this.options.createWorker();
        const slot = { worker, pending: new Map(), nextId: 1, dead: false, docGeneration: 0, failedGeneration: -1 };
        worker.addEventListener('message', (event) => {
            const response = event.data;
            const entry = slot.pending.get(response.id);
            if (!entry) {
                if (response.ok && response.raster)
                    closeIfBitmap(response.raster.source);
                return;
            }
            slot.pending.delete(response.id);
            entry.detachAbort?.();
            this.notifySlots();
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
                entry.detachAbort?.();
                if (!entry.abandoned)
                    entry.reject(error);
            }
            slot.pending.clear();
            this.notifySlots();
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
    openSlot(slot, bytes, manifest) {
        const copy = bytes.slice().buffer;
        return this.send(slot, { type: 'open', bytes: copy, manifest }, [copy]);
    }
    slotAvailable(slot) {
        return !!this.manifest && !slot.dead && slot.docGeneration === this.generation && slot.pending.size === 0;
    }
    notifySlots() {
        for (const listener of this.slotListeners)
            listener();
    }
    terminateAll() {
        for (const slot of this.slots) {
            for (const entry of slot.pending.values()) {
                entry.detachAbort?.();
                if (!entry.abandoned)
                    entry.reject(abortError());
            }
            slot.pending.clear();
            slot.dead = true;
            slot.worker.terminate();
        }
        this.notifySlots();
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
