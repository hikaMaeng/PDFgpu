import type {
  PdfDocumentEngine,
  PdfDocumentManifest,
  PdfDocumentSource,
  PdfLoadProgressListener,
  PdfPreviewRenderRequest,
  PdfRasterResult,
  PdfTileRenderRequest
} from '../types.js';
import { normalizeDetailDpi } from './dpi.js';
import type { WorkerRequest, WorkerRequestBody, WorkerResponse } from './workerProtocol.js';
import type { RasterTask } from '../scheduler/queue.js';
import type { ViewerRasterSlot } from '../scheduler/progressive.js';

const TILE_SIZE = 512;

/** The part of `Worker` the pool uses; lets tests supply a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: WorkerResponse }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

type Pending = {
  resolve: (response: Extract<WorkerResponse, { ok: true }>) => void;
  reject: (error: Error) => void;
  /** True once the caller gave up (abort); a late raster is closed, not delivered. */
  abandoned: boolean;
  detachAbort?: () => void;
};

type Slot = {
  worker: WorkerLike;
  /**
   * Requests sent to this worker and not yet answered.
   * - key: request id (unique per slot, from `nextId`); scope: one worker.
   * - lifetime: from `send` until the worker replies, the worker errors, or
   *   the pool is disposed; each path deletes the entry.
   * - bound: the viewer's queue depth plus control messages; never grows
   *   without a matching reply because the worker answers every request.
   */
  pending: Map<number, Pending>;
  nextId: number;
  dead: boolean;
  /**
   * `generation` of the document this worker has open; 0 = none. Renders are
   * routed only to workers whose document matches the current generation,
   * so a worker still opening in the background is never asked to render.
   */
  docGeneration: number;
  failedGeneration: number;
};

function abortError() {
  return new DOMException('render aborted', 'AbortError');
}

function closeIfBitmap(source: unknown) {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
  else (source as { close?: () => void } | null)?.close?.();
}

export interface WorkerPoolOptions {
  createWorker: () => WorkerLike;
  size: number;
  loadBytes: (source: PdfDocumentSource, onProgress?: PdfLoadProgressListener) => Promise<Uint8Array>;
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
export class WorkerPoolPdfEngine implements PdfDocumentEngine {
  readonly kind = 'in-memory' as const;
  private readonly slots: Slot[] = [];
  private readonly slotListeners = new Set<() => void>();
  private manifest: PdfDocumentManifest | null = null;
  private generation = 0;
  private disposed = false;

  private constructor(private readonly options: WorkerPoolOptions) {}

  /** Starts up to `size` workers. A partially initialized pool can still render. */
  static async create(options: WorkerPoolOptions): Promise<WorkerPoolPdfEngine> {
    const engine = new WorkerPoolPdfEngine(options);
    let initializationError: unknown;
    for (let index = 0; index < Math.max(1, options.size); index += 1) {
      try {
        engine.slots.push(engine.createSlot());
      } catch (error) {
        initializationError = error;
      }
    }
    await Promise.all(engine.slots.map(async (slot) => {
      try {
        await engine.send(slot, { type: 'init' });
      } catch (error) {
        initializationError = error;
        slot.dead = true;
        slot.worker.terminate();
      }
    }));
    if (engine.liveWorkers === 0) throw initializationError ?? new Error('no pdfium worker started');
    return engine;
  }

  get queueDepth() {
    return this.liveWorkers;
  }

  /** Workers that have not crashed. */
  get liveWorkers() {
    return this.slots.filter((slot) => !slot.dead).length;
  }

  async open(source: PdfDocumentSource, onProgress?: PdfLoadProgressListener): Promise<PdfDocumentManifest> {
    if (this.disposed) throw new Error('engine is disposed');
    const token = ++this.generation;
    this.manifest = null;
    const bytes = await this.options.loadBytes(source, onProgress);
    if (token !== this.generation) throw abortError();

    const live = this.liveSlots();
    let manifest: PdfDocumentManifest | undefined;
    let openError: unknown;
    for (const slot of live) {
      try {
        manifest = (await this.openSlot(slot, bytes)).manifest;
        if (!manifest) throw new Error('worker returned no manifest');
      } catch (error) {
        if (token !== this.generation) throw abortError();
        slot.failedGeneration = token;
        openError = error;
        continue;
      }
      if (token !== this.generation) throw abortError();
      slot.docGeneration = token;
      break;
    }
    if (!manifest) throw openError ?? new Error('no pdfium worker opened the document');
    this.manifest = manifest;
    this.notifySlots();
    // One worker inspects the PDF; the others reuse its manifest and join
    // as soon as their document is open.
    for (const slot of live) {
      if (slot.dead || slot.docGeneration === token || slot.failedGeneration === token) continue;
      void this.openSlot(slot, bytes, manifest).then(
        () => {
          if (token !== this.generation) return;
          slot.docGeneration = token;
          this.notifySlots();
        },
        (error) => {
          if (token !== this.generation) return;
          slot.failedGeneration = token;
          console.warn('[pdfgpu] pdfium worker failed to open the document', error);
          this.notifySlots();
        }
      );
    }
    return manifest;
  }

  getViewerSlots(): ViewerRasterSlot[] {
    const eligible = this.slots.filter((slot) => !slot.dead && slot.failedGeneration !== this.generation).slice(0, 4);
    const roles: ViewerRasterSlot['role'][] = eligible.length === 1 ? ['shared']
      : eligible.length === 2 ? ['forward', 'detail'] : ['forward', 'backward', 'detail', 'detail'];
    return eligible.map((slot, index) => ({
      id: this.slots.indexOf(slot),
      role: roles[index],
      available: this.slotAvailable(slot),
    }));
  }

  subscribeViewerSlots(listener: () => void): () => void {
    this.slotListeners.add(listener);
    return () => { this.slotListeners.delete(listener); };
  }

  tryRenderForViewer(id: number, task: RasterTask): Promise<PdfRasterResult> | undefined {
    const slot = this.slots[id];
    if (!slot || !this.slotAvailable(slot)) return;
    this.assertPage(task.pageIndex);
    const { pageIndex, dpi } = task;
    if (task.kind === 'preview') return this.renderOn(slot, { type: 'preview', pageIndex, dpi });
    const { tileX, tileY, tileWidth, tileHeight } = task;
    return this.renderOn(slot, this.tileRequest({ pageIndex, dpi, tileX, tileY, tileWidth, tileHeight }));
  }

  async renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult> {
    this.assertPage(request.pageIndex);
    return this.render({ type: 'preview', pageIndex: request.pageIndex, dpi: request.dpi }, request.signal);
  }

  async renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult> {
    this.assertPage(request.pageIndex);
    return this.render(this.tileRequest(request), request.signal);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.manifest = null;
    this.terminateAll();
    this.slotListeners.clear();
  }

  private tileRequest(request: PdfTileRenderRequest): Extract<WorkerRequestBody, { type: 'tile' }> {
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

  private async render(
    message: Extract<WorkerRequestBody, { type: 'preview' | 'tile' }>,
    signal?: AbortSignal
  ): Promise<PdfRasterResult> {
    if (signal?.aborted) throw abortError();
    return this.renderOn(this.pickSlot(), message, signal);
  }

  private async renderOn(
    slot: Slot, message: Extract<WorkerRequestBody, { type: 'preview' | 'tile' }>, signal?: AbortSignal
  ): Promise<PdfRasterResult> {
    if (signal?.aborted) throw abortError();
    const response = await this.send(slot, message, [], signal);
    if (!response.raster) throw new Error('worker returned no raster');
    return response.raster;
  }

  private send(
    slot: Slot,
    message: WorkerRequestBody,
    transfer: Transferable[] = [],
    signal?: AbortSignal
  ): Promise<Extract<WorkerResponse, { ok: true }>> {
    if (slot.dead) return Promise.reject(new Error('pdfium worker is not running'));
    const id = slot.nextId;
    slot.nextId += 1;
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, abandoned: false };
      slot.pending.set(id, entry);
      if (signal) {
        const onAbort = () => {
          if (entry.abandoned) return;
          entry.abandoned = true;
          // The worker skips it if it has not started; if it has, the
          // finished raster is closed on arrival instead of delivered.
          reject(abortError());
          if (!slot.dead) slot.worker.postMessage({ id: -1, type: 'cancel', target: id });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }
      try {
        slot.worker.postMessage({ ...message, id } as WorkerRequest, transfer);
      } catch (error) {
        slot.pending.delete(id);
        entry.detachAbort?.();
        reject(error);
        this.notifySlots();
      }
    });
  }

  private createSlot(): Slot {
    const worker = this.options.createWorker();
    const slot: Slot = { worker, pending: new Map(), nextId: 1, dead: false, docGeneration: 0, failedGeneration: -1 };
    worker.addEventListener('message', (event) => {
      const response = event.data;
      const entry = slot.pending.get(response.id);
      if (!entry) {
        if (response.ok && response.raster) closeIfBitmap(response.raster.source);
        return;
      }
      slot.pending.delete(response.id);
      entry.detachAbort?.();
      this.notifySlots();
      if (entry.abandoned) {
        if (response.ok && response.raster) closeIfBitmap(response.raster.source);
        return;
      }
      if (response.ok) {
        entry.resolve(response);
      } else {
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
        if (!entry.abandoned) entry.reject(error);
      }
      slot.pending.clear();
      this.notifySlots();
    });
    return slot;
  }

  private liveSlots(): Slot[] {
    const live = this.slots.filter((slot) => !slot.dead);
    if (live.length === 0) throw new Error('no pdfium worker is running');
    return live;
  }

  /** Workers that have the current document open and have not crashed. */
  get readyWorkers() {
    return this.slots.filter((slot) => !slot.dead && slot.docGeneration === this.generation).length;
  }

  private pickSlot(): Slot {
    let best: Slot | null = null;
    for (const slot of this.liveSlots()) {
      if (slot.docGeneration !== this.generation) continue;
      if (!best || slot.pending.size < best.pending.size) best = slot;
    }
    if (!best) throw new Error('no pdfium worker has the document open');
    return best;
  }

  private openSlot(slot: Slot, bytes: Uint8Array, manifest?: PdfDocumentManifest) {
    const copy = bytes.slice().buffer;
    return this.send(slot, { type: 'open', bytes: copy, manifest }, [copy]);
  }

  private slotAvailable(slot: Slot): boolean {
    return !!this.manifest && !slot.dead && slot.docGeneration === this.generation && slot.pending.size === 0;
  }

  private notifySlots() {
    for (const listener of this.slotListeners) listener();
  }

  private terminateAll() {
    for (const slot of this.slots) {
      for (const entry of slot.pending.values()) {
        entry.detachAbort?.();
        if (!entry.abandoned) entry.reject(abortError());
      }
      slot.pending.clear();
      slot.dead = true;
      slot.worker.terminate();
    }
    this.notifySlots();
  }

  private assertPage(pageIndex: number) {
    if (this.disposed) throw new Error('engine is disposed');
    if (!this.manifest) throw new Error('document not opened');
    if (pageIndex < 0 || pageIndex >= this.manifest.pageCount) {
      throw new Error(`invalid page index: ${pageIndex}`);
    }
  }
}
