import type { PdfRasterResult } from '../types.js';
import { previewTask, type DetailTask, type RasterTask } from './queue.js';

const DETAIL_DELAY = 200;
const PREFETCH_DELAY = 500;
const DIRECTIONS = [1, -1] as const;
type Direction = (typeof DIRECTIONS)[number];
const BACKWARD_FIRST = [-1, 1] as const;

export interface ViewerRasterSlot {
  id: number;
  role: 'forward' | 'backward' | 'detail' | 'shared';
  available: boolean;
}

interface Viewport {
  activePage: number;
  visiblePages: readonly number[];
  pageCount: number;
  detailTiles(): DetailTask[];
}

interface Host {
  slots(): ViewerRasterSlot[];
  render(slot: number, task: RasterTask, signal?: AbortSignal): Promise<PdfRasterResult> | undefined;
  has(task: RasterTask): boolean;
  canPrefetch(pageIndex: number, anchor: number, bytes?: number): boolean;
  cache(task: RasterTask, raster: PdfRasterResult, prefetchAnchor?: number): boolean;
  changed(pageIndex: number): void;
  failed(error: unknown): void;
  prefetchRadius: number;
  abortStale?: boolean;
}

interface Clock {
  now(): number;
  wake(callback: () => void, delay: number): () => void;
}

const clock: Clock = {
  now: () => performance.now(),
  wake(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

interface Running {
  task: RasterTask;
  document: number;
  controller?: AbortController;
}

/** Holds the latest view and one actual in-flight request per slot. */
export class ProgressiveRasterScheduler {
  private view?: Viewport;
  private lastPage?: number;
  private document = 0;
  private detailAfter = 0;
  private prefetchAfter?: number;
  private moved = false;
  private anchor?: number;
  private cursors = { 1: 0, '-1': 0 };
  private nextDirection: Direction = 1;
  private tiles?: DetailTask[];
  private detailSlot?: number;
  private cancelWake?: () => void;
  private pumping = false;
  private readonly running = new Map<number, Running>();
  private readonly failedPreviews = new Set<number>();
  private readonly failedDetails = new Set<string>();
  private readonly previewBytes = new Map<number, number>();

  constructor(private readonly host: Host, private readonly time: Clock = clock) {}

  invalidate(moved = false): void {
    this.view = undefined;
    this.tiles = undefined;
    this.detailSlot = undefined;
    this.failedDetails.clear();
    this.detailAfter = this.time.now() + DETAIL_DELAY;
    if (moved) {
      this.moved = true;
      this.prefetchAfter = this.time.now() + PREFETCH_DELAY;
    }
    this.cancelWake?.();
    this.cancelWake = undefined;
  }

  reset(): void {
    this.invalidate();
    this.document += 1;
    this.lastPage = undefined;
    this.anchor = undefined;
    this.nextDirection = 1;
    this.prefetchAfter = undefined;
    this.moved = false;
    this.failedPreviews.clear();
    this.previewBytes.clear();
    for (const work of this.running.values()) work.controller?.abort();
  }

  update(view: Viewport): void {
    if (this.prefetchAfter === undefined || (!this.moved && this.lastPage !== view.activePage)) {
      this.prefetchAfter = this.time.now() + PREFETCH_DELAY;
    }
    this.moved = false;
    this.lastPage = view.activePage;
    this.view = view;
    this.cancelObsoleteRemoteWork(view);
    this.pump();
  }

  previewFailed(pageIndex: number): boolean {
    return this.failedPreviews.has(pageIndex);
  }

  pump = (): void => {
    const view = this.view;
    if (this.pumping || !view?.visiblePages.length) return;
    this.pumping = true;
    try {
      const slots = this.host.slots();
      const low = slots.filter(({ role }) => role !== 'detail');
      for (const slot of low) {
        if (!this.available(slot)) continue;
        const task = view.visiblePages.map(previewTask).find((candidate) => this.needs(candidate));
        if (!task) break;
        this.start(slot, task);
      }

      const now = this.time.now();
      const prefetchAfter = this.prefetchAfter ?? now;
      if (now >= this.detailAfter) this.advanceDetail(view, slots.filter(({ role }) => role === 'detail' || role === 'shared'));
      if (now >= prefetchAfter) this.advancePrefetch(view, low);

      this.cancelWake?.();
      const nextWake = Math.min(this.detailAfter > now ? this.detailAfter : Infinity, prefetchAfter > now ? prefetchAfter : Infinity);
      this.cancelWake = nextWake < Infinity ? this.time.wake(this.pump, nextWake - now) : undefined;
    } finally {
      this.pumping = false;
    }
  };

  private available(slot: ViewerRasterSlot): boolean {
    return slot.available && !this.running.has(slot.id);
  }

  private needs(task: RasterTask): boolean {
    if (this.host.has(task)) return false;
    const failed = task.kind === 'preview' ? this.previewFailed(task.pageIndex) : this.failedDetails.has(task.key);
    return !failed && ![...this.running.values()].some((work) => work.document === this.document && work.task.key === task.key);
  }

  private advanceDetail(view: Viewport, slots: ViewerRasterSlot[]): void {
    const assigned = slots.find(({ id }) => id === this.detailSlot);
    const slot = assigned ?? slots.find((candidate) => this.available(candidate));
    if (!slot || !this.available(slot)) return;
    const task = this.detailTiles(view).find((tile) => this.needs(tile)
      && (this.previewFailed(tile.pageIndex) || this.host.has(previewTask(tile.pageIndex))));
    if (task && this.start(slot, task)) this.detailSlot = slot.id;
  }

  private detailTiles(view: Viewport): DetailTask[] {
    return this.tiles ??= view.detailTiles();
  }

  private advancePrefetch(view: Viewport, slots: ViewerRasterSlot[]): void {
    // Leave available preview capacity for the next frame when a visible
    // preview was unable to start, or is still being produced.
    if (view.visiblePages.some((page) => !this.previewFailed(page) && !this.host.has(previewTask(page)))) return;
    const anchor = view.activePage;
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      for (const direction of DIRECTIONS) this.cursors[direction] = anchor + direction;
    }
    const order = slots.length === 1 && this.nextDirection === -1 ? BACKWARD_FIRST : DIRECTIONS;
    for (const direction of order) {
      const role = direction === 1 ? 'forward' : 'backward';
      const dedicated = slots.find((slot) => slot.role === role);
      const slot = dedicated ?? slots.find((candidate) => this.available(candidate));
      if (!slot || !this.available(slot)) continue;
      const inside = (page: number) => page >= 0 && page < view.pageCount && Math.abs(page - anchor) <= this.host.prefetchRadius;
      let page = this.cursors[direction];
      while (inside(page) && (this.previewFailed(page) || this.host.has(previewTask(page)))) page += direction;
      this.cursors[direction] = page;
      if (!inside(page)) continue;
      const task = previewTask(page);
      if (this.needs(task) && this.host.canPrefetch(page, anchor, this.previewBytes.get(page)) && this.start(slot, task)) {
        this.nextDirection = direction === 1 ? -1 : 1;
      }
    }
  }

  private cancelObsoleteRemoteWork(view: Viewport): void {
    if (!this.host.abortStale) return;
    for (const work of this.running.values()) {
      if (work.document !== this.document || !work.controller) continue;
      const { task } = work;
      const wanted = task.kind === 'preview' ? view.visiblePages.includes(task.pageIndex)
        : this.detailTiles(view).some(({ key }) => key === task.key);
      if (!wanted) work.controller.abort();
    }
  }

  private start(slot: ViewerRasterSlot, task: RasterTask): boolean {
    const document = this.document;
    const controller = this.host.abortStale ? new AbortController() : undefined;
    let result: Promise<PdfRasterResult> | undefined;
    try {
      result = this.host.render(slot.id, task, controller?.signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    if (!result) return false;
    this.running.set(slot.id, { document, task, controller });
    void result.then((raster) => {
      if (document === this.document && !controller?.signal.aborted && !this.host.has(task)) {
        if (this.accept(task, raster)) return;
      }
      if (typeof ImageBitmap !== 'undefined' && raster.source instanceof ImageBitmap) raster.source.close();
    }, (error: unknown) => {
      if (document !== this.document || controller?.signal.aborted) return;
      // A failed worker doesn't make its page invalid. The next pump routes
      // the same key on another live slot.
      if (!this.host.slots().some(({ id }) => id === slot.id)) return;
      if (task.kind === 'preview') this.failedPreviews.add(task.pageIndex);
      else if (this.view && this.detailTiles(this.view).some(({ key }) => key === task.key)) this.failedDetails.add(task.key);
      this.host.failed(error);
    }).finally(() => {
      this.running.delete(slot.id);
      if (document === this.document) this.host.changed(task.pageIndex);
      this.pump();
    });
    return true;
  }

  private accept(task: RasterTask, raster: PdfRasterResult): boolean {
    const view = this.view;
    if (task.kind === 'detail') {
      if (!view || !this.detailTiles(view).some(({ key }) => key === task.key)) return false;
      if (this.host.cache(task, raster)) return true;
      this.failedDetails.add(task.key);
      return false;
    }
    const anchor = view?.activePage ?? this.lastPage;
    if (view?.visiblePages.includes(task.pageIndex)) return this.host.cache(task, raster);
    if (anchor === undefined || Math.abs(task.pageIndex - anchor) > this.host.prefetchRadius) return false;
    const accepted = this.host.cache(task, raster, anchor);
    if (!accepted) this.previewBytes.set(task.pageIndex, raster.width * raster.height * 4);
    return accepted;
  }
}
