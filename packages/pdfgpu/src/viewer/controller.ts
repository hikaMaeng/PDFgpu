import { buildLayout, resolveViewportWindow, spreadRows, visiblePageIndices, windowPageIndices, type LayoutMetrics } from '../layout/layout.js';
import { findPageAtViewportPoint, projectOverlaysForVisiblePages, screenRectToAbsoluteRect } from './coordinates.js';
import { RasterCache } from '../scheduler/byteBudgetCache.js';
import { DEFAULT_COLOR_ADJUSTMENTS, updateColorAdjustments } from '../render/colorAdjustments.js';
import { PageRenderer } from '../render/renderer.js';
import { detailSourceScale, detailTileVisible, previewTask, PREVIEW_DPI, visibleDetailTiles, type RasterTask, type ViewportBounds } from '../scheduler/queue.js';
import { ProgressiveRasterScheduler, type ViewerRasterSlot } from '../scheduler/progressive.js';
import { WorkerPoolPdfEngine } from '../engine/workerPoolEngine.js';
import { captureSourceRect } from './capture.js';
import {
  type PdfDocumentManifest,
  type PdfDocumentSource,
  type PdfGpuColorAdjustmentState,
  type PdfGpuColorAdjustments,
  type PdfGpuFitMode,
  type PdfGpuScrollMode,
  type PdfGpuSpreadPlacement,
  type PdfGpuSpreadPairing,
  type PdfGpuViewMode,
  type PdfGpuViewerController,
  type PdfGpuCaptureController,
  type PdfGpuCaptureResult,
  type PdfGpuOverlayItem,
  type PdfGpuOverlayProjection,
  type PdfGpuScreenPoint,
  PdfGpuCaptureError,
  type PdfGpuViewerOptions,
  type PdfGpuViewerState,
  type PdfRasterProvider,
  type PdfRasterResult,
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
const DEFAULT_DETAIL_DPI = 192;
const LOAD_PARSE_PROGRESS = 35;
const LOAD_PARSE_TRANSITION_MS = 900;
const LOAD_READY_TRANSITION_MS = 1400;
const PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;
const DETAIL_CACHE_BYTES = 128 * 1024 * 1024;
const FALLBACK_PREFETCH_RADIUS = 2;

const VIEWPORT_REGION_ROLE = 'region';
const VIEWPORT_REGION_LABEL = 'PDF viewer';
const PAGE_TEXT_LAYER_TESTID = 'pdfgpu-text-layer';

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

class PdfGpuViewerControllerImpl implements PdfGpuViewerController, PdfGpuCaptureController {
  private readonly container: HTMLElement;
  private readonly engine: PdfRasterProvider;
  private readonly renderer: PageRenderer;
  private readonly previewCache: RasterCache;
  private readonly detailCache: RasterCache;
  private readonly scheduler: ProgressiveRasterScheduler;
  private readonly unsubscribeSlots?: () => void;
  private readonly listeners = new Set<(state: PdfGpuViewerState) => void>();
  private readonly pageShells = new Map<number, HTMLElement>();

  private viewport: HTMLElement;
  private content: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private layout: LayoutMetrics = { pagePositions: [], totalHeight: 0, totalWidth: 0 };
  private loadGeneration = 0;
  private state: PdfGpuViewerState & { colorAdjustments: PdfGpuColorAdjustmentState };
  private snapshot: PdfGpuViewerState;
  private disposed = false;
  private manifest: PdfDocumentManifest | null = null;
  private baseScale = 1;
  private currentBucketDpi = normalizeDetailDpi(DEFAULT_DETAIL_DPI);
  private detailDpi = normalizeDetailDpi(DEFAULT_DETAIL_DPI);
  private activePageIndex: number | undefined = undefined;
  private pageSizes: Array<{ width: number; height: number }> = [];
  private visiblePages: number[] = [];
  /** Pages in the overscan window; shells stay laid out for these while scrolling. */
  private windowPages: number[] = [];
  /**
   * Page modes only: scrollTop that the viewer itself last set (navigation) or
   * last followed. A different scrollTop means the user moved the view.
   * - scope: this controller; lifetime: reset to null on load and on mode
   *   change, set by `scrollToPage` and by `renderCycle`; bound: one number.
   */
  private pageModeAnchorScrollTop: number | null = null;
  private loadPreviewPages = new Set<number>();
  private pendingLayout = false;
  private interaction: ViewerInteractionState;
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
      spreadPairing: options.spreadPairing ?? 'alone',
      fitMode: options.fitMode ?? 'none',
      scrollMode: options.scrollMode ?? 'continuous',
      queueDepth: 0,
      renderQuality: 'idle',
      detailDpi: normalizeDetailDpi(options.detailDpi ?? DEFAULT_DETAIL_DPI),
      colorAdjustments: updateColorAdjustments(DEFAULT_COLOR_ADJUSTMENTS, options.colorAdjustments ?? {}),
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
    // GPU texture lifetime follows raster lifetime: whenever a raster leaves
    // the cache, the texture uploaded from it is destroyed in the same step.
    const onRelease = (source: PdfRasterResult['source']) => this.renderer.releaseTexture(source);
    this.previewCache = new RasterCache({ maxBytes: PREVIEW_CACHE_BYTES, onRelease });
    this.detailCache = new RasterCache({ maxBytes: DETAIL_CACHE_BYTES, onRelease });

    const pool = this.engine instanceof WorkerPoolPdfEngine ? this.engine : undefined;
    const limit = this.engine.kind === 'in-memory' ? 8 : 3;
    const sharedSlots = Array.from({ length: clamp(1, limit, this.engine.queueDepth ?? 1) }, (_, id): ViewerRasterSlot => ({
      id, role: 'shared', available: true,
    }));
    const slots = () => pool?.getViewerSlots() ?? sharedSlots;
    this.scheduler = new ProgressiveRasterScheduler({
      slots,
      render: (slot, task, signal) => pool ? pool.tryRenderForViewer(slot, task) : this.renderRaster(task, signal),
      has: (task) => (task.kind === 'preview' ? this.previewCache : this.detailCache).has(task.key),
      canPrefetch: (pageIndex, anchor, bytes) => this.canPrefetch(pageIndex, anchor, bytes),
      cache: (task, raster, anchor) => this.storeRaster(task, raster, anchor),
      changed: (pageIndex) => this.onRasterChanged(pageIndex),
      failed: (error) => console.error('[pdfgpu] render failed', error),
      prefetchRadius: pool ? Infinity : FALLBACK_PREFETCH_RADIUS,
      abortStale: this.engine.kind === 'webapi' || this.engine.kind === 'websocket',
    });
    this.state.queueDepth = slots().length;
    this.snapshot = { ...this.state, visiblePages: [] };
    this.interaction = createViewerInteractionState({
      pageCount: 0,
      mode: viewerModeFromParts(this.state.scrollMode, this.state.viewMode),
      pairing: this.state.spreadPairing,
    });
    this.unsubscribeSlots = pool?.subscribeViewerSlots(() => {
      if (this.disposed) return;
      const depth = slots().length;
      if (this.state.queueDepth !== depth) {
        this.state.queueDepth = depth;
        this.notify();
      }
      this.scheduler.pump();
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

    this.renderer.onBackendChange = (backend) => {
      if (this.disposed) return;
      this.state.backend = backend;
      if (backend === 'webgpu') this.scheduleUpdate();
      this.notify();
    };
    await this.renderer.init(this.canvas);
    this.state.backend = this.renderer.state;
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
    this.rebuildLayout();
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

  setSpreadPairing(pairing: PdfGpuSpreadPairing): void {
    this.assertAlive();
    if (pairing !== 'alone' && pairing !== 'paired') return;
    if (this.state.spreadPairing === pairing) return;
    // The page whose row we keep: the navigated page in page modes, the page
    // at the centre in continuous scroll.
    const currentIndex = this.interaction.mode === 'scroll'
      ? this.activePageIndex
      : this.interaction.page - 1;
    this.state.spreadPairing = pairing;
    this.interaction = reduceViewerInteraction(this.interaction, { type: 'setPairing', pairing }).state;
    this.reapplyFitOrLayout();
    if (this.manifest && currentIndex !== undefined && this.state.viewMode === 'spread') {
      // Land on the first page of the new row that holds the current page.
      const rows = spreadRows(this.manifest.pageCount, pairing);
      const row = rows.find((r) => r.includes(currentIndex));
      if (row) this.scrollToPage(row[0]);
    }
    this.notify();
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
    this.scheduleUpdate();
    this.notify();
  }

  setDetailDpi(dpi: number): void {
    this.assertAlive();
    const next = normalizeDetailDpi(dpi);
    if (this.detailDpi === next) return;
    this.detailDpi = next;
    this.currentBucketDpi = next;
    this.state.detailDpi = next;
    this.scheduleUpdate();
    this.notify();
  }

  setColorAdjustments(update: PdfGpuColorAdjustments): void {
    this.assertAlive();
    const current = this.state.colorAdjustments;
    const next = updateColorAdjustments(current, update);
    if (next === current) return;
    this.state.colorAdjustments = next;
    if (this.state.backend === 'webgpu' && this.manifest && !this.state.loading) this.scheduleFrame();
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
    const targetPage = normalizeViewerPage(index + 1, this.manifest.pageCount, this.interaction.mode, this.interaction.pairing);
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
    // Read back: the browser clamps at the end of the document.
    this.pageModeAnchorScrollTop = this.viewport.scrollTop;
    this.scheduleUpdate(true);
    this.notify();
  }

  async captureRegion(start: PdfGpuScreenPoint, end: PdfGpuScreenPoint, options: { minSize?: number; signal?: AbortSignal } = {}): Promise<PdfGpuCaptureResult> {
    this.assertAlive();
    const minSize = options.minSize ?? 50;
    if (Math.abs(end.x - start.x) < minSize || Math.abs(end.y - start.y) < minSize) {
      throw new PdfGpuCaptureError('capture-too-small', `capture region must be at least ${minSize}x${minSize}px`);
    }
    const page = findPageAtViewportPoint(this.layout, start, this.viewport.scrollTop);
    const endPage = findPageAtViewportPoint(this.layout, end, this.viewport.scrollTop);
    if (!page || !endPage || page.index !== endPage.index) throw new PdfGpuCaptureError('invalid-coordinates', 'capture region must stay within one page');
    const manifestPage = this.manifest?.pages[page.index];
    if (!manifestPage) throw new PdfGpuCaptureError('invalid-coordinates', 'page is not available');
    const dpi = Math.max(this.detailDpi, 192);
    const rect = screenRectToAbsoluteRect(page, start, end, this.viewport.scrollTop, manifestPage.widthPts, manifestPage.heightPts);
    if (rect.width <= 0 || rect.height <= 0) throw new PdfGpuCaptureError('invalid-coordinates', 'capture region is empty');
    if (this.state.renderQuality === 'preview') throw new PdfGpuCaptureError('high-resolution-not-ready', 'high-resolution page is still loading');
    const scale = dpi / 72;
    const raster = await this.engine.renderPreview({ pageIndex: page.index, dpi, signal: options.signal });
    if (options.signal?.aborted) throw new DOMException('capture aborted', 'AbortError');
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new PdfGpuCaptureError('high-resolution-not-ready', 'capture canvas is unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // Sample the source in the raster's own pixel space. A provider is not
    // guaranteed to honour the requested dpi (the bundled demo server always
    // returns a 96 DPI preview), so the source rectangle is derived from the
    // raster's actual size per PDF point, not from `dpi`. Using `dpi` here
    // cropped the wrong region whenever the two differed.
    const { sx, sy, sw, sh } = captureSourceRect(rect, raster, manifestPage.widthPts, manifestPage.heightPts);
    context.drawImage(raster.source as CanvasImageSource, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    return { pageIndex: page.index, rect, imageBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png', quality: 'high-resolution', dpi };
  }

  projectOverlays(overlays: PdfGpuOverlayItem[]): PdfGpuOverlayProjection[] {
    return projectOverlaysForVisiblePages(
      this.layout,
      overlays,
      this.state.visiblePages,
      this.viewport.scrollTop,
      this.manifest?.pages.map((page) => ({ width: page.widthPts, height: page.heightPts })) ?? [],
    );
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
    // Idempotent: the controller owns the provider and disposes it below, so
    // a second call must not dispose the provider (or the GPU device) again.
    if (this.disposed) return;
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
    this.loadGeneration += 1;
    this.scheduler.reset();
    this.unsubscribeSlots?.();
    this.listeners.clear();

    this.viewport.removeEventListener('scroll', this.onScroll);
    this.viewport.removeEventListener('wheel', this.onWheel);
    this.viewport.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);

    this.renderer.dispose();
    this.engine.dispose();
    this.previewCache.clear();
    this.detailCache.clear();
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
      spreadPairing: this.state.spreadPairing,
      fitMode: this.state.fitMode,
      scrollMode: this.state.scrollMode,
      queueDepth: 0,
      renderQuality: 'idle',
      detailDpi: this.detailDpi,
      colorAdjustments: this.state.colorAdjustments,
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
    this.canvas.remove();
    this.content.remove();
  }

  private async loadInternal(source: PdfDocumentSource): Promise<void> {
    this.assertAlive();
    const token = ++this.loadGeneration;
    this.scheduler.reset();
    if (this.loadProgressRafId !== null) {
      cancelAnimationFrame(this.loadProgressRafId);
      this.loadProgressRafId = null;
    }
    this.loadReadyAnimationRunning = false;
    this.previewCache.clear();
    this.detailCache.clear();
    this.clearShells();
    this.manifest = null;
    this.state.loading = true;
    this.state.loadPhase = 'opening';
    this.state.loadProgress = 0;
    this.state.loadProgressDeterminate = false;
    this.state.loadedPages = 0;
    this.state.loadPageCount = 0;
    this.loadPreviewPages.clear();
    this.pageModeAnchorScrollTop = null;
    this.state.error = null;
    this.state.renderQuality = 'preview';
    this.visiblePages = [];
    this.state.visiblePages = [];
    this.notify();

    try {
      const manifest = await this.engine.open(source, (progress: PdfLoadProgress) => {
        if (this.disposed || token !== this.loadGeneration) return;
        this.state.loadProgressDeterminate = progress.ratio !== undefined;
        if (progress.ratio !== undefined) {
          this.state.loadProgress = Math.min(34, Math.round(progress.ratio * 34));
        }
        this.notify();
      });
      if (this.disposed || token !== this.loadGeneration) return;

      this.manifest = manifest;
      this.interaction = reduceViewerInteraction(this.interaction, {
        type: 'setPageCount',
        pageCount: manifest.pageCount,
      }).state;
      this.pageSizes = manifest.pages.map((page) => ({
        width: Math.max(1, Math.round(page.widthPts * PREVIEW_DPI / 72)),
        height: Math.max(1, Math.round(page.heightPts * PREVIEW_DPI / 72))
      }));
      this.currentBucketDpi = this.detailDpi;
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
      this.scheduleUpdate();
    } catch (error) {
      if (this.disposed || token !== this.loadGeneration) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.state.loading = false;
        this.state.loadPhase = 'idle';
        this.state.loadProgress = 0;
        this.state.loadProgressDeterminate = false;
        this.notify();
        return;
      }
      this.state.loading = false;
      this.state.loadPhase = 'error';
      this.state.error = error instanceof Error ? error.name + ': ' + error.message : 'failed to open document';
      this.notify();
      throw error;
    }
  }

  private renderCycle = () => {
    if (this.disposed || this.state.loading || !this.manifest) return;

    const window = resolveViewportWindow(
      this.layout.pagePositions,
      this.viewport.clientHeight || 1,
      this.viewport.scrollTop,
      this.overscanPages
    );
    this.windowPages = windowPageIndices(this.layout.pagePositions, window);
    this.visiblePages = visiblePageIndices(
      this.layout.pagePositions,
      window,
      this.viewport.scrollTop,
      this.viewport.clientHeight || 1
    );
    if (this.state.loadPhase === 'rendering' && !this.loadReadyAnimationRunning) {
      this.loadPreviewPages = new Set(this.visiblePages);
      this.updateLoadProgress();
    }
    // Page modes navigate by page, but the scrollbar can still move the view.
    // If the scroll position is no longer the one our own navigation left,
    // the user moved it: follow the page at the centre. Otherwise keep the
    // navigated page (the last row cannot be centred, so "page at centre"
    // alone would mislabel it). Chrome before the fix: dragged to pages 2-3
    // while the state said 8, and PageDown went to 10.
    const current = this.interaction.page - 1;
    let active: number | undefined = current;
    if (this.interaction.mode === 'scroll') {
      active = this.chooseActivePage(this.visiblePages, window);
    } else {
      const scrollTop = this.viewport.scrollTop;
      if (this.pageModeAnchorScrollTop === null) {
        this.pageModeAnchorScrollTop = scrollTop;
      } else if (Math.abs(scrollTop - this.pageModeAnchorScrollTop) > 1) {
        active = this.chooseActivePage(this.visiblePages, window) ?? current;
        this.pageModeAnchorScrollTop = scrollTop;
      }
    }
    const normalizedActive = active === undefined
      ? undefined
      : normalizeViewerPage(active + 1, this.manifest.pageCount, this.interaction.mode, this.interaction.pairing) - 1;
    this.activePageIndex = normalizedActive;
    this.state.visiblePages = [...this.visiblePages];
    this.state.activePage = normalizedActive !== undefined ? normalizedActive + 1 : this.state.activePage;
    if (normalizedActive !== undefined) {
      this.interaction = reduceViewerInteraction(this.interaction, {
        type: 'setPage',
        page: normalizedActive + 1,
      }).state;
    }
    this.applyVisibleShells();
    this.applyCompositedFrame(this.visiblePages);
    const activePage = normalizedActive ?? this.visiblePages[0];
    if (activePage !== undefined) {
      const bounds = this.viewportBounds();
      const pages = [...this.visiblePages].sort((a, b) => Math.abs(a - activePage) - Math.abs(b - activePage));
      this.previewCache.prune(this.previewKeepKeys());
      this.scheduler.update({
        activePage,
        visiblePages: pages,
        pageCount: this.manifest.pageCount,
        detailTiles: () => this.detailTiles(pages, bounds),
      });
    }
    this.notify();
  };

  private viewportBounds(): ViewportBounds {
    return { top: this.viewport.scrollTop, width: this.viewport.clientWidth || 1, height: this.viewport.clientHeight || 1 };
  }

  private detailTiles(visiblePages: readonly number[], bounds: ViewportBounds) {
    const dpi = this.currentBucketDpi;
    const scale = detailSourceScale(dpi, this.baseScale);
    return visiblePages.flatMap((index) => {
      const page = this.layout.pagePositions[index];
      const source = this.manifest?.pages[index];
      if (!page || !source) return [];
      const width = Math.max(1, Math.round(source.widthPts * dpi / 72));
      const height = Math.max(1, Math.round(source.heightPts * dpi / 72));
      return visibleDetailTiles(page, bounds, dpi, scale, width, height);
    });
  }

  private async renderRaster(task: RasterTask, signal?: AbortSignal): Promise<PdfRasterResult> {
    const generation = this.loadGeneration;
    if (this.engine.kind === 'in-memory') {
      // The single-thread fallback yields before entering synchronous PDFium.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (generation !== this.loadGeneration) throw new DOMException('render aborted', 'AbortError');
    const { pageIndex, dpi } = task;
    if (task.kind === 'preview') return this.engine.renderPreview({ pageIndex, dpi, signal });
    const { tileX, tileY, tileWidth, tileHeight } = task;
    return this.engine.renderTile({ pageIndex, dpi, tileX, tileY, tileWidth, tileHeight, signal });
  }

  private previewKeepKeys(pageIndex?: number, anchor?: number): Set<string> {
    const keep = new Set(this.visiblePages.map((page) => previewTask(page).key));
    if (pageIndex === undefined || anchor === undefined) return keep;
    const distance = Math.abs(pageIndex - anchor);
    for (const entry of this.previewCache.values()) {
      if (Math.abs(entry.pageIndex - anchor) <= distance) keep.add(entry.key);
    }
    return keep;
  }

  private canPrefetch(pageIndex: number, anchor: number, bytes?: number): boolean {
    const page = this.pageSizes[pageIndex];
    return !!page && this.previewCache.canFit(bytes ?? page.width * page.height * 4, this.previewKeepKeys(pageIndex, anchor));
  }

  private detailKeepKeys(bounds: ViewportBounds): Set<string> {
    const keep = new Set<string>();
    const scale = detailSourceScale(this.currentBucketDpi, this.baseScale);
    for (const entry of this.detailCache.values()) {
      if (entry.dpi !== this.currentBucketDpi || !this.visiblePages.includes(entry.pageIndex)) continue;
      const page = this.layout.pagePositions[entry.pageIndex];
      if (page && detailTileVisible(entry, page, bounds, scale)) keep.add(entry.key);
    }
    return keep;
  }

  private storeRaster(task: RasterTask, raster: PdfRasterResult, prefetchAnchor?: number): boolean {
    const isPreview = task.kind === 'preview';
    if (!isPreview && raster.dpi !== task.dpi) return false;
    const cache = isPreview ? this.previewCache : this.detailCache;
    const keep = isPreview ? this.previewKeepKeys(task.pageIndex, prefetchAnchor) : this.detailKeepKeys(this.viewportBounds());
    if ((!isPreview || prefetchAnchor !== undefined) && !cache.canFit(raster.width * raster.height * 4, keep)) return false;
    keep.add(task.key);
    cache.set({
      key: task.key,
      kind: task.kind,
      pageIndex: task.pageIndex,
      dpi: raster.dpi,
      tileX: isPreview ? 0 : raster.tileX ?? task.tileX,
      tileY: isPreview ? 0 : raster.tileY ?? task.tileY,
      tileWidth: isPreview ? 0 : raster.tileWidth ?? raster.width,
      tileHeight: isPreview ? 0 : raster.tileHeight ?? raster.height,
      source: raster.source,
      width: raster.width,
      height: raster.height,
      sourceWidth: raster.width,
      sourceHeight: raster.height,
      dpiRounded: normalizeDetailDpi(raster.dpi),
    }, keep);
    return true;
  }

  private onRasterChanged(pageIndex: number): void {
    this.applyShellState(pageIndex);
    if (!this.pendingLayout && this.visiblePages.includes(pageIndex)) this.applyCompositedFrame(this.visiblePages);
    this.updateLoadProgress();
    this.notify();
  }

  private applyVisibleShells() {
    if (!this.manifest) return;
    const keep = this.computeShellWindowPages([...this.windowPages, ...this.visiblePages], this.activePageIndex);
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
    const bounds = { top: viewportTop, width, height };

    // Resize only when the viewport changed. Measured in Chrome before this
    // guard: 550 assignments over 275 frames, every one with the value the
    // canvas already had (0 real resizes, 0 context reconfigures). Clearing
    // is not lost: the WebGPU pass uses loadOp 'clear', and the 2D path
    // (`PageRenderer.render2d`) resets its target canvas itself.
    // The style check keeps this correct if anything else (e.g. `initialize`,
    // which sets height '0') touches the styles while the pixel size matches.
    if (
      this.canvas.width !== width
      || this.canvas.height !== height
      || this.canvas.style.height !== `${height}px`
      || this.canvas.style.width !== `${width}px`
    ) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      // The sticky canvas is an overlay; cancel its flow height so the first
      // page keeps the same top coordinate as the scroll content.
      this.canvas.style.marginBottom = `${-height}px`;
      this.canvas.style.top = '0';
      this.canvas.style.transform = 'none';
    }

    const tiles = [];
    const visibleSet = new Set(visiblePages);
    const detailByPage = new Map<number, ReturnType<RasterCache['values']>>();
    const sourceScale = detailSourceScale(this.currentBucketDpi, this.baseScale);
    for (const entry of this.detailCache.values()) {
      if (!visibleSet.has(entry.pageIndex)) continue;
      if (entry.dpi !== this.currentBucketDpi) continue;
      const page = this.layout.pagePositions[entry.pageIndex];
      if (!page || !detailTileVisible(entry, page, bounds, sourceScale)) continue;
      const pageEntries = detailByPage.get(entry.pageIndex);
      if (pageEntries) pageEntries.push(entry);
      else detailByPage.set(entry.pageIndex, [entry]);
    }

    for (const pageIndex of visiblePages) {
      const page = this.layout.pagePositions[pageIndex];
      if (!page) continue;

      const pageLeft = page.left;
      const preview = this.previewCache.get(previewTask(pageIndex).key);

      if (preview) {
        tiles.push({
          source: preview.source,
          left: Math.round(pageLeft),
          top: Math.round(page.top - viewportTop),
          width: Math.round(page.width),
          height: Math.round(page.height)
        });
      }

      const detail = detailByPage.get(pageIndex);
      for (const entry of detail ?? []) {
        const scale = 1 / sourceScale;
        tiles.push({
          source: entry.source,
          left: Math.round(pageLeft + entry.tileX * scale),
          top: Math.round(page.top + entry.tileY * scale - viewportTop),
          width: Math.max(1, Math.round(entry.width * scale)),
          height: Math.max(1, Math.round(entry.height * scale))
        });
      }

      this.updateShellStateByContent(pageIndex, detail?.length ? 'detail' : preview ? 'preview' : 'idle');
    }

    if (detailByPage.size > 0) {
      this.state.renderQuality = 'detail';
    } else if (visiblePages.length) {
      this.state.renderQuality = 'preview';
    }

    this.renderer.render(this.canvas, {
      width,
      height,
      tiles,
      colorAdjustments: this.state.colorAdjustments
    });
    this.state.backend = this.renderer.state;
  }

  private pageHasPreview(pageIndex: number): boolean {
    return this.previewCache.has(previewTask(pageIndex).key);
  }

  private updateLoadProgress(): void {
    if (this.state.loadPhase !== 'rendering' || this.loadPreviewPages.size === 0) return;
    let loadedPages = 0;
    let failedPages = 0;
    for (const pageIndex of this.loadPreviewPages) {
      if (this.pageHasPreview(pageIndex)) loadedPages += 1;
      else if (this.scheduler.previewFailed(pageIndex)) failedPages += 1;
    }
    this.state.loadedPages = loadedPages;
    const settledPages = loadedPages + failedPages;
    if (this.state.loadProgress < LOAD_PARSE_PROGRESS) return;
    if (settledPages >= this.loadPreviewPages.size) {
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
    this.state.loadProgress = Math.min(99, LOAD_PARSE_PROGRESS + Math.round((settledPages / this.loadPreviewPages.size) * (100 - LOAD_PARSE_PROGRESS)));
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
    return this.detailCache.values().some((entry) => entry.pageIndex === pageIndex && entry.dpi === this.currentBucketDpi);
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
      spreadPairing: this.state.spreadPairing,
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
    this.applyVisibleShells();
    this.scheduleUpdate();
    this.notify();
  }

  /**
   * Space a fitted page can use: the viewport's client box minus its padding.
   * `clientWidth`/`clientHeight` include padding, so fitting to them made a
   * page overflow by the padding (measured in Chrome: the demo app's 6px
   * top/bottom padding left 7px of a fit-height page below the fold).
   */
  private viewportContentBox(): { width: number; height: number } {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(this.viewport) : null;
    const px = (value: string | undefined) => {
      const parsed = Number.parseFloat(value ?? '');
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const padX = style ? px(style.paddingLeft) + px(style.paddingRight) : 0;
    const padY = style ? px(style.paddingTop) + px(style.paddingBottom) : 0;
    return {
      width: Math.max(1, this.viewport.clientWidth - padX),
      height: Math.max(1, this.viewport.clientHeight - padY)
    };
  }

  private computeFitWidthZoom(): number {
    if (!this.pageSizes.length || !this.viewport.clientWidth) return this.state.zoom;
    return this.viewportContentBox().width / this.intrinsicMaxRowWidth();
  }

  private computeFitHeightZoom(): number {
    if (!this.pageSizes.length || !this.viewport.clientHeight) return this.state.zoom;
    return this.viewportContentBox().height / this.intrinsicMaxRowHeight();
  }

  private intrinsicMaxRowWidth(): number {
    if (this.state.viewMode === 'single') {
      return Math.max(...this.pageSizes.map((page) => page.width), 1);
    }
    // Every spread row, including a lone first or last page, takes the width of
    // a two-page row (the lone page sits in one slot), matching buildLayout.
    let maxWidth = 1;
    for (const row of spreadRows(this.pageSizes.length, this.state.spreadPairing)) {
      const [first, second] = row.map((index) => this.pageSizes[index]);
      if (!first) continue;
      const width = second
        ? first.width + this.spreadGap + second.width
        : first.width * 2 + this.spreadGap;
      maxWidth = Math.max(maxWidth, width);
    }
    return maxWidth;
  }

  private intrinsicMaxRowHeight(): number {
    if (this.state.viewMode === 'single') {
      return Math.max(...this.pageSizes.map((page) => page.height), 1);
    }
    let maxHeight = 1;
    for (const row of spreadRows(this.pageSizes.length, this.state.spreadPairing)) {
      for (const index of row) maxHeight = Math.max(maxHeight, this.pageSizes[index]?.height ?? 0);
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

  private scheduleUpdate(moved = false) {
    this.scheduler.invalidate(moved);
    this.pendingLayout = true;
    this.scheduleFrame();
  }

  private scheduleFrame() {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.pendingLayout) {
        this.pendingLayout = false;
        this.renderCycle();
      } else if (!this.disposed && !this.state.loading && this.renderer.state === 'webgpu') {
        this.applyCompositedFrame(this.visiblePages);
        this.notify();
      }
    });
  }

  private notify() {
    const next = {
      ...this.state,
      visiblePages: [...this.visiblePages]
    };
    // renderCycle calls this on every animation frame while scrolling. Skip
    // listeners when nothing observable changed, so a React consumer does not
    // re-render the whole app once per frame with an identical state.
    if (this.snapshot && sameViewerState(this.snapshot, next)) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private onScroll = () => {
    this.scheduleUpdate(true);
  };

  private onWheel = (event: WheelEvent) => {
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

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    const editableTarget = !!target
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const transition = reduceViewerInteraction(this.interaction, {
      type: 'key',
      key: event.key,
      editableTarget,
    });
    this.interaction = transition.state;
    if (transition.preventDefault) event.preventDefault();
    for (const effect of transition.effects) {
      if (effect.type === 'navigate') this.scrollToPage(effect.page - 1);
    }
  };

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
    // Keyboard paging (PageUp/PageDown/arrows in single/double). The reducer
    // already handled 'key' events, but nothing dispatched them.
    this.viewport.addEventListener('keydown', this.onKeyDown);
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
    this.pageModeAnchorScrollTop = null;
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

/** Shallow equality over every state field; arrays compared element-wise. */
function sameViewerState(a: PdfGpuViewerState, b: PdfGpuViewerState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof PdfGpuViewerState>;
  for (const key of keys) {
    const left = a[key] as unknown;
    const right = b[key] as unknown;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
      }
      continue;
    }
    if (left !== right) return false;
  }
  return true;
}
