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
  private readonly slots: Slot[];
  private manifest: PdfDocumentManifest | null = null;
  private generation = 0;
  private disposed = false;

  private constructor(private readonly options: WorkerPoolOptions) {
    this.slots = Array.from({ length: Math.max(1, options.size) }, () => this.createSlot());
  }

  /** Starts `size` workers and waits until each has loaded PDFium. */
  static async create(options: WorkerPoolOptions): Promise<WorkerPoolPdfEngine> {
    const engine = new WorkerPoolPdfEngine(options);
    try {
      await Promise.all(engine.slots.map((slot) => engine.send(slot, { type: 'init' })));
    } catch (error) {
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

  async open(source: PdfDocumentSource, onProgress?: PdfLoadProgressListener): Promise<PdfDocumentManifest> {
    this.generation += 1;
    const token = this.generation;
    const bytes = await this.options.loadBytes(source, onProgress);
    const live = this.liveSlots();
    const [first, ...rest] = live;
    for (const slot of live) slot.docGeneration = 0;
    // The first worker extracts the manifest; the rest reuse it instead of
    // walking every page again. Each worker gets its own copy of the bytes
    // (transferred, so the copy is not duplicated again in flight).
    const firstCopy = bytes.slice().buffer;
    const opened = await this.send(first, { type: 'open', bytes: firstCopy }, [firstCopy]);
    const manifest = opened.manifest;
    if (!manifest) throw new Error('worker returned no manifest');
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
      this.send(slot, { type: 'open', bytes: copy, manifest }, [copy]).then(
        () => {
          if (token === this.generation) slot.docGeneration = token;
        },
        (error) => {
          if (token === this.generation && !this.disposed) {
            console.warn('[pdfgpu] pdfium worker failed to open the document', error);
          }
        }
      );
    }
    return manifest;
  }

  async renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult> {
    this.assertPage(request.pageIndex);
    return this.render({ type: 'preview', pageIndex: request.pageIndex, dpi: request.dpi }, request.signal);
  }

  async renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult> {
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.manifest = null;
    this.terminateAll();
  }

  private async render(
    message: Extract<WorkerRequestBody, { type: 'preview' | 'tile' }>,
    signal?: AbortSignal
  ): Promise<PdfRasterResult> {
    if (signal?.aborted) throw abortError();
    const slot = this.pickSlot();
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
          slot.worker.postMessage({ id: -1, type: 'cancel', target: id });
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      slot.worker.postMessage({ ...message, id } as WorkerRequest, transfer);
    });
  }

  private createSlot(): Slot {
    const worker = this.options.createWorker();
    const slot: Slot = { worker, pending: new Map(), nextId: 1, dead: false, docGeneration: 0 };
    worker.addEventListener('message', (event) => {
      const response = event.data;
      const entry = slot.pending.get(response.id);
      if (!entry) return;
      slot.pending.delete(response.id);
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
        if (!entry.abandoned) entry.reject(error);
      }
      slot.pending.clear();
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

  private async closeDocuments() {
    await Promise.allSettled(this.liveSlots().map((slot) => this.send(slot, { type: 'close' })));
  }

  private terminateAll() {
    for (const slot of this.slots) {
      for (const entry of slot.pending.values()) {
        if (!entry.abandoned) entry.reject(abortError());
      }
      slot.pending.clear();
      slot.dead = true;
      slot.worker.terminate();
    }
  }

  private assertPage(pageIndex: number) {
    if (this.disposed) throw new Error('engine is disposed');
    if (!this.manifest) throw new Error('document not opened');
    if (pageIndex < 0 || pageIndex >= this.manifest.pageCount) {
      throw new Error(`invalid page index: ${pageIndex}`);
    }
  }
}
