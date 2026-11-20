import type {
  PdfDocumentManifest,
  PdfDocumentSource,
  PdfDocumentEngine,
  PdfPreviewRenderRequest,
  PdfRasterResult,
  PdfTileRenderRequest,
  PdfLoadProgressListener
} from '../types.js';
import { normalizeDetailDpi } from './dpi.js';
import { clamp, ensurePdfium, PdfiumDocument, TILE_SIZE, type PdfiumWrapped } from './pdfiumCore.js';
import { WorkerPoolPdfEngine, type WorkerLike } from './workerPoolEngine.js';

export async function sourceToBytes(source: PdfDocumentSource, onProgress?: PdfLoadProgressListener): Promise<Uint8Array> {
  const reportComplete = (length: number) => onProgress?.({ loadedBytes: length, totalBytes: length, ratio: 1 });
  if (source instanceof Uint8Array) {
    reportComplete(source.byteLength);
    return source;
  }
  if (source instanceof ArrayBuffer) {
    const bytes = new Uint8Array(source);
    reportComplete(bytes.byteLength);
    return bytes;
  }
  if (source instanceof Blob || source instanceof File) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    reportComplete(bytes.byteLength);
    return bytes;
  }
  if (source instanceof URL || typeof source === 'string') {
    const response = await fetch(source instanceof URL ? source.toString() : source);
    if (!response.ok) throw new Error(`failed to fetch document: ${response.status}`);
    const header = response.headers.get('content-length');
    const totalBytes = header ? Number.parseInt(header, 10) : undefined;
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      onProgress?.({ loadedBytes: bytes.byteLength, totalBytes: totalBytes ?? bytes.byteLength, ratio: 1 });
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loadedBytes += value.byteLength;
      onProgress?.({
        loadedBytes,
        totalBytes,
        ratio: totalBytes && totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : undefined,
      });
    }
    const bytes = new Uint8Array(loadedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    onProgress?.({ loadedBytes, totalBytes: totalBytes ?? loadedBytes, ratio: 1 });
    return bytes;
  }
  throw new Error('unsupported source type');
}

export interface PdfDocumentEngineCreateOptions {
  /**
   * Number of rasterization workers. Each worker is a dedicated Web Worker
   * with its own PDFium WASM instance and its own copy of the document, so
   * pages render in parallel and off the main thread. Memory grows with the
   * pool: every worker holds the whole file plus its PDFium heap.
   *
   * Default: `min(4, navigator.hardwareConcurrency - 1)`, at least 1.
   * Values are clamped to 1..8.
   */
  poolSize?: number;
  /**
   * Creates one worker. Defaults to the bundled `pdfiumWorkerMain` module
   * worker. Exposed so hosts with unusual bundling (or tests) can supply
   * their own; when workers cannot be created at all, the engine falls back
   * to rendering on the main thread.
   */
  createWorker?: () => WorkerLike;
}

const MAX_POOL_SIZE = 8;

function defaultPoolSize(): number {
  const hardware = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return clamp(hardware - 1, 1, 4);
}

function defaultCreateWorker(): WorkerLike {
  return new Worker(new URL('./pdfiumWorkerMain.ts', import.meta.url), {
    type: 'module',
    name: 'pdfgpu-pdfium'
  }) as unknown as WorkerLike;
}

export async function createPdfDocumentEngine(
  options: PdfDocumentEngineCreateOptions = {}
): Promise<PdfDocumentEngine> {
  const poolSize = clamp(Math.round(options.poolSize ?? defaultPoolSize()), 1, MAX_POOL_SIZE);
  const createWorker = options.createWorker
    ?? (typeof Worker !== 'undefined' ? defaultCreateWorker : null);
  if (createWorker) {
    try {
      return await WorkerPoolPdfEngine.create({ createWorker, size: poolSize, loadBytes: sourceToBytes });
    } catch (error) {
      console.warn('[pdfgpu] pdfium workers unavailable; rendering on the main thread', error);
    }
  }
  const pdfium = await ensurePdfium();
  return new MainThreadPdfEngine(pdfium);
}

/**
 * Fallback engine: one PDFium document on the main thread. Rendering blocks
 * the main thread, so the viewer runs at most one raster task at a time.
 */
class MainThreadPdfEngine implements PdfDocumentEngine {
  readonly kind = 'in-memory' as const;
  readonly queueDepth = 1;
  private manifest: PdfDocumentManifest | null = null;
  private readonly document: PdfiumDocument;
  private generation = 0;
  private disposed = false;

  constructor(pdfium: PdfiumWrapped) {
    this.document = new PdfiumDocument(pdfium);
  }

  async open(source: PdfDocumentSource, onProgress?: PdfLoadProgressListener): Promise<PdfDocumentManifest> {
    if (this.disposed) throw new Error('engine is disposed');
    const token = ++this.generation;
    this.manifest = null;
    const bytes = await sourceToBytes(source, onProgress);
    if (token !== this.generation) throw new DOMException('open aborted', 'AbortError');
    const manifest = await this.document.open(bytes);
    if (token !== this.generation) {
      if (this.disposed) await this.document.dispose();
      throw new DOMException('open aborted', 'AbortError');
    }
    this.manifest = manifest;
    return manifest;
  }

  async renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult> {
    this.assertPage(request.pageIndex);
    return this.document.renderPreview(request);
  }

  async renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult> {
    this.assertPage(request.pageIndex);
    return this.document.renderTile(normalizeTileRequest(request));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    this.manifest = null;
    await this.document.dispose();
  }

  private assertPage(pageIndex: number) {
    if (!this.manifest) throw new Error('document not opened');
    if (pageIndex < 0 || pageIndex >= this.manifest.pageCount) {
      throw new Error(`invalid page index: ${pageIndex}`);
    }
  }
}

export function normalizeTileRequest(request: PdfTileRenderRequest): PdfTileRenderRequest {
  return {
    ...request,
    dpi: normalizeDetailDpi(request.dpi),
    tileWidth: request.tileWidth ?? TILE_SIZE,
    tileHeight: request.tileHeight ?? TILE_SIZE
  };
}
