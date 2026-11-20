import { normalizeDetailDpi } from './dpi.js';
import { clamp, ensurePdfium, PdfiumDocument, TILE_SIZE } from './pdfiumCore.js';
import { WorkerPoolPdfEngine } from './workerPoolEngine.js';
export async function sourceToBytes(source, onProgress) {
    const reportComplete = (length) => onProgress?.({ loadedBytes: length, totalBytes: length, ratio: 1 });
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
        if (!response.ok)
            throw new Error(`failed to fetch document: ${response.status}`);
        const header = response.headers.get('content-length');
        const totalBytes = header ? Number.parseInt(header, 10) : undefined;
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            onProgress?.({ loadedBytes: bytes.byteLength, totalBytes: totalBytes ?? bytes.byteLength, ratio: 1 });
            return bytes;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let loadedBytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
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
const MAX_POOL_SIZE = 8;
function defaultPoolSize() {
    const hardware = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    return clamp(hardware - 1, 1, 4);
}
function defaultCreateWorker() {
    return new Worker(new URL('./pdfiumWorkerMain.js', import.meta.url), {
        type: 'module',
        name: 'pdfgpu-pdfium'
    });
}
export async function createPdfDocumentEngine(options = {}) {
    const poolSize = clamp(Math.round(options.poolSize ?? defaultPoolSize()), 1, MAX_POOL_SIZE);
    const createWorker = options.createWorker
        ?? (typeof Worker !== 'undefined' ? defaultCreateWorker : null);
    if (createWorker) {
        try {
            return await WorkerPoolPdfEngine.create({ createWorker, size: poolSize, loadBytes: sourceToBytes });
        }
        catch (error) {
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
class MainThreadPdfEngine {
    constructor(pdfium) {
        this.kind = 'in-memory';
        this.queueDepth = 1;
        this.manifest = null;
        this.generation = 0;
        this.disposed = false;
        this.document = new PdfiumDocument(pdfium);
    }
    async open(source, onProgress) {
        if (this.disposed)
            throw new Error('engine is disposed');
        const token = ++this.generation;
        this.manifest = null;
        const bytes = await sourceToBytes(source, onProgress);
        if (token !== this.generation)
            throw new DOMException('open aborted', 'AbortError');
        const manifest = await this.document.open(bytes);
        if (token !== this.generation) {
            if (this.disposed)
                await this.document.dispose();
            throw new DOMException('open aborted', 'AbortError');
        }
        this.manifest = manifest;
        return manifest;
    }
    async renderPreview(request) {
        this.assertPage(request.pageIndex);
        return this.document.renderPreview(request);
    }
    async renderTile(request) {
        this.assertPage(request.pageIndex);
        return this.document.renderTile(normalizeTileRequest(request));
    }
    async dispose() {
        this.disposed = true;
        this.generation += 1;
        this.manifest = null;
        await this.document.dispose();
    }
    assertPage(pageIndex) {
        if (!this.manifest)
            throw new Error('document not opened');
        if (pageIndex < 0 || pageIndex >= this.manifest.pageCount) {
            throw new Error(`invalid page index: ${pageIndex}`);
        }
    }
}
export function normalizeTileRequest(request) {
    return {
        ...request,
        dpi: normalizeDetailDpi(request.dpi),
        tileWidth: request.tileWidth ?? TILE_SIZE,
        tileHeight: request.tileHeight ?? TILE_SIZE
    };
}
