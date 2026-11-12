import { FPDF_REVERSE_BYTE_ORDER, pdfiumRgbxToRgba } from './pixels.js';
import { normalizeDetailDpi } from './dpi.js';
const PREVIEW_DPI = 96;
const TILE_SIZE = 512;
// PDFium writes R, G, B, x with this flag; see engine/pixels.ts.
const RENDER_FLAGS = FPDF_REVERSE_BYTE_ORDER;
const WHITE = 0xffffffff;
const PT_TO_PX_SCALE = 96 / 72;
const ROTATE_TO_FLAG = {
    0: 0,
    90: 1,
    180: 2,
    270: 3
};
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function roundInt(value) {
    return Math.max(1, Math.round(value));
}
function normalizeRotation(rawRotation) {
    const normalized = ((rawRotation % 360) + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}
function rotateFlag(rawRotation) {
    return ROTATE_TO_FLAG[normalizeRotation(rawRotation)] ?? 0;
}
function isBrowserEnvironment() {
    return (typeof window !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        typeof fetch !== 'undefined');
}
function assertNotAborted(signal) {
    if (signal?.aborted) {
        throw new DOMException('render aborted', 'AbortError');
    }
}
async function sourceToBytes(source, onProgress) {
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
function extractManifest(pdfium, docPtr) {
    const pageCount = pdfium.FPDF_GetPageCount(docPtr);
    const pages = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const pagePtr = pdfium.FPDF_LoadPage(docPtr, pageIndex);
        if (!pagePtr) {
            throw new Error(`failed to inspect page ${pageIndex}`);
        }
        try {
            const rawWidth = pdfium.FPDF_GetPageWidthF(pagePtr);
            const rawHeight = pdfium.FPDF_GetPageHeightF(pagePtr);
            const rawRotation = pdfium.EPDF_GetPageRotationByIndex(docPtr, pageIndex);
            const rotation = normalizeRotation(rawRotation);
            const widthPts = rotation === 90 || rotation === 270 ? rawHeight : rawWidth;
            const heightPts = rotation === 90 || rotation === 270 ? rawWidth : rawHeight;
            pages.push({
                index: pageIndex,
                widthPts,
                heightPts,
                rotation
            });
        }
        finally {
            pdfium.FPDF_ClosePage(pagePtr);
        }
    }
    return pages;
}
let pdfiumShared = null;
async function ensurePdfium() {
    if (pdfiumShared)
        return pdfiumShared;
    if (!isBrowserEnvironment()) {
        throw new Error('PDFium engine is browser-only');
    }
    pdfiumShared = Promise.all([
        import('@embedpdf/pdfium'),
        import('@embedpdf/pdfium/pdfium.wasm?url')
    ]).then(async ([raw, wasmAsset]) => {
        const pdfiumModule = raw;
        const response = await fetch(wasmAsset.default);
        const wasmBinary = await response.arrayBuffer();
        const wrapped = await pdfiumModule.init({ wasmBinary });
        wrapped.PDFiumExt_Init();
        return wrapped;
    });
    try {
        return await pdfiumShared;
    }
    catch (error) {
        pdfiumShared = null;
        throw error;
    }
}
async function createBitmapImage(pdfium, pagePtr, bitmapWidth, bitmapHeight, startX, startY, renderWidth, renderHeight, rotate) {
    const targetBitmapWidth = roundInt(bitmapWidth);
    const targetBitmapHeight = roundInt(bitmapHeight);
    const bitmapPtr = pdfium.FPDFBitmap_Create(targetBitmapWidth, targetBitmapHeight, 0);
    if (!bitmapPtr)
        throw new Error('failed to allocate bitmap');
    try {
        pdfium.FPDFBitmap_FillRect(bitmapPtr, 0, 0, targetBitmapWidth, targetBitmapHeight, WHITE);
        pdfium.FPDF_RenderPageBitmap(bitmapPtr, pagePtr, startX, startY, roundInt(renderWidth), roundInt(renderHeight), rotate, RENDER_FLAGS);
        const bufferPtr = pdfium.FPDFBitmap_GetBuffer(bitmapPtr);
        if (!bufferPtr)
            throw new Error('failed to read rendered buffer');
        const bytesPerPixel = 4;
        const byteCount = targetBitmapWidth * targetBitmapHeight * bytesPerPixel;
        const sourceBytes = new Uint8ClampedArray(new ArrayBuffer(byteCount));
        sourceBytes.set(pdfium.pdfium.HEAPU8.subarray(bufferPtr, bufferPtr + byteCount));
        const imageData = new ImageData(pdfiumRgbxToRgba(sourceBytes), targetBitmapWidth, targetBitmapHeight);
        return await createImageBitmap(imageData);
    }
    finally {
        pdfium.FPDFBitmap_Destroy(bitmapPtr);
    }
}
class PdfiumWorker {
    constructor(pdfium) {
        this.pdfium = pdfium;
        this.loaded = null;
        this.currentManifest = null;
    }
    async open(bytes, manifest) {
        await this.dispose();
        const dataPtr = this.pdfium.pdfium.wasmExports.malloc(bytes.length);
        if (!dataPtr)
            throw new Error('failed to allocate source bytes');
        this.pdfium.pdfium.HEAPU8.set(bytes, dataPtr);
        const docPtr = this.pdfium.FPDF_LoadMemDocument(dataPtr, bytes.length, null);
        if (!docPtr) {
            this.pdfium.pdfium.wasmExports.free(dataPtr);
            throw new Error('failed to open document');
        }
        this.loaded = { docPtr, filePtr: dataPtr };
        this.currentManifest = manifest ?? (() => {
            const pages = extractManifest(this.pdfium, docPtr);
            return { pageCount: pages.length, pages };
        })();
        return this.currentManifest;
    }
    async renderPreview(request) {
        assertNotAborted(request.signal);
        const page = this.currentManifest?.pages[request.pageIndex];
        if (!page)
            throw new Error(`invalid page index: ${request.pageIndex}`);
        const pagePtr = this.pdfium.FPDF_LoadPage(this.requireOpen().docPtr, request.pageIndex);
        if (!pagePtr)
            throw new Error(`failed to load page ${request.pageIndex}`);
        try {
            const dpi = request.dpi ?? PREVIEW_DPI;
            const scale = dpi / 72;
            const width = roundInt(page.widthPts * scale);
            const height = roundInt(page.heightPts * scale);
            const source = await createBitmapImage(this.pdfium, pagePtr, width, height, 0, 0, width, height, rotateFlag(page.rotation));
            assertNotAborted(request.signal);
            return {
                source,
                width,
                height,
                dpi,
                pageIndex: request.pageIndex,
                kind: 'preview'
            };
        }
        finally {
            this.pdfium.FPDF_ClosePage(pagePtr);
        }
    }
    async renderTile(request) {
        assertNotAborted(request.signal);
        const page = this.currentManifest?.pages[request.pageIndex];
        if (!page)
            throw new Error(`invalid page index: ${request.pageIndex}`);
        const scale = request.dpi / 72;
        const pageWidth = roundInt(page.widthPts * scale);
        const pageHeight = roundInt(page.heightPts * scale);
        const pagePtr = this.pdfium.FPDF_LoadPage(this.requireOpen().docPtr, request.pageIndex);
        if (!pagePtr)
            throw new Error(`failed to load page ${request.pageIndex}`);
        try {
            const tileX = clamp(Math.floor(request.tileX), 0, Math.max(0, pageWidth - 1));
            const tileY = clamp(Math.floor(request.tileY), 0, Math.max(0, pageHeight - 1));
            const tileWidth = Math.max(1, Math.min(request.tileWidth, pageWidth - tileX));
            const tileHeight = Math.max(1, Math.min(request.tileHeight, pageHeight - tileY));
            const source = await createBitmapImage(this.pdfium, pagePtr, tileWidth, tileHeight, -tileX, -tileY, pageWidth, pageHeight, rotateFlag(page.rotation));
            assertNotAborted(request.signal);
            return {
                source,
                width: tileWidth,
                height: tileHeight,
                dpi: request.dpi,
                pageIndex: request.pageIndex,
                kind: 'detail',
                tileX,
                tileY,
                tileWidth,
                tileHeight
            };
        }
        finally {
            this.pdfium.FPDF_ClosePage(pagePtr);
        }
    }
    async dispose() {
        if (!this.loaded)
            return;
        const { docPtr, filePtr } = this.loaded;
        this.loaded = null;
        this.currentManifest = null;
        this.pdfium.FPDF_CloseDocument(docPtr);
        this.pdfium.pdfium.wasmExports.free(filePtr);
    }
    requireOpen() {
        if (!this.loaded || !this.currentManifest) {
            throw new Error('document is not opened');
        }
        return this.loaded;
    }
}
export async function createPdfDocumentEngine(_options = {}) {
    const pdfium = await ensurePdfium();
    return new PdfDocumentEngineImpl(pdfium, 1);
}
class PdfDocumentEngineImpl {
    constructor(pdfium, queueDepth) {
        this.kind = 'in-memory';
        this.manifest = null;
        this.generation = 0;
        this.detailTileSize = TILE_SIZE;
        this._queueDepth = queueDepth;
        this.workers = Array.from({ length: queueDepth }, () => new PdfiumWorker(pdfium));
    }
    async open(source, onProgress) {
        this.generation += 1;
        const token = this.generation;
        const bytes = await sourceToBytes(source, onProgress);
        const primary = this.workers[0];
        if (!primary)
            throw new Error('PDFium worker pool is empty');
        const primaryManifest = await primary.open(bytes);
        const manifests = [primaryManifest];
        for (let index = 1; index < this.workers.length; index += 1) {
            manifests.push(await this.workers[index].open(bytes, primaryManifest));
        }
        if (token !== this.generation) {
            await this.dispose();
            throw new DOMException('open aborted', 'AbortError');
        }
        this.manifest = manifests[0] ?? null;
        return this.manifest;
    }
    async renderPreview(request) {
        if (!this.manifest)
            throw new Error('document not opened');
        if (request.pageIndex < 0 || request.pageIndex >= this.manifest.pageCount) {
            throw new Error(`invalid page index: ${request.pageIndex}`);
        }
        const worker = this.selectWorker(request.pageIndex);
        return worker.renderPreview(request);
    }
    async renderTile(request) {
        if (!this.manifest)
            throw new Error('document not opened');
        if (request.pageIndex < 0 || request.pageIndex >= this.manifest.pageCount) {
            throw new Error(`invalid page index: ${request.pageIndex}`);
        }
        const task = {
            ...request,
            dpi: normalizeDetailDpi(request.dpi),
            tileWidth: request.tileWidth ?? this.detailTileSize,
            tileHeight: request.tileHeight ?? this.detailTileSize
        };
        const worker = this.selectWorker(request.pageIndex);
        return worker.renderTile(task);
    }
    async dispose() {
        this.generation += 1;
        this.manifest = null;
        await Promise.all(this.workers.map((worker) => worker.dispose()));
    }
    get queueDepth() {
        return this._queueDepth;
    }
    selectWorker(pageIndex) {
        return this.workers[Math.abs(pageIndex) % this.workers.length];
    }
}
