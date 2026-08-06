import { buildLayout, resolveViewportWindow, visiblePageIndices, type LayoutMetrics } from '../layout/layout.js';
import { RasterCache, cacheKey } from '../scheduler/byteBudgetCache.js';
import { PageRenderer } from '../render/renderer.js';
import { buildRenderQueue, type QueueRenderTask } from '../scheduler/queue.js';
import {
  type PdfDocumentManifest,
  type PdfDocumentSource,
  type PdfGpuFitMode,
  type PdfGpuScrollMode,
  type PdfGpuSpreadPlacement,
  type PdfGpuViewMode,
  type PdfGpuViewerController,
  type PdfGpuViewerOptions,
  type PdfGpuViewerState,
  type PdfRasterProvider,
  type PdfLoadProgress
} from '../types.js';
import { normalizeDetailDpi } from '../engine/dpi.js';
import {
  createViewerInteractionState,
  normalizeViewerPage,
  reduceViewerInteraction,
  viewerModeFromParts,
  type ViewerInteractionState,
} from './interaction.js';

const DEFAULT_MIN_ZOOM = 0.25;
const DEFAULT_MAX_ZOOM = 8;
const DEFAULT_PAGE_GAP = 16;
const DEFAULT_SPREAD_GAP = 20;
const DEFAULT_OVERSCAN_PAGES = 2;
const DEFAULT_ZOOM_STEP = 1.1;
const BASE_PREVIEW_DPI = 96;
const DEFAULT_DETAIL_DPI = 192;
const LOAD_PARSE_PROGRESS = 35;
const LOAD_PARSE_TRANSITION_MS = 900;
const LOAD_READY_TRANSITION_MS = 1400;
const MAX_PENDING_QUEUE_TASKS = 96;
const INTERACTION_IDLE_MS = 140;

const VIEWPORT_REGION_ROLE = 'region';
const VIEWPORT_REGION_LABEL = 'PDF viewer';
const PAGE_TEXT_LAYER_TESTID = 'pdfgpu-text-layer';

type EngineWithQueueDepth = PdfRasterProvider & { queueDepth?: number };

type QueueTask = {
  key: string;
  kind: 'preview' | 'detail';
  pageIndex: number;
  dpi: number;
  tileX: number;
  tileY: number;
  tileWidth: number;
  tileHeight: number;
  priority: number;
};

type ViewportWindow = {
  from: number;
  to: number;
};

function clamp(min: number, max: number, value: number) {
  return Math.max(min, Math.min(max, value));
}

export async function createPdfGpuViewer(options: PdfGpuViewerOptions): Promise<PdfGpuViewerController> {
  const controller = new PdfGpuViewerControllerImpl(options);
  await controller.initialize();
  return controller;
}

class PdfGpuViewerControllerImpl implements PdfGpuViewerController {
  private readonly container: HTMLElement;
  private readonly engine: EngineWithQueueDepth;
  private readonly renderer: PageRenderer;
  private readonly cache: RasterCache;
  private readonly listeners = new Set<(state: PdfGpuViewerState) => void>();
  private readonly loadSignals = new Set<AbortController>();
  private readonly inFlightTasks = new Map<string, AbortController>();
  private readonly pageShells = new Map<number, HTMLElement>();

  private viewport: HTMLElement;
  private content: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private layout: LayoutMetrics = { pagePositions: [], totalHeight: 0, totalWidth: 0 };
  private queueDepth = 1;
  private queueRefreshToken = 0;
  private state: PdfGpuViewerState;
  private snapshot: PdfGpuViewerState;
  private disposed = false;
  private manifest: PdfDocumentManifest | null = null;
  private baseScale = 1;
  private currentBucketDpi = normalizeDetailDpi(DEFAULT_DETAIL_DPI);
  private detailDpi = normalizeDetailDpi(DEFAULT_DETAIL_DPI);
  private activePageIndex: number | undefined = undefined;
  private pageSizes: Array<{ width: number; height: number }> = [];
  private visiblePages: number[] = [];
  private initialPreviewPages = new Set<number>();
  private pendingLayout = false;
  private queuePumpScheduled = false;
  private readonly pendingQueueTasks = new Map<string, QueueTask>();
  private interaction: ViewerInteractionState;
  private interactionUntil = 0;
  private queueIdleTimerId: number | null = null;
  private minZoom = DEFAULT_MIN_ZOOM;
  private maxZoom = DEFAULT_MAX_ZOOM;
  private overscanPages = DEFAULT_OVERSCAN_PAGES;
  private pageGap = DEFAULT_PAGE_GAP;
  private spreadGap = DEFAULT_SPREAD_GAP;
  private rafId: number | null = null;
  private loadProgressRafId: number | null = null;
  private loadReadyAnimationRunning = false;

  constructor(options: PdfGpuViewerOptions) {
    this.container = options.container;
    this.engine = options.provider ?? options.engine;
    if (!this.engine) {
      throw new Error('PdfGpuViewerOptions.provider is required');
    }
    this.state = {
      backend: 'unsupported',
      zoom: options.initialZoom ?? 1,
      pageCount: 0,
      provider: options.providerKind ?? this.engine.kind ?? 'in-memory',
      engine: options.providerKind ?? this.engine.kind ?? 'in-memory',
      endpoint: this.engine.endpoint,
      viewMode: options.viewMode ?? 'single',
      spreadPlacement: options.spreadPlacement ?? 'first-right',
      fitMode: options.fitMode ?? 'none',
      scrollMode: options.scrollMode ?? 'continuous',
      queueDepth: 0,
      renderQuality: 'idle',
      detailDpi: normalizeDetailDpi(options.detailDpi ?? DEFAULT_DETAIL_DPI),
      visiblePages: [],
      loading: false,
      loadPhase: 'idle',
      loadProgress: 0,
      loadProgressDeterminate: false,
      loadedPages: 0,
      loadPageCount: 0,
      error: null,
      activePage: undefined
    };

    this.minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM;
    this.maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM;
    this.overscanPages = options.overscanPages ?? DEFAULT_OVERSCAN_PAGES;
    this.pageGap = options.pageGap ?? DEFAULT_PAGE_GAP;
    this.spreadGap = options.spreadGap ?? DEFAULT_SPREAD_GAP;
    this.detailDpi = this.state.detailDpi;
    this.currentBucketDpi = this.detailDpi;
    this.baseScale = this.state.zoom;

    this.viewport = options.container;
    this.content = document.createElement('div');
    this.canvas = document.createElement('canvas');

    this.renderer = new PageRenderer();
    this.cache = new RasterCache();

    const maxQueueDepth = this.engine.kind === 'in-memory' ? 1 : 3;
    this.queueDepth = clamp(1, maxQueueDepth, this.engine.queueDepth ?? 1);
    this.state.queueDepth = this.queueDepth;
    this.snapshot = { ...this.state, visiblePages: [] };
    this.interaction = createViewerInteractionState({
      pageCount: 0,
      mode: viewerModeFromParts(this.state.scrollMode, this.state.viewMode),
    });
  }

  async initialize(): Promise<void> {
    this.setContainerAria();

    this.content.style.position = 'relative';
    this.content.style.width = '100%';
    this.content.style.minHeight = '100%';
    this.content.style.overflowAnchor = 'none';

    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.position = 'sticky';
    this.canvas.style.left = '0';
    this.canvas.style.top = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '0';
    this.canvas.style.marginBottom = '0';
    this.canvas.style.display = 'block';
    this.canvas.style.pointerEvents = 'auto';
    this.canvas.style.zIndex = '1';

    this.viewport.innerHTML = '';
    // Keep the composited frame in the viewport's coordinate space. Putting it
    // inside the scrolling content makes it move with the scroll first and
    // catch up on the next animation frame, which produces a visible jump at
    // the viewport's top edge.
    this.viewport.appendChild(this.canvas);
    this.viewport.appendChild(this.content);
    this.bindEvents();

    this.state.backend = await this.renderer.init(this.canvas);
    this.state.renderQuality = 'idle';
    this.notify();
  }

  load(source: PdfDocumentSource): Promise<void> {
    return this.loadInternal(source);
  }

  setZoom(value: number): void {
    this.assertAlive();
    const next = clamp(this.minZoom, this.maxZoom, value);
    if (next === this.state.zoom) return;
    this.state.zoom = next;
    this.state.fitMode = 'none';
    this.baseScale = next;
    this.currentBucketDpi = this.detailDpi;
    this.state.renderQuality = this.currentBucketDpi > BASE_PREVIEW_DPI ? 'detail' : 'preview';

    this.rebuildLayout();
    this.pendingQueueTasks.clear();
    this.applyVisibleShells();
    this.scheduleUpdate();
    this.notify();
  }

  zoomIn(): void {
    this.setZoom(this.state.zoom * DEFAULT_ZOOM_STEP);
  }

  zoomOut(): void {
    this.setZoom(this.state.zoom / DEFAULT_ZOOM_STEP);
  }

  setViewMode(mode: PdfGpuViewMode): void {
    this.assertAlive();
    if (this.state.viewMode === mode) return;
    this.state.viewMode = mode;
    this.syncInteractionMode();
    this.reapplyFitOrLayout();
  }

  setSpreadPlacement(placement: PdfGpuSpreadPlacement): void {
    this.assertAlive();
    if (this.state.spreadPlacement === placement) return;
    this.state.spreadPlacement = placement;
    this.reapplyFitOrLayout();
  }

  setFitMode(mode: PdfGpuFitMode): void {
    this.assertAlive();
    this.state.fitMode = mode;
    if (mode === 'width') this.applyZoom(this.computeFitWidthZoom(), mode);
    else if (mode === 'height') this.applyZoom(this.computeFitHeightZoom(), mode);
    else if (mode === 'page') this.applyZoom(Math.min(this.computeFitWidthZoom(), this.computeFitHeightZoom()), mode);
    else this.rebuildAndRefresh();
  }

  setScrollMode(mode: PdfGpuScrollMode): void {
    this.assertAlive();
    if (this.state.scrollMode === mode) return;
    this.state.scrollMode = mode;
    this.syncInteractionMode();
    this.notify();
  }

  setDetailDpi(dpi: number): void {
    this.assertAlive();
    const next = normalizeDetailDpi(dpi);
    if (this.detailDpi === next) return;
    this.detailDpi = next;
    this.currentBucketDpi = next;
    this.state.detailDpi = next;
    this.state.renderQuality = 'detail';
    this.pendingQueueTasks.clear();
    this.scheduleUpdate();
    this.notify();
  }

  fitWidth(): void {
    this.state.fitMode = 'width';
    this.applyZoom(this.computeFitWidthZoom(), 'width');
  }

  fitHeight(): void {
    this.state.fitMode = 'height';
    this.applyZoom(this.computeFitHeightZoom(), 'height');
  }

  fitPage(): void {
    this.state.fitMode = 'page';
    this.applyZoom(Math.min(this.computeFitWidthZoom(), this.computeFitHeightZoom()), 'page');
  }

  scrollToPage(index: number): void {
    if (!this.manifest) return;
    const targetPage = normalizeViewerPage(index + 1, this.manifest.pageCount, this.interaction.mode);
    this.interaction = reduceViewerInteraction(this.interaction, { type: 'setPage', page: targetPage }).state;
    const target = targetPage - 1;
    const position = this.layout.pagePositions[target];
    if (!position) return;
    this.activePageIndex = target;
    this.state.activePage = targetPage;
    this.viewport.scrollTop = Math.max(
      0,
      position.top + position.height / 2 - (this.viewport.clientHeight || 1) / 2,
    );
    this.scheduleUpdate();
    this.notify();
  }

  getState(): PdfGpuViewerState {
    return this.snapshot;
  }

  subscribe(listener: (state: PdfGpuViewerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.loadProgressRafId !== null) {
      cancelAnimationFrame(this.loadProgressRafId);
      this.loadProgressRafId = null;
    }
    this.loadReadyAnimationRunning = false;
    if (this.queueIdleTimerId !== null) {
      window.clearTimeout(this.queueIdleTimerId);
      this.queueIdleTimerId = null;
    }
    this.cancelQueue();
    this.listeners.clear();

    this.viewport.removeEventListener('scroll', this.onScroll);
    this.viewport.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);

    this.renderer.dispose();
    this.engine.dispose();
    this.cache.clear();
    this.clearShells();
    this.manifest = null;
    this.state = {
      backend: this.state.backend,
      zoom: this.state.zoom,
      pageCount: 0,
      provider: this.state.provider,
      engine: this.state.engine,
      endpoint: this.state.endpoint,
      viewMode: this.state.viewMode,
      spreadPlacement: this.state.spreadPlacement,
      fitMode: this.state.fitMode,
      scrollMode: this.state.scrollMode,
      queueDepth: this.queueDepth,
      renderQuality: 'idle',
      detailDpi: this.detailDpi,
      visiblePages: [],
      loading: false,
      loadPhase: 'idle',
      loadProgress: 0,
      loadProgressDeterminate: false,
      loadedPages: 0,
      loadPageCount: 0,
      error: null,
      activePage: undefined
    };
    this.snapshot = { ...this.state, visiblePages: [] };
    this.viewport.replaceChildren();
  }

  private async loadInternal(source: PdfDocumentSource): Promise<void> {
    this.assertAlive();
    this.cancelQueue();
    if (this.loadProgressRafId !== null) {
      cancelAnimationFrame(this.loadProgressRafId);
      this.loadProgressRafId = null;
    }
    this.cache.clear();
    this.clearShells();
    this.state.loading = true;
    this.state.loadPhase = 'opening';
    this.state.loadProgress = 0;
    this.state.loadProgressDeterminate = false;
    this.state.loadedPages = 0;
    this.state.loadPageCount = 0;
    this.initialPreviewPages.clear();
    this.state.error = null;
    this.state.renderQuality = 'preview';
    this.visiblePages = [];
    this.state.visiblePages = [];
    this.notify();

    const openSignal = new AbortController();
    this.loadSignals.add(openSignal);
    const token = ++this.queueRefreshToken;
    try {
      const manifest = await this.engine.open(source, (progress: PdfLoadProgress) => {
        this.state.loadProgressDeterminate = progress.ratio !== undefined;
        if (progress.ratio !== undefined) {
          this.state.loadProgress = Math.min(34, Math.round(progress.ratio * 34));
        }
        this.notify();
      });
      if (openSignal.signal.aborted || token !== this.queueRefreshToken || this.disposed) {
        throw new DOMException('load aborted', 'AbortError');
      }

      this.manifest = manifest;
      this.interaction = reduceViewerInteraction(this.interaction, {
        type: 'setPageCount',
        pageCount: manifest.pageCount,
      }).state;
      this.pageSizes = manifest.pages.map((page) => ({
        width: Math.max(1, Math.round(page.widthPts * BASE_PREVIEW_DPI / 72)),
        height: Math.max(1, Math.round(page.heightPts * BASE_PREVIEW_DPI / 72))
      }));
      this.currentBucketDpi = this.detailDpi;
      this.state.renderQuality = this.currentBucketDpi > BASE_PREVIEW_DPI ? 'detail' : 'preview';
      this.state.pageCount = manifest.pageCount;
      this.state.loadPageCount = manifest.pageCount;
      this.state.loadPhase = 'rendering';
      this.state.loadProgressDeterminate = true;
      this.animateLoadProgressTo(LOAD_PARSE_PROGRESS);
      this.rebuildLayout();
      this.activePageIndex = manifest.pageCount > 0 ? 0 : undefined;
      this.state.activePage = this.activePageIndex !== undefined ? this.activePageIndex + 1 : undefined;
      this.state.loading = false;
      this.notify();
      this.cancelQueue();
      this.scheduleUpdate();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.state.loading = false;
        this.state.loadPhase = 'idle';
        this.state.loadProgress = 0;
        this.state.loadProgressDeterminate = false;
        this.notify();
        return;
      }
      if (this.disposed || token !== this.queueRefreshToken) return;
      this.state.loading = false;
      this.state.loadPhase = 'error';
      this.state.error = error instanceof Error ? error.name + ': ' + error.message : 'failed to open document';
      this.notify();
      throw error;
    } finally {
      this.loadSignals.delete(openSignal);
    }
  }

  private renderCycle = () => {
    this.rafId = null;
    if (this.disposed || this.state.loading || !this.manifest) return;

    const window = resolveViewportWindow(
      this.layout.pagePositions,
      this.viewport.clientHeight || 1,
      this.viewport.scrollTop,
      this.overscanPages
    );
    this.visiblePages = visiblePageIndices(this.layout.pagePositions, window);
    if (this.state.loadPhase === 'rendering' && this.initialPreviewPages.size === 0) {
      this.initialPreviewPages = new Set(this.visiblePages);
      this.updateLoadProgress();
    }
    const active = this.interaction.mode === 'scroll'
      ? this.chooseActivePage(this.visiblePages, window)
      : this.interaction.page - 1;
    const normalizedActive = active === undefined
      ? undefined
      : normalizeViewerPage(active + 1, this.manifest.pageCount, this.interaction.mode) - 1;
    this.activePageIndex = normalizedActive;
    this.state.visiblePages = [...this.visiblePages];
    this.state.activePage = normalizedActive !== undefined ? normalizedActive + 1 : this.state.activePage;
    if (normalizedActive !== undefined) {
      this.interaction = reduceViewerInteraction(this.interaction, {
        type: 'setPage',
        page: normalizedActive + 1,
      }).state;
    }
    this.state.renderQuality = this.currentBucketDpi > BASE_PREVIEW_DPI ? 'detail' : 'preview';

    this.applyVisibleShells();
    this.requestQueue(this.visiblePages);
    this.applyCompositedFrame(this.visiblePages);
    this.notify();
  };

  private requestQueue(visiblePages: number[]): void {
    if (!this.manifest) return;
    const window = resolveViewportWindow(
      this.layout.pagePositions,
      this.viewport.clientHeight || 1,
      this.viewport.scrollTop,
      this.overscanPages
    );
    const tasks = buildRenderQueue({
      layout: this.layout,
      pageCount: this.pageSizes.length,
      visiblePages,
      activePage: this.activePageIndex,
      viewportTop: this.viewport.scrollTop,
      viewportHeight: this.viewport.clientHeight,
      qualityDpi: this.currentBucketDpi,
      // `page.width`/`page.height` are already layout dimensions and include
      // the current zoom. Detail raster coordinates, however, are in the
      // provider's native DPI space. Do not divide by baseScale here: doing
      // so makes the tile grid stop short of the page whenever zoom > 1 and
      // leaves the uncovered area showing the low-resolution preview.
      sourceScale: this.currentBucketDpi / BASE_PREVIEW_DPI
    });

    const tasksToRun = this.toRenderTaskList(tasks);
    const desiredKeys = new Set(tasksToRun.map((task) => task.key));
    this.cancelStaleQueueWork(desiredKeys);
    const keepKeys = this.collectKeepKeys(visiblePages);
    this.cache.prune(keepKeys);

    for (const task of tasksToRun) {
      if (this.cache.has(task.key) || this.inFlightTasks.has(task.key)) continue;
      const existing = this.pendingQueueTasks.get(task.key);
      if (!existing || task.priority < existing.priority) {
        this.pendingQueueTasks.set(task.key, task);
      }
    }

    this.trimPendingQueue();
    this.pumpBackgroundQueue();
  }

  private pumpBackgroundQueue(): void {
    if (this.disposed || this.queuePumpScheduled) return;
    const idleDelay = this.interactionUntil - performance.now();
    if (idleDelay > 0) {
      if (this.queueIdleTimerId !== null) {
        window.clearTimeout(this.queueIdleTimerId);
      }
      this.queueIdleTimerId = window.setTimeout(() => {
        this.queueIdleTimerId = null;
        this.pumpBackgroundQueue();
      }, Math.ceil(idleDelay));
      return;
    }

    this.queuePumpScheduled = true;
    window.setTimeout(() => {
      this.queuePumpScheduled = false;
      if (this.disposed) return;

      const parallelLimit = Math.max(1, this.queueDepth);
      while (this.inFlightTasks.size < parallelLimit) {
        const task = this.takeNextPendingTask();
        if (!task) return;
        void this.startRenderTask(task, this.queueRefreshToken).finally(() => {
          this.pumpBackgroundQueue();
        });
      }
    }, 0);
  }

  private takeNextPendingTask(): QueueTask | undefined {
    let selected: QueueTask | undefined;
    for (const task of this.pendingQueueTasks.values()) {
      if (!selected || task.priority < selected.priority) {
        selected = task;
      }
    }
    if (selected) {
      this.pendingQueueTasks.delete(selected.key);
    }
    return selected;
  }

  private trimPendingQueue(): void {
    if (this.pendingQueueTasks.size <= MAX_PENDING_QUEUE_TASKS) return;
    const keep = [...this.pendingQueueTasks.values()]
      .sort((a, b) => a.priority - b.priority)
      .slice(0, MAX_PENDING_QUEUE_TASKS);
    this.pendingQueueTasks.clear();
    for (const task of keep) {
      this.pendingQueueTasks.set(task.key, task);
    }
  }

  private startRenderTask(task: QueueTask, token: number): Promise<void> {
    if (this.disposed || token !== this.queueRefreshToken) return Promise.resolve();
    const key = task.key;
    if (this.cache.has(key) || this.inFlightTasks.has(key)) return Promise.resolve();

    const controller = new AbortController();
    this.inFlightTasks.set(key, controller);

    const complete = async () => {
      try {
        await this.deferRasterStart();
        if (token !== this.queueRefreshToken || this.disposed) return;
        if (performance.now() < this.interactionUntil) {
          this.pendingQueueTasks.set(task.key, task);
          return;
        }

        const result =
          task.kind === 'preview'
            ? await this.engine.renderPreview({
                pageIndex: task.pageIndex,
                signal: controller.signal
              })
            : await this.engine.renderTile({
                pageIndex: task.pageIndex,
                dpi: task.dpi,
                tileX: task.tileX,
                tileY: task.tileY,
                tileWidth: task.tileWidth,
                tileHeight: task.tileHeight,
                signal: controller.signal
              });

        if (controller.signal.aborted || token !== this.queueRefreshToken || this.disposed) {
          if (result.source instanceof ImageBitmap) {
            result.source.close();
          }
          return;
        }

        const protectedKeys = this.collectKeepKeys(this.visiblePages);
        protectedKeys.add(key);
        this.cache.set({
          kind: task.kind,
          pageIndex: task.pageIndex,
          dpi: result.dpi,
          tileX: result.tileX ?? 0,
          tileY: result.tileY ?? 0,
          tileWidth: result.tileWidth ?? 0,
          tileHeight: result.tileHeight ?? 0,
          source: result.source,
          width: result.width,
          height: result.height,
          sourceWidth: result.width,
          sourceHeight: result.height,
          dpiRounded: normalizeDetailDpi(result.dpi),
          key
        }, protectedKeys);
        if (this.visiblePages.includes(task.pageIndex)) {
          this.applyCompositedFrame(this.visiblePages);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('[pdfgpu] render failed', error);
      } finally {
        this.inFlightTasks.delete(key);
        this.applyShellState(task.pageIndex);
        this.updateLoadProgress();
        this.notify();
      }
    };

    return complete();
  }

  private deferRasterStart(): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }

  private applyVisibleShells() {
    if (!this.manifest) return;
    const keep = this.computeShellWindowPages(this.visiblePages, this.activePageIndex);
    const keepSet = new Set<number>(keep);
    const seen = new Set<number>(keep);

    for (const index of keep) {
      this.getOrCreateShell(index);
      const position = this.layout.pagePositions[index];
      if (!position) continue;
      const shell = this.pageShells.get(index);
      if (!shell) continue;

      shell.style.top = `${Math.round(position.top)}px`;
      shell.style.left = `${Math.round(position.left)}px`;
      shell.style.width = `${Math.round(position.width)}px`;
      shell.style.height = `${Math.max(1, Math.round(position.height))}px`;
      shell.style.position = 'absolute';
      shell.dataset.pageIndex = String(index);
      this.updateShellStateByContent(index, this.pageHasDetail(index) ? 'detail' : this.pageHasPreview(index) ? 'preview' : 'idle');

      if (!shell.parentElement) {
        this.content.appendChild(shell);
      }
    }

    for (const [pageIndex, shell] of this.pageShells) {
      if (!keepSet.has(pageIndex)) {
        shell.remove();
        this.pageShells.delete(pageIndex);
      } else if (!seen.has(pageIndex)) {
        seen.add(pageIndex);
      }
    }
  }

  private applyCompositedFrame(visiblePages: number[]) {
    if (!this.manifest) return;
    const width = Math.max(1, Math.ceil(this.viewport.clientWidth || 1));
    const height = Math.max(1, Math.ceil(this.viewport.clientHeight || 1));
    const viewportTop = Math.max(0, this.viewport.scrollTop || 0);

    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    // The sticky canvas is an overlay; cancel its flow height so the first
    // page keeps the same top coordinate as the scroll content.
    this.canvas.style.marginBottom = `${-height}px`;
    this.canvas.style.top = '0';
    this.canvas.style.transform = 'none';

    const tiles = [];
    const visibleSet = new Set(visiblePages);
    const detailByPage = new Map<number, ReturnType<RasterCache['values']>>();
    for (const entry of this.cache.values()) {
      if (!visibleSet.has(entry.pageIndex)) continue;
      if (entry.kind !== 'detail') continue;
      if (entry.dpi !== this.currentBucketDpi) continue;
      const pageEntries = detailByPage.get(entry.pageIndex);
      if (pageEntries) pageEntries.push(entry);
      else detailByPage.set(entry.pageIndex, [entry]);
    }

    for (const pageIndex of visiblePages) {
      const page = this.layout.pagePositions[pageIndex];
      if (!page) continue;

      const pageLeft = page.left;
      const preview = this.cache.get(
        cacheKey({
          kind: 'preview',
          pageIndex,
          dpiBucket: BASE_PREVIEW_DPI,
          tileX: 0,
          tileY: 0
        })
      );

      if (preview) {
        tiles.push({
          source: preview.source,
          left: Math.round(pageLeft),
          top: Math.round(page.top - viewportTop),
          width: Math.round(page.width),
          height: Math.round(page.height)
        });
      }

      for (const entry of detailByPage.get(pageIndex) ?? []) {
        const scale = this.baseScale * BASE_PREVIEW_DPI / entry.dpi;
        tiles.push({
          source: entry.source,
          left: Math.round(pageLeft + entry.tileX * scale),
          top: Math.round(page.top + entry.tileY * scale - viewportTop),
          width: Math.max(1, Math.round(entry.width * scale)),
          height: Math.max(1, Math.round(entry.height * scale))
        });
      }

      this.updateShellStateByContent(pageIndex, preview ? 'preview' : 'idle');
    }

    const visibleHasDetail = visiblePages.some((pageIndex) => this.pageHasDetail(pageIndex));
    if (visibleHasDetail) {
      this.state.renderQuality = 'detail';
    } else if (visiblePages.length) {
      this.state.renderQuality = 'preview';
    }

    this.state.backend = this.renderer.state;
    this.renderer.render(this.canvas, {
      width,
      height,
      tiles
    });
  }

  private collectKeepKeys(visiblePages: number[]): Set<string> {
    const keep = new Set<string>();
    const keepPages = new Set<number>(visiblePages);
    if (this.activePageIndex !== undefined) {
      keepPages.add(this.activePageIndex);
      if (this.activePageIndex > 0) keepPages.add(this.activePageIndex - 1);
      if (this.activePageIndex + 1 < (this.manifest?.pageCount ?? 0)) keepPages.add(this.activePageIndex + 1);
    }

    for (const pageIndex of keepPages) {
      keep.add(
        cacheKey({
          kind: 'preview',
          pageIndex,
          dpiBucket: BASE_PREVIEW_DPI,
          tileX: 0,
          tileY: 0
        })
      );
    }

    for (const entry of this.cache.values()) {
      if (!entry.key) continue;
      if (keepPages.has(entry.pageIndex) && entry.kind === 'detail') {
        keep.add(entry.key);
      }
    }

    return keep;
  }

  private cancelStaleQueueWork(desiredKeys: ReadonlySet<string>): void {
    for (const key of this.pendingQueueTasks.keys()) {
      if (!desiredKeys.has(key)) {
        this.pendingQueueTasks.delete(key);
      }
    }

    for (const [key, signal] of this.inFlightTasks) {
      if (!desiredKeys.has(key)) {
        signal.abort();
      }
    }
  }

  private toRenderTaskList(tasks: QueueRenderTask[]): QueueTask[] {
    const deduped = new Map<string, QueueTask>();
    for (const task of tasks) {
      deduped.set(task.key, task);
    }
    return [...deduped.values()];
  }

  private pageHasPreview(pageIndex: number): boolean {
    const key = cacheKey({
      kind: 'preview',
      pageIndex,
      dpiBucket: BASE_PREVIEW_DPI,
      tileX: 0,
      tileY: 0
    });
    return this.cache.has(key);
  }

  private updateLoadProgress(): void {
    if (this.state.loadPhase !== 'rendering' || this.initialPreviewPages.size === 0) return;
    const loadedPages = [...this.initialPreviewPages].filter((pageIndex) => this.pageHasPreview(pageIndex)).length;
    this.state.loadedPages = loadedPages;
    if (this.state.loadProgress < LOAD_PARSE_PROGRESS) return;
    if (loadedPages >= this.initialPreviewPages.size) {
      if (!this.loadReadyAnimationRunning) {
        this.loadReadyAnimationRunning = true;
        this.animateLoadProgressTo(100, LOAD_READY_TRANSITION_MS, () => {
          this.loadReadyAnimationRunning = false;
          if (this.state.loadPhase !== 'rendering') return;
          this.state.loadProgress = 100;
          this.state.loadPhase = 'ready';
          this.notify();
        });
      }
      return;
    }
    this.state.loadProgress = Math.min(99, LOAD_PARSE_PROGRESS + Math.round((loadedPages / this.initialPreviewPages.size) * (100 - LOAD_PARSE_PROGRESS)));
  }

  private animateLoadProgressTo(target: number, duration = LOAD_PARSE_TRANSITION_MS, onComplete?: () => void): void {
    if (this.loadProgressRafId !== null) {
      cancelAnimationFrame(this.loadProgressRafId);
      this.loadProgressRafId = null;
    }
    const start = this.state.loadProgress;
    if (start >= target) {
      this.state.loadProgress = target;
      onComplete?.();
      if (!onComplete) this.updateLoadProgress();
      this.notify();
      return;
    }
    const startedAt = performance.now();
    const tick = (now: number) => {
      if (this.disposed) return;
      const ratio = Math.min(1, (now - startedAt) / duration);
      this.state.loadProgress = Math.round(start + (target - start) * ratio);
      this.notify();
      if (ratio < 1) {
        this.loadProgressRafId = requestAnimationFrame(tick);
      } else {
        this.loadProgressRafId = null;
        if (onComplete) onComplete();
        else this.updateLoadProgress();
        this.notify();
      }
    };
    this.loadProgressRafId = requestAnimationFrame(tick);
  }

  private pageHasDetail(pageIndex: number): boolean {
    const details = this.cache.values().filter((entry) => entry.pageIndex === pageIndex);
    return details.some((entry) => entry.kind === 'detail' && entry.dpi === this.currentBucketDpi);
  }

  private updateShellStateByContent(pageIndex: number, state: 'idle' | 'preview' | 'detail') {
    const shell = this.pageShells.get(pageIndex);
    if (!shell) return;
    shell.dataset.renderState = state;
    shell.style.background = state === 'idle' ? '#fff' : 'transparent';
  }

  private applyShellState(pageIndex: number) {
    const hasDetail = this.pageHasDetail(pageIndex);
    const hasPreview = this.pageHasPreview(pageIndex);
    this.updateShellStateByContent(pageIndex, hasDetail ? 'detail' : hasPreview ? 'preview' : 'idle');
  }

  private getOrCreateShell(pageIndex: number): HTMLElement {
    const existing = this.pageShells.get(pageIndex);
    if (existing) return existing;

    const shell = document.createElement('div');
    shell.dataset.pdfgpuPageShell = 'true';
    shell.setAttribute('data-testid', 'pdfgpu-page-shell');
    shell.setAttribute('data-page-index', String(pageIndex));
    shell.dataset.renderState = 'idle';
    shell.style.position = 'absolute';
    shell.style.pointerEvents = 'none';
    shell.style.overflow = 'hidden';
    shell.style.background = '#fff';
    shell.style.boxShadow = '0 0 0 1px rgba(35, 61, 120, 0.12)';
    shell.style.willChange = 'transform';
    shell.style.zIndex = '2';

    const textLayer = document.createElement('div');
    textLayer.setAttribute('data-testid', PAGE_TEXT_LAYER_TESTID);
    textLayer.setAttribute('data-page-index', String(pageIndex));
    textLayer.setAttribute('aria-hidden', 'true');
    textLayer.setAttribute('inert', 'true');
    textLayer.style.position = 'absolute';
    textLayer.style.left = '0';
    textLayer.style.top = '0';
    textLayer.style.right = '0';
    textLayer.style.bottom = '0';
    textLayer.style.opacity = '0';
    textLayer.style.pointerEvents = 'none';
    shell.appendChild(textLayer);

    this.pageShells.set(pageIndex, shell);
    return shell;
  }

  private clearShells() {
    for (const shell of this.pageShells.values()) {
      shell.remove();
    }
    this.pageShells.clear();
  }

  private computeShellWindowPages(visiblePages: number[], activePage: number | undefined): number[] {
    const result = new Set<number>(visiblePages);
    if (activePage !== undefined) {
      result.add(activePage);
      if (activePage > 0) result.add(activePage - 1);
      if (activePage + 1 < (this.manifest?.pageCount ?? 0)) result.add(activePage + 1);
    }
    return [...result].sort((a, b) => a - b);
  }

  private rebuildLayout(): LayoutMetrics {
    const map = new Map<number, { baseWidth: number; baseHeight: number }>();
    for (let i = 0; i < this.pageSizes.length; i += 1) {
      const pageSize = this.pageSizes[i];
      if (!pageSize) continue;
      map.set(i, { baseWidth: pageSize.width, baseHeight: pageSize.height });
    }
    this.layout = buildLayout(this.pageSizes.length, map, this.baseScale, this.pageGap, {
      viewMode: this.state.viewMode,
      spreadPlacement: this.state.spreadPlacement,
      spreadGap: this.spreadGap,
      viewportWidth: this.viewport.clientWidth || 1
    });
    this.content.style.height = `${Math.max(1, this.layout.totalHeight)}px`;
    return this.layout;
  }

  private applyZoom(value: number, fitMode: PdfGpuFitMode): void {
    this.assertAlive();
    const next = clamp(this.minZoom, this.maxZoom, value);
    if (!Number.isFinite(next) || next <= 0) return;
    if (next === this.state.zoom && this.state.fitMode === fitMode) {
      this.rebuildAndRefresh();
      return;
    }
    this.state.zoom = next;
    this.state.fitMode = fitMode;
    this.baseScale = next;
    this.currentBucketDpi = this.detailDpi;
    this.state.renderQuality = this.currentBucketDpi > BASE_PREVIEW_DPI ? 'detail' : 'preview';
    this.rebuildAndRefresh();
  }

  private reapplyFitOrLayout(): void {
    if (this.state.fitMode !== 'none') {
      this.setFitMode(this.state.fitMode);
      return;
    }
    this.rebuildAndRefresh();
  }

  private rebuildAndRefresh(): void {
    this.rebuildLayout();
    this.pendingQueueTasks.clear();
    this.applyVisibleShells();
    this.scheduleUpdate();
    this.notify();
  }

  private computeFitWidthZoom(): number {
    if (!this.pageSizes.length || !this.viewport.clientWidth) return this.state.zoom;
    const viewportWidth = Math.max(1, this.viewport.clientWidth);
    return viewportWidth / this.intrinsicMaxRowWidth();
  }

  private computeFitHeightZoom(): number {
    if (!this.pageSizes.length || !this.viewport.clientHeight) return this.state.zoom;
    const viewportHeight = Math.max(1, this.viewport.clientHeight);
    return viewportHeight / this.intrinsicMaxRowHeight();
  }

  private intrinsicMaxRowWidth(): number {
    if (this.state.viewMode === 'single') {
      return Math.max(...this.pageSizes.map((page) => page.width), 1);
    }
    const spreadGap = this.spreadGap;
    let maxWidth = 1;
    if (this.pageSizes[0]) {
      maxWidth = Math.max(
        maxWidth,
        this.state.spreadPlacement === 'first-right'
          ? this.pageSizes[0].width * 2 + spreadGap
          : this.pageSizes[0].width
      );
    }
    for (let index = 1; index < this.pageSizes.length; index += 2) {
      const left = this.pageSizes[index];
      const right = this.pageSizes[index + 1];
      if (!left) continue;
      maxWidth = Math.max(maxWidth, left.width + (right ? spreadGap + right.width : 0));
    }
    return maxWidth;
  }

  private intrinsicMaxRowHeight(): number {
    if (this.state.viewMode === 'single') {
      return Math.max(...this.pageSizes.map((page) => page.height), 1);
    }
    let maxHeight = this.pageSizes[0]?.height ?? 1;
    for (let index = 1; index < this.pageSizes.length; index += 2) {
      const left = this.pageSizes[index];
      const right = this.pageSizes[index + 1];
      if (!left) continue;
      maxHeight = Math.max(maxHeight, left.height, right?.height ?? 0);
    }
    return maxHeight;
  }

  private chooseActivePage(visiblePages: number[], _window: ViewportWindow): number | undefined {
    if (!visiblePages.length) return undefined;
    if (this.layout.pagePositions.length === 0) return visiblePages[0];

    const viewportCenter = this.viewport.scrollTop + (this.viewport.clientHeight || 1) / 2;
    let best = visiblePages[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const pageIndex of visiblePages) {
      const page = this.layout.pagePositions[pageIndex];
      if (!page) continue;
      const center = page.top + page.height / 2;
      const distance = Math.abs(center - viewportCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = pageIndex;
      }
    }
    return best;
  }

  private scheduleUpdate() {
    if (this.pendingLayout) return;
    this.pendingLayout = true;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.pendingLayout = false;
      this.renderCycle();
    });
  }

  private cancelQueue() {
    this.queueRefreshToken += 1;
    this.pendingQueueTasks.clear();
    for (const signal of this.loadSignals) {
      signal.abort();
    }
    this.loadSignals.clear();
    for (const controller of this.inFlightTasks.values()) {
      controller.abort();
    }
    this.inFlightTasks.clear();
  }

  private notify() {
    this.snapshot = {
      ...this.state,
      visiblePages: [...this.visiblePages]
    };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private onScroll = () => {
    this.markActiveInteraction();
    this.scheduleUpdate();
  };

  private onWheel = (event: WheelEvent) => {
    this.markActiveInteraction();
    const transition = reduceViewerInteraction(this.interaction, {
      type: 'wheel',
      deltaY: event.deltaY,
      ctrlKey: event.ctrlKey,
    });
    this.interaction = transition.state;
    if (transition.preventDefault) event.preventDefault();
    for (const effect of transition.effects) {
      if (effect.type === 'zoom') {
        if (effect.direction === 'in') this.zoomIn();
        else this.zoomOut();
      } else if (effect.type === 'navigate') {
        this.scrollToPage(effect.page - 1);
      }
    }
  };

  private markActiveInteraction() {
    this.interactionUntil = performance.now() + INTERACTION_IDLE_MS;
  }

  private onResize = () => {
    if (this.disposed) return;
    if (this.state.fitMode !== 'none') {
      this.setFitMode(this.state.fitMode);
      return;
    }
    this.rebuildLayout();
    this.applyVisibleShells();
    this.applyCompositedFrame(this.visiblePages);
    this.scheduleUpdate();
  };

  private bindEvents() {
    this.viewport.addEventListener('scroll', this.onScroll);
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('resize', this.onResize);
  }

  private setContainerAria() {
    this.viewport.style.position = this.viewport.style.position || 'relative';
    this.viewport.style.overflow = this.viewport.style.overflow || 'auto';
    this.viewport.style.overflowX = 'hidden';
    this.viewport.style.overflowY = 'auto';
    this.viewport.style.overflowAnchor = 'none';
    this.viewport.style.overscrollBehavior = 'contain';
    this.viewport.tabIndex = 0;
    this.viewport.setAttribute('role', VIEWPORT_REGION_ROLE);
    this.viewport.setAttribute('aria-label', VIEWPORT_REGION_LABEL);
    this.viewport.dataset.pdfgpuViewport = 'true';
  }

  private syncInteractionMode() {
    this.interaction = reduceViewerInteraction(this.interaction, {
      type: 'setMode',
      mode: viewerModeFromParts(this.state.scrollMode, this.state.viewMode),
    }).state;
    if (this.interaction.pageCount > 0) {
      this.state.activePage = this.interaction.page;
      this.activePageIndex = this.interaction.page - 1;
    }
  }

  private assertAlive() {
    if (this.disposed) throw new Error('viewer controller is disposed');
  }
}
